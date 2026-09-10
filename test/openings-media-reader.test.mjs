import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readOpeningsJobContent,
  readOpeningsMediaMetadata,
} from '../src/modules/publishing/openings-media-reader.mjs';
import { sha256 } from '../src/shared/hash.mjs';

const jobId = `gh_${'a'.repeat(24)}`;
const selectedJob = {
  id: jobId,
  sourceId: 'openings/jobs#1',
  sourceType: 'github-issue',
  issueState: 'open',
  title: 'Snapshot title',
  contentHash: 'b'.repeat(64),
};
const authoritativeJob = { ...selectedJob, title: 'Authoritative title', incidental: 'newer metadata' };
const entityContentSha256 = sha256(JSON.stringify(authoritativeJob));
const transport = {
  baseUrl: 'https://publishing.example',
  clientId: 'producer',
  secret: 'test-only-secret',
};

function metadataFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    tenant: 'openings',
    jobId,
    entityRevision: selectedJob.contentHash,
    entityContentSha256,
    latestGeneration: 4,
    bridge: null,
    ...overrides,
  };
}

test('reads strict signed metadata without trusting response origins', async () => {
  const actualArtifactId = 'artifact_12345678';
  const metadata = metadataFixture({
    bridge: {
      manifest: {
        schemaVersion: 1, tenant: 'openings', jobId,
        entityRevision: selectedJob.contentHash,
        entityContentSha256, generation: 3,
        media: [{ role: 'opengraph', artifactId: actualArtifactId, sha256: 'c'.repeat(64),
          byteSize: 100, mediaType: 'image/png', width: 1200, height: 630, renderVersion: '2' }],
      },
      publicMedia: [{ role: 'opengraph',
        url: `https://media.openings.dev/media/openings/${actualArtifactId}/${'c'.repeat(64)}`,
        expiresAt: '2026-09-17T00:00:00.000Z' }],
    },
  });
  let calls = 0;
  const result = await readOpeningsMediaMetadata({
    jobId,
    transport: { ...transport, fetch: async (url, init) => {
      calls += 1;
      assert.equal(url, `https://publishing.example/v1/openings/jobs/${jobId}/media`);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers['x-pub-client'], transport.clientId);
      assert.equal(typeof init.headers['x-pub-signature'], 'string');
      return Response.json(metadata);
    } },
    gatewayOrigin: 'https://media.openings.dev',
    now: () => new Date('2026-09-10T12:00:00.000Z'),
    nonce: () => 'metadata-nonce',
  });
  assert.deepEqual(result, metadata);
  assert.equal(calls, 1);
});

test('hashes bounded raw content before parsing and accepts incidental snapshot drift', async () => {
  let calls = 0;
  const result = await readOpeningsJobContent({
    selectedJob,
    metadata: metadataFixture({ latestGeneration: 0 }),
    transport: { ...transport, fetch: async (url, init) => {
      calls += 1;
      assert.equal(url, `https://publishing.example/v1/openings/jobs/${jobId}/content/${entityContentSha256}`);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      return new Response(JSON.stringify(authoritativeJob), { headers: { 'content-type': 'application/json' } });
    } },
    now: () => new Date('2026-09-10T12:00:00.000Z'),
    nonce: () => 'content-nonce',
  });
  assert.deepEqual(result, authoritativeJob);
  assert.equal(result.title, 'Authoritative title');
  assert.equal(calls, 1);
});

test('rejects malformed transport and identities before fetch', async () => {
  let calls = 0;
  for (const invalid of [
    { ...transport, baseUrl: 'http://publishing.example' },
    { ...transport, baseUrl: 'https://user@publishing.example' },
    { ...transport, baseUrl: 'https://publishing.example/path' },
    { ...transport, baseUrl: ' https://publishing.example' },
    { ...transport, secret: '' },
  ]) {
    await assert.rejects(readOpeningsMediaMetadata({
      jobId, transport: { ...invalid, fetch: async () => { calls += 1; } },
      gatewayOrigin: 'https://media.openings.dev',
    }));
  }
  await assert.rejects(readOpeningsMediaMetadata({
    jobId: 'bad', transport: { ...transport, fetch: async () => { calls += 1; } },
    gatewayOrigin: 'https://media.openings.dev',
  }));
  for (const gatewayOrigin of ['http://media.openings.dev', 'https://media.openings.dev/path',
    ' https://media.openings.dev', 'https://media.openings.dev?', 'https://user@media.openings.dev']) {
    await assert.rejects(readOpeningsMediaMetadata({
      jobId, transport: { ...transport, fetch: async () => { calls += 1; } }, gatewayOrigin,
    }));
  }
  assert.equal(calls, 0);
});

test('rejects oversized metadata streams and attempts cancellation', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readOpeningsMediaMetadata({
    jobId,
    transport: { ...transport, fetch: async () => new Response(body, {
      headers: { 'content-type': 'application/json' },
    }) },
    gatewayOrigin: 'https://media.openings.dev',
  }), /too large/u);
  assert.equal(cancelled, true);
});

test('rejects strict metadata corruption without following response-controlled URLs', async () => {
  const artifactId = 'artifact_12345678';
  const manifest = {
    schemaVersion: 1, tenant: 'openings', jobId, entityRevision: selectedJob.contentHash,
    entityContentSha256, generation: 1,
    media: [{ role: 'opengraph', artifactId, sha256: 'c'.repeat(64), byteSize: 100,
      mediaType: 'image/png', width: 1200, height: 630, renderVersion: '2' }],
  };
  const valid = metadataFixture({ bridge: { manifest, publicMedia: [{ role: 'opengraph',
    url: `https://media.openings.dev/media/openings/${artifactId}/${'c'.repeat(64)}`,
    expiresAt: '2026-09-17T00:00:00.000Z' }] } });
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.latestGeneration = -1; },
    (value) => { value.jobId = `gh_${'f'.repeat(24)}`; },
    (value) => { value.bridge.manifest.entityRevision = 'f'.repeat(64); },
    (value) => { value.bridge.manifest.media[0].artifactId = 'logical'; },
    (value) => { value.bridge.publicMedia[0].role = 'instagram-feed'; },
    (value) => { value.bridge.publicMedia[0].url = 'https://attacker.example/media/openings/x/y'; },
    (value) => { value.bridge.publicMedia[0].url += '?token=reflected'; },
    (value) => { value.bridge.publicMedia[0].expiresAt = '2026-09-17T00:00:00Z'; },
  ]) {
    const changed = structuredClone(valid); mutate(changed);
    await assert.rejects(readOpeningsMediaMetadata({
      jobId,
      transport: { ...transport, fetch: async () => Response.json(changed) },
      gatewayOrigin: 'https://media.openings.dev',
    }), /metadata/u);
  }
});

test('rejects content overflow, hash failure, malformed JSON, and source drift', async () => {
  const invoke = (response, metadata = metadataFixture()) => readOpeningsJobContent({
    selectedJob, metadata,
    transport: { ...transport, fetch: async () => response },
  });
  await assert.rejects(invoke(new Response(new Uint8Array(262_145), {
    headers: { 'content-type': 'application/json' },
  })), /too large/u);
  await assert.rejects(invoke(new Response('{}', {
    headers: { 'content-type': 'application/json' },
  })), /hash mismatch/u);
  const malformed = Buffer.from('{invalid', 'utf8');
  await assert.rejects(invoke(new Response(malformed, { headers: { 'content-type': 'application/json' } }),
    metadataFixture({ entityContentSha256: sha256(malformed) })), /invalid/u);
  for (const change of [{ sourceId: 'changed' }, { sourceType: 'other' }, { issueState: 'closed' },
    { contentHash: 'f'.repeat(64) }, { id: `gh_${'f'.repeat(24)}` }]) {
    const changed = { ...authoritativeJob, ...change };
    const bytes = Buffer.from(JSON.stringify(changed));
    await assert.rejects(invoke(new Response(bytes, { headers: { 'content-type': 'application/json' } }),
      metadataFixture({ entityContentSha256: sha256(bytes) })), /identity/u);
  }
});
