import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sha256 as digest } from '../src/shared/hash.mjs';
import {
  ensureOpeningsR2Objects,
  readOpeningsR2Config,
} from '../src/modules/publishing/openings-r2-store.mjs';
import { buildOpeningsR2Manifest } from '../src/modules/publishing/openings-r2-manifest.mjs';

const now = new Date('2026-09-10T12:00:00.000Z');
const jobId = `gh_${'a'.repeat(24)}`;
const bytes = Buffer.from('verified png bytes');
const sha256 = digest(bytes);

function configEnv() {
  return {
    OPENINGS_R2_ACCOUNT_ID: 'a'.repeat(32),
    OPENINGS_R2_BUCKET: 'openings-public-social-media',
    OPENINGS_R2_BUCKET_PURPOSE: 'openings-public-social-media-v1',
    OPENINGS_R2_PUBLIC_ORIGIN: 'https://media.openings.dev',
    OPENINGS_R2_ACCESS_KEY_ID: 'access-key',
    OPENINGS_R2_SECRET_ACCESS_KEY: 'secret-key',
  };
}

function mediaOwner() {
  return {
    jobId, sourceId: 'openings/jobs#1', contentHash: 'c'.repeat(64), requestDigest: 'd'.repeat(64),
    preparedAt: now.toISOString(), files: [{ role: 'opengraph', fileName: 'opengraph-image.png',
      logicalArtifactId: 'opengraph', sha256, byteSize: bytes.length, mediaType: 'image/png',
      width: 1200, height: 630, renderVersion: '2' }],
  };
}

test('requires dedicated bucket configuration and keeps credentials out of the returned public config', () => {
  const config = readOpeningsR2Config(configEnv());
  assert.equal(config.endpoint, `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`);
  assert.equal(config.bucket, 'openings-public-social-media');
  assert.equal(config.publicOrigin, 'https://media.openings.dev');
  assert.equal(JSON.stringify(config).includes('secret-key'), false);
  for (const change of [
    { OPENINGS_R2_BUCKET_PURPOSE: undefined },
    { OPENINGS_R2_BUCKET: 'entities-private' },
    { OPENINGS_R2_PUBLIC_ORIGIN: 'http://media.openings.dev' },
    { OPENINGS_R2_ACCOUNT_ID: 'bad' },
  ]) assert.throws(() => readOpeningsR2Config({ ...configEnv(), ...change }), /R2 configuration/u);
});

test('uploads a missing object create-only and checkpoints its portable state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-r2-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'opengraph-image.png'), bytes);
  const manifest = buildOpeningsR2Manifest({ mediaOwner: mediaOwner(),
    publicOrigin: 'https://media.openings.dev', consumersByRole: { opengraph: ['twitter'] } });
  const calls = [];
  const client = { send: async (command) => {
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === 'HeadObjectCommand') {
      const error = new Error('missing'); error.name = 'NotFound'; error.$metadata = { httpStatusCode: 404 }; throw error;
    }
    return { ETag: 'etag' };
  } };
  const checkpoints = [];
  const result = await ensureOpeningsR2Objects({
    config: readOpeningsR2Config(configEnv()), manifest, preparationDirectory: directory, client,
    capacity: { observedAt: now.toISOString(), standardStorageBytes: 0, classAOperations: 0,
      activeObjectCount: 0, retainedBytes: 0 }, now: () => now,
    checkpoint: async (next) => checkpoints.push(structuredClone(next)),
  });
  assert.deepEqual(calls.map((call) => call.name), ['HeadObjectCommand', 'PutObjectCommand']);
  assert.equal(calls[1].input.IfNoneMatch, '*');
  assert.equal(calls[1].input.ContentType, 'image/png');
  assert.equal(calls[1].input.Metadata.sha256, sha256);
  assert.equal(calls[1].input.CacheControl, 'public, max-age=31536000, immutable');
  assert.equal(result.files[0].uploadState, 'uploaded');
  assert.equal(checkpoints.at(-1).files[0].uploadState, 'uploaded');
});

test('checkpoints an ambiguous upload and stops instead of overwriting or claiming success', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-r2-ambiguous-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'opengraph-image.png'), bytes);
  const manifest = buildOpeningsR2Manifest({ mediaOwner: mediaOwner(),
    publicOrigin: 'https://media.openings.dev', consumersByRole: { opengraph: ['twitter'] } });
  const checkpoints = [];
  const client = { send: async (command) => {
    if (command.constructor.name === 'HeadObjectCommand') {
      const error = new Error('missing'); error.name = 'NotFound'; error.$metadata = { httpStatusCode: 404 }; throw error;
    }
    throw new Error('connection ended after upload');
  } };
  await assert.rejects(ensureOpeningsR2Objects({
    config: readOpeningsR2Config(configEnv()), manifest, preparationDirectory: directory, client,
    capacity: { observedAt: now.toISOString(), standardStorageBytes: 0, classAOperations: 0,
      activeObjectCount: 0, retainedBytes: 0 }, now: () => now,
    checkpoint: async (next) => checkpoints.push(structuredClone(next)),
  }), /connection ended/u);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].files[0].uploadState, 'ambiguous');
});

test('fails closed on stale capacity evidence before contacting R2', async () => {
  const manifest = buildOpeningsR2Manifest({ mediaOwner: mediaOwner(),
    publicOrigin: 'https://media.openings.dev', consumersByRole: { opengraph: ['twitter'] } });
  let calls = 0;
  await assert.rejects(ensureOpeningsR2Objects({
    config: readOpeningsR2Config(configEnv()), manifest, preparationDirectory: '/unused',
    client: { send: async () => { calls += 1; } },
    capacity: { observedAt: '2026-09-10T11:00:00.000Z', standardStorageBytes: 0,
      classAOperations: 0, activeObjectCount: 0, retainedBytes: 0 }, now: () => now,
  }), /capacity evidence/u);
  assert.equal(calls, 0);
});
