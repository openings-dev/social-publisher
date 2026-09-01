import sharp from 'sharp';

import { OPENINGS_ORIGIN, REQUEST_TIMEOUT_MS } from '../../config/constants.mjs';
import { sha256 } from '../../shared/hash.mjs';

const NAMES = Object.freeze(['slide-01', 'slide-02', 'slide-03', 'slide-04', 'slide-05', 'slide-06', 'slide-07', 'story']);
const HASH = /^[0-9a-f]{64}$/u;

function mismatch(reason, allowMismatch) {
  if (allowMismatch) return Object.freeze({ matches: false, reason });
  throw new Error(`Public editorial verification failed: ${reason}`);
}

function validateIdentity(contentId, version) {
  if (typeof contentId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(contentId)) throw new Error('Editorial content ID is invalid');
  if (typeof version !== 'string' || !/^[1-9][0-9]*$/u.test(version)) throw new Error('Editorial version is invalid');
}

async function fetchBounded(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Verification timed out')), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyPublicEditorial({
  contentId,
  version,
  expectedSourceHashes,
  origin = OPENINGS_ORIGIN,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  allowMismatch = false,
}) {
  validateIdentity(contentId, version);
  if (expectedSourceHashes === null || typeof expectedSourceHashes !== 'object' || Array.isArray(expectedSourceHashes)) {
    throw new Error('Editorial source hashes are invalid');
  }
  const baseUrl = `${origin.replace(/\/$/u, '')}/social/editorial/${contentId}/${version}`;
  const manifestUrl = `${baseUrl}/manifest.json`;
  let response;
  try {
    response = await fetchBounded(manifestUrl, fetchImpl, timeoutMs);
  } catch {
    return mismatch('manifest_request_failed', allowMismatch);
  }
  if (!response.ok) return mismatch(response.status === 404 ? 'manifest_not_found' : 'manifest_http_error', allowMismatch);
  if (!/^application\/json\b/iu.test(response.headers.get('content-type') ?? '')) return mismatch('manifest_content_type_mismatch', allowMismatch);
  let manifest;
  try {
    manifest = await response.json();
  } catch {
    return mismatch('manifest_decode_failed', allowMismatch);
  }
  if (manifest?.schemaVersion !== 1 || manifest.contentId !== contentId || manifest.contentVersion !== version
    || !Array.isArray(manifest.assets) || manifest.assets.length !== NAMES.length) {
    return mismatch('manifest_contract_mismatch', allowMismatch);
  }
  const assetsByName = new Map(manifest.assets.map((asset) => [asset?.name, asset]));
  if (assetsByName.size !== NAMES.length) return mismatch('manifest_assets_mismatch', allowMismatch);
  const urls = [];
  for (const name of NAMES) {
    const asset = assetsByName.get(name);
    const expectedHeight = name === 'story' ? 1920 : 1350;
    if (!asset || asset.path !== `${name}.jpg` || asset.width !== 1080 || asset.height !== expectedHeight
      || !HASH.test(asset.sha256 ?? '') || asset.sourceSha256 !== expectedSourceHashes[name]) {
      return mismatch('manifest_assets_mismatch', allowMismatch);
    }
    const url = `${baseUrl}/${asset.path}`;
    let imageResponse;
    try {
      imageResponse = await fetchBounded(url, fetchImpl, timeoutMs);
    } catch {
      return mismatch('asset_request_failed', allowMismatch);
    }
    if (!imageResponse.ok) return mismatch('asset_http_error', allowMismatch);
    if (!/^image\/jpeg\b/iu.test(imageResponse.headers.get('content-type') ?? '')) return mismatch('asset_content_type_mismatch', allowMismatch);
    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    if (sha256(buffer) !== asset.sha256) return mismatch('asset_hash_mismatch', allowMismatch);
    let metadata;
    try {
      metadata = await sharp(buffer).metadata();
    } catch {
      return mismatch('asset_decode_failed', allowMismatch);
    }
    if (metadata.format !== 'jpeg' || metadata.width !== asset.width || metadata.height !== asset.height) {
      return mismatch('asset_dimensions_mismatch', allowMismatch);
    }
    urls.push(url);
  }
  return Object.freeze({
    matches: true,
    baseUrl,
    manifestUrl,
    carouselUrls: Object.freeze(urls.slice(0, 7)),
    storyUrl: urls[7],
    manifest,
  });
}

