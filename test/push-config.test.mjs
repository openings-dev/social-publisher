import assert from 'node:assert/strict';
import test from 'node:test';

import { readPushConfig } from '../src/modules/push/push-config.mjs';

const base = {
  ONESIGNAL_APP_ID: 'app-id',
  ONESIGNAL_API_KEY: 'api-key',
  PUSH_AUDIENCE_VERSION: 'android-consent-v1',
  ONESIGNAL_AUDIENCE_JSON: JSON.stringify({ included_segments: ['reviewed-android-new-job-consent'] }),
  ONESIGNAL_FREE_ATTESTATION_JSON: JSON.stringify({ checkedAt: '2026-09-16T12:00:00.000Z', mobileMau: 100, plan: 'free', scope: 'organization', overLimitBehavior: 'pause' }),
};

test('requires a fresh account-wide Free attestation below the conservative threshold', () => {
  const config = readPushConfig(base, { now: '2026-09-16T13:00:00.000Z' });
  assert.equal(config.attestation.mobileMau, 100);
  assert.throws(() => readPushConfig({ ...base, ONESIGNAL_FREE_ATTESTATION_JSON: JSON.stringify({ checkedAt: '2026-09-01T12:00:00.000Z', mobileMau: 100, plan: 'free', scope: 'organization', overLimitBehavior: 'pause' }) }, { now: '2026-09-16T13:00:00.000Z' }), /stale/u);
  assert.throws(() => readPushConfig({ ...base, ONESIGNAL_FREE_ATTESTATION_JSON: JSON.stringify({ checkedAt: '2026-09-16T12:00:00.000Z', mobileMau: 900, plan: 'free', scope: 'organization', overLimitBehavior: 'pause' }) }, { now: '2026-09-16T13:00:00.000Z' }), /threshold/u);
});

test('uses only explicit owner-controlled canary subscription IDs', () => {
  const config = readPushConfig({ ...base, PUSH_TEST_SUBSCRIPTION_IDS: '123e4567-e89b-42d3-a456-426614174000' }, { now: '2026-09-16T13:00:00.000Z' });
  assert.deepEqual(config.audience, { include_subscription_ids: ['123e4567-e89b-42d3-a456-426614174000'] });
  assert.throws(() => readPushConfig({ ...base, PUSH_TEST_SUBSCRIPTION_IDS: 'not-an-id' }, { now: '2026-09-16T13:00:00.000Z' }), /subscription ID/u);
});

test('rejects missing credentials and audience field injection', () => {
  assert.throws(() => readPushConfig({ ...base, ONESIGNAL_API_KEY: '' }, { now: '2026-09-16T13:00:00.000Z' }), /API key/u);
  assert.throws(() => readPushConfig({ ...base, ONESIGNAL_AUDIENCE_JSON: JSON.stringify({ included_segments: ['segment'], app_id: 'attacker' }) }, { now: '2026-09-16T13:00:00.000Z' }), /audience/u);
});
