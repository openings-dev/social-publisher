import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpeningsR2Manifest,
  validateOpeningsR2Manifest,
} from '../src/modules/publishing/openings-r2-manifest.mjs';

const jobId = `gh_${'a'.repeat(24)}`;
const contentHash = 'b'.repeat(64);
const requestDigest = 'c'.repeat(64);
const createdAt = '2026-09-10T00:00:00.000Z';
const queueItem = { jobId, sourceId: 'openings/jobs#1', contentHash };
const mediaOwner = {
  jobId,
  sourceId: queueItem.sourceId,
  contentHash,
  requestDigest,
  preparedAt: createdAt,
  files: [
    { role: 'opengraph', fileName: 'opengraph-image.png', logicalArtifactId: 'opengraph',
      sha256: 'd'.repeat(64), byteSize: 100, mediaType: 'image/png', width: 1200, height: 630,
      renderVersion: '2' },
    { role: 'instagram-feed', fileName: 'instagram-image.jpg', logicalArtifactId: 'instagram-feed',
      sha256: 'e'.repeat(64), byteSize: 200, mediaType: 'image/jpeg', width: 1080, height: 1350,
      renderVersion: '7' },
  ],
};

test('builds stable immutable R2 keys and portable consumer references', () => {
  const manifest = buildOpeningsR2Manifest({
    mediaOwner,
    publicOrigin: 'https://media.openings.dev',
    consumersByRole: {
      opengraph: ['twitter', 'linkedin'],
      'instagram-feed': ['instagram'],
    },
  });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.publicOrigin, 'https://media.openings.dev');
  assert.equal(manifest.files[0].objectKey,
    `openings/jobs/${jobId}/${contentHash}/${requestDigest}/opengraph-image.png`);
  assert.equal(manifest.files[0].url,
    `https://media.openings.dev/openings/jobs/${jobId}/${contentHash}/${requestDigest}/opengraph-image.png`);
  assert.equal(manifest.files[0].uploadState, 'pending');
  assert.deepEqual(manifest.files[0].consumers, [
    { channel: 'twitter', state: 'pending', remoteId: null, updatedAt: null },
    { channel: 'linkedin', state: 'pending', remoteId: null, updatedAt: null },
  ]);
  assert.deepEqual(validateOpeningsR2Manifest(manifest, queueItem), manifest);
});

test('rejects mutable paths, tampering, duplicate consumers, secrets, and unknown state', () => {
  const valid = buildOpeningsR2Manifest({
    mediaOwner,
    publicOrigin: 'https://media.openings.dev',
    consumersByRole: { opengraph: ['twitter'], 'instagram-feed': ['instagram'] },
  });
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.publicOrigin = 'http://media.openings.dev'; },
    (value) => { value.files[0].objectKey = '../shared.png'; },
    (value) => { value.files[0].url += '?v=1'; },
    (value) => { value.files[0].sha256 = 'f'.repeat(64); },
    (value) => { value.files[0].uploadState = 'unknown'; },
    (value) => { value.files[0].consumers.push(value.files[0].consumers[0]); },
    (value) => { value.files[0].consumers[0].accessToken = 'secret'; },
  ]) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => validateOpeningsR2Manifest(changed, queueItem), /R2 manifest/u);
  }
});

test('validates historical manifests against their own immutable identity', () => {
  const manifest = buildOpeningsR2Manifest({
    mediaOwner,
    publicOrigin: 'https://media.openings.dev',
    consumersByRole: { opengraph: ['twitter'], 'instagram-feed': ['instagram'] },
  });
  assert.deepEqual(validateOpeningsR2Manifest(manifest, manifest), manifest);
  assert.throws(() => validateOpeningsR2Manifest(manifest, {
    ...queueItem, contentHash: 'f'.repeat(64),
  }), /R2 manifest/u);
});
