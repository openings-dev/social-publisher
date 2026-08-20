import { REQUEST_TIMEOUT_MS } from '../config/constants.mjs';

export async function fetchJson(url, {
  fetchImpl = globalThis.fetch,
  headers,
  method = 'GET',
  body,
  timeoutMs = REQUEST_TIMEOUT_MS,
  signal,
} = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`HTTP request failed with status ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/\bapplication\/(?:[a-z0-9.+-]*\+)?json\b/i.test(contentType)) {
      throw new Error('Expected a JSON content type');
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
