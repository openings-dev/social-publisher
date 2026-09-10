import { INSTAGRAM_API_ORIGIN } from '../../config/constants.mjs';
import { fetchJson } from '../../shared/http.mjs';
import { formatInstagramCaption } from '../render/instagram-caption.mjs';

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

function normalizedResult(media, status) {
  return Object.freeze({
    status,
    id: media.id,
    url: typeof media.permalink === 'string' ? media.permalink : null,
  });
}

function normalizeReconciliationMarker(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^#[A-Za-z][A-Za-z0-9]{1,63}$/u.test(value)) {
    throw publicationError('instagram_configuration', 'Instagram reconciliation marker is invalid');
  }
  return value;
}

function apiBase(apiOrigin, apiVersion) {
  if (!/^v\d+\.\d+$/u.test(apiVersion)) {
    throw publicationError('instagram_configuration', 'Instagram Graph API version is invalid');
  }
  return `${new URL(apiOrigin).origin}/${apiVersion}`;
}

function assertCredentials(accessToken, userId) {
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw publicationError('instagram_authentication', 'Instagram authentication is required');
  }
  if (typeof userId !== 'string' || !/^\d+$/u.test(userId)) {
    throw publicationError('instagram_configuration', 'Instagram user ID is invalid');
  }
}

function publicMediaUrl(value, { extension, label }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw publicationError('instagram_configuration', `${label} URL is invalid`);
  }
  if (url.protocol !== 'https:' || !url.pathname.toLowerCase().endsWith(extension)) {
    throw publicationError(
      'instagram_configuration',
      `${label} URL must be a public HTTPS ${extension === '.mp4' ? 'MP4' : 'JPEG'}`,
    );
  }
  return url.toString();
}

function validateCaption(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 2_200) {
    throw publicationError('instagram_configuration', 'Instagram caption is invalid');
  }
  return value;
}

async function findRecentMedia({
  base,
  userId,
  canonicalUrl,
  reconciliationMarker,
  accessToken,
  fetchImpl,
}) {
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
    && media.caption.includes(canonicalUrl)
    && (reconciliationMarker === null || media.caption.includes(reconciliationMarker))) ?? null;
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

async function findRecentMediaByMarker({
  base,
  userId,
  reconciliationMarker,
  accessToken,
  fetchImpl,
}) {
  if (reconciliationMarker === null) return { ok: false, media: null };
  const url = new URL(`${base}/${encodeURIComponent(userId)}/media`);
  url.searchParams.set('fields', 'id,caption,permalink,timestamp');
  url.searchParams.set('limit', '50');
  try {
    const response = await fetchJson(url, {
      fetchImpl,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!Array.isArray(response?.data)) return { ok: false, media: null };
    const matches = response.data.filter((media) => typeof media?.caption === 'string'
      && media.caption.includes(reconciliationMarker));
    return matches.length <= 1
      ? { ok: true, media: matches[0] ?? null }
      : { ok: false, media: null };
  } catch {
    return { ok: false, media: null };
  }
}

async function createMediaContainer({
  base,
  userId,
  accessToken,
  fetchImpl,
  parameters,
  errorCode,
}) {
  let container;
  try {
    container = await fetchJson(`${base}/${encodeURIComponent(userId)}/media`, {
      fetchImpl,
      method: 'POST',
      headers: headers(accessToken),
      body: new URLSearchParams(parameters).toString(),
    });
  } catch {
    throw publicationError(errorCode, 'Instagram media container creation failed');
  }
  if (typeof container?.id !== 'string' || container.id.length === 0) {
    throw publicationError(errorCode, 'Instagram media container returned invalid data');
  }
  return container;
}

async function publishMediaContainer({
  base,
  userId,
  containerId,
  accessToken,
  fetchImpl,
  errorCode,
  reconcile,
}) {
  let published;
  try {
    published = await fetchJson(`${base}/${encodeURIComponent(userId)}/media_publish`, {
      fetchImpl,
      method: 'POST',
      headers: headers(accessToken),
      body: new URLSearchParams({ creation_id: containerId }).toString(),
    });
  } catch {
    const reconciled = typeof reconcile === 'function' ? await reconcile() : null;
    if (reconciled) return normalizedResult(reconciled, 'reconciled');
    throw publicationError(errorCode, 'Instagram publication result is ambiguous');
  }
  if (typeof published?.id !== 'string' || published.id.length === 0) {
    throw publicationError(errorCode, 'Instagram publication returned invalid data');
  }
  const media = await findMediaById({
    base,
    id: published.id,
    accessToken,
    fetchImpl,
  });
  return normalizedResult(media ?? { id: published.id }, 'published');
}

function pollingOptions({
  containerPollAttempts = 24,
  containerPollDelayMs = 5_000,
} = {}) {
  return {
    attempts: Number.isInteger(containerPollAttempts) && containerPollAttempts > 0
      ? Math.min(containerPollAttempts, 60)
      : 1,
    delayMs: Math.max(0, containerPollDelayMs),
  };
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

export async function publishImageToInstagram({
  job,
  post,
  imageUrl,
  accessToken,
  userId,
  apiVersion,
  reconciliationMarker,
  apiOrigin = INSTAGRAM_API_ORIGIN,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  containerPollAttempts = 24,
  containerPollDelayMs = 5_000,
}) {
  assertCredentials(accessToken, userId);
  const marker = normalizeReconciliationMarker(reconciliationMarker);
  const publicImage = publicMediaUrl(imageUrl, {
    extension: '.jpg',
    label: 'Instagram image',
  });
  const base = apiBase(apiOrigin, apiVersion);
  const baseCaption = formatInstagramCaption(job, post);
  const caption = validateCaption(marker === null || baseCaption.includes(marker)
    ? baseCaption
    : `${baseCaption}\n\n${marker}`);
  const existing = await findRecentMedia({
    base,
    userId,
    canonicalUrl: post.canonicalUrl,
    reconciliationMarker: marker,
    accessToken,
    fetchImpl,
  });
  if (existing) return normalizedResult(existing, 'reconciled');

  const container = await createMediaContainer({
    base,
    userId,
    accessToken,
    fetchImpl,
    parameters: { image_url: publicImage, caption },
    errorCode: 'instagram_container',
  });
  await waitUntilContainerReady({
    base,
    containerId: container.id,
    accessToken,
    fetchImpl,
    sleep,
    ...pollingOptions({ containerPollAttempts, containerPollDelayMs }),
  });
  return publishMediaContainer({
    base,
    userId,
    containerId: container.id,
    accessToken,
    fetchImpl,
    errorCode: 'instagram_publication',
    reconcile: () => findRecentMedia({
      base,
      userId,
      canonicalUrl: post.canonicalUrl,
      reconciliationMarker: marker,
      accessToken,
      fetchImpl,
    }).catch(() => null),
  });
}

export async function publishToInstagram({
  job,
  post,
  videoUrl,
  coverUrl,
  accessToken,
  userId,
  apiVersion,
  reconciliationMarker,
  apiOrigin = INSTAGRAM_API_ORIGIN,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  containerPollAttempts = 24,
  containerPollDelayMs = 5_000,
}) {
  assertCredentials(accessToken, userId);
  const marker = normalizeReconciliationMarker(reconciliationMarker);
  let publicVideo;
  let publicCover;
  try {
    publicVideo = new URL(videoUrl);
  } catch {
    throw publicationError('instagram_configuration', 'Instagram video URL is invalid');
  }
  if (publicVideo.protocol !== 'https:' || !publicVideo.pathname.endsWith('.mp4')) {
    throw publicationError('instagram_configuration', 'Instagram video URL must be a public HTTPS MP4');
  }
  try {
    publicCover = new URL(coverUrl);
  } catch {
    throw publicationError('instagram_configuration', 'Instagram Reel cover URL is invalid');
  }
  if (publicCover.protocol !== 'https:' || !publicCover.pathname.endsWith('.jpg')) {
    throw publicationError('instagram_configuration', 'Instagram Reel cover URL must be a public HTTPS JPEG');
  }

  const base = apiBase(apiOrigin, apiVersion);
  const existing = await findRecentMedia({
    base,
    userId,
    canonicalUrl: post.canonicalUrl,
    reconciliationMarker: marker,
    accessToken,
    fetchImpl,
  });
  if (existing) return normalizedResult(existing, 'reconciled');

  const baseCaption = formatInstagramCaption(job, post);
  const caption = marker === null || baseCaption.includes(marker)
    ? baseCaption
    : `${baseCaption}\n\n${marker}`;
  let container;
  try {
    container = await fetchJson(`${base}/${encodeURIComponent(userId)}/media`, {
      fetchImpl,
      method: 'POST',
      headers: headers(accessToken),
      body: new URLSearchParams({
        media_type: 'REELS',
        video_url: publicVideo.toString(),
        cover_url: publicCover.toString(),
        caption,
        share_to_feed: 'true',
      }).toString(),
    });
  } catch {
    throw publicationError('instagram_container', 'Instagram media container creation failed');
  }
  if (typeof container?.id !== 'string' || container.id.length === 0) {
    throw publicationError('instagram_container', 'Instagram media container returned invalid data');
  }

  const attempts = Number.isInteger(containerPollAttempts) && containerPollAttempts > 0
    ? Math.min(containerPollAttempts, 60)
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
      reconciliationMarker: marker,
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

export async function publishCarouselToInstagram({
  imageUrls,
  caption,
  accessToken,
  userId,
  apiVersion,
  reconciliationMarker,
  apiOrigin = INSTAGRAM_API_ORIGIN,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  containerPollAttempts = 24,
  containerPollDelayMs = 5_000,
}) {
  assertCredentials(accessToken, userId);
  if (!Array.isArray(imageUrls) || imageUrls.length < 2 || imageUrls.length > 10) {
    throw publicationError('instagram_configuration', 'Instagram carousel must contain between 2 and 10 images');
  }
  const images = imageUrls.map((imageUrl) => publicMediaUrl(imageUrl, {
    extension: '.jpg',
    label: 'Instagram carousel image',
  }));
  if (new Set(images).size !== images.length) {
    throw publicationError('instagram_configuration', 'Instagram carousel image URLs must be unique');
  }
  const safeCaption = validateCaption(caption);
  const marker = normalizeReconciliationMarker(reconciliationMarker);
  if (marker === null || !safeCaption.includes(marker)) {
    throw publicationError('instagram_configuration', 'Instagram carousel requires a caption reconciliation marker');
  }
  const base = apiBase(apiOrigin, apiVersion);
  const existing = await findRecentMediaByMarker({
    base,
    userId,
    reconciliationMarker: marker,
    accessToken,
    fetchImpl,
  });
  if (!existing.ok) {
    throw publicationError('instagram_carousel_reconciliation', 'Instagram carousel reconciliation failed before publication');
  }
  if (existing.media) return normalizedResult(existing.media, 'reconciled');

  const polling = pollingOptions({ containerPollAttempts, containerPollDelayMs });
  const childIds = [];
  for (const imageUrl of images) {
    const child = await createMediaContainer({
      base,
      userId,
      accessToken,
      fetchImpl,
      parameters: { image_url: imageUrl, is_carousel_item: 'true' },
      errorCode: 'instagram_carousel_container',
    });
    await waitUntilContainerReady({
      base,
      containerId: child.id,
      accessToken,
      fetchImpl,
      sleep,
      ...polling,
    });
    childIds.push(child.id);
  }
  const parent = await createMediaContainer({
    base,
    userId,
    accessToken,
    fetchImpl,
    parameters: {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption: safeCaption,
    },
    errorCode: 'instagram_carousel_container',
  });
  await waitUntilContainerReady({
    base,
    containerId: parent.id,
    accessToken,
    fetchImpl,
    sleep,
    ...polling,
  });
  return publishMediaContainer({
    base,
    userId,
    containerId: parent.id,
    accessToken,
    fetchImpl,
    errorCode: 'instagram_carousel_publication',
    reconcile: async () => {
      const scan = await findRecentMediaByMarker({
        base,
        userId,
        reconciliationMarker: marker,
        accessToken,
        fetchImpl,
      });
      return scan.ok ? scan.media : null;
    },
  });
}

export async function publishStoryToInstagram({
  mediaUrl,
  mediaKind,
  accessToken,
  userId,
  apiVersion,
  apiOrigin = INSTAGRAM_API_ORIGIN,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  containerPollAttempts = 24,
  containerPollDelayMs = 5_000,
}) {
  assertCredentials(accessToken, userId);
  if (mediaKind !== 'image' && mediaKind !== 'video') {
    throw publicationError('instagram_configuration', 'Instagram Story media kind must be image or video');
  }
  const publicUrl = publicMediaUrl(mediaUrl, {
    extension: mediaKind === 'video' ? '.mp4' : '.jpg',
    label: 'Instagram Story media',
  });
  const base = apiBase(apiOrigin, apiVersion);
  const container = await createMediaContainer({
    base,
    userId,
    accessToken,
    fetchImpl,
    parameters: {
      media_type: 'STORIES',
      [mediaKind === 'video' ? 'video_url' : 'image_url']: publicUrl,
    },
    errorCode: 'instagram_story_container',
  });
  await waitUntilContainerReady({
    base,
    containerId: container.id,
    accessToken,
    fetchImpl,
    sleep,
    ...pollingOptions({ containerPollAttempts, containerPollDelayMs }),
  });
  return publishMediaContainer({
    base,
    userId,
    containerId: container.id,
    accessToken,
    fetchImpl,
    errorCode: 'instagram_story_ambiguous',
  });
}
