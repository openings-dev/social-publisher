const EXPECTED_APP_ID = 'c49d82df-9d48-4283-b746-4afe280cda5e';
const EXPECTED_PROJECT_ID = 'openingshq';
const EXPECTED_CLIENT_EMAIL = 'onesignal-fcm-sender@openingshq.iam.gserviceaccount.com';

export const OPENINGS_ONESIGNAL_APP_ID = EXPECTED_APP_ID;

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
