import { MASTODON_BASE_URL } from '../../config/constants.mjs';
import { sha256 } from '../../shared/hash.mjs';
import { fetchJson } from '../../shared/http.mjs';

export function mastodonIdempotencyKey(jobId) {
  return sha256(`mastodon:${jobId}`);
}

function authorizationHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

function normalizeUrl(value) {
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'");
}

function statusContainsCanonicalUrl(status, canonicalUrl) {
  if (normalizeUrl(status?.card?.url) === canonicalUrl) {
    return true;
  }
  const content = typeof status?.content === 'string' ? status.content : '';
  for (const match of content.matchAll(/href=(['"])(.*?)\1/giu)) {
    if (normalizeUrl(decodeHtmlAttribute(match[2])) === canonicalUrl) {
      return true;
    }
  }
  return false;
}

function normalizedResult(status, outcome, canonicalUrl) {
  return Object.freeze({
    status: outcome,
    id: status.id,
    url: status.url,
    cardStatus: normalizeUrl(status.card?.url) === canonicalUrl ? 'resolved' : 'pending',
  });
}

async function verifyAccount(baseUrl, accessToken, fetchImpl) {
  try {
    const account = await fetchJson(`${baseUrl}/api/v1/accounts/verify_credentials`, {
      fetchImpl,
      headers: authorizationHeaders(accessToken),
    });
    if (typeof account.id !== 'string' || account.id.length === 0) {
      throw new Error('invalid account');
    }
    return account;
  } catch {
    throw new Error('Mastodon authentication failed');
  }
}

async function findRecentStatus(baseUrl, accountId, canonicalUrl, accessToken, fetchImpl) {
  const url = new URL(`/api/v1/accounts/${encodeURIComponent(accountId)}/statuses`, baseUrl);
  url.searchParams.set('limit', '40');
  url.searchParams.set('exclude_replies', 'true');
  url.searchParams.set('exclude_reblogs', 'true');
  let statuses;
  try {
    statuses = await fetchJson(url, {
      fetchImpl,
      headers: authorizationHeaders(accessToken),
    });
  } catch {
    throw new Error('Mastodon duplicate reconciliation failed');
  }
  if (!Array.isArray(statuses)) {
    throw new Error('Mastodon duplicate reconciliation returned invalid data');
  }
  return statuses.find((status) => statusContainsCanonicalUrl(status, canonicalUrl)) ?? null;
}

async function observePreviewCard({
  baseUrl,
  status,
  canonicalUrl,
  accessToken,
  fetchImpl,
  sleep,
  attempts,
  delayMs,
}) {
  let current = status;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (normalizeUrl(current.card?.url) === canonicalUrl) {
      return current;
    }
    if (attempt > 0 || delayMs > 0) {
      await sleep(delayMs);
    }
    try {
      current = await fetchJson(`${baseUrl}/api/v1/statuses/${encodeURIComponent(status.id)}`, {
        fetchImpl,
        headers: authorizationHeaders(accessToken),
      });
    } catch {
      return status;
    }
  }
  return current;
}

export async function publishToMastodon({
  job,
  post,
  accessToken,
  baseUrl = MASTODON_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  cardPollAttempts = 6,
  cardPollDelayMs = 5_000,
}) {
  const normalizedBaseUrl = new URL(baseUrl).origin;
  const account = await verifyAccount(normalizedBaseUrl, accessToken, fetchImpl);
  const existing = await findRecentStatus(
    normalizedBaseUrl,
    account.id,
    post.canonicalUrl,
    accessToken,
    fetchImpl,
  );
  if (existing) {
    return normalizedResult(existing, 'reconciled', post.canonicalUrl);
  }

  const body = new URLSearchParams({
    status: post.text,
    visibility: 'public',
    language: 'en',
  });
  let created;
  try {
    created = await fetchJson(`${normalizedBaseUrl}/api/v1/statuses`, {
      fetchImpl,
      method: 'POST',
      headers: {
        ...authorizationHeaders(accessToken),
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Idempotency-Key': mastodonIdempotencyKey(job.id),
      },
      body: body.toString(),
    });
  } catch {
    throw new Error('Mastodon publication failed');
  }
  if (typeof created.id !== 'string' || typeof created.url !== 'string') {
    throw new Error('Mastodon publication returned invalid data');
  }

  const attempts = Number.isInteger(cardPollAttempts) && cardPollAttempts > 0
    ? Math.min(cardPollAttempts, 10)
    : 1;
  const observed = await observePreviewCard({
    baseUrl: normalizedBaseUrl,
    status: created,
    canonicalUrl: post.canonicalUrl,
    accessToken,
    fetchImpl,
    sleep,
    attempts,
    delayMs: Math.max(0, cardPollDelayMs),
  });
  return normalizedResult(observed, 'published', post.canonicalUrl);
}
