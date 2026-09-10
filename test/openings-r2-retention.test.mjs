import assert from 'node:assert/strict';
import test from 'node:test';

import { planOpeningsR2Cleanup } from '../src/modules/publishing/openings-r2-retention.mjs';

const base = {
  objectKey: 'openings/jobs/job/revision/request/image.png', byteSize: 100,
  uploadState: 'verified', consumers: [
    { channel: 'twitter', state: 'completed', remoteId: 'buffer-1', updatedAt: '2026-09-10T00:00:00.000Z' },
    { channel: 'linkedin', state: 'completed', remoteId: 'buffer-2', updatedAt: '2026-09-10T00:00:00.000Z' },
  ],
};

test('deletes only bounded files whose every consumer completed or was skipped', () => {
  const plan = planOpeningsR2Cleanup({ files: [base, { ...base, objectKey: `${base.objectKey}-2`,
    consumers: [{ channel: 'instagram', state: 'skipped', remoteId: null, updatedAt: '2026-09-10T00:00:00.000Z' }] }] },
  { maxObjects: 1, maxBytes: 100 });
  assert.deepEqual(plan, { objectKeys: [base.objectKey], totalBytes: 100, truncated: true });
});

test('retains accepted, scheduled, ambiguous, pending, unknown, and shared references', () => {
  for (const state of ['accepted', 'ambiguous', 'pending']) {
    const candidate = structuredClone(base);
    candidate.consumers[0].state = state;
    assert.deepEqual(planOpeningsR2Cleanup({ files: [candidate] }, { maxObjects: 10, maxBytes: 1_000 }),
      { objectKeys: [], totalBytes: 0, truncated: false });
  }
  const unknown = structuredClone(base); unknown.consumers[0].state = 'unknown';
  assert.throws(() => planOpeningsR2Cleanup({ files: [unknown] }, { maxObjects: 10, maxBytes: 1_000 }), /retention/u);
});
