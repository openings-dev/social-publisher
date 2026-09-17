import assert from 'node:assert/strict';
import test from 'node:test';

import { runOneSignalFcmBootstrap } from '../src/cli/configure-onesignal-fcm.mjs';

const env = {
  REQUEST_CONFIRMATION: 'CONFIGURE_OPENINGS_FCM_V1',
  ONESIGNAL_APP_ID: 'c49d82df-9d48-4283-b746-4afe280cda5e',
  ONESIGNAL_ORGANIZATION_API_KEY: 'organization-secret',
  ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON: '{"credential":true}',
};

test('bootstraps FCM with mapped environment values and a safe summary', async () => {
  const calls = [];
  const logs = [];
  const result = { appId: env.ONESIGNAL_APP_ID, fcmV1Configured: true };

  const actual = await runOneSignalFcmBootstrap({
    env,
    log: (message) => logs.push(message),
    configure: async (input) => {
      calls.push(input);
      return result;
    },
  });

  assert.equal(actual, result);
  assert.deepEqual(calls, [{
    appId: env.ONESIGNAL_APP_ID,
    organizationApiKey: env.ONESIGNAL_ORGANIZATION_API_KEY,
    serviceAccountJson: env.ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON,
  }]);
  assert.deepEqual(logs, [`OneSignal FCM v1 configured for ${env.ONESIGNAL_APP_ID}`]);
  assert.equal(logs.join('\n').includes(env.ONESIGNAL_ORGANIZATION_API_KEY), false);
  assert.equal(logs.join('\n').includes('credential'), false);
});

test('removes line wrapping copied with the organization API key', async () => {
  const calls = [];
  const key = env.ONESIGNAL_ORGANIZATION_API_KEY;

  await runOneSignalFcmBootstrap({
    env: {
      ...env,
      ONESIGNAL_ORGANIZATION_API_KEY: `${key.slice(0, 8)}\r\n${key.slice(8)}\n`,
    },
    log: () => {},
    configure: async (input) => {
      calls.push(input);
      return { appId: env.ONESIGNAL_APP_ID, fcmV1Configured: true };
    },
  });

  assert.equal(calls[0].organizationApiKey, key);
});

test('rejects a non-exact confirmation before calling the configurator', async () => {
  let calls = 0;

  await assert.rejects(
    () => runOneSignalFcmBootstrap({
      env: { ...env, REQUEST_CONFIRMATION: 'configure' },
      configure: async () => {
        calls += 1;
      },
    }),
    (error) => error instanceof Error
      && /exact confirmation phrase/u.test(error.message),
  );

  assert.equal(calls, 0);
});
