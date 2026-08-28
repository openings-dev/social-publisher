import { REQUEST_TIMEOUT_MS, THREADS_API_URL } from '../../config/constants.mjs';
import { fetchJson } from '../../shared/http.mjs';

function headers(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  };
}

function publicationError(code, message) {
  const error = new Error(message);
  error.name = 'ThreadsPublicationError';
  error.code = code;
  return error;
}

function normalizedResult(thread, status) {
  return Object.freeze({
    status,
    id: thread.id,
    url: typeof thread.permalink === 'string' ? thread.permalink : null,
  });
}

function normalizeReconciliationMarker(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^#[A-Za-z][A-Za-z0-9]{1,63}$/u.test(value)) {
    throw publicationError('threads_configuration', 'Threads reconciliation marker is invalid');
  }
  return value;
}

async function findRecentThread({ apiUrl, canonicalUrl, reconciliationMarker, accessToken, fetchImpl }) {
  const url = new URL(`${apiUrl.replace(/\/$/u, '')}/me/threads`);
  url.searchParams.set('fields', 'id,text,permalink,timestamp');
  url.searchParams.set('limit', '50');
  let response;
  try {
    response = await fetchJson(url, {
      fetchImpl,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw publicationError('threads_reconciliation', 'Threads duplicate reconciliation failed');
  }
  if (!Array.isArray(response?.data)) {
    throw publicationError('threads_reconciliation', 'Threads duplicate reconciliation returned invalid data');
  }
  return response.data.find((thread) => typeof thread?.text === 'string'
    && thread.text.includes(canonicalUrl)
    && (reconciliationMarker === null || thread.text.includes(reconciliationMarker))) ?? null;
}

async function findThreadById({ apiUrl, id, accessToken, fetchImpl }) {
  const url = new URL(`${apiUrl.replace(/\/$/u, '')}/${encodeURIComponent(id)}`);
  url.searchParams.set('fields', 'id,permalink');
  try {
    const response = await fetchJson(url, {
      fetchImpl,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return typeof response?.id === 'string' ? response : null;
  } catch {
    return null;
  }
}

export async function publishToThreads({
  job,
  post,
  accessToken,
  reconciliationMarker,
  apiUrl = THREADS_API_URL,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw publicationError('threads_authentication', 'Threads authentication is required');
  }
  const marker = normalizeReconciliationMarker(reconciliationMarker);
  const existing = await findRecentThread({
    apiUrl,
    canonicalUrl: post.canonicalUrl,
    reconciliationMarker: marker,
    accessToken,
    fetchImpl,
  });
  if (existing) return normalizedResult(existing, 'reconciled');

  const body = new URLSearchParams({
    media_type: 'TEXT',
    text: marker === null ? post.text : `${post.text}\n\n${marker}`,
    link_attachment: post.canonicalUrl,
    auto_publish_text: 'true',
    reply_control: 'everyone',
  });
  let created;
  try {
    created = await fetchJson(`${apiUrl.replace(/\/$/u, '')}/me/threads`, {
      fetchImpl,
      method: 'POST',
      headers: headers(accessToken),
      body: body.toString(),
    });
  } catch {
    const reconciled = await findRecentThread({
      apiUrl,
      canonicalUrl: post.canonicalUrl,
      reconciliationMarker: marker,
      accessToken,
      fetchImpl,
    }).catch(() => null);
    if (reconciled) return normalizedResult(reconciled, 'reconciled');
    throw publicationError('threads_publication', 'Threads publication failed');
  }
  if (typeof created?.id !== 'string' || created.id.length === 0) {
    throw publicationError('threads_publication', 'Threads publication returned invalid data');
  }
  const published = await findThreadById({
    apiUrl,
    id: created.id,
    accessToken,
    fetchImpl,
  });
  return normalizedResult(published ?? { id: created.id }, 'published');
}

export async function deleteThreadsPost({
  id,
  accessToken,
  apiUrl = THREADS_API_URL,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw publicationError('threads_authentication', 'Threads authentication is required');
  }
  if (typeof id !== 'string' || id.trim() === '') {
    throw publicationError('threads_configuration', 'Threads post ID is invalid');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Request timed out')), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${apiUrl.replace(/\/$/u, '')}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
      redirect: 'error',
    });
  } catch {
    throw publicationError('threads_deletion', 'Threads superseded post deletion failed');
  } finally {
    clearTimeout(timeout);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw publicationError('threads_deletion', 'Threads superseded post deletion returned invalid data');
  }
  if (!response.ok) {
    if (payload?.error?.code === 100 && payload.error.error_subcode === 33) {
      return Object.freeze({ id, status: 'already_deleted' });
    }
    throw publicationError('threads_deletion', 'Threads superseded post deletion failed');
  }
  if (payload?.success !== true) {
    throw publicationError('threads_deletion', 'Threads superseded post deletion returned invalid data');
  }
  return Object.freeze({ id, status: 'deleted' });
}
