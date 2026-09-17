import assert from 'node:assert/strict';
import test from 'node:test';

import { sendVersionAnnouncement } from '../src/cli/send-version-announcement.mjs';

const env = {
  ONESIGNAL_APP_ID: 'app-id',
  ONESIGNAL_API_KEY: 'api-key',
  ONESIGNAL_AUDIENCE_JSON: '{"included_segments":["Subscribed Users"]}',
  ONESIGNAL_FREE_ATTESTATION_JSON: '{"plan":"free","scope":"organization","overLimitBehavior":"pause","mobileMau":1,"checkedAt":"2026-09-17T20:20:00.000Z"}',
  PUSH_AUDIENCE_VERSION: 'android-consent-v1',
};

test('broadcasts the fixed version announcement to the configured audience', async () => {
  let request;
  const result = await sendVersionAnnouncement({
    confirmation: 'BROADCAST_VERSION_ANNOUNCEMENT',
    operationKey: 'job-push-123-1',
    env,
    now: '2026-09-17T23:00:00.000Z',
    send: async (intent, config) => { request = { intent, config }; return { status: 'accepted', notificationId: 'notification-id' }; },
    log: () => {},
  });
  assert.equal(result.outcome, 'accepted');
  assert.deepEqual(request.config.audience, { included_segments: ['Subscribed Users'] });
  assert.equal(request.intent.payload.headings.en, 'Nova versão do Openings');
  assert.match(request.intent.payload.contents.en, /Atualize agora/u);
  assert.match(request.intent.idempotencyKey, /^[0-9a-f-]{36}$/u);
});

test('rejects an announcement without the exact confirmation', async () => {
  await assert.rejects(() => sendVersionAnnouncement({ confirmation: 'wrong', operationKey: 'job-push-123-1', env }), /exact confirmation/u);
});
