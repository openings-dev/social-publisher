import assert from 'node:assert/strict';
import test from 'node:test';
import { INSTAGRAM_CARD_VERSION } from '../src/config/constants.mjs';
import { processOnePublication } from '../src/modules/publishing/orchestrator.mjs';
import { PREVIEW_SAMPLES } from '../src/modules/preview/sample-jobs.mjs';
import { enqueueJob, transitionQueueStage } from '../src/modules/state/queue-operations.mjs';

const now = '2026-09-08T12:00:00.000Z';
const job = PREVIEW_SAMPLES[0].job;
const canonicalUrl = `https://openings.dev/jobs/${job.id}`;
const snapshot = { commit: 'a'.repeat(40), dataHash: 'b'.repeat(64), generatedAt: now,
  jobsById: new Map([[job.id, job]]) };
const pngHash = '1'.repeat(64), instagramSvgHash = '2'.repeat(64);
const video = { socialVideoVersion: '4',
  socialVideoUrl: `${canonicalUrl}/social-video.mp4?v=4.${instagramSvgHash.slice(0, 16)}`,
  socialVideoCoverUrl: `${canonicalUrl}/social-video-cover.jpg?v=4.${instagramSvgHash.slice(0, 16)}` };
const image = { visualDirection: 'night', pngHash, instagramSvgHash,
  instagramCardVersion: INSTAGRAM_CARD_VERSION, instagramFeedMediaKind: 'image',
  instagramJpegHash: '3'.repeat(64), instagramImageUrl: `${canonicalUrl}/instagram-image.jpg?v=7.image` };

function published(queue, stage, result) {
  return transitionQueueStage(transitionQueueStage(queue, job.id, stage, 'publishing', { at: now }),
    job.id, stage, 'published', { at: now, result });
}
function setup(bridge = image, channels = ['instagram']) {
  let queue = enqueueJob({ schemaVersion: 3, items: [] }, {
    job, snapshot, discoveredAt: now, enabledChannels: channels, instagramStoryEnabled: true,
  });
  queue = published(queue, 'bridge', bridge);
  queue.items[0].visualDirection = 'night';
  return queue;
}
function run(queueState, overrides = {}) {
  const forbidden = async () => assert.fail('unexpected provider');
  return processOnePublication({ queueState, currentSnapshot: snapshot,
    publicationsState: { schemaVersion: 3, jobs: {} }, now,
    publishBridge: forbidden, publishBluesky: forbidden, publishMastodon: forbidden,
    publishInstagram: async () => ({ id: 'image-feed', url: 'https://instagram.com/p/image-feed' }),
    ...overrides });
}
function legacy(extra = {}) { return { ...image, instagramFeedMediaKind: 'reel', ...video, ...extra }; }
function assertNoVideo(bridge) {
  for (const key of [...Object.keys(video), 'storyMediaCandidate']) assert.equal(Object.hasOwn(bridge, key), false, key);
}

for (const oldVideo of [undefined, '1']) {
  test(`current image feed publishes without a bridge refresh when video version is ${oldVideo}`, async () => {
    const queue = setup({ ...image, ...(oldVideo ? { socialVideoVersion: oldVideo } : {}) });
    let calls = 0;
    const result = await run(queue, { publishInstagram: async () => { calls++; return { id: 'image' }; } });
    assert.equal(result.outcome, 'completed');
    assert.equal(calls, 1);
    assert.equal(result.queueState.items[0].bridge.attempts, 1);
  });
}
for (const [label, patch] of Object.entries({ kind: { instagramFeedMediaKind: 'reel' },
  card: { instagramCardVersion: 'old' }, hash: { instagramJpegHash: 'A'.repeat(64) },
  missingHash: { instagramJpegHash: undefined }, url: { instagramImageUrl: 'https://openings.dev/image.mp4' },
  insecureUrl: { instagramImageUrl: 'http://openings.dev/image.jpg' } })) {
  test(`pending feed refreshes a bridge with invalid ${label}`, async () => {
    let calls = 0;
    const result = await run(setup({ ...image, socialVideoVersion: '8', ...patch }), { publishBridge: async () => { calls++; return image; } });
    assert.equal(result.outcome, 'completed');
    assert.equal(calls, 1);
  });
}
test('published legacy Instagram keeps its full receipt and video while another channel completes', async () => {
  const queue = published(setup(legacy(), ['instagram', 'bluesky']), 'instagram', { id: 'legacy-reel', url: 'https://instagram.com/reel/legacy' });
  const receipt = structuredClone(queue.items[0].instagram);
  const result = await run(queue, { publishInstagram: async () => assert.fail('must not repost'),
    publishBluesky: async () => ({ id: 'bluesky' }) });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.queueState.items[0].instagram, receipt);
  for (const key of Object.keys(video)) assert.equal(result.queueState.items[0].bridge.result[key], video[key]);
});

test('same-source image refresh retains only verified legacy video fields despite snapshot drift', async () => {
  const queue = setup(legacy({ retiredReceipt: 'do-not-merge' }));
  const result = await run(queue, { currentSnapshot: { ...snapshot, commit: 'c'.repeat(40), dataHash: 'd'.repeat(64) },
    publishBridge: async () => image });
  assert.equal(result.outcome, 'completed');
  const bridge = result.queueState.items[0].bridge.result;
  for (const key of Object.keys(video)) assert.equal(bridge[key], video[key]);
  assert.equal(Object.hasOwn(bridge, 'retiredReceipt'), false);
  assert.equal(Object.hasOwn(bridge, 'storyMediaCandidate'), false);
});
test('failed refresh persists a bounded candidate through JSON restart and then restores exact video', async () => {
  const checkpoints = [];
  const failed = await run(setup(legacy({ unrelated: { mustDisappear: true } })), {
    publishBridge: async () => { throw Error('refresh failed'); },
    checkpoint: async event => checkpoints.push(JSON.parse(JSON.stringify(event.queueState))),
  });
  assert.equal(failed.outcome, 'bridge_retryable');
  const candidate = failed.queueState.items[0].bridge.result?.storyMediaCandidate;
  assert.deepEqual(candidate, { contentHash: job.contentHash, socialTitle: null, visualDirection: 'night', pngHash, instagramSvgHash, ...video });
  assert.deepEqual(checkpoints[0].items[0].bridge.result.storyMediaCandidate, candidate);
  assert.equal(failed.queueState.items[0].bridge.result.socialVideoUrl, undefined);
  const result = await run(JSON.parse(JSON.stringify(failed.queueState)), { publishBridge: async () => image });
  for (const key of Object.keys(video)) assert.equal(result.queueState.items[0].bridge.result[key], video[key]);
  assert.equal(Object.hasOwn(result.queueState.items[0].bridge.result, 'storyMediaCandidate'), false);
});

for (const reason of ['source', 'title', 'direction', 'png', 'svg', 'missingPng', 'missingSvg', 'wrongJob', 'wrongVersion', 'wrongFingerprint']) {
  test(`refresh discards legacy Story candidate on ${reason} mismatch, also after failure and restart`, async () => {
    const old = legacy();
    const output = { ...image };
    const overrides = {};
    if (reason === 'source') overrides.currentSnapshot = { ...snapshot, jobsById: new Map([[job.id, { ...job, contentHash: 'e'.repeat(64) }]]) };
    if (reason === 'title') overrides.preparePublicationJob = value => ({ ...value, socialTitle: 'New approved title' });
    if (reason === 'direction') old.visualDirection = 'peach';
    if (reason === 'png') output.pngHash = '4'.repeat(64);
    if (reason === 'svg') output.instagramSvgHash = '5'.repeat(64);
    if (reason === 'missingPng') delete old.pngHash;
    if (reason === 'missingSvg') delete old.instagramSvgHash;
    if (reason === 'wrongJob') old.socialVideoUrl = old.socialVideoUrl.replace(job.id, 'gh_' + 'f'.repeat(24));
    if (reason === 'wrongVersion') old.socialVideoVersion = '3';
    if (reason === 'wrongFingerprint') old.socialVideoCoverUrl = old.socialVideoCoverUrl.replace('2'.repeat(16), 'f'.repeat(16));
    const failed = await run(setup(old), { ...overrides, publishBridge: async () => { throw Error('refresh failed'); } });
    assert.equal(failed.outcome, 'bridge_retryable');
    const result = await run(JSON.parse(JSON.stringify(failed.queueState)), { ...overrides, publishBridge: async () => output });
    assert.equal(result.outcome, 'completed');
    assertNoVideo(result.queueState.items[0].bridge.result);
  });
}
test('candidate compares direction to the actual artwork reservation, including absent legacy direction', async () => {
  for (const direction of [undefined, 'night', 'peach']) {
    const old = legacy();
    if (direction === undefined) delete old.visualDirection;
    else old.visualDirection = direction;
    const queue = setup(old);
    delete queue.items[0].visualDirection;
    const result = await run(queue, { publishBridge: async ({ direction: actual }) => { assert.equal(actual, 'night'); return image; } });
    if (direction === 'peach') assertNoVideo(result.queueState.items[0].bridge.result);
    else for (const key of Object.keys(video)) assert.equal(result.queueState.items[0].bridge.result[key], video[key]);
  }
});
