import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPushResult,
  preparePushSubmission,
} from '../src/modules/push/push-orchestrator.mjs';
import { createPushState, ingestPushSnapshots } from '../src/modules/push/push-state.mjs';

const job = { id: 'gh_abcdefabcdefabcdefabcdef', sourceId: 'source#1', title: 'Platform Engineer', createdAt: '2026-09-16T12:00:00.000Z', contentHash: 'c'.repeat(64), issueState: 'open' };
const snapshot = (commit, jobs, generatedAt) => ({ commit, generatedAt, dataHash: commit[0].repeat(64), jobsById: new Map(jobs.map((item) => [item.id, item])) });

function queuedState({ dailyCap = 10, maxAgeHours = 24 } = {}) {
  const before = snapshot('a'.repeat(40), [], '2026-09-16T12:00:00.000Z');
  const after = snapshot('b'.repeat(40), [job], '2026-09-16T13:00:00.000Z');
  const state = createPushState(before, { activatedAt: '2026-09-16T12:00:00.000Z', audienceVersion: 'android-consent-v1', dailyCap, maxAgeHours });
  state.enabled = true;
  return { current: after, state: ingestPushSnapshots(state, [before, after], { uuid: () => '123e4567-e89b-42d3-a456-426614174000' }) };
}

test('prepares one request only after current availability and keeps the same key', () => {
  const { current, state } = queuedState();
  const first = preparePushSubmission(state, current, { now: '2026-09-16T13:05:00.000Z' });
  const resumed = preparePushSubmission(first.state, current, { now: '2026-09-16T13:06:00.000Z' });
  assert.equal(first.intent.status, 'submitting');
  assert.equal(resumed.intent.idempotencyKey, first.intent.idempotencyKey);
  assert.equal(resumed.state.intents.length, 1);
});

test('skips stale unsent alerts and defers at the daily cap', () => {
  const stale = queuedState({ maxAgeHours: 1 });
  const expired = preparePushSubmission(stale.state, stale.current, { now: '2026-09-16T15:01:00.000Z' });
  assert.equal(expired.intent, null);
  assert.equal(expired.state.intents[0].status, 'skipped_stale');

  const capped = queuedState({ dailyCap: 1 });
  capped.state.intents.push({ ...capped.state.intents[0], jobId: 'gh_111111111111111111111111', idempotencyKey: '123e4567-e89b-42d3-a456-426614174001', payload: { ...capped.state.intents[0].payload, data: { ...capped.state.intents[0].payload.data, jobId: 'gh_111111111111111111111111' } }, status: 'accepted', updatedAt: '2026-09-16T12:30:00.000Z', result: { notificationId: 'existing' } });
  const deferred = preparePushSubmission(capped.state, capped.current, { now: '2026-09-16T13:05:00.000Z' });
  assert.equal(deferred.intent, null);
  assert.equal(deferred.reason, 'daily_cap');
});

test('limits broadcasts to two per Sao Paulo day even when the stored cap is higher', () => {
  const { current, state } = queuedState({ dailyCap: 10 });
  const template = state.intents[0];
  state.intents.push(
    {
      ...template,
      jobId: 'gh_111111111111111111111111',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174001',
      payload: { ...template.payload, data: { ...template.payload.data, jobId: 'gh_111111111111111111111111' } },
      status: 'accepted',
      updatedAt: '2026-09-16T23:30:00.000Z',
      result: { notificationId: 'first' },
    },
    {
      ...template,
      jobId: 'gh_222222222222222222222222',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174002',
      payload: { ...template.payload, data: { ...template.payload.data, jobId: 'gh_222222222222222222222222' } },
      status: 'accepted',
      updatedAt: '2026-09-17T01:30:00.000Z',
      result: { notificationId: 'second' },
    },
  );

  const deferred = preparePushSubmission(state, current, { now: '2026-09-17T02:30:00.000Z' });

  assert.equal(deferred.intent, null);
  assert.equal(deferred.reason, 'daily_cap');
});

test('resets the daily limit at midnight in Sao Paulo', () => {
  const { current, state } = queuedState({ dailyCap: 2 });
  const template = state.intents[0];
  state.intents.push(
    {
      ...template,
      jobId: 'gh_111111111111111111111111',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174001',
      payload: { ...template.payload, data: { ...template.payload.data, jobId: 'gh_111111111111111111111111' } },
      status: 'accepted',
      updatedAt: '2026-09-17T01:30:00.000Z',
      result: { notificationId: 'first' },
    },
    {
      ...template,
      jobId: 'gh_222222222222222222222222',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174002',
      payload: { ...template.payload, data: { ...template.payload.data, jobId: 'gh_222222222222222222222222' } },
      status: 'accepted',
      updatedAt: '2026-09-17T02:30:00.000Z',
      result: { notificationId: 'second' },
    },
  );

  const prepared = preparePushSubmission(state, current, { now: '2026-09-17T03:30:00.000Z' });

  assert.equal(prepared.reason, 'ready');
  assert.equal(prepared.intent?.jobId, job.id);
});

test('persists provider outcomes without claiming delivery and pauses on auth failure', () => {
  const { current, state } = queuedState();
  const prepared = preparePushSubmission(state, current, { now: '2026-09-16T13:05:00.000Z' });
  const accepted = applyPushResult(prepared.state, prepared.intent.jobId, { status: 'accepted', notificationId: 'notification-id' }, { now: '2026-09-16T13:06:00.000Z' });
  assert.equal(accepted.intents[0].status, 'accepted');
  assert.deepEqual(accepted.intents[0].result, { notificationId: 'notification-id', providerStatus: 'accepted' });

  const failed = applyPushResult(prepared.state, prepared.intent.jobId, { status: 'failed', code: 'authentication' }, { now: '2026-09-16T13:06:00.000Z' });
  assert.deepEqual(failed.paused, { at: '2026-09-16T13:06:00.000Z', code: 'authentication' });
});

test('expired ambiguity requires reconciliation instead of another request', () => {
  const { current, state } = queuedState();
  const prepared = preparePushSubmission(state, current, { now: '2026-09-16T13:05:00.000Z' });
  const uncertain = applyPushResult(prepared.state, prepared.intent.jobId, { status: 'uncertain', code: 'transport' }, { now: '2026-09-16T13:06:00.000Z' });
  const expired = preparePushSubmission(uncertain, current, { now: '2026-10-17T13:07:00.000Z' });
  assert.equal(expired.intent, null);
  assert.equal(expired.state.intents[0].status, 'failed');
  assert.equal(expired.state.intents[0].result.code, 'reconciliation_required');
});
