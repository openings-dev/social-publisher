import {
  DEPLOY_POLL_ATTEMPTS,
  DEPLOY_POLL_DELAY_MS,
  GITHUB_API_ORIGIN,
  INSTAGRAM_CARD_VERSION,
  MAX_REPOSITORY_DISPATCH_BODY_CHARACTERS,
  SOCIAL_VIDEO_VERSION,
} from '../../config/constants.mjs';
import { gzipSync } from 'node:zlib';
import { sha256 } from '../../shared/hash.mjs';
import { assertValidJobId } from '../../shared/job-id.mjs';
import { verifyPublicBridge } from './public-verifier.mjs';
import { verifyPublicEditorial } from './editorial-verifier.mjs';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const EDITORIAL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SVG_FRAGMENT_PATTERN = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/u;
const SVG_DATA_PATTERN = /^data:image\/svg\+xml;base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/u;
const DEFAULT_DISPATCH_ATTEMPTS = 3;
const DEFAULT_DISPATCH_RETRY_DELAY_MS = 2_000;
const MAX_DISPATCH_ATTEMPTS = 5;
const MAX_DISPATCH_RETRY_DELAY_MS = 60_000;

function bridgeDispatchError(message) {
  const error = new Error(message);
  error.code = 'bridge_dispatch';
  return error;
}

function dispatchAttemptsValue(value) {
  return Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_DISPATCH_ATTEMPTS)
    : 1;
}

function dispatchRetryDelay(response, fallbackDelayMs) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_DISPATCH_RETRY_DELAY_MS);
    }
  }
  return Math.min(Math.max(0, fallbackDelayMs), MAX_DISPATCH_RETRY_DELAY_MS);
}

async function isTransientDispatchResponse(response) {
  if (response.status === 429 || (response.status >= 500 && response.status <= 599)) return true;
  if (response.status !== 422) return false;
  try {
    return /endpoint has been spammed|secondary rate limit|abuse/iu.test(await response.text());
  } catch {
    return false;
  }
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertRepository(value) {
  if (typeof value !== 'string' || !REPOSITORY_PATTERN.test(value)) {
    throw new Error('Web deploy repository is invalid');
  }
  return value;
}

function assertInstagramCardVersion(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error('Instagram card version is invalid');
  }
  return value;
}

function toBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string' || value instanceof Uint8Array) return Buffer.from(value);
  throw new Error(`${label} artifact is invalid`);
}

function assertToken(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Web deploy token is required');
  }
  return value;
}

export function buildRepositoryDispatchRequest({
  jobId,
  contentHash,
  html,
  image,
  instagramSvg,
  repository,
  apiOrigin = GITHUB_API_ORIGIN,
}) {
  const safeJobId = assertValidJobId(jobId);
  const safeContentHash = assertHash(contentHash, 'Bridge content hash');
  const safeRepository = assertRepository(repository);
  const htmlBuffer = toBuffer(html, 'HTML');
  const imageBuffer = toBuffer(image, 'Image');
  const instagramSvgBuffer = toBuffer(instagramSvg, 'Instagram SVG');

  const body = JSON.stringify({
    event_type: 'publish_job_bridge',
    client_payload: {
      job_id: safeJobId,
      content_hash: safeContentHash,
      html_sha256: sha256(htmlBuffer),
      image_sha256: sha256(imageBuffer),
      instagram_svg_sha256: sha256(instagramSvgBuffer),
      html_base64: htmlBuffer.toString('base64'),
      image_base64: imageBuffer.toString('base64'),
      instagram_svg_base64: instagramSvgBuffer.toString('base64'),
    },
  });

  if (body.length > MAX_REPOSITORY_DISPATCH_BODY_CHARACTERS) {
    throw new Error(`Repository dispatch payload is too large (${body.length} characters)`);
  }

  return Object.freeze({
    url: `${apiOrigin}/repos/${safeRepository}/dispatches`,
    body,
  });
}

function assertSafeSvgDocument(document, label, { embedded = false } = {}) {
  if (/<!DOCTYPE|<!ENTITY|<(?:script|style|foreignObject)\b|\b(?:on[a-z]+|style)\s*=|@import/iu.test(document)) {
    throw new Error(`${label} contains unsupported SVG content`);
  }
  let remaining = document.replace(/\b(?:href|src)\s*=\s*(["'])([^"']*)\1/giu, (attribute, quote, reference) => {
    if (SVG_FRAGMENT_PATTERN.test(reference)) return '';
    const data = SVG_DATA_PATTERN.exec(reference)?.[1];
    if (embedded || data === undefined) throw new Error(`${label} contains an unsupported SVG resource`);
    const decoded = Buffer.from(data, 'base64');
    const nested = decoded.toString('utf8');
    if (decoded.length === 0 || decoded.length > 128 * 1024 || decoded.toString('base64') !== data
      || !Buffer.from(nested, 'utf8').equals(decoded) || !/^\s*<svg\b/iu.test(nested)) {
      throw new Error(`${label} contains an invalid embedded SVG resource`);
    }
    assertSafeSvgDocument(nested, `${label} embedded resource`, { embedded: true });
    return '';
  });
  if (/\b(?:href|src)\s*=/iu.test(remaining)) {
    throw new Error(`${label} contains an unsupported SVG resource`);
  }
  remaining = remaining.replace(/url\(\s*(["']?)(#[A-Za-z_][A-Za-z0-9_.:-]*)\1\s*\)/giu, '');
  if (/url\s*\(/iu.test(remaining)) throw new Error(`${label} contains an unsupported SVG URL`);
}

function assertEditorialSvg(value, label, height) {
  const buffer = toBuffer(value, label);
  const document = buffer.toString('utf8');
  if (!Buffer.from(document, 'utf8').equals(buffer)
    || !new RegExp(`^\\s*<svg\\b[^>]*\\bwidth="1080"[^>]*\\bheight="${height}"`, 'iu').test(document)) {
    throw new Error(`${label} is not a safe 1080×${height} SVG`);
  }
  assertSafeSvgDocument(document, label);
  return buffer;
}

export function buildEditorialDispatchRequest({
  contentId,
  version,
  carouselSvgs,
  storySvg,
  repository,
  apiOrigin = GITHUB_API_ORIGIN,
}) {
  if (typeof contentId !== 'string' || !EDITORIAL_ID_PATTERN.test(contentId)) throw new Error('Editorial content ID is invalid');
  if (typeof version !== 'string' || !/^[1-9][0-9]*$/u.test(version)) throw new Error('Editorial version is invalid');
  const safeRepository = assertRepository(repository);
  if (!Array.isArray(carouselSvgs) || carouselSvgs.length !== 7) throw new Error('Editorial carousel must contain seven SVGs');
  const buffers = carouselSvgs.map((svg, index) => assertEditorialSvg(svg, `Editorial slide ${index + 1}`, 1350));
  buffers.push(assertEditorialSvg(storySvg, 'Editorial Story', 1920));
  const names = [...buffers.slice(0, 7).map((_, index) => `slide-${String(index + 1).padStart(2, '0')}`), 'story'];
  const body = JSON.stringify({
    event_type: 'publish_instagram_editorial',
    client_payload: {
      content_id: contentId,
      content_version: version,
      assets: buffers.map((buffer, index) => {
        const compressed = gzipSync(buffer, { level: 9, mtime: 0 });
        return {
          name: names[index],
          sha256: sha256(buffer),
          svg_gzip_base64: compressed.toString('base64'),
        };
      }),
    },
  });
  if (body.length > MAX_REPOSITORY_DISPATCH_BODY_CHARACTERS) {
    throw new Error(`Editorial repository dispatch payload is too large (${body.length} characters)`);
  }
  return Object.freeze({ url: `${apiOrigin}/repos/${safeRepository}/dispatches`, body });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function requestIncrementalBridgeDeployment({
  jobId,
  contentHash,
  expectedPngHash,
  expectedInstagramSvgHash,
  expectedInstagramCardVersion = INSTAGRAM_CARD_VERSION,
  expectedSocialVideoVersion = SOCIAL_VIDEO_VERSION,
  forceDeployment = false,
  html,
  image,
  instagramSvg,
  repository,
  token,
  origin,
  fetchImpl = globalThis.fetch,
  verifyPublic = verifyPublicBridge,
  sleep = wait,
  pollAttempts = DEPLOY_POLL_ATTEMPTS,
  pollDelayMs = DEPLOY_POLL_DELAY_MS,
  dispatchAttempts = DEFAULT_DISPATCH_ATTEMPTS,
  dispatchRetryDelayMs = DEFAULT_DISPATCH_RETRY_DELAY_MS,
}) {
  const safeJobId = assertValidJobId(jobId);
  if (typeof forceDeployment !== 'boolean') {
    throw new Error('Force deployment flag is invalid');
  }
  const safeExpectedPngHash = assertHash(expectedPngHash, 'Expected PNG hash');
  const imageBuffer = toBuffer(image, 'Image');
  const instagramSvgBuffer = toBuffer(instagramSvg, 'Instagram SVG');
  if (sha256(imageBuffer) !== safeExpectedPngHash) {
    throw new Error('Expected PNG hash does not match the image artifact');
  }
  const safeExpectedInstagramSvgHash = assertHash(
    expectedInstagramSvgHash,
    'Expected Instagram SVG hash',
  );
  if (sha256(instagramSvgBuffer) !== safeExpectedInstagramSvgHash) {
    throw new Error('Expected Instagram SVG hash does not match the Instagram SVG artifact');
  }

  const verificationInput = {
    jobId: safeJobId,
    contentHash: assertHash(contentHash, 'Bridge content hash'),
    expectedPngHash: safeExpectedPngHash,
    expectedInstagramSvgHash: safeExpectedInstagramSvgHash,
    expectedInstagramCardVersion: assertInstagramCardVersion(expectedInstagramCardVersion),
    expectedSocialVideoVersion: assertInstagramCardVersion(expectedSocialVideoVersion),
    origin,
    fetchImpl,
  };
  const current = await verifyPublic({ ...verificationInput, allowMismatch: true });
  if (current.matches && !forceDeployment) {
    return Object.freeze({ status: 'already_current', verification: current });
  }

  const request = buildRepositoryDispatchRequest({
    jobId: safeJobId,
    contentHash,
    html,
    image: imageBuffer,
    instagramSvg: instagramSvgBuffer,
    repository,
  });
  const attempts = dispatchAttemptsValue(dispatchAttempts);
  const requestOptions = {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${assertToken(token)}`,
      'content-type': 'application/json',
      'user-agent': 'openings-social-publisher',
      'x-github-api-version': '2026-03-10',
    },
    body: request.body,
    redirect: 'error',
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(request.url, requestOptions);
    } catch {
      if (attempt < attempts - 1) {
        await sleep(Math.min(Math.max(0, dispatchRetryDelayMs), MAX_DISPATCH_RETRY_DELAY_MS));
        continue;
      }
      throw bridgeDispatchError(`GitHub deployment dispatch failed for job ${safeJobId}`);
    }
    if (response.status === 204) break;
    const error = bridgeDispatchError(
      `GitHub deployment dispatch failed for job ${safeJobId} with HTTP ${response.status}`,
    );
    if (!await isTransientDispatchResponse(response) || attempt === attempts - 1) throw error;
    await sleep(dispatchRetryDelay(response, dispatchRetryDelayMs));
  }

  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    await sleep(pollDelayMs);
    const verification = await verifyPublic({ ...verificationInput, allowMismatch: true });
    if (verification.matches) {
      return Object.freeze({ status: 'deployed', verification });
    }
  }

  throw new Error(`Public bridge verification timed out for job ${safeJobId}`);
}

export async function requestEditorialDeployment({
  contentId,
  version,
  carouselSvgs,
  storySvg,
  repository,
  token,
  origin,
  fetchImpl = globalThis.fetch,
  verifyPublic = verifyPublicEditorial,
  sleep = wait,
  pollAttempts = DEPLOY_POLL_ATTEMPTS,
  pollDelayMs = DEPLOY_POLL_DELAY_MS,
}) {
  const request = buildEditorialDispatchRequest({ contentId, version, carouselSvgs, storySvg, repository });
  const payload = JSON.parse(request.body).client_payload;
  const expectedSourceHashes = Object.fromEntries(payload.assets.map(({ name, sha256: hash }) => [name, hash]));
  const verificationInput = { contentId, version, expectedSourceHashes, origin, fetchImpl };
  const current = await verifyPublic({ ...verificationInput, allowMismatch: true });
  if (current.matches) return Object.freeze({ status: 'already_current', verification: current });
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${assertToken(token)}`,
        'content-type': 'application/json',
        'user-agent': 'openings-social-publisher',
        'x-github-api-version': '2026-03-10',
      },
      body: request.body,
      redirect: 'error',
    });
  } catch {
    throw new Error(`GitHub editorial deployment dispatch failed for ${contentId}`);
  }
  if (response.status !== 204) throw new Error(`GitHub editorial deployment dispatch failed with HTTP ${response.status}`);
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    await sleep(pollDelayMs);
    const verification = await verifyPublic({ ...verificationInput, allowMismatch: true });
    if (verification.matches) return Object.freeze({ status: 'deployed', verification });
  }
  throw new Error(`Public editorial verification timed out for ${contentId}`);
}
