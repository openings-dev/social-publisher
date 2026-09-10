import assert from 'node:assert/strict';
import test from 'node:test';

import { verifySourceCheckout } from '../src/cli/verify-source-checkout.mjs';

test('accepts only the dispatched immutable commit and manifest hash', () => {
  const expectedCommit = 'a'.repeat(40);
  const expectedDataHash = 'b'.repeat(64);
  assert.deepEqual(verifySourceCheckout({
    expectedCommit,
    expectedDataHash,
    actualCommit: expectedCommit,
    manifest: { dataHash: expectedDataHash },
  }), { sourceCommit: expectedCommit, dataHash: expectedDataHash });

  for (const change of [
    { actualCommit: 'c'.repeat(40) },
    { manifest: { dataHash: 'd'.repeat(64) } },
    { manifest: {} },
  ]) {
    assert.throws(() => verifySourceCheckout({
      expectedCommit,
      expectedDataHash,
      actualCommit: expectedCommit,
      manifest: { dataHash: expectedDataHash },
      ...change,
    }), /source event does not match checked-out snapshot/u);
  }
});
