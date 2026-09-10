import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpeningsR2BridgePublisher } from '../src/modules/publishing/openings-r2-publisher.mjs';
import { updateOpeningsR2FileState } from '../src/modules/publishing/openings-r2-manifest.mjs';

const job = { id: `gh_${'a'.repeat(24)}`, sourceId: 'openings/jobs#1', contentHash: 'b'.repeat(64) };
const queueItem = { jobId: job.id, sourceId: job.sourceId, contentHash: job.contentHash };

test('checkpoints pending, uploaded, and publicly verified media before returning provider URLs', async () => {
  const events = [];
  const descriptors = [
    { role: 'opengraph', logicalArtifactId: 'opengraph', sha256: 'c'.repeat(64), byteSize: 100,
      mediaType: 'image/png', width: 1200, height: 630, renderVersion: '2' },
    { role: 'instagram-feed', logicalArtifactId: 'instagram-feed', sha256: 'd'.repeat(64), byteSize: 200,
      mediaType: 'image/jpeg', width: 1080, height: 1350, renderVersion: '7' },
  ];
  const publish = createOpeningsR2BridgePublisher({
    publicOrigin: 'https://media.openings.dev', outputRoot: '/tmp/output', wordmarkSvg: '<svg/>',
    enabledChannels: ['twitter', 'instagram'], linkedinProvider: 'direct', storyEnabled: false,
    r2Config: {}, capacity: {},
    dependencies: {
      renderBridgeArtifacts: async () => ({ imagePath: '/tmp/og.png', instagramJpegPath: '/tmp/feed.jpg' }),
      describeMediaFile: async ({ role }) => descriptors.find((item) => item.role === role),
      ensureObjects: async ({ manifest, checkpoint }) => {
        events.push('upload');
        let uploaded = manifest;
        for (const file of manifest.files) uploaded = updateOpeningsR2FileState(uploaded, file.role, 'uploaded');
        await checkpoint(uploaded);
        return uploaded;
      },
      verifyFile: async (file) => ({ ...file, uploadState: 'verified' }),
    },
  });
  const checkpoints = [];
  const result = await publish({ job, queueItem, direction: 'night',
    checkpointMedia: async (manifest) => { checkpoints.push(structuredClone(manifest)); events.push(manifest.files[0].uploadState); } });
  assert.deepEqual(events, ['pending', 'upload', 'uploaded', 'verified']);
  assert.equal(checkpoints.at(-1).files.every((file) => file.uploadState === 'verified'), true);
  assert.equal(result.status, 'hosted');
  assert.equal(result.imageUrl, checkpoints.at(-1).files[0].url);
  assert.equal(result.instagramImageUrl, checkpoints.at(-1).files[1].url);
  assert.deepEqual(result.r2Media, checkpoints.at(-1));
});
