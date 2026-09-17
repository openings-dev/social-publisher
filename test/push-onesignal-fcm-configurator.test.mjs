import assert from 'node:assert/strict';
import test from 'node:test';

import { validateFirebaseServiceAccount } from '../src/modules/push/onesignal-fcm-configurator.mjs';

const credential = {
  type: 'service_account',
  project_id: 'openingshq',
  private_key_id: 'key-id',
  private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n',
  client_email: 'onesignal-fcm-sender@openingshq.iam.gserviceaccount.com',
  client_id: '1234567890',
  token_uri: 'https://oauth2.googleapis.com/token',
};

test('accepts the dedicated Firebase service account', () => {
  assert.deepEqual(validateFirebaseServiceAccount(JSON.stringify(credential)), credential);
});

test('rejects malformed Firebase service account JSON without exposing its contents', () => {
  const secret = 'malformed-private-key-secret';
  assert.throws(
    () => validateFirebaseServiceAccount(`{"private_key":"${secret}`),
    (error) => error instanceof Error
      && error.message === 'Firebase service account must be valid JSON'
      && !error.message.includes(secret),
  );
});

test('rejects Firebase service accounts with an unexpected identity', () => {
  for (const [field, value] of [
    ['type', 'user_account'],
    ['project_id', 'other-project'],
    ['client_email', 'other@example.com'],
  ]) {
    assert.throws(
      () => validateFirebaseServiceAccount(JSON.stringify({ ...credential, [field]: value })),
      /Firebase service account identity is invalid/u,
    );
  }
});

test('rejects Firebase service accounts with an invalid private key', () => {
  for (const privateKey of [undefined, '', 'secret', '-----BEGIN PRIVATE KEY-----\nsecret\n']) {
    const candidate = { ...credential };
    if (privateKey === undefined) delete candidate.private_key;
    else candidate.private_key = privateKey;
    assert.throws(
      () => validateFirebaseServiceAccount(JSON.stringify(candidate)),
      /Firebase service account private key is invalid/u,
    );
  }
});
