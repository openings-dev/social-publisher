const ENDPOINT = 'https://api.onesignal.com/notifications';
const TARGET_KEYS = ['include_subscription_ids', 'included_segments', 'filters'];

function validateConfig(config) {
  if (typeof config?.appId !== 'string' || config.appId.trim() === '') throw new Error('OneSignal App ID is required');
  if (typeof config?.apiKey !== 'string' || config.apiKey.trim() === '') throw new Error('OneSignal API key is required');
  const audience = config.audience;
  if (audience === null || typeof audience !== 'object' || Array.isArray(audience)) throw new Error('OneSignal audience is required');
  if (TARGET_KEYS.filter((key) => audience[key] !== undefined).length !== 1) throw new Error('OneSignal audience must use exactly one targeting method');
}

function retryAfterSeconds(response) {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : 100;
}

export async function sendOneSignalPush(intent, config, {
  fetchImpl = fetch,
  timeoutMs = 60_000,
} = {}) {
  validateConfig(config);
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Key ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...config.audience,
        app_id: config.appId,
        target_channel: 'push',
        isAndroid: true,
        ...intent.payload,
        idempotency_key: intent.idempotencyKey,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429) return { status: 'retryable', code: 'rate_limited', retryAfterSeconds: retryAfterSeconds(response) };
    if (response.status >= 500) return { status: 'uncertain', code: 'provider_unavailable' };
    if (response.status === 401 || response.status === 403) return { status: 'failed', code: 'authentication' };
    if (!response.ok) return { status: 'failed', code: 'invalid_request' };
    const body = await response.json();
    return typeof body?.id === 'string' && body.id.trim() !== ''
      ? { status: 'accepted', notificationId: body.id }
      : { status: 'no_recipients' };
  } catch {
    return { status: 'uncertain', code: 'transport' };
  }
}
