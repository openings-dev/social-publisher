import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueJob, transitionQueueStage } from './queue-operations.mjs';
import { validateQueueState } from './state-model.mjs';
import { PREVIEW_SAMPLES } from '../preview/sample-jobs.mjs';
import * as queueOperations from './queue-operations.mjs';
import { processOnePublication } from '../publishing/orchestrator.mjs';

test('selected jobs alternate Night/Editorial independently of enqueue order and retain their assignment', () => {
  let queue = { schemaVersion: 3, items: [] };
  const snapshot = { commit: 'a'.repeat(40), dataHash: 'b'.repeat(64) };
  const at = '2026-09-05T12:00:00.000Z';
  const jobs = Array.from({ length: 8 }, (_, index) => ({ ...PREVIEW_SAMPLES[0].job, id: `gh_${index.toString(16).padStart(24, '0')}` }));
  for (const job of jobs) queue = enqueueJob(queue, { job, snapshot, discoveredAt: at });
  assert.equal(typeof queueOperations.reservePublicationArtwork, 'function');
  assert.ok(queue.items.every(item => !item.visualDirection));
  const order = [3, 7, 1, 4, 0, 6, 2, 5];
  const choices = [];
  for (const index of order) {
    queue = queueOperations.reservePublicationArtwork(queue, jobs[index].id);
    choices.push(queue.items[index].visualDirection);
  }
  assert.deepEqual(choices, ['night', 'editorial', 'night', 'lavender', 'night', 'peach', 'night', 'editorial']);
  const original = queue.items[1].visualDirection;
  queue = transitionQueueStage(queue, jobs[1].id, 'bridge', 'publishing', { at });
  queue = transitionQueueStage(queue, jobs[1].id, 'bridge', 'retryable', { at, errorCode: 'deployment' });
  queue = validateQueueState(JSON.parse(JSON.stringify(queue)));
  queue = queueOperations.reservePublicationArtwork(queue, jobs[1].id);
  assert.equal(queue.items[1].visualDirection, original);
  assert.equal(enqueueJob(queue, { job: jobs[1], snapshot, discoveredAt: at }).items.length, 8);
  assert.throws(() => validateQueueState({ ...queue, items: [{ ...queue.items[0], visualDirection: 'invalid' }] }), /direction/i);
});

test('legacy partial publications retain their visual identity without consuming the new cycle', () => {
  assert.equal(typeof queueOperations.reservePublicationArtwork, 'function');
  const job = PREVIEW_SAMPLES[0].job;
  let queue = enqueueJob({ schemaVersion: 3, items: [] }, { job, snapshot: { commit: 'a'.repeat(40), dataHash: 'b'.repeat(64) }, discoveredAt: '2026-09-05T12:00:00.000Z' });
  queue.items[0].bluesky = { ...queue.items[0].bluesky, status: 'published', attempts: 1 };
  queue.items[0].bridge.result = { visualDirection: 'peach' };
  queue = queueOperations.reservePublicationArtwork(queue, job.id);
  assert.equal(queue.items[0].visualDirection, 'peach');
  assert.equal(queue.items[0].visualSequence, undefined);
});

test('scheduler order drives colors and refreshes provisionally rendered bridge assets', async () => {
  const now = '2026-09-05T12:00:00.000Z';
  const jobs = Array.from({ length: 6 }, (_, index) => ({ ...PREVIEW_SAMPLES[0].job,
    id: `gh_${index.toString(16).padStart(24, '0')}`, createdAt: `2026-09-05T0${index}:00:00.000Z` }));
  const snapshot = { commit: 'a'.repeat(40), dataHash: 'b'.repeat(64), generatedAt: now, jobsById: new Map(jobs.map(job => [job.id, job])) };
  let queue = { schemaVersion: 3, items: [] }, publications = { schemaVersion: 3, jobs: {} };
  for (const job of jobs) {
    queue = enqueueJob(queue, { job, snapshot, discoveredAt: now, enabledChannels: ['bluesky'] });
    queue = transitionQueueStage(queue, job.id, 'bridge', 'publishing', { at: now });
    queue = transitionQueueStage(queue, job.id, 'bridge', 'published', { at: now, result: { visualDirection: 'peach' } });
  }
  const delivered = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const result = await processOnePublication({ queueState: queue, publicationsState: publications, currentSnapshot: snapshot, now,
      publishBridge: async ({ direction }) => ({ visualDirection: direction }),
      publishBluesky: async ({ job, queueItem }) => {
        assert.equal(queueItem.bridge.result.visualDirection, queueItem.visualDirection);
        delivered.push([job.id, queueItem.visualDirection]); return { status: 'published' };
      }, publishMastodon: async () => { throw new Error('Disabled provider'); },
    });
    assert.equal(result.outcome, 'completed');
    queue = JSON.parse(JSON.stringify(result.queueState)); publications = result.publicationsState;
  }
  assert.deepEqual(delivered.map(([id]) => id), [...jobs].reverse().map(job => job.id));
  assert.deepEqual(delivered.map(([, direction]) => direction), ['night', 'editorial', 'night', 'lavender', 'night', 'peach']);
});

test('a revised legacy partial publication preserves the old bridge color before invalidation', async () => {
  const now = '2026-09-05T12:00:00.000Z', job = PREVIEW_SAMPLES[0].job;
  const changed = { ...job, contentHash: 'c'.repeat(64), title: 'Updated role' };
  const snapshot = { commit: 'a'.repeat(40), dataHash: 'b'.repeat(64), generatedAt: now, jobsById: new Map([[job.id, changed]]) };
  let queue = enqueueJob({ schemaVersion: 3, items: [] }, { job, snapshot, discoveredAt: now, enabledChannels: ['bluesky', 'mastodon'] });
  queue.items[0].bluesky = { ...queue.items[0].bluesky, status: 'published', attempts: 1 };
  queue.items[0].bridge = { ...queue.items[0].bridge, status: 'published', attempts: 1, result: { visualDirection: 'peach' } };
  const result = await processOnePublication({ queueState: queue, publicationsState: { schemaVersion: 3, jobs: {} }, currentSnapshot: snapshot, now,
    publishBridge: async ({ direction }) => ({ visualDirection: direction }),
    publishBluesky: async () => { throw new Error('Already published'); },
    publishMastodon: async () => ({ status: 'published' }),
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.queueState.items[0].visualDirection, 'peach');
  assert.equal(result.queueState.items[0].bridge.result.visualDirection, 'peach');
  assert.equal(result.queueState.items[0].visualSequence, undefined);
});

test('legacy partial publications refresh old bridge artwork even with Instagram disabled', async () => {
  const now = '2026-09-05T12:00:00.000Z', job = PREVIEW_SAMPLES[0].job;
  const snapshot = { commit: 'a'.repeat(40), dataHash: 'b'.repeat(64), generatedAt: now, jobsById: new Map([[job.id, job]]) };
  const queue = enqueueJob({ schemaVersion: 3, items: [] }, { job, snapshot, discoveredAt: now, enabledChannels: ['bluesky', 'mastodon', 'twitter'] });
  queue.items[0].mastodon = { ...queue.items[0].mastodon, status: 'published', attempts: 1 };
  queue.items[0].bridge = { ...queue.items[0].bridge, status: 'published', attempts: 1, result: {
    instagramCardVersion: '4', socialVideoVersion: '4', imageUrl: 'https://example.test/legacy-v3.png',
  } };
  let bridgeCalls = 0;
  const delivered = [];
  const publishPending = async ({ queueItem }) => {
    delivered.push(queueItem.bridge.result);
    return { status: 'published' };
  };
  const result = await processOnePublication({ queueState: queue, publicationsState: { schemaVersion: 3, jobs: {} }, currentSnapshot: snapshot, now,
    publishBridge: async ({ direction }) => {
      bridgeCalls += 1;
      return { visualDirection: direction, instagramCardVersion: '5', socialVideoVersion: '5', imageUrl: 'https://example.test/approved-v4.png' };
    },
    publishBluesky: publishPending, publishTwitter: publishPending,
    publishMastodon: async () => { throw new Error('Already published'); },
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(bridgeCalls, 1, 'Pending channels must not reuse a legacy bridge');
  assert.equal(delivered.length, 2);
  for (const bridge of delivered) {
    assert.equal(bridge.visualDirection, result.queueState.items[0].visualDirection);
    assert.equal(bridge.imageUrl, 'https://example.test/approved-v4.png');
  }
  assert.equal(result.queueState.items[0].visualSequence, undefined);
  assert.equal(result.queueState.items[0].mastodon.status, 'published');
});
