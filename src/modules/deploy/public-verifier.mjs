import sharp from 'sharp';

import {
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  INSTAGRAM_CARD_VERSION,
  INSTAGRAM_IMAGE_HEIGHT,
  INSTAGRAM_IMAGE_WIDTH,
  OPENINGS_ORIGIN,
  REQUEST_TIMEOUT_MS,
  SOCIAL_VIDEO_HEIGHT,
  SOCIAL_VIDEO_VERSION,
  SOCIAL_VIDEO_WIDTH,
} from '../../config/constants.mjs';
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

async function fetchResponse(url, fetchImpl, timeoutMs, redirect = 'error') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Verification timed out')), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal, redirect });
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
  expectedInstagramCardVersion = INSTAGRAM_CARD_VERSION,
  expectedSocialVideoVersion = SOCIAL_VIDEO_VERSION,
  origin = OPENINGS_ORIGIN,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  allowMismatch = false,
}) {
  const canonicalUrl = buildCanonicalJobUrl(jobId, origin);
  const imageUrl = `${canonicalUrl}/opengraph-image.png`;
  const instagramImageUrl = `${canonicalUrl}/instagram-image.jpg`;
  const socialVideoUrl = `${canonicalUrl}/social-video.mp4`;
  const socialVideoCoverUrl = `${canonicalUrl}/social-video-cover.jpg`;
  let htmlResponse;
  try {
    htmlResponse = await fetchResponse(canonicalUrl, fetchImpl, timeoutMs, 'manual');
  } catch {
    return mismatch('html_request_failed', allowMismatch);
  }
  if (htmlResponse.status === 301 || htmlResponse.status === 308) {
    const redirectedUrl = `${canonicalUrl}/`;
    if (htmlResponse.headers.get('location') !== redirectedUrl) {
      return mismatch('html_redirect_mismatch', allowMismatch);
    }
    try {
      htmlResponse = await fetchResponse(redirectedUrl, fetchImpl, timeoutMs);
    } catch {
      return mismatch('html_request_failed', allowMismatch);
    }
  }
  const edgeBlocked = htmlResponse.status === 403
    && /cloudflare/iu.test(htmlResponse.headers.get('server') ?? '');
  if (!edgeBlocked) {
    if (!htmlResponse.ok) {
      return mismatch(htmlResponse.status === 404 ? 'not_found' : 'html_http_error', allowMismatch);
    }
    if (!/^text\/html\b/iu.test(htmlResponse.headers.get('content-type') ?? '')) {
      return mismatch('html_content_type_mismatch', allowMismatch);
    }
    const tags = collectTags(await htmlResponse.text());
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
    if (findContent(tags, 'name', 'openings:instagram-card-version', 'content')
      !== expectedInstagramCardVersion) {
      return mismatch('instagram_card_version_mismatch', allowMismatch);
    }
    if (findContent(tags, 'name', 'openings:social-video-version', 'content')
      !== expectedSocialVideoVersion) {
      return mismatch('social_video_version_mismatch', allowMismatch);
    }
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

  let instagramImageResponse;
  try {
    instagramImageResponse = await fetchResponse(instagramImageUrl, fetchImpl, timeoutMs);
  } catch {
    return mismatch('instagram_image_request_failed', allowMismatch);
  }
  if (!instagramImageResponse.ok) {
    return mismatch(instagramImageResponse.status === 404
      ? 'instagram_image_not_found'
      : 'instagram_image_http_error', allowMismatch);
  }
  if (!/^image\/jpeg\b/iu.test(instagramImageResponse.headers.get('content-type') ?? '')) {
    return mismatch('instagram_image_content_type_mismatch', allowMismatch);
  }
  let instagramMetadata;
  try {
    instagramMetadata = await sharp(Buffer.from(await instagramImageResponse.arrayBuffer())).metadata();
  } catch {
    return mismatch('instagram_image_decode_failed', allowMismatch);
  }
  if (instagramMetadata.format !== 'jpeg'
    || instagramMetadata.width !== INSTAGRAM_IMAGE_WIDTH
    || instagramMetadata.height !== INSTAGRAM_IMAGE_HEIGHT) {
    return mismatch('instagram_image_dimensions_mismatch', allowMismatch);
  }

  let socialVideoCoverResponse;
  try {
    socialVideoCoverResponse = await fetchResponse(socialVideoCoverUrl, fetchImpl, timeoutMs);
  } catch {
    return mismatch('social_video_cover_request_failed', allowMismatch);
  }
  if (!socialVideoCoverResponse.ok) {
    return mismatch(socialVideoCoverResponse.status === 404
      ? 'social_video_cover_not_found'
      : 'social_video_cover_http_error', allowMismatch);
  }
  if (!/^image\/jpeg\b/iu.test(socialVideoCoverResponse.headers.get('content-type') ?? '')) {
    return mismatch('social_video_cover_content_type_mismatch', allowMismatch);
  }
  let socialVideoCoverMetadata;
  try {
    socialVideoCoverMetadata = await sharp(
      Buffer.from(await socialVideoCoverResponse.arrayBuffer()),
    ).metadata();
  } catch {
    return mismatch('social_video_cover_decode_failed', allowMismatch);
  }
  if (socialVideoCoverMetadata.format !== 'jpeg'
    || socialVideoCoverMetadata.width !== SOCIAL_VIDEO_WIDTH
    || socialVideoCoverMetadata.height !== SOCIAL_VIDEO_HEIGHT) {
    return mismatch('social_video_cover_dimensions_mismatch', allowMismatch);
  }

  let socialVideoResponse;
  try {
    socialVideoResponse = await fetchResponse(socialVideoUrl, fetchImpl, timeoutMs);
  } catch {
    return mismatch('social_video_request_failed', allowMismatch);
  }
  if (!socialVideoResponse.ok) {
    return mismatch(socialVideoResponse.status === 404
      ? 'social_video_not_found'
      : 'social_video_http_error', allowMismatch);
  }
  if (!/^video\/mp4\b/iu.test(socialVideoResponse.headers.get('content-type') ?? '')) {
    return mismatch('social_video_content_type_mismatch', allowMismatch);
  }
  const socialVideo = Buffer.from(await socialVideoResponse.arrayBuffer());
  if (socialVideo.byteLength < 12 || socialVideo.subarray(4, 8).toString('ascii') !== 'ftyp') {
    return mismatch('social_video_container_mismatch', allowMismatch);
  }
  return Object.freeze({
    matches: true,
    canonicalUrl,
    imageUrl,
    instagramImageUrl,
    socialVideoUrl,
    socialVideoCoverUrl,
    contentHash,
    pngHash: expectedPngHash,
    instagramCardVersion: expectedInstagramCardVersion,
    socialVideoVersion: expectedSocialVideoVersion,
    htmlVerification: edgeBlocked ? 'edge_blocked_assets_verified' : 'verified',
  });
}
