import { randomUUID } from 'node:crypto';

import { buildSignedHeaders } from '@trebla/publishing';

import { sha256 } from '../../shared/hash.mjs';

const METADATA_MAX_BYTES = 64 * 1024;
const CONTENT_MAX_BYTES = 262_144;
const DEFAULT_TIMEOUT_MS = 15_000;
const BRIDGE_ROLES = Object.freeze(['opengraph', 'instagram-feed', 'instagram-story', 'social-video']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function fixedTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validString(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function positiveInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function exactOrigin(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a plain HTTPS origin`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a plain HTTPS origin`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/' || (value !== parsed.origin && value !== `${parsed.origin}/`)) {
    throw new Error(`${label} must be a plain HTTPS origin`);
  }
  return parsed.origin;
}

function validateTransport(transport) {
  if (!record(transport) || !validString(transport.clientId)
    || typeof transport.secret !== 'string' || transport.secret.length === 0) {
    throw new Error('Openings media read configuration is invalid');
  }
  return exactOrigin(transport.baseUrl, 'Publishing endpoint');
}

async function readBounded(response, maximum) {
  if (!(response.body instanceof ReadableStream)) throw new Error('Openings read response body is missing');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > maximum)) {
    try { await response.body.cancel(); } catch { /* Size remains authoritative. */ }
    throw new Error('Openings read response is too large');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Openings read response is invalid');
      if (value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maximum) {
        try { await reader.cancel(); } catch { /* Size remains authoritative. */ }
        throw new Error('Openings read response is too large');
      }
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original safe failure. */ }
    throw error;
  }
  if (total === 0) throw new Error('Openings read response body is empty');
  return Buffer.concat(chunks, total);
}

function parseJson(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Openings read response is invalid'); }
  try { return JSON.parse(text); }
  catch { throw new Error('Openings read response is invalid'); }
}

async function signedGet({ path, transport, now, nonce, timeoutMs, maximum }) {
  const origin = validateTransport(transport);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Openings read timeout is invalid');
  const instant = now();
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new Error('Openings read clock is invalid');
  const headers = await buildSignedHeaders({
    clientId: transport.clientId,
    secret: transport.secret,
    method: 'GET',
    path,
    tenant: 'openings',
    timestamp: instant.toISOString(),
    nonce: nonce(),
    body: '',
  });
  let response;
  try {
    response = await (transport.fetch ?? fetch)(`${origin}${path}`, {
      method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('Openings read request failed');
  }
  if (!(response instanceof Response) || !response.ok) {
    try { await response?.body?.cancel(); } catch { /* Never surface a response body. */ }
    throw new Error(`Openings read returned HTTP ${String(response?.status ?? 'invalid')}`);
  }
  if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
    try { await response.body?.cancel(); } catch { /* MIME mismatch remains authoritative. */ }
    throw new Error('Openings read response content type is invalid');
  }
  return readBounded(response, maximum);
}

function validateManifest(value, root, gatewayOrigin) {
  if (!exact(value, ['schemaVersion', 'tenant', 'jobId', 'entityRevision', 'entityContentSha256', 'generation', 'media'])
    || value.schemaVersion !== 1 || value.tenant !== 'openings' || value.jobId !== root.jobId
    || value.entityRevision !== root.entityRevision || value.entityContentSha256 !== root.entityContentSha256
    || !positiveInteger(value.generation) || !Array.isArray(value.media)
    || value.media.length < 1 || value.media.length > 4) throw new Error('Openings media metadata is invalid');
  const seen = new Set();
  for (const item of value.media) {
    if (!exact(item, ['role', 'artifactId', 'sha256', 'byteSize', 'mediaType', 'width', 'height', 'renderVersion'])
      || !BRIDGE_ROLES.includes(item.role) || seen.has(item.role)
      || typeof item.artifactId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/u.test(item.artifactId)
      || !hash(item.sha256) || !positiveInteger(item.byteSize, 50_000_000)
      || !positiveInteger(item.width, 8192) || !positiveInteger(item.height, 8192)
      || typeof item.renderVersion !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(item.renderVersion)
      || (item.role === 'social-video' ? item.mediaType !== 'video/mp4'
        : item.mediaType !== 'image/png' && item.mediaType !== 'image/jpeg')) {
      throw new Error('Openings media metadata is invalid');
    }
    seen.add(item.role);
  }
  const origin = exactOrigin(gatewayOrigin, 'Public media gateway');
  return { manifest: value, origin };
}

export function validateOpeningsMediaMetadata(value, { jobId, gatewayOrigin }) {
  if (!/^gh_[a-f0-9]{24}$/u.test(jobId)
    || !exact(value, ['schemaVersion', 'tenant', 'jobId', 'entityRevision', 'entityContentSha256', 'latestGeneration', 'bridge'])
    || value.schemaVersion !== 1 || value.tenant !== 'openings' || value.jobId !== jobId
    || !validString(value.entityRevision) || !hash(value.entityContentSha256)
    || !Number.isSafeInteger(value.latestGeneration) || value.latestGeneration < 0) {
    throw new Error('Openings media metadata is invalid');
  }
  if (value.bridge === null) return value;
  if (!exact(value.bridge, ['manifest', 'publicMedia']) || !Array.isArray(value.bridge.publicMedia)) {
    throw new Error('Openings media metadata is invalid');
  }
  const { manifest, origin } = validateManifest(value.bridge.manifest, value, gatewayOrigin);
  if (value.bridge.publicMedia.length !== manifest.media.length) throw new Error('Openings media metadata is invalid');
  value.bridge.publicMedia.forEach((item, index) => {
    const media = manifest.media[index];
    if (!exact(item, ['role', 'url', 'expiresAt']) || item.role !== media.role || !fixedTimestamp(item.expiresAt)
      || item.url !== `${origin}/media/openings/${media.artifactId}/${media.sha256}`) {
      throw new Error('Openings media metadata is invalid');
    }
  });
  return value;
}

export async function readOpeningsMediaMetadata({
  jobId,
  transport,
  gatewayOrigin,
  now = () => new Date(),
  nonce = randomUUID,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof jobId !== 'string' || !/^gh_[a-f0-9]{24}$/u.test(jobId)) throw new Error('Openings job ID is invalid');
  exactOrigin(gatewayOrigin, 'Public media gateway');
  const path = `/v1/openings/jobs/${jobId}/media`;
  const bytes = await signedGet({ path, transport, now, nonce, timeoutMs, maximum: METADATA_MAX_BYTES });
  return validateOpeningsMediaMetadata(parseJson(bytes), { jobId, gatewayOrigin });
}

export async function readOpeningsJobContent({
  selectedJob,
  metadata,
  transport,
  gatewayOrigin,
  now = () => new Date(),
  nonce = randomUUID,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!record(selectedJob) || typeof selectedJob.id !== 'string' || !/^gh_[a-f0-9]{24}$/u.test(selectedJob.id)
    || selectedJob.issueState !== 'open' || !validString(selectedJob.sourceId) || !hash(selectedJob.contentHash)) {
    throw new Error('Selected Openings job is invalid');
  }
  const checkedMetadata = validateOpeningsMediaMetadata(metadata, {
    jobId: selectedJob.id,
    gatewayOrigin: metadata?.bridge === null ? undefined : gatewayOrigin,
  });
  if (checkedMetadata.entityRevision !== selectedJob.contentHash) {
    throw new Error('Openings source identity changed');
  }
  const path = `/v1/openings/jobs/${selectedJob.id}/content/${checkedMetadata.entityContentSha256}`;
  const bytes = await signedGet({ path, transport, now, nonce, timeoutMs, maximum: CONTENT_MAX_BYTES });
  if (sha256(bytes) !== checkedMetadata.entityContentSha256) throw new Error('Openings content hash mismatch');
  const content = parseJson(bytes);
  if (!record(content) || content.id !== selectedJob.id || content.issueState !== 'open'
    || content.sourceId !== selectedJob.sourceId || content.sourceType !== selectedJob.sourceType
    || content.contentHash !== selectedJob.contentHash) {
    throw new Error('Openings source identity changed');
  }
  return content;
}
