import { THREADS_API_URL } from '../../config/constants.mjs';
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

async function findRecentThread({ apiUrl, canonicalUrl, accessToken, fetchImpl }) {
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
    && thread.text.includes(canonicalUrl)) ?? null;
}

export async function publishToThreads({
  job,
  post,
  accessToken,
  apiUrl = THREADS_API_URL,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw publicationError('threads_authentication', 'Threads authentication is required');
  }
  const existing = await findRecentThread({
    apiUrl,
    canonicalUrl: post.canonicalUrl,
    accessToken,
    fetchImpl,
  });
  if (existing) return normalizedResult(existing, 'reconciled');

  const body = new URLSearchParams({
    media_type: 'TEXT',
    text: post.text,
    link_attachment: post.canonicalUrl,
    auto_publish_text: 'true',
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
      accessToken,
      fetchImpl,
    }).catch(() => null);
    if (reconciled) return normalizedResult(reconciled, 'reconciled');
    throw publicationError('threads_publication', 'Threads publication failed');
  }
  if (typeof created?.id !== 'string' || created.id.length === 0) {
    throw publicationError('threads_publication', 'Threads publication returned invalid data');
  }
  return normalizedResult({ id: created.id }, 'published');
}
