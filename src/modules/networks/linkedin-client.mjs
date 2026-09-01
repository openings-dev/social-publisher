import {
  LINKEDIN_API_ORIGIN,
  REQUEST_TIMEOUT_MS,
} from '../../config/constants.mjs';
import { opportunityDescription } from '../render/html-page.mjs';

const IMAGE_URN_PATTERN = /^urn:li:image:[A-Za-z0-9_-]+$/u;
const POST_URN_PATTERN = /^urn:li:(?:share|ugcPost):[0-9]+$/u;

function publicationError(code, message) {
  const error = new Error(message);
  error.name = 'LinkedInPublicationError';
  error.code = code;
  return error;
}

function normalizeConfiguration({ accessToken, organizationId, apiVersion, apiOrigin }) {
  if (typeof accessToken !== 'string' || accessToken.trim() === '') {
    throw publicationError('linkedin_authentication', 'LinkedIn authentication is required');
  }
  if (typeof organizationId !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(organizationId)) {
    throw publicationError('linkedin_configuration', 'LinkedIn organization ID is invalid');
  }
  if (typeof apiVersion !== 'string' || !/^20[0-9]{4}$/u.test(apiVersion)) {
    throw publicationError('linkedin_configuration', 'LinkedIn API version is invalid');
  }
  let origin;
  try {
    const candidate = new URL(apiOrigin);
    if (candidate.protocol !== 'https:'
      || candidate.username
      || candidate.password
      || candidate.pathname !== '/'
      || candidate.search
      || candidate.hash) {
      throw new Error('unsafe origin');
    }
    origin = candidate.origin;
  } catch {
    throw publicationError('linkedin_configuration', 'LinkedIn API origin is invalid');
  }
  return {
    accessToken,
    organizationId,
    organizationUrn: `urn:li:organization:${organizationId}`,
    apiVersion,
    apiOrigin: origin,
  };
}

function linkedInHeaders(config, contentType) {
  return {
    Authorization: `Bearer ${config.accessToken}`,
    'Linkedin-Version': config.apiVersion,
    'X-Restli-Protocol-Version': '2.0.0',
    ...(contentType ? { 'Content-Type': contentType } : {}),
  };
}

async function fetchWithTimeout(url, options, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Request timed out')),
    REQUEST_TIMEOUT_MS,
  );
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
      redirect: 'error',
    });
  } finally {
    clearTimeout(timeout);
  }
}

function assertSuccessfulResponse(response, errorCode, message) {
  if (response.status === 401 || response.status === 403) {
    throw publicationError('linkedin_authentication', 'LinkedIn authentication failed');
  }
  if (!response.ok) {
    throw publicationError(errorCode, message);
  }
}

async function requestJson(url, {
  config,
  fetchImpl,
  method = 'GET',
  headers = {},
  body,
  errorCode,
  message,
}) {
  let response;
  try {
    response = await fetchWithTimeout(url, {
      method,
      headers: { ...linkedInHeaders(config), ...headers },
      body,
    }, fetchImpl);
  } catch (error) {
    if (error?.name === 'LinkedInPublicationError') throw error;
    throw publicationError(errorCode, message);
  }
  assertSuccessfulResponse(response, errorCode, message);
  const contentType = response.headers.get('content-type') ?? '';
  if (!/\bapplication\/(?:[a-z0-9.+-]*\+)?json\b/iu.test(contentType)) {
    throw publicationError('linkedin_response', 'LinkedIn returned an invalid response type');
  }
  try {
    return await response.json();
  } catch {
    throw publicationError('linkedin_response', 'LinkedIn returned invalid JSON');
  }
}

function normalizedResult(post, status) {
  if (typeof post?.id !== 'string' || !POST_URN_PATTERN.test(post.id)) {
    throw publicationError('linkedin_response', 'LinkedIn returned an invalid Post URN');
  }
  return Object.freeze({
    status,
    id: post.id,
    url: `https://www.linkedin.com/feed/update/${post.id}/`,
  });
}

function commentaryContainsUrl(commentary, canonicalUrl) {
  return typeof commentary === 'string' && commentary.includes(canonicalUrl);
}

async function findExistingPost({ config, canonicalUrl, fetchImpl }) {
  const url = new URL('/rest/posts', config.apiOrigin);
  url.searchParams.set('author', config.organizationUrn);
  url.searchParams.set('q', 'author');
  url.searchParams.set('count', '100');
  url.searchParams.set('sortBy', 'CREATED');
  const response = await requestJson(url, {
    config,
    fetchImpl,
    headers: { 'X-RestLi-Method': 'FINDER' },
    errorCode: 'linkedin_reconciliation',
    message: 'LinkedIn duplicate reconciliation failed',
  });
  if (!Array.isArray(response?.elements)) {
    throw publicationError(
      'linkedin_reconciliation',
      'LinkedIn duplicate reconciliation returned invalid data',
    );
  }
  const existing = response.elements.find((candidate) => (
    candidate?.author === config.organizationUrn
    && (candidate?.content?.article?.source === canonicalUrl
      || commentaryContainsUrl(candidate?.commentary, canonicalUrl))
  ));
  return existing ? normalizedResult(existing, 'reconciled') : null;
}

function isLinkedInUploadHost(hostname) {
  return hostname === 'linkedin.com'
    || hostname.endsWith('.linkedin.com')
    || hostname === 'licdn.com'
    || hostname.endsWith('.licdn.com');
}

function normalizeUploadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw publicationError('linkedin_image_initialization', 'LinkedIn image upload URL is invalid');
  }
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || url.hash
    || !isLinkedInUploadHost(url.hostname)) {
    throw publicationError('linkedin_image_initialization', 'LinkedIn image upload URL is invalid');
  }
  return url.toString();
}

async function initializeImageUpload({ config, fetchImpl }) {
  const response = await requestJson(new URL('/rest/images?action=initializeUpload', config.apiOrigin), {
    config,
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      initializeUploadRequest: { owner: config.organizationUrn },
    }),
    errorCode: 'linkedin_image_initialization',
    message: 'LinkedIn image initialization failed',
  });
  const image = response?.value?.image;
  if (typeof image !== 'string' || !IMAGE_URN_PATTERN.test(image)) {
    throw publicationError('linkedin_image_initialization', 'LinkedIn returned an invalid Image URN');
  }
  return {
    image,
    uploadUrl: normalizeUploadUrl(response?.value?.uploadUrl),
  };
}

async function uploadImage({ config, fetchImpl, uploadUrl, png }) {
  let response;
  try {
    response = await fetchWithTimeout(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'image/png',
      },
      body: png,
    }, fetchImpl);
  } catch {
    throw publicationError('linkedin_image_upload', 'LinkedIn image upload failed');
  }
  assertSuccessfulResponse(response, 'linkedin_image_upload', 'LinkedIn image upload failed');
}

async function waitForImage({
  config,
  fetchImpl,
  sleep,
  image,
  attempts,
  delayMs,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs);
    const response = await requestJson(
      new URL(`/rest/images/${encodeURIComponent(image)}`, config.apiOrigin),
      {
        config,
        fetchImpl,
        errorCode: 'linkedin_image_processing',
        message: 'LinkedIn image processing check failed',
      },
    );
    if (response?.id !== image || response?.owner !== config.organizationUrn) {
      throw publicationError('linkedin_response', 'LinkedIn returned an invalid image resource');
    }
    if (response.status === 'AVAILABLE') return;
    if (response.status === 'PROCESSING_FAILED') {
      throw publicationError('linkedin_image_processing', 'LinkedIn image processing failed');
    }
    if (!['PROCESSING', 'WAITING_UPLOAD'].includes(response.status)) {
      throw publicationError('linkedin_response', 'LinkedIn returned an invalid image status');
    }
  }
  throw publicationError('linkedin_image_processing', 'LinkedIn image processing timed out');
}

async function createArticlePost({ config, fetchImpl, job, post, image }) {
  let response;
  try {
    response = await fetchWithTimeout(new URL('/rest/posts', config.apiOrigin), {
      method: 'POST',
      headers: linkedInHeaders(config, 'application/json'),
      body: JSON.stringify({
        author: config.organizationUrn,
        commentary: post.text,
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        content: {
          article: {
            source: post.canonicalUrl,
            thumbnail: image,
            title: job.title.trim(),
            description: opportunityDescription(job),
          },
        },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      }),
    }, fetchImpl);
  } catch {
    throw publicationError('linkedin_publication', 'LinkedIn publication failed');
  }
  assertSuccessfulResponse(response, 'linkedin_publication', 'LinkedIn publication failed');
  return normalizedResult({ id: response.headers.get('x-restli-id') }, 'published');
}

export async function publishToLinkedIn({
  job,
  post,
  png,
  accessToken,
  organizationId,
  apiVersion,
  apiOrigin = LINKEDIN_API_ORIGIN,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  imagePollAttempts = 6,
  imagePollDelayMs = 2_000,
}) {
  const config = normalizeConfiguration({ accessToken, organizationId, apiVersion, apiOrigin });
  if (!job || typeof job.title !== 'string' || job.title.trim() === '') {
    throw publicationError('linkedin_configuration', 'LinkedIn job title is invalid');
  }
  if (!post || typeof post.text !== 'string' || typeof post.canonicalUrl !== 'string') {
    throw publicationError('linkedin_configuration', 'LinkedIn post content is invalid');
  }
  if (!(png instanceof Uint8Array) || png.byteLength === 0) {
    throw publicationError('linkedin_configuration', 'LinkedIn article image is invalid');
  }
  const attempts = Number.isInteger(imagePollAttempts) && imagePollAttempts > 0
    ? Math.min(imagePollAttempts, 10)
    : 1;
  const delayMs = Number.isFinite(imagePollDelayMs) ? Math.max(0, imagePollDelayMs) : 0;

  const existing = await findExistingPost({
    config,
    canonicalUrl: post.canonicalUrl,
    fetchImpl,
  });
  if (existing) return existing;

  const initialized = await initializeImageUpload({ config, fetchImpl });
  await uploadImage({ config, fetchImpl, uploadUrl: initialized.uploadUrl, png });
  await waitForImage({
    config,
    fetchImpl,
    sleep,
    image: initialized.image,
    attempts,
    delayMs,
  });
  try {
    return await createArticlePost({
      config,
      fetchImpl,
      job,
      post,
      image: initialized.image,
    });
  } catch (error) {
    if (error?.code === 'linkedin_authentication') throw error;
    const reconciled = await findExistingPost({
      config,
      canonicalUrl: post.canonicalUrl,
      fetchImpl,
    }).catch(() => null);
    if (reconciled) return reconciled;
    if (error?.code === 'linkedin_response') throw error;
    throw publicationError('linkedin_publication', 'LinkedIn publication failed');
  }
}
