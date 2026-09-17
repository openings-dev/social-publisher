import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  configureOneSignalFcm,
  OPENINGS_ONESIGNAL_APP_ID,
  validateFirebaseServiceAccount,
} from '../src/modules/push/onesignal-fcm-configurator.mjs';

const { privateKey: rsaPrivateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const { privateKey: ecPrivateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const credential = {
  type: 'service_account',
  project_id: 'openingshq',
  private_key_id: 'key-id',
  private_key: rsaPrivateKey,
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
  for (const privateKey of [
    undefined,
    '',
    'secret',
    '-----BEGIN PRIVATE KEY-----\nsynthetic-body\n-----END PRIVATE KEY-----\n',
    '-----BEGIN PRIVATE KEY-----\nsecret\n',
    ecPrivateKey,
  ]) {
    const candidate = { ...credential };
    if (privateKey === undefined) delete candidate.private_key;
    else candidate.private_key = privateKey;
    assert.throws(
      () => validateFirebaseServiceAccount(JSON.stringify(candidate)),
      (error) => error instanceof Error
        && error.message === 'Firebase service account private key is invalid'
        && (typeof privateKey !== 'string' || privateKey === '' || !error.message.includes(privateKey)),
    );
  }
});

test('configures and reads back FCM v1 through the OneSignal app endpoint', async () => {
  const endpoint = `https://api.onesignal.com/apps/${OPENINGS_ONESIGNAL_APP_ID}`;
  const requests = [];
  const responses = [
    new Response('{}', { status: 200 }),
    new Response(JSON.stringify({
      id: OPENINGS_ONESIGNAL_APP_ID,
      fcm_v1_service_account_json: 'configured-marker',
    }), { status: 200 }),
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return responses.shift();
  };

  const result = await configureOneSignalFcm({
    appId: OPENINGS_ONESIGNAL_APP_ID,
    organizationApiKey: 'organization-secret',
    serviceAccountJson: JSON.stringify(credential),
  }, { fetchImpl });

  assert.deepEqual(result, {
    appId: OPENINGS_ONESIGNAL_APP_ID,
    fcmV1Configured: true,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, endpoint);
  assert.equal(requests[0].options.method, 'PUT');
  assert.deepEqual(requests[0].options.headers, {
    accept: 'application/json',
    authorization: 'Key organization-secret',
    'content-type': 'application/json',
  });
  assert.equal(requests[0].options.signal instanceof AbortSignal, true);
  assert.equal(requests[0].options.redirect, 'error');
  const updatePayload = JSON.parse(requests[0].options.body);
  assert.deepEqual(Object.keys(updatePayload), ['fcm_v1_service_account_json']);
  assert.deepEqual(
    JSON.parse(Buffer.from(updatePayload.fcm_v1_service_account_json, 'base64').toString('utf8')),
    credential,
  );
  assert.equal(requests[1].url, endpoint);
  assert.equal(requests[1].options.method, 'GET');
  assert.deepEqual(requests[1].options.headers, {
    accept: 'application/json',
    authorization: 'Key organization-secret',
  });
  assert.equal(requests[1].options.signal instanceof AbortSignal, true);
  assert.equal(requests[1].options.redirect, 'error');
});

test('rejects invalid FCM configuration inputs before making a request', async () => {
  for (const input of [
    { appId: 'another-app', organizationApiKey: 'organization-secret', serviceAccountJson: JSON.stringify(credential) },
    { appId: OPENINGS_ONESIGNAL_APP_ID, organizationApiKey: '  ', serviceAccountJson: JSON.stringify(credential) },
    { appId: OPENINGS_ONESIGNAL_APP_ID, organizationApiKey: 'organization-secret', serviceAccountJson: '' },
  ]) {
    let fetches = 0;
    await assert.rejects(
      configureOneSignalFcm(input, { fetchImpl: async () => { fetches += 1; } }),
      /invalid|required/u,
    );
    assert.equal(fetches, 0);
  }
});

test('does not expose provider details when the OneSignal FCM update fails', async () => {
  const providerDetail = 'private provider detail';
  let requests = 0;
  await assert.rejects(
    configureOneSignalFcm({
      appId: OPENINGS_ONESIGNAL_APP_ID,
      organizationApiKey: 'organization-secret',
      serviceAccountJson: JSON.stringify(credential),
    }, { fetchImpl: async () => {
      requests += 1;
      return new Response(providerDetail, { status: 403 });
    } }),
    (error) => error instanceof Error
      && error.message === 'OneSignal FCM update failed with status 403'
      && !error.message.includes(providerDetail)
      && !error.message.includes('organization-secret'),
  );
  assert.equal(requests, 1);
});

test('rejects a read-back response that does not confirm FCM v1', async () => {
  const responses = [
    new Response('{}', { status: 200 }),
    new Response(JSON.stringify({ id: OPENINGS_ONESIGNAL_APP_ID }), { status: 200 }),
  ];
  await assert.rejects(
    configureOneSignalFcm({
      appId: OPENINGS_ONESIGNAL_APP_ID,
      organizationApiKey: 'organization-secret',
      serviceAccountJson: JSON.stringify(credential),
    }, { fetchImpl: async () => responses.shift() }),
    { message: 'OneSignal FCM read-back did not confirm FCM v1' },
  );
});

test('rejects a multiline organization API key before making a request', async () => {
  const secret = 'organization-secret\ninjected';
  let requests = 0;
  await assert.rejects(
    configureOneSignalFcm({
      appId: OPENINGS_ONESIGNAL_APP_ID,
      organizationApiKey: secret,
      serviceAccountJson: JSON.stringify(credential),
    }, { fetchImpl: async () => { requests += 1; } }),
    (error) => error instanceof Error
      && error.message === 'OneSignal Organization API key is invalid'
      && !error.message.includes(secret),
  );
  assert.equal(requests, 0);
});

test('sanitizes a rejected OneSignal FCM update request', async () => {
  const secret = 'put-transport-secret';
  await assert.rejects(
    configureOneSignalFcm({
      appId: OPENINGS_ONESIGNAL_APP_ID,
      organizationApiKey: 'organization-secret',
      serviceAccountJson: JSON.stringify(credential),
    }, { fetchImpl: async () => { throw new Error(secret); } }),
    (error) => error instanceof Error
      && error.message === 'OneSignal FCM update transport failed'
      && !error.message.includes(secret),
  );
});

test('sanitizes a rejected OneSignal FCM read-back request', async () => {
  const secret = 'get-transport-secret';
  const responses = [
    new Response('{}', { status: 200 }),
    Promise.reject(new Error(secret)),
  ];
  await assert.rejects(
    configureOneSignalFcm({
      appId: OPENINGS_ONESIGNAL_APP_ID,
      organizationApiKey: 'organization-secret',
      serviceAccountJson: JSON.stringify(credential),
    }, { fetchImpl: async () => await responses.shift() }),
    (error) => error instanceof Error
      && error.message === 'OneSignal FCM read-back transport failed'
      && !error.message.includes(secret),
  );
});

test('sanitizes an invalid OneSignal FCM read-back response body', async () => {
  const sensitiveBody = 'private response detail';
  const responses = [
    new Response('{}', { status: 200 }),
    new Response(sensitiveBody, { status: 200 }),
  ];
  await assert.rejects(
    configureOneSignalFcm({
      appId: OPENINGS_ONESIGNAL_APP_ID,
      organizationApiKey: 'organization-secret',
      serviceAccountJson: JSON.stringify(credential),
    }, { fetchImpl: async () => responses.shift() }),
    (error) => error instanceof Error
      && error.message === 'OneSignal FCM read-back response is invalid'
      && !error.message.includes(sensitiveBody),
  );
});

test('sanitizes a non-successful OneSignal FCM read-back response', async () => {
  const providerDetail = 'private read-back detail';
  const responses = [
    new Response('{}', { status: 200 }),
    new Response(providerDetail, { status: 502 }),
  ];
  await assert.rejects(
    configureOneSignalFcm({
      appId: OPENINGS_ONESIGNAL_APP_ID,
      organizationApiKey: 'organization-secret',
      serviceAccountJson: JSON.stringify(credential),
    }, { fetchImpl: async () => responses.shift() }),
    (error) => error instanceof Error
      && error.message === 'OneSignal FCM read-back failed with status 502'
      && !error.message.includes(providerDetail)
      && !error.message.includes('organization-secret'),
  );
});

test('rejects read-back responses that do not identify the configured FCM v1 app', async () => {
  for (const app of [
    { id: 'another-app', fcm_v1_service_account_json: 'configured-marker' },
    { id: OPENINGS_ONESIGNAL_APP_ID },
    { id: OPENINGS_ONESIGNAL_APP_ID, fcm_v1_service_account_json: '' },
    { id: OPENINGS_ONESIGNAL_APP_ID, fcm_v1_service_account_json: 42 },
  ]) {
    const responses = [
      new Response('{}', { status: 200 }),
      new Response(JSON.stringify(app), { status: 200 }),
    ];
    await assert.rejects(
      configureOneSignalFcm({
        appId: OPENINGS_ONESIGNAL_APP_ID,
        organizationApiKey: 'organization-secret',
        serviceAccountJson: JSON.stringify(credential),
      }, { fetchImpl: async () => responses.shift() }),
      { message: 'OneSignal FCM read-back did not confirm FCM v1' },
    );
  }
});
