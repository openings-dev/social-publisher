import assert from 'node:assert/strict';
import test from 'node:test';

import { sendOneSignalPush } from '../src/modules/push/onesignal-client.mjs';

const intent = {
  idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  payload: {
    headings: { en: 'New job on Openings' },
    contents: { en: 'Platform Engineer' },
    data: { type: 'openings.job', version: 1, jobId: 'gh_abcdefabcdefabcdefabcdef' },
  },
};

test('returns accepted only when OneSignal returns a notification ID', async () => {
  const result = await sendOneSignalPush(intent, {
    appId: 'app-id', apiKey: 'secret', audience: { include_subscription_ids: ['subscription-id'] },
  }, { fetchImpl: async (_url, request) => {
    assert.equal(request.headers.authorization, 'Key secret');
    const body = JSON.parse(request.body);
    assert.equal(body.idempotency_key, intent.idempotencyKey);
    assert.equal(body.isAndroid, true);
    return new Response(JSON.stringify({ id: 'notification-id' }), { status: 200 });
  } });
  assert.deepEqual(result, { status: 'accepted', notificationId: 'notification-id' });
});

test('classifies a successful response without an ID as no recipients', async () => {
  const result = await sendOneSignalPush(intent, {
    appId: 'app-id', apiKey: 'secret', audience: { include_subscription_ids: ['subscription-id'] },
  }, { fetchImpl: async () => new Response('{}', { status: 200 }) });
  assert.deepEqual(result, { status: 'no_recipients' });
});

test('classifies rate limits, authentication, and ambiguous transport failures', async () => {
  const config = { appId: 'app-id', apiKey: 'secret', audience: { include_subscription_ids: ['subscription-id'] } };
  assert.deepEqual(await sendOneSignalPush(intent, config, {
    fetchImpl: async () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }),
  }), { status: 'retryable', code: 'rate_limited', retryAfterSeconds: 120 });
  assert.deepEqual(await sendOneSignalPush(intent, config, {
    fetchImpl: async () => new Response('{}', { status: 401 }),
  }), { status: 'failed', code: 'authentication' });
  assert.deepEqual(await sendOneSignalPush(intent, config, {
    fetchImpl: async () => { throw new TypeError('secret network detail'); },
  }), { status: 'uncertain', code: 'transport' });
});
