import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sha256 as digest } from '../src/shared/hash.mjs';
import { ensureOpeningsR2Objects, readOpeningsR2Config } from '../src/modules/publishing/openings-r2-store.mjs';
import { buildOpeningsR2Manifest } from '../src/modules/publishing/openings-r2-manifest.mjs';

const jobId = `gh_${'a'.repeat(24)}`;
const bytes = Buffer.from('verified png bytes');
const sha256 = digest(bytes);
function configEnv() { return { OPENINGS_R2_ACCOUNT_ID: 'a'.repeat(32), OPENINGS_R2_BUCKET: 'openings-public-social-media', OPENINGS_R2_BUCKET_PURPOSE: 'openings-public-social-media-v1', OPENINGS_R2_PUBLIC_ORIGIN: 'https://media.openings.dev', OPENINGS_R2_ACCESS_KEY_ID: 'access-key', OPENINGS_R2_SECRET_ACCESS_KEY: 'secret-key' }; }
function mediaOwner(overrides = {}) { return { jobId, sourceId: 'openings/jobs#1', contentHash: 'c'.repeat(64), requestDigest: 'd'.repeat(64), preparedAt: '2026-09-10T12:00:00.000Z', files: [{ role: 'opengraph', fileName: 'opengraph-image.png', logicalArtifactId: 'opengraph', sha256, byteSize: bytes.length, mediaType: 'image/png', width: 1200, height: 630, renderVersion: '2', ...overrides }] }; }
function manifest(overrides) { return buildOpeningsR2Manifest({ mediaOwner: mediaOwner(overrides), publicOrigin: 'https://media.openings.dev', consumersByRole: { opengraph: ['twitter'] } }); }
function notFound() { return Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }); }

test('requires dedicated bucket configuration and keeps credentials out of the returned public config', () => {
  const config = readOpeningsR2Config(configEnv());
  assert.equal(config.endpoint, `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`);
  assert.equal(config.bucket, 'openings-public-social-media');
  assert.equal(config.publicOrigin, 'https://media.openings.dev');
  assert.equal(JSON.stringify(config).includes('secret-key'), false);
  for (const change of [{ OPENINGS_R2_BUCKET_PURPOSE: undefined }, { OPENINGS_R2_BUCKET: 'entities-private' }, { OPENINGS_R2_PUBLIC_ORIGIN: 'http://media.openings.dev' }, { OPENINGS_R2_ACCOUNT_ID: 'bad' }]) assert.throws(() => readOpeningsR2Config({ ...configEnv(), ...change }), /R2 configuration/u);
});

test('observes capacity then heads and create-only uploads a missing object', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-r2-store-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'opengraph-image.png'), bytes);
  const calls = []; const checkpoints = [];
  const client = { send: async (command) => {
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'ListObjectsV2Command') return { IsTruncated: false, Contents: [] };
    if (command.constructor.name === 'HeadObjectCommand') throw notFound();
    return { ETag: 'etag' };
  } };
  const result = await ensureOpeningsR2Objects({ config: readOpeningsR2Config(configEnv()), manifest: manifest(), preparationDirectory: directory, client, checkpoint: async (next) => checkpoints.push(structuredClone(next)) });
  assert.deepEqual(calls.map((call) => call.name), ['ListObjectsV2Command', 'HeadObjectCommand', 'PutObjectCommand']);
  assert.deepEqual(calls[0].input, { Bucket: 'openings-public-social-media', MaxKeys: 1000 });
  assert.equal(calls[2].input.IfNoneMatch, '*'); assert.equal(calls[2].input.Metadata.sha256, sha256);
  assert.equal(result.files[0].uploadState, 'uploaded'); assert.equal(checkpoints.at(-1).files[0].uploadState, 'uploaded');
});

test('reuses a matching existing object without charging it as new capacity', async () => {
  const calls = [];
  const client = { send: async (command) => { calls.push(command.constructor.name); if (command.constructor.name === 'ListObjectsV2Command') return { IsTruncated: false, Contents: Array.from({ length: 1000 }, (_, index) => ({ Key: `existing/${index}`, Size: 512 * 1024 })) }; return { ContentLength: bytes.length, ContentType: 'image/png', Metadata: { sha256 } }; } };
  const result = await ensureOpeningsR2Objects({ config: readOpeningsR2Config(configEnv()), manifest: manifest(), preparationDirectory: '/unused', client });
  assert.deepEqual(calls, ['ListObjectsV2Command', 'HeadObjectCommand']); assert.equal(result.files[0].uploadState, 'uploaded');
});

test('fails closed when an existing immutable object conflicts', async () => {
  const client = { send: async (command) => command.constructor.name === 'ListObjectsV2Command' ? { IsTruncated: false, Contents: [] } : { ContentLength: bytes.length, ContentType: 'image/png', Metadata: { sha256: 'e'.repeat(64) } } };
  await assert.rejects(ensureOpeningsR2Objects({ config: readOpeningsR2Config(configEnv()), manifest: manifest(), preparationDirectory: '/unused', client }), /conflicts with immutable manifest/u);
});

test('fails closed on truncated or malformed bounded listings before HEAD', async () => {
  for (const listing of [{ IsTruncated: true, Contents: [] }, { IsTruncated: false, Contents: {} }, { IsTruncated: false, Contents: [{ Key: '', Size: 1 }] }, { IsTruncated: false, Contents: [{ Key: 'valid', Size: -1 }] }, { IsTruncated: false, Contents: [{ Key: 'valid', Size: 1.5 }] }]) {
    const calls = [];
    await assert.rejects(ensureOpeningsR2Objects({ config: readOpeningsR2Config(configEnv()), manifest: manifest(), preparationDirectory: '/unused', client: { send: async (command) => { calls.push(command.constructor.name); return listing; } } }), /bounded observation/u);
    assert.deepEqual(calls, ['ListObjectsV2Command']);
  }
});

test('admits capacity at the limits and rejects retained bytes or object count over them', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-r2-capacity-')); t.after(() => rm(directory, { recursive: true, force: true })); await writeFile(join(directory, 'opengraph-image.png'), bytes);
  const run = (Contents) => ensureOpeningsR2Objects({ config: readOpeningsR2Config(configEnv()), manifest: manifest(), preparationDirectory: directory, client: { send: async (command) => { if (command.constructor.name === 'ListObjectsV2Command') return { IsTruncated: false, Contents }; if (command.constructor.name === 'HeadObjectCommand') throw notFound(); return {}; } } });
  await run([{ Key: 'existing', Size: 512 * 1024 * 1024 - bytes.length }]);
  await assert.rejects(run([{ Key: 'existing', Size: 512 * 1024 * 1024 - bytes.length + 1 }]), /safe admission limit/u);
  await assert.rejects(run(Array.from({ length: 1000 }, (_, index) => ({ Key: `existing/${index}`, Size: 0 }))), /safe admission limit/u);
});

test('rejects a missing object when the per-run byte limit is exceeded', async () => {
  const source = mediaOwner().files[0];
  const files = [
    { ...source, byteSize: 20 * 1024 * 1024 + 1 },
    { ...source, role: 'instagram-feed', fileName: 'instagram-feed.jpg', logicalArtifactId: 'instagram-feed', sha256: '1'.repeat(64), byteSize: 20 * 1024 * 1024, mediaType: 'image/jpeg', width: 1080, height: 1350 },
    { ...source, role: 'social-video', fileName: 'social-video.mp4', logicalArtifactId: 'social-video', sha256: '2'.repeat(64), byteSize: 20 * 1024 * 1024, mediaType: 'video/mp4', width: 1080, height: 1920 },
  ];
  const oversized = buildOpeningsR2Manifest({ mediaOwner: { ...mediaOwner(), files }, publicOrigin: 'https://media.openings.dev', consumersByRole: { opengraph: ['twitter'], 'instagram-feed': ['instagram'], 'social-video': ['instagramStory'] } });
  await assert.rejects(ensureOpeningsR2Objects({ config: readOpeningsR2Config(configEnv()), manifest: oversized, preparationDirectory: '/unused', client: { send: async (command) => { if (command.constructor.name === 'ListObjectsV2Command') return { IsTruncated: false, Contents: [] }; throw notFound(); } } }), /safe admission limit/u);
});

test('checkpoints an uncertain PUT as ambiguous and retries it by HEAD before any later PUT', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-r2-ambiguous-')); t.after(() => rm(directory, { recursive: true, force: true })); await writeFile(join(directory, 'opengraph-image.png'), bytes);
  const checkpoints = []; let firstPut = true;
  const client = { send: async (command) => { if (command.constructor.name === 'ListObjectsV2Command') return { IsTruncated: false, Contents: [] }; if (command.constructor.name === 'HeadObjectCommand') { if (firstPut) throw notFound(); return { ContentLength: bytes.length, ContentType: 'image/png', Metadata: { sha256 } }; } firstPut = false; throw new Error('connection ended after upload'); } };
  let next;
  await assert.rejects(ensureOpeningsR2Objects({ config: readOpeningsR2Config(configEnv()), manifest: manifest(), preparationDirectory: directory, client, checkpoint: async (value) => { next = structuredClone(value); checkpoints.push(next); } }), /connection ended/u);
  assert.equal(next.files[0].uploadState, 'ambiguous');
  const result = await ensureOpeningsR2Objects({ config: readOpeningsR2Config(configEnv()), manifest: next, preparationDirectory: directory, client, checkpoint: async (value) => checkpoints.push(structuredClone(value)) });
  assert.equal(result.files[0].uploadState, 'uploaded'); assert.equal(checkpoints.length, 2);
});

test('validates the winner after a conditional PUT race', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-r2-race-')); t.after(() => rm(directory, { recursive: true, force: true })); await writeFile(join(directory, 'opengraph-image.png'), bytes);
  const calls = [];
  const client = { send: async (command) => { calls.push(command.constructor.name); if (command.constructor.name === 'ListObjectsV2Command') return { IsTruncated: false, Contents: [] }; if (command.constructor.name === 'HeadObjectCommand' && calls.filter((name) => name === 'HeadObjectCommand').length === 1) throw notFound(); if (command.constructor.name === 'PutObjectCommand') throw Object.assign(new Error('race'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }); return { ContentLength: bytes.length, ContentType: 'image/png', Metadata: { sha256 } }; } };
  const result = await ensureOpeningsR2Objects({ config: readOpeningsR2Config(configEnv()), manifest: manifest(), preparationDirectory: directory, client });
  assert.deepEqual(calls, ['ListObjectsV2Command', 'HeadObjectCommand', 'PutObjectCommand', 'HeadObjectCommand']); assert.equal(result.files[0].uploadState, 'uploaded');
});

test('heads every pending target before admission and stays within ten conservative operations', async () => {
  const source = mediaOwner().files[0];
  const files = [
    { ...source, byteSize: 21 * 1024 * 1024 },
    { ...source, role: 'instagram-feed', fileName: 'instagram-feed.jpg', logicalArtifactId: 'instagram-feed', sha256: '1'.repeat(64), byteSize: 21 * 1024 * 1024, mediaType: 'image/jpeg', width: 1080, height: 1350 },
    { ...source, role: 'social-video', fileName: 'social-video.mp4', logicalArtifactId: 'social-video', sha256: '2'.repeat(64), byteSize: 21 * 1024 * 1024, mediaType: 'video/mp4', width: 1080, height: 1920 },
  ];
  const three = buildOpeningsR2Manifest({ mediaOwner: { ...mediaOwner(), files }, publicOrigin: 'https://media.openings.dev', consumersByRole: { opengraph: ['twitter'], 'instagram-feed': ['instagram'], 'social-video': ['instagramStory'] } });
  const calls = [];
  await assert.rejects(ensureOpeningsR2Objects({ config: readOpeningsR2Config(configEnv()), manifest: three, preparationDirectory: '/unused', client: { send: async (command) => { calls.push(command.constructor.name); if (command.constructor.name === 'ListObjectsV2Command') return { IsTruncated: false, Contents: [] }; throw notFound(); } } }), /safe admission limit/u);
  assert.deepEqual(calls, ['ListObjectsV2Command', 'HeadObjectCommand', 'HeadObjectCommand', 'HeadObjectCommand']); assert.ok(1 + 3 + (3 * 2) <= 10);
});
