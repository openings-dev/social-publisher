import { validatePublicationEnvelope } from '@trebla/publishing';

import { sha256 } from '../../shared/hash.mjs';

const INPUT_KEYS = Object.freeze([
  'jobId',
  'entityRevision',
  'entityContentSha256',
  'generation',
  'expiresAt',
  'canonical',
  'formattedText',
  'media',
]);
const DESCRIPTOR_KEYS = Object.freeze([
  'role',
  'logicalArtifactId',
  'sha256',
  'byteSize',
  'mediaType',
  'width',
  'height',
  'renderVersion',
]);
const FORMATS = Object.freeze([
  Object.freeze({ role: 'opengraph', mediaType: 'image/png', width: 1200, height: 630, extension: 'png' }),
  Object.freeze({ role: 'instagram-feed', mediaType: 'image/jpeg', width: 1080, height: 1350, extension: 'jpg' }),
  Object.freeze({ role: 'social-video', mediaType: 'video/mp4', width: 1080, height: 1920, extension: 'mp4' }),
]);
const RECORD_KEYS = Object.freeze([
  'schemaVersion', 'jobId', 'sourceId', 'dataCommit', 'dataHash', 'contentHash', 'entityRevision',
  'entityContentSha256', 'generation', 'preparedAt', 'expiresAt', 'requestDigest', 'canonical',
  'formattedText', 'socialTitle', 'direction', 'storyRequired', 'envelope', 'files',
]);
const FILE_KEYS = Object.freeze([...DESCRIPTOR_KEYS, 'fileName']);
const FILE_NAMES = Object.freeze(['opengraph-image.png', 'instagram-image.jpg', 'social-video.mp4']);
const DIRECTIONS = Object.freeze(['night', 'editorial', 'lavender', 'peach']);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function requireOwner(condition) {
  if (!condition) throw new Error('Invalid Openings media owner contract');
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, keys) {
  return record(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validBridgeString(value) {
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

function hash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function fixedTimestamp(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validateInput(input) {
  requireOwner(exact(input, INPUT_KEYS));
  requireOwner(typeof input.jobId === 'string' && /^gh_[a-f0-9]{24}$/u.test(input.jobId));
  requireOwner(validBridgeString(input.entityRevision));
  requireOwner(hash(input.entityContentSha256));
  requireOwner(positiveInteger(input.generation));
  requireOwner(fixedTimestamp(input.expiresAt));
  requireOwner(typeof input.formattedText === 'string' && input.formattedText.length > 0);
  requireOwner(Array.isArray(input.media) && input.media.length >= 2 && input.media.length <= 3);
  requireOwner(record(input.canonical)
    && Object.keys(input.canonical).every((key) => ['title', 'summary', 'canonicalUrl', 'language'].includes(key))
    && Object.hasOwn(input.canonical, 'title') && Object.hasOwn(input.canonical, 'canonicalUrl')
    && Object.hasOwn(input.canonical, 'language')
    && typeof input.canonical.title === 'string' && input.canonical.title.length > 0
    && (input.canonical.summary === undefined || typeof input.canonical.summary === 'string')
    && typeof input.canonical.language === 'string' && input.canonical.language.length > 0
    && input.canonical.canonicalUrl === `https://openings.dev/jobs/${input.jobId}`);
  const media = input.media.map((item, index) => {
    const format = FORMATS[index];
    requireOwner(format && exact(item, DESCRIPTOR_KEYS));
    requireOwner(item.role === format.role && item.mediaType === format.mediaType
      && item.width === format.width && item.height === format.height
      && validBridgeString(item.logicalArtifactId) && hash(item.sha256)
      && positiveInteger(item.byteSize, 50_000_000)
      && (item.role !== 'instagram-feed' || item.byteSize < 2 * 1024 * 1024)
      && typeof item.renderVersion === 'string' && /^[1-9][0-9]{0,31}$/u.test(item.renderVersion));
    requireOwner(!input.media.slice(0, index).some((entry) => entry.logicalArtifactId === item.logicalArtifactId));
    return item;
  });
  return { ...input, media };
}

export function openingsMediaOwnerDigestPreimage(input) {
  const value = validateInput(input);
  return JSON.stringify({
    contractVersion: 'openings-media-owner/v1',
    formatterVersion: 'openings-social-formatter/v1',
    tenant: 'openings',
    sourceType: 'social-media-owner',
    jobId: value.jobId,
    entityRevision: value.entityRevision,
    entityContentSha256: value.entityContentSha256,
    canonical: {
      title: value.canonical.title,
      summary: value.canonical.summary,
      canonicalUrl: value.canonical.canonicalUrl,
      language: value.canonical.language,
    },
    formattedText: value.formattedText,
    generation: value.generation,
    expiresAt: value.expiresAt,
    media: value.media.map((item) => ({
      role: item.role,
      logicalArtifactId: item.logicalArtifactId,
      sha256: item.sha256,
      byteSize: item.byteSize,
      mediaType: item.mediaType,
      width: item.width,
      height: item.height,
      renderVersion: item.renderVersion,
    })),
  });
}

function ownerResult(envelope, input, requestDigest) {
  return Object.freeze({
    requestDigest,
    retainedBytes: input.media.reduce((total, item) => total + item.byteSize, 0),
    envelope,
  });
}

export function buildOpeningsMediaOwnerEnvelope(input) {
  const value = validateInput(input);
  const requestDigest = sha256(openingsMediaOwnerDigestPreimage(value));
  const envelope = {
    schemaVersion: 1,
    identity: {
      tenant: 'openings',
      sourceType: 'social-media-owner',
      sourceId: value.jobId,
      revision: `sha256:${requestDigest}`,
      idempotencyKey: `openings:social-media-owner:${value.jobId}:${requestDigest}`,
    },
    canonical: value.canonical,
    artifacts: value.media.map((item, index) => ({
      id: item.logicalArtifactId,
      storage: 'r2-temporary',
      sha256: item.sha256,
      byteSize: item.byteSize,
      mediaType: item.mediaType,
      locator: `temporary/openings/bridge/${requestDigest}/${item.sha256}.${FORMATS[index].extension}`,
    })),
    deliveries: [{
      id: 'media-owner',
      adapter: 'social.openings-media',
      operation: 'retain-media',
      required: true,
      payload: {
        type: 'social.post',
        text: value.formattedText,
        artifactIds: value.media.map((item) => item.logicalArtifactId),
      },
      providerOptions: {
        schemaVersion: 1,
        jobId: value.jobId,
        entityRevision: value.entityRevision,
        entityContentSha256: value.entityContentSha256,
        generation: value.generation,
        expiresAt: value.expiresAt,
        media: value.media,
      },
    }],
  };
  return validateOpeningsMediaOwnerEnvelope(envelope);
}

export function validateOpeningsMediaOwnerEnvelope(value) {
  const envelope = validatePublicationEnvelope(value);
  requireOwner(new TextEncoder().encode(JSON.stringify(envelope)).byteLength <= 16 * 1024);
  requireOwner(exact(envelope, ['schemaVersion', 'identity', 'canonical', 'artifacts', 'deliveries']));
  requireOwner(exact(envelope.identity, ['tenant', 'sourceType', 'sourceId', 'revision', 'idempotencyKey'])
    && envelope.identity.tenant === 'openings'
    && envelope.identity.sourceType === 'social-media-owner');
  requireOwner(Array.isArray(envelope.deliveries) && envelope.deliveries.length === 1);
  const delivery = envelope.deliveries[0];
  requireOwner(exact(delivery, ['id', 'adapter', 'operation', 'required', 'payload', 'providerOptions'])
    && delivery.id === 'media-owner' && delivery.adapter === 'social.openings-media'
    && delivery.operation === 'retain-media' && delivery.required === true);
  requireOwner(exact(delivery.payload, ['type', 'text', 'artifactIds'])
    && delivery.payload.type === 'social.post');
  const options = delivery.providerOptions;
  requireOwner(exact(options, [
    'schemaVersion', 'jobId', 'entityRevision', 'entityContentSha256', 'generation', 'expiresAt', 'media',
  ]) && options.schemaVersion === 1);
  const input = validateInput({
    jobId: options.jobId,
    entityRevision: options.entityRevision,
    entityContentSha256: options.entityContentSha256,
    generation: options.generation,
    expiresAt: options.expiresAt,
    canonical: envelope.canonical,
    formattedText: delivery.payload.text,
    media: options.media,
  });
  requireOwner(envelope.identity.sourceId === input.jobId
    && Array.isArray(delivery.payload.artifactIds)
    && delivery.payload.artifactIds.length === input.media.length
    && envelope.artifacts.length === input.media.length);
  const requestDigest = sha256(openingsMediaOwnerDigestPreimage(input));
  requireOwner(envelope.identity.revision === `sha256:${requestDigest}`
    && envelope.identity.idempotencyKey === `openings:social-media-owner:${input.jobId}:${requestDigest}`);
  input.media.forEach((item, index) => {
    const artifact = envelope.artifacts[index];
    requireOwner(artifact.id === item.logicalArtifactId
      && artifact.storage === 'r2-temporary'
      && artifact.sha256 === item.sha256
      && artifact.byteSize === item.byteSize
      && artifact.mediaType === item.mediaType
      && artifact.locator === `temporary/openings/bridge/${requestDigest}/${item.sha256}.${FORMATS[index].extension}`
      && delivery.payload.artifactIds[index] === item.logicalArtifactId);
  });
  return ownerResult(envelope, input, requestDigest);
}

export function validateOpeningsMediaOwnerRecord(value, target) {
  requireOwner(exact(value, RECORD_KEYS) && value.schemaVersion === 1);
  requireOwner(record(target) && value.jobId === target.jobId && /^gh_[a-f0-9]{24}$/u.test(value.jobId));
  requireOwner(typeof value.sourceId === 'string' && value.sourceId.length > 0
    && typeof value.dataCommit === 'string' && /^[0-9a-f]{7,64}$/iu.test(value.dataCommit)
    && hash(value.dataHash) && hash(value.contentHash) && value.entityRevision === value.contentHash
    && hash(value.entityContentSha256) && positiveInteger(value.generation)
    && fixedTimestamp(value.preparedAt) && fixedTimestamp(value.expiresAt)
    && Date.parse(value.expiresAt) > Date.parse(value.preparedAt)
    && Date.parse(value.expiresAt) - Date.parse(value.preparedAt) <= WEEK_MS
    && hash(value.requestDigest) && typeof value.socialTitle === 'string' && value.socialTitle.length > 0
    && value.socialTitle === value.canonical?.title
    && DIRECTIONS.includes(value.direction) && typeof value.storyRequired === 'boolean'
    && typeof value.formattedText === 'string' && value.formattedText.length > 0
    && Array.isArray(value.files) && value.files.length >= 2 && value.files.length <= 3
    && value.storyRequired === (value.files.length === 3));
  const media = value.files.map((file, index) => {
    requireOwner(exact(file, FILE_KEYS) && file.fileName === FILE_NAMES[index]);
    const { fileName: _fileName, ...descriptor } = file;
    return descriptor;
  });
  const checked = validateOpeningsMediaOwnerEnvelope(value.envelope);
  const options = value.envelope.deliveries[0].providerOptions;
  requireOwner(checked.requestDigest === value.requestDigest
    && value.jobId === options.jobId && value.entityRevision === options.entityRevision
    && value.entityContentSha256 === options.entityContentSha256 && value.generation === options.generation
    && value.expiresAt === options.expiresAt
    && JSON.stringify(value.canonical) === JSON.stringify(value.envelope.canonical)
    && value.formattedText === value.envelope.deliveries[0].payload.text
    && JSON.stringify(media) === JSON.stringify(options.media));
  return value;
}
