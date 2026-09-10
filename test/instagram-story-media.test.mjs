import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runJobStoryPublication } from '../src/cli/publish-story.mjs';
import { buildOpeningsR2Manifest } from '../src/modules/publishing/openings-r2-manifest.mjs';
import { PREVIEW_SAMPLES } from '../src/modules/preview/sample-jobs.mjs';
import { enqueueJob, selectNextInstagramStory, transitionQueueStage } from '../src/modules/state/queue-operations.mjs';
import { saveStateFile } from '../src/modules/state/save-state.mjs';
import { validateQueueState, validatePublicationsState } from '../src/modules/state/state-model.mjs';

const now = '2026-09-08T12:00:00.000Z';
const job = PREVIEW_SAMPLES[0].job;
const snapshot = { commit: 'a'.repeat(40), dataHash: 'b'.repeat(64) };
const videoUrl = `https://openings.dev/jobs/${job.id}/social-video.mp4?v=4.exact`;
const env = { INSTAGRAM_STORY_AUTO_PUBLISH: 'true', INSTAGRAM_ACCESS_TOKEN: 'fixture', INSTAGRAM_USER_ID: '17841400000000000', META_GRAPH_VERSION: 'v26.0' };
function publish(queue, id, stage, result) {
  queue = transitionQueueStage(queue, id, stage, 'publishing', { at: now });
  return transitionQueueStage(queue, id, stage, 'published', { at: now, result });
}
function append(queue, currentJob, media = null) {
  queue = enqueueJob(queue, { job: currentJob, snapshot, discoveredAt: now, enabledChannels: ['instagram', 'linkedin'], instagramStoryEnabled: true });
  queue = publish(queue, currentJob.id, 'bridge', { instagramFeedMediaKind: 'image', instagramImageUrl: `https://openings.dev/jobs/${currentJob.id}/instagram-image.jpg`,
    ...(media ? { socialVideoUrl: media } : {}) });
  return publish(queue, currentJob.id, 'instagram', { id: `feed-${currentJob.id}`, url: 'https://instagram.com/p/feed' });
}
function fixture(media = null) { return append({ schemaVersion: 3, items: [] }, job, media); }
function withStoryManifest(queue) {
  queue.items[0].r2Media = buildOpeningsR2Manifest({
    mediaOwner: {
      jobId: job.id, sourceId: job.sourceId, contentHash: job.contentHash,
      requestDigest: 'd'.repeat(64), preparedAt: now,
      files: [{ role: 'social-video', fileName: 'social-video.mp4', logicalArtifactId: 'social-video',
        sha256: 'e'.repeat(64), byteSize: 100, mediaType: 'video/mp4', width: 1080, height: 1920,
        renderVersion: '8' }],
    },
    publicOrigin: 'https://media.openings.dev',
    consumersByRole: { 'social-video': ['instagramStory'] },
  });
  return queue;
}
async function stateFixture(t, queue, publications = { schemaVersion: 3, jobs: {} }) {
  const directory = await mkdtemp(join(tmpdir(), 'openings-story-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await saveStateFile(join(directory, 'queue.json'), queue, validateQueueState);
  await saveStateFile(join(directory, 'publications.json'), publications, validatePublicationsState);
  const bytes = () => Promise.all(['queue.json', 'publications.json'].map(file => readFile(join(directory, file), 'utf8')));
  return { bytes, run: overrides => runJobStoryPublication({ stateDirectory: directory, mode: 'intent', operationKey: 'operation', env, now, log: () => {}, ...overrides }) };
}

for (const mode of ['intent', 'publish']) {
  for (const status of ['pending', 'retryable', 'publishing']) {
    test(`${mode} ${status} Story without video is blocked_media with no credentials/providers/writes`, async t => {
      let queue = fixture();
      if (status !== 'pending') queue = transitionQueueStage(queue, job.id, 'instagramStory', 'publishing', { at: now, intent: { operationKey: 'operation' } });
      if (status === 'retryable') queue = transitionQueueStage(queue, job.id, 'instagramStory', 'retryable', { at: now, errorCode: 'provider' });
      const f = await stateFixture(t, queue);
      const before = await f.bytes();
      let calls = 0;
      const blockedEnv = new Proxy({ INSTAGRAM_STORY_AUTO_PUBLISH: 'true' }, { get(target, key) {
        assert.equal(key, 'INSTAGRAM_STORY_AUTO_PUBLISH', 'must not load credentials'); return target[key];
      } });
      const result = await f.run({ mode, env: blockedEnv, dependencies: { publishStory: async () => { calls++; } } });
      assert.equal(result.outcome, 'blocked_media');
      assert.equal(result.selectedJobId, job.id);
      assert.equal(calls, 0);
      assert.deepEqual(result.queueState, queue);
      assert.deepEqual(await f.bytes(), before);
    });
  }
}
test('blocked media defers unrelated queue and publication ledger reconciliation writes', async t => {
  let queue = fixture();
  const other = { ...job, id: 'gh_' + 'e'.repeat(24) };
  const third = { ...job, id: 'gh_' + 'f'.repeat(24) };
  queue = append(queue, other, videoUrl);
  queue = publish(queue, other.id, 'instagramStory', { id: 'already-published' });
  queue = append(queue, third, videoUrl);
  queue = transitionQueueStage(queue, third.id, 'instagramStory', 'publishing', { at: now, intent: { operationKey: 'earlier' } });
  const publications = { schemaVersion: 3, jobs: { [third.id]: { linkedin: null, twitter: null, instagramStory: { id: 'ledger-story' } } } };
  const f = await stateFixture(t, queue, publications);
  const before = await f.bytes();
  const result = await f.run({ jobId: job.id });
  assert.equal(result.outcome, 'blocked_media');
  assert.deepEqual(await f.bytes(), before);
  assert.deepEqual(result.queueState, queue);
  assert.deepEqual(result.publicationsState, publications);
});
for (const mode of ['intent', 'publish']) {
  test(`interrupted ${mode} with a different operation stays manual review even without media`, async t => {
    const queue = transitionQueueStage(fixture(), job.id, 'instagramStory', 'publishing', { at: now, intent: { operationKey: 'earlier' } });
    const f = await stateFixture(t, queue);
    const result = await f.run({ mode });
    assert.equal(result.outcome, 'failed_manual_review');
    assert.equal(result.queueState.items[0].instagramStory.lastError.code, 'instagram_story_interrupted');
  });
}
test('ready Story uses the exact existing video despite a failing channel and is never resubmitted', async t => {
  let queue = withStoryManifest(fixture(videoUrl));
  queue = transitionQueueStage(queue, job.id, 'linkedin', 'publishing', { at: now });
  queue = transitionQueueStage(queue, job.id, 'linkedin', 'retryable', { at: now, errorCode: 'buffer_media' });
  const f = await stateFixture(t, queue);
  assert.equal((await f.run()).outcome, 'prepared');
  const calls = [];
  const options = { mode: 'publish', dependencies: { publishStory: async input => { calls.push(input); return { id: 'story' }; } } };
  const result = await f.run(options);
  assert.equal(result.outcome, 'published');
  assert.deepEqual(calls, [{ mediaKind: 'video', mediaUrl: videoUrl }]);
  assert.equal(result.publicationsState.jobs[job.id].instagramStory.id, 'story');
  assert.deepEqual(result.queueState.items[0].r2Media.files[0].consumers[0], {
    channel: 'instagramStory', state: 'completed', remoteId: 'story', updatedAt: now,
  });
  assert.equal((await f.run(options)).outcome, 'idle');
  assert.equal(calls.length, 1);
});
test('an earlier missing-media Story cannot starve a later ready video and remains unchanged', async t => {
  const other = { ...job, id: 'gh_' + 'f'.repeat(24) };
  let queue = append(fixture(), other, videoUrl);
  queue.items[1].instagram.updatedAt = '2026-09-08T13:00:00.000Z';
  assert.equal(selectNextInstagramStory(queue).jobId, other.id);
  const f = await stateFixture(t, queue);
  assert.equal((await f.run({ jobId: job.id })).outcome, 'blocked_media');
  assert.equal((await f.run()).selectedJobId, other.id);
  const result = await f.run({ mode: 'publish', dependencies: { publishStory: async () => ({ id: 'later-story' }) } });
  assert.equal(result.outcome, 'published');
  assert.equal(result.selectedJobId, other.id);
  assert.deepEqual(result.queueState.items[0], queue.items[0]);
  assert.equal((await f.run()).outcome, 'blocked_media');
});
test('an interrupted Story without video reaches review before normal ready work', async t => {
  const other = { ...job, id: 'gh_' + 'f'.repeat(24) };
  let queue = append(fixture(), other, videoUrl);
  queue = transitionQueueStage(queue, job.id, 'instagramStory', 'publishing', { at: now, intent: { operationKey: 'earlier' } });
  const f = await stateFixture(t, queue);
  const result = await f.run();
  assert.equal(result.outcome, 'failed_manual_review');
  assert.equal(result.selectedJobId, job.id);
  assert.deepEqual(result.queueState.items[1], queue.items[1]);
});
