import { sha256 } from '../../shared/hash.mjs';

const RECORD_KEYS = Object.freeze([
  'schemaVersion', 'jobId', 'sourceId', 'contentHash', 'requestDigest', 'createdAt',
  'publicOrigin', 'files', 'manifestDigest',
]);
const FILE_KEYS = Object.freeze([
  'role', 'fileName', 'logicalArtifactId', 'objectKey', 'url', 'sha256', 'byteSize',
  'mediaType', 'width', 'height', 'renderVersion', 'uploadState', 'consumers',
]);
const CONSUMER_KEYS = Object.freeze(['channel', 'state', 'remoteId', 'updatedAt']);
const ROLES = new Set(['opengraph', 'instagram-feed', 'social-video']);
const CHANNELS = new Set(['bluesky', 'mastodon', 'twitter', 'threads', 'instagram', 'linkedin', 'instagramStory']);
const UPLOAD_STATES = new Set(['pending', 'uploaded', 'verified', 'ambiguous']);
const CONSUMER_STATES = new Set(['pending', 'accepted', 'completed', 'ambiguous', 'skipped']);

function fail(condition) {
  if (!condition) throw new Error('Invalid Openings R2 manifest');
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, keys) {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function hash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function fixedTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function origin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail(false); }
  fail(parsed.protocol === 'https:' && !parsed.username && !parsed.password
    && !parsed.search && !parsed.hash && parsed.pathname === '/'
    && (value === parsed.origin || value === `${parsed.origin}/`));
  return parsed.origin;
}

function preimage(value) {
  const { manifestDigest: _manifestDigest, ...unsigned } = value;
  return JSON.stringify(unsigned);
}

export function validateOpeningsR2Manifest(value, target) {
  fail(exact(value, RECORD_KEYS) && value.schemaVersion === 1 && record(target));
  fail(/^gh_[a-f0-9]{24}$/u.test(value.jobId) && value.jobId === target.jobId
    && typeof value.sourceId === 'string' && value.sourceId === target.sourceId
    && hash(value.contentHash) && value.contentHash === target.contentHash
    && hash(value.requestDigest) && fixedTimestamp(value.createdAt)
    && hash(value.manifestDigest));
  const publicOrigin = origin(value.publicOrigin);
  fail(Array.isArray(value.files) && value.files.length >= 1 && value.files.length <= 3);
  const seenRoles = new Set();
  const seenKeys = new Set();
  for (const file of value.files) {
    fail(exact(file, FILE_KEYS) && ROLES.has(file.role) && !seenRoles.has(file.role)
      && typeof file.fileName === 'string' && /^[a-z0-9-]+\.(?:png|jpg|mp4)$/u.test(file.fileName)
      && typeof file.logicalArtifactId === 'string' && /^[a-z0-9-]{1,64}$/u.test(file.logicalArtifactId)
      && hash(file.sha256) && Number.isSafeInteger(file.byteSize) && file.byteSize > 0
      && file.byteSize <= 50_000_000 && Number.isSafeInteger(file.width) && file.width > 0
      && Number.isSafeInteger(file.height) && file.height > 0
      && typeof file.renderVersion === 'string' && /^[1-9][0-9]{0,31}$/u.test(file.renderVersion)
      && UPLOAD_STATES.has(file.uploadState));
    const expectedKey = `openings/jobs/${value.jobId}/${value.contentHash}/${value.requestDigest}/${file.fileName}`;
    fail(file.objectKey === expectedKey && !seenKeys.has(file.objectKey)
      && file.url === `${publicOrigin}/${expectedKey}`);
    fail((file.role === 'opengraph' && file.mediaType === 'image/png' && file.width === 1200 && file.height === 630)
      || (file.role === 'instagram-feed' && file.mediaType === 'image/jpeg' && file.width === 1080 && file.height === 1350)
      || (file.role === 'social-video' && file.mediaType === 'video/mp4' && file.width === 1080 && file.height === 1920));
    fail(Array.isArray(file.consumers) && file.consumers.length >= 1 && file.consumers.length <= CHANNELS.size);
    const seenChannels = new Set();
    for (const consumer of file.consumers) {
      fail(exact(consumer, CONSUMER_KEYS) && CHANNELS.has(consumer.channel)
        && !seenChannels.has(consumer.channel) && CONSUMER_STATES.has(consumer.state)
        && (consumer.remoteId === null || (typeof consumer.remoteId === 'string' && consumer.remoteId.length > 0))
        && (consumer.updatedAt === null || fixedTimestamp(consumer.updatedAt)));
      fail((consumer.state === 'pending' && consumer.remoteId === null && consumer.updatedAt === null)
        || consumer.state !== 'pending');
      seenChannels.add(consumer.channel);
    }
    seenRoles.add(file.role);
    seenKeys.add(file.objectKey);
  }
  fail(sha256(preimage(value)) === value.manifestDigest);
  return value;
}

export function buildOpeningsR2Manifest({ mediaOwner, publicOrigin, consumersByRole }) {
  fail(record(mediaOwner) && record(consumersByRole));
  const normalizedOrigin = origin(publicOrigin);
  const value = {
    schemaVersion: 1,
    jobId: mediaOwner.jobId,
    sourceId: mediaOwner.sourceId,
    contentHash: mediaOwner.contentHash,
    requestDigest: mediaOwner.requestDigest,
    createdAt: mediaOwner.preparedAt,
    publicOrigin: normalizedOrigin,
    files: mediaOwner.files.map((file) => {
      const consumers = consumersByRole[file.role];
      fail(Array.isArray(consumers));
      const objectKey = `openings/jobs/${mediaOwner.jobId}/${mediaOwner.contentHash}/${mediaOwner.requestDigest}/${file.fileName}`;
      return {
        ...file,
        objectKey,
        url: `${normalizedOrigin}/${objectKey}`,
        uploadState: 'pending',
        consumers: consumers.map((channel) => ({ channel, state: 'pending', remoteId: null, updatedAt: null })),
      };
    }),
  };
  const manifest = { ...value, manifestDigest: sha256(JSON.stringify(value)) };
  return validateOpeningsR2Manifest(manifest, mediaOwner);
}

export function updateOpeningsR2FileState(manifest, role, uploadState) {
  validateOpeningsR2Manifest(manifest, manifest);
  fail(ROLES.has(role) && UPLOAD_STATES.has(uploadState));
  const index = manifest.files.findIndex((file) => file.role === role);
  fail(index >= 0);
  const files = manifest.files.map((file, fileIndex) => fileIndex === index ? { ...file, uploadState } : file);
  const unsigned = { ...manifest, files };
  delete unsigned.manifestDigest;
  return validateOpeningsR2Manifest({ ...unsigned, manifestDigest: sha256(JSON.stringify(unsigned)) }, manifest);
}

export function updateOpeningsR2Consumer(manifest, channel, { state, remoteId = null, updatedAt }) {
  validateOpeningsR2Manifest(manifest, manifest);
  fail(CHANNELS.has(channel) && CONSUMER_STATES.has(state) && fixedTimestamp(updatedAt));
  fail((state === 'accepted' || state === 'completed')
    ? typeof remoteId === 'string' && remoteId.length > 0
    : remoteId === null || (typeof remoteId === 'string' && remoteId.length > 0));
  let found = false;
  const files = manifest.files.map((file) => ({
    ...file,
    consumers: file.consumers.map((consumer) => {
      if (consumer.channel !== channel) return consumer;
      found = true;
      return { channel, state, remoteId, updatedAt };
    }),
  }));
  fail(found);
  const unsigned = { ...manifest, files };
  delete unsigned.manifestDigest;
  return validateOpeningsR2Manifest({ ...unsigned, manifestDigest: sha256(JSON.stringify(unsigned)) }, manifest);
}
