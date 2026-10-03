const SUBSCRIPTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseJson(raw, label) {
  try { return JSON.parse(raw); } catch { throw new Error(`${label} must be valid JSON`); }
}

function validateAudience(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('OneSignal audience is invalid');
  const keys = ['include_subscription_ids', 'included_segments', 'filters'].filter((key) => value[key] !== undefined);
  if (keys.length !== 1) throw new Error('OneSignal audience must use exactly one targeting method');
  if (Object.keys(value).some((key) => !['include_subscription_ids', 'included_segments', 'excluded_segments', 'filters'].includes(key))) throw new Error('OneSignal audience contains unsupported fields');
  return value;
}

export function readPushConfig(env) {
  if (typeof env.ONESIGNAL_APP_ID !== 'string' || env.ONESIGNAL_APP_ID.trim() === '') throw new Error('OneSignal App ID is required');
  if (typeof env.ONESIGNAL_API_KEY !== 'string' || env.ONESIGNAL_API_KEY.trim() === '') throw new Error('OneSignal API key is required');
  if (env.PUSH_AUDIENCE_VERSION !== 'android-consent-v1') throw new Error('Push audience version is invalid');
  const testIds = env.PUSH_TEST_SUBSCRIPTION_IDS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  if (testIds.some((value) => !SUBSCRIPTION_ID_PATTERN.test(value))) throw new Error('Test subscription ID is invalid');
  const audience = testIds.length > 0
    ? { include_subscription_ids: testIds }
    : validateAudience(parseJson(env.ONESIGNAL_AUDIENCE_JSON ?? '', 'OneSignal audience'));
  return Object.freeze({
    appId: env.ONESIGNAL_APP_ID,
    apiKey: env.ONESIGNAL_API_KEY,
    audience,
    audienceVersion: env.PUSH_AUDIENCE_VERSION,
  });
}
