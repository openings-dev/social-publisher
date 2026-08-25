import { INSTAGRAM_API_ORIGIN } from '../../config/constants.mjs';
import { fetchJson } from '../../shared/http.mjs';

function headers(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  };
}

function publicationError(code, message) {
  const error = new Error(message);
  error.name = 'InstagramPublicationError';
  error.code = code;
  return error;
}

function captionFor(post) {
  return [
    'New opening on openings.dev',
    post.title,
    [post.metadataLine, post.salaryLine].filter(Boolean).join('\n'),
    `Full details:\n${post.canonicalUrl}`,
    post.hashtags,
  ].filter(Boolean).join('\n\n');
}

function normalizedResult(media, status) {
  return Object.freeze({
    status,
    id: media.id,
    url: typeof media.permalink === 'string' ? media.permalink : null,
  });
}

function apiBase(apiOrigin, apiVersion) {
  if (!/^v\d+\.\d+$/u.test(apiVersion)) {
    throw publicationError('instagram_configuration', 'Instagram Graph API version is invalid');
  }
  return `${new URL(apiOrigin).origin}/${apiVersion}`;
}

async function findRecentMedia({ base, userId, canonicalUrl, accessToken, fetchImpl }) {
  const url = new URL(`${base}/${encodeURIComponent(userId)}/media`);
  url.searchParams.set('fields', 'id,caption,permalink,timestamp');
  url.searchParams.set('limit', '50');
  let response;
  try {
    response = await fetchJson(url, {
      fetchImpl,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw publicationError('instagram_reconciliation', 'Instagram duplicate reconciliation failed');
  }
  if (!Array.isArray(response?.data)) {
    throw publicationError('instagram_reconciliation', 'Instagram duplicate reconciliation returned invalid data');
  }
  return response.data.find((media) => typeof media?.caption === 'string'
    && media.caption.includes(canonicalUrl)) ?? null;
}

async function findMediaById({ base, id, accessToken, fetchImpl }) {
  const url = new URL(`${base}/${encodeURIComponent(id)}`);
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

async function waitUntilContainerReady({
  base,
  containerId,
  accessToken,
  fetchImpl,
  sleep,
  attempts,
  delayMs,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const url = new URL(`${base}/${encodeURIComponent(containerId)}`);
    url.searchParams.set('fields', 'status_code,status');
    let response;
    try {
      response = await fetchJson(url, {
        fetchImpl,
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      throw publicationError('instagram_container', 'Instagram media preparation failed');
    }
    if (response?.status_code === 'FINISHED' || response?.status_code === 'PUBLISHED') return;
    if (response?.status_code === 'ERROR' || response?.status_code === 'EXPIRED') {
      throw publicationError('instagram_container', 'Instagram rejected the media container');
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  throw publicationError('instagram_container', 'Instagram media preparation timed out');
}

export async function publishToInstagram({
  job,
  post,
  imageUrl,
  accessToken,
  userId,
  apiVersion,
  apiOrigin = INSTAGRAM_API_ORIGIN,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  containerPollAttempts = 6,
  containerPollDelayMs = 5_000,
}) {
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw publicationError('instagram_authentication', 'Instagram authentication is required');
  }
  if (typeof userId !== 'string' || !/^\d+$/u.test(userId)) {
    throw publicationError('instagram_configuration', 'Instagram user ID is invalid');
  }
  let publicImage;
  try {
    publicImage = new URL(imageUrl);
  } catch {
    throw publicationError('instagram_configuration', 'Instagram image URL is invalid');
  }
  if (publicImage.protocol !== 'https:' || !publicImage.pathname.endsWith('.jpg')) {
    throw publicationError('instagram_configuration', 'Instagram image URL must be a public HTTPS JPEG');
  }

  const base = apiBase(apiOrigin, apiVersion);
  const existing = await findRecentMedia({
    base,
    userId,
    canonicalUrl: post.canonicalUrl,
    accessToken,
    fetchImpl,
  });
  if (existing) return normalizedResult(existing, 'reconciled');

  const caption = captionFor(post);
  let container;
  try {
    container = await fetchJson(`${base}/${encodeURIComponent(userId)}/media`, {
      fetchImpl,
      method: 'POST',
      headers: headers(accessToken),
      body: new URLSearchParams({ image_url: publicImage.toString(), caption }).toString(),
    });
  } catch {
    throw publicationError('instagram_container', 'Instagram media container creation failed');
  }
  if (typeof container?.id !== 'string' || container.id.length === 0) {
    throw publicationError('instagram_container', 'Instagram media container returned invalid data');
  }

  const attempts = Number.isInteger(containerPollAttempts) && containerPollAttempts > 0
    ? Math.min(containerPollAttempts, 10)
    : 1;
  await waitUntilContainerReady({
    base,
    containerId: container.id,
    accessToken,
    fetchImpl,
    sleep,
    attempts,
    delayMs: Math.max(0, containerPollDelayMs),
  });

  let published;
  try {
    published = await fetchJson(`${base}/${encodeURIComponent(userId)}/media_publish`, {
      fetchImpl,
      method: 'POST',
      headers: headers(accessToken),
      body: new URLSearchParams({ creation_id: container.id }).toString(),
    });
  } catch {
    const reconciled = await findRecentMedia({
      base,
      userId,
      canonicalUrl: post.canonicalUrl,
      accessToken,
      fetchImpl,
    }).catch(() => null);
    if (reconciled) return normalizedResult(reconciled, 'reconciled');
    throw publicationError('instagram_publication', 'Instagram publication failed');
  }
  if (typeof published?.id !== 'string' || published.id.length === 0) {
    throw publicationError('instagram_publication', 'Instagram publication returned invalid data');
  }
  const media = await findMediaById({
    base,
    id: published.id,
    accessToken,
    fetchImpl,
  });
  return normalizedResult(media ?? { id: published.id }, 'published');
}
