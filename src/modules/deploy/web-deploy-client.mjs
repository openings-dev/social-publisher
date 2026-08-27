import {
  DEPLOY_POLL_ATTEMPTS,
  DEPLOY_POLL_DELAY_MS,
  GITHUB_API_ORIGIN,
  INSTAGRAM_CARD_VERSION,
  MAX_REPOSITORY_DISPATCH_BODY_CHARACTERS,
  SOCIAL_VIDEO_VERSION,
} from '../../config/constants.mjs';
import { sha256 } from '../../shared/hash.mjs';
import { assertValidJobId } from '../../shared/job-id.mjs';
import { verifyPublicBridge } from './public-verifier.mjs';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
    throw new Error(`GitHub deployment dispatch failed for job ${safeJobId}`);
  }
  if (response.status !== 204) {
    throw new Error(`GitHub deployment dispatch failed for job ${safeJobId} with HTTP ${response.status}`);
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
