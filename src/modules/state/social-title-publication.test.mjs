import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueJob, selectNextQueueItem, resetFailedStage } from './queue-operations.mjs';
import { processOnePublication } from '../publishing/orchestrator.mjs';
import { prepareSocialJob } from '../render/social-title.mjs';
import { PREVIEW_SAMPLES } from '../preview/sample-jobs.mjs';

const now = '2026-09-07T12:00:00.000Z';
function setup(title) {
  const job = { ...PREVIEW_SAMPLES[0].job, title };
  const snapshot = { commit: 'a'.repeat(40), dataHash: 'b'.repeat(64), generatedAt: now, jobsById: new Map([[job.id, job]]) };
  const queueState = enqueueJob({ schemaVersion: 3, items: [] }, { job, snapshot, discoveredAt: now, enabledChannels: ['bluesky'] });
  return { job, queueState, currentSnapshot: snapshot, publicationsState: { schemaVersion: 3, jobs: {} }, now,
    preparePublicationJob: prepareSocialJob, publishMastodon: async () => { throw Error('disabled'); } };
}

test('new social publication uses English consistently and refreshes provisional artwork', async () => {
  const input = setup('バックエンドエンジニア募集');
  input.queueState.items[0].bridge = { ...input.queueState.items[0].bridge, status: 'published', attempts: 1, result: { visualDirection: 'night' } };
  input.queueState.items[0].visualDirection = 'night';
  const calls = [];
  const result = await processOnePublication({ ...input,
    publishBridge: async ({ job }) => { calls.push('bridge'); assert.equal(job.title, input.job.title); assert.equal(job.socialTitle, 'Backend Engineer'); return {}; },
    publishBluesky: async ({ job, post }) => { calls.push('social'); assert.equal(job.socialTitle, post.title); return {}; },
  });
  assert.deepEqual(calls, ['bridge', 'social']);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.queueState.items[0].bridge.result.socialTitle, 'Backend Engineer');
  assert.equal(input.job.socialTitle, undefined);
});

test('uncertain titles are retained for review without network calls or blocking subsequent selection', async () => {
  const input = setup('未知の役職');
  const forbidden = async () => { assert.fail('Must not publish before title review'); };
  const result = await processOnePublication({ ...input, publishBridge: forbidden, publishBluesky: forbidden });
  assert.equal(result.outcome, 'title_review_required');
  assert.equal(result.queueState.items[0].bluesky.lastError.code, 'social_title_review_required');
  assert.equal(result.queueState.items[0].bluesky.attempts, 0);
  assert.equal(selectNextQueueItem(result.queueState, now), null);
  const nextJob = { ...input.job, id: 'gh_' + 'e'.repeat(24), title: 'Software Engineer' };
  const continued = enqueueJob(result.queueState, { job: nextJob, snapshot: input.currentSnapshot, discoveredAt: now, enabledChannels: ['bluesky'] });
  assert.equal(selectNextQueueItem(continued, now).jobId, nextJob.id);
  assert.deepEqual(result.publicationsState.jobs, {});
});

test('legacy partial publications do not switch titles or resend published channels', async () => {
  const input = setup('バックエンドエンジニア募集');
  input.queueState.items[0].bluesky = { ...input.queueState.items[0].bluesky, status: 'published', attempts: 1 };
  input.queueState.items[0].mastodon = { ...input.queueState.items[0].mastodon, status: 'pending' };
  let title;
  const result = await processOnePublication({ ...input, preparePublicationJob: () => { assert.fail('Legacy title must remain unchanged'); },
    publishBridge: async () => ({}), publishBluesky: async () => { assert.fail('No duplicate'); },
    publishMastodon: async ({ post }) => { title = post.title; return {}; },
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(title, input.job.title);
});

test('retry retains the deployed title even if the title resolver changes', async () => {
  const input = setup('バックエンドエンジニア募集');
  const first = await processOnePublication({ ...input, publishBridge: async () => ({}), publishBluesky: async () => { throw Error('temporary'); } });
  let used;
  const second = await processOnePublication({ ...input, queueState: first.queueState,
    now: '2026-09-08T12:00:00.000Z', preparePublicationJob: () => { throw Error('Must retain deployed title'); },
    publishBridge: async () => ({}), publishBluesky: async ({ post }) => { used = post.title; return {}; },
  });
  assert.equal(second.outcome, 'completed');
  assert.equal(used, 'Backend Engineer');
});

test('a failed bridge refresh cannot lose the title of an already-started publication', async () => {
  const input = setup('バックエンドエンジニア募集');
  const first = await processOnePublication({ ...input, publishBridge: async () => ({}), publishBluesky: async () => { throw Error('temporary'); } });
  const revised = { ...input.job, contentHash: 'c'.repeat(64) };
  const snapshot = { ...input.currentSnapshot, jobsById: new Map([[revised.id, revised]]) };
  const second = await processOnePublication({ ...input, queueState: first.queueState, currentSnapshot: snapshot,
    now: '2026-09-08T12:00:00.000Z', publishBridge: async () => { throw Error('temporary deployment'); }, publishBluesky: async () => ({}),
  });
  assert.equal(second.outcome, 'bridge_retryable');
  assert.equal(second.queueState.items[0].bridge.result?.socialTitle, 'Backend Engineer');
  second.queueState.items[0].bridge.status = 'failed';
  const reset = resetFailedStage(second.queueState, revised.id, 'bridge', { at: now, reason: 'manual_reset' });
  assert.equal(reset.items[0].bridge.result.socialTitle, 'Backend Engineer');
});
