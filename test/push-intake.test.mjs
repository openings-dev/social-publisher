import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPushState,
  ingestPushSnapshots,
  validatePushState,
} from '../src/modules/push/push-state.mjs';

const reference = (commit, generatedAt, dataHash) => ({ commit, generatedAt, dataHash });
const job = (id, overrides = {}) => ({
  id,
  sourceId: `source#${id}`,
  title: `Role ${id}`,
  createdAt: '2026-09-16T12:00:00.000Z',
  contentHash: 'c'.repeat(64),
  issueState: 'open',
  ...overrides,
});
const snapshot = (commit, jobs, generatedAt = '2026-09-16T12:00:00.000Z') => ({
  ...reference(commit, generatedAt, commit[0].repeat(64)),
  jobsById: new Map(jobs.map((item) => [item.id, item])),
});

test('activation snapshots the boundary without historical backfill', () => {
  const current = snapshot('a'.repeat(40), [job('gh_1234567890abcdef12345678')]);
  const state = createPushState(current, {
    activatedAt: '2026-09-16T13:00:00.000Z',
    audienceVersion: 'android-consent-v1',
    dailyCap: 10,
    maxAgeHours: 24,
  });
  assert.equal(state.intents.length, 0);
  assert.deepEqual(state.activationBoundary, reference(current.commit, current.generatedAt, current.dataHash));
  assert.deepEqual(state.processedSnapshot, state.activationBoundary);
  validatePushState(state);
});

test('intake queues only genuinely new jobs and preserves the first intent', () => {
  const existing = job('gh_1234567890abcdef12345678');
  const added = job('gh_abcdefabcdefabcdefabcdef');
  const before = snapshot('a'.repeat(40), [existing]);
  const after = snapshot('b'.repeat(40), [
    { ...existing, title: 'Updated title', contentHash: 'd'.repeat(64) },
    added,
  ], '2026-09-16T13:30:00.000Z');
  const initial = createPushState(before, {
    activatedAt: '2026-09-16T13:00:00.000Z', audienceVersion: 'android-consent-v1', dailyCap: 10, maxAgeHours: 24,
  });
  const first = ingestPushSnapshots(initial, [before, after], { uuid: () => '123e4567-e89b-42d3-a456-426614174000' });
  const replay = ingestPushSnapshots(first, [after], { uuid: () => { throw new Error('must not mint'); } });

  assert.equal(first.intents.length, 1);
  assert.equal(first.intents[0].jobId, added.id);
  assert.equal(first.intents[0].status, 'pending');
  assert.equal(first.intents[0].idempotencyKey, '123e4567-e89b-42d3-a456-426614174000');
  assert.deepEqual(replay, first);
});

test('closure skips an unsent alert and never rewrites an accepted result', () => {
  const added = job('gh_abcdefabcdefabcdefabcdef');
  const before = snapshot('a'.repeat(40), []);
  const addedSnapshot = snapshot('b'.repeat(40), [added]);
  const removedSnapshot = snapshot('c'.repeat(40), [], '2026-09-16T14:00:00.000Z');
  const initial = createPushState(before, {
    activatedAt: '2026-09-16T13:00:00.000Z', audienceVersion: 'android-consent-v1', dailyCap: 10, maxAgeHours: 24,
  });
  const queued = ingestPushSnapshots(initial, [before, addedSnapshot], { uuid: () => '123e4567-e89b-42d3-a456-426614174000' });
  const closed = ingestPushSnapshots(queued, [addedSnapshot, removedSnapshot]);
  assert.equal(closed.intents[0].status, 'skipped_closed');
});
