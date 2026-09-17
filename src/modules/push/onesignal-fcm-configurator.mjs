const EXPECTED_APP_ID = 'c49d82df-9d48-4283-b746-4afe280cda5e';
const EXPECTED_PROJECT_ID = 'openingshq';
const EXPECTED_CLIENT_EMAIL = 'onesignal-fcm-sender@openingshq.iam.gserviceaccount.com';

export const OPENINGS_ONESIGNAL_APP_ID = EXPECTED_APP_ID;

function requireNonEmpty(value, message) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(message);
  }
  return value;
}

export function validateFirebaseServiceAccount(rawJson) {
  let credential;
  try {
    credential = JSON.parse(rawJson);
  } catch {
    throw new Error('Firebase service account must be valid JSON');
  }

  if (credential?.type !== 'service_account'
    || credential.project_id !== EXPECTED_PROJECT_ID
    || credential.client_email !== EXPECTED_CLIENT_EMAIL) {
    throw new Error('Firebase service account identity is invalid');
  }

  if (typeof credential.private_key !== 'string'
    || !/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n?$/u.test(credential.private_key)) {
    throw new Error('Firebase service account private key is invalid');
  }

  return credential;
}

export async function configureOneSignalFcm({
  appId,
  organizationApiKey,
  serviceAccountJson,
}, {
  fetchImpl = fetch,
  timeoutMs = 60000,
} = {}) {
  if (appId !== EXPECTED_APP_ID) {
    throw new Error('OneSignal app ID is invalid');
  }
  requireNonEmpty(organizationApiKey, 'OneSignal organization API key is required');
  requireNonEmpty(serviceAccountJson, 'Firebase service account JSON is required');

  const credential = validateFirebaseServiceAccount(serviceAccountJson);
  const endpoint = `https://api.onesignal.com/apps/${EXPECTED_APP_ID}`;
  const authorization = `Key ${organizationApiKey}`;
  const updateResponse = await fetchImpl(endpoint, {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      authorization,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      fcm_v1_service_account_json: Buffer.from(JSON.stringify(credential), 'utf8').toString('base64'),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!updateResponse.ok) {
    throw new Error(`OneSignal FCM update failed with status ${updateResponse.status}`);
  }

  const readBackResponse = await fetchImpl(endpoint, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!readBackResponse.ok) {
    throw new Error(`OneSignal FCM read-back failed with status ${readBackResponse.status}`);
  }

  const app = await readBackResponse.json();
  if (app?.id !== EXPECTED_APP_ID
    || typeof app.fcm_v1_service_account_json !== 'string'
    || app.fcm_v1_service_account_json.trim() === '') {
    throw new Error('OneSignal FCM read-back did not confirm FCM v1');
  }

  return Object.freeze({ appId: EXPECTED_APP_ID, fcmV1Configured: true });
}
