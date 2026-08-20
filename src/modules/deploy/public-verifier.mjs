import sharp from 'sharp';

import { IMAGE_HEIGHT, IMAGE_WIDTH, OPENINGS_ORIGIN, REQUEST_TIMEOUT_MS } from '../../config/constants.mjs';
import { sha256 } from '../../shared/hash.mjs';
import { buildCanonicalJobUrl } from '../../shared/job-id.mjs';

function parseAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([:\w-]+)="([^"]*)"/gu)) {
    attributes[match[1].toLowerCase()] = match[2];
  }
  return attributes;
}

function collectTags(html) {
  return [...html.matchAll(/<(?:meta|link)\b[^>]*>/giu)].map((match) => parseAttributes(match[0]));
}

function findContent(tags, attribute, value, target) {
  return tags.find((tag) => tag[attribute] === value)?.[target] ?? null;
}

async function fetchResponse(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Verification timed out')), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
  } finally {
    clearTimeout(timeout);
  }
}

function mismatch(reason, allowMismatch) {
  if (allowMismatch) {
    return Object.freeze({ matches: false, reason });
  }
  throw new Error(`Public bridge verification failed: ${reason}`);
}

export async function verifyPublicBridge({
  jobId,
  contentHash,
  expectedPngHash,
  origin = OPENINGS_ORIGIN,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  allowMismatch = false,
}) {
  const canonicalUrl = buildCanonicalJobUrl(jobId, origin);
  const imageUrl = `${canonicalUrl}/opengraph-image.png`;
  let htmlResponse;
  try {
    htmlResponse = await fetchResponse(canonicalUrl, fetchImpl, timeoutMs);
  } catch {
    return mismatch('html_request_failed', allowMismatch);
  }
  if (!htmlResponse.ok) {
    return mismatch(htmlResponse.status === 404 ? 'not_found' : 'html_http_error', allowMismatch);
  }
  if (!/^text\/html\b/iu.test(htmlResponse.headers.get('content-type') ?? '')) {
    return mismatch('html_content_type_mismatch', allowMismatch);
  }
  const html = await htmlResponse.text();
  const tags = collectTags(html);
  if (findContent(tags, 'rel', 'canonical', 'href') !== canonicalUrl) {
    return mismatch('canonical_url_mismatch', allowMismatch);
  }
  if (findContent(tags, 'property', 'og:url', 'content') !== canonicalUrl) {
    return mismatch('open_graph_url_mismatch', allowMismatch);
  }
  if (findContent(tags, 'property', 'og:image', 'content') !== imageUrl) {
    return mismatch('open_graph_image_mismatch', allowMismatch);
  }
  if (findContent(tags, 'name', 'openings:data-hash', 'content') !== contentHash) {
    return mismatch('content_hash_mismatch', allowMismatch);
  }

  let imageResponse;
  try {
    imageResponse = await fetchResponse(imageUrl, fetchImpl, timeoutMs);
  } catch {
    return mismatch('image_request_failed', allowMismatch);
  }
  if (!imageResponse.ok) {
    return mismatch(imageResponse.status === 404 ? 'image_not_found' : 'image_http_error', allowMismatch);
  }
  if (!/^image\/png\b/iu.test(imageResponse.headers.get('content-type') ?? '')) {
    return mismatch('image_content_type_mismatch', allowMismatch);
  }
  const png = Buffer.from(await imageResponse.arrayBuffer());
  if (sha256(png) !== expectedPngHash) {
    return mismatch('image_hash_mismatch', allowMismatch);
  }
  let metadata;
  try {
    metadata = await sharp(png).metadata();
  } catch {
    return mismatch('image_decode_failed', allowMismatch);
  }
  if (metadata.format !== 'png' || metadata.width !== IMAGE_WIDTH || metadata.height !== IMAGE_HEIGHT) {
    return mismatch('image_dimensions_mismatch', allowMismatch);
  }
  return Object.freeze({
    matches: true,
    canonicalUrl,
    imageUrl,
    contentHash,
    pngHash: expectedPngHash,
  });
}
