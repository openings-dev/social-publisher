import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { sha256 } from '../../shared/hash.mjs';
import {
  updateOpeningsR2FileState,
  validateOpeningsR2Manifest,
} from './openings-r2-manifest.mjs';

const PURPOSE = 'openings-public-social-media-v1';
const MAX_EVIDENCE_AGE_MS = 15 * 60 * 1000;
const MAX_RUN_BYTES = 60 * 1024 * 1024;
const MAX_RETAINED_BYTES = 512 * 1024 * 1024;
const MAX_ACTIVE_OBJECTS = 1_000;
const MAX_CLASS_A_OPERATIONS = 100_000;

function fail(message = 'Openings R2 configuration is invalid') {
  throw new Error(message);
}

function plainHttpsOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/'
    || parsed.search || parsed.hash || (value !== parsed.origin && value !== `${parsed.origin}/`)) fail();
  return parsed.origin;
}

export function readOpeningsR2Config(env) {
  if (!env || typeof env !== 'object' || env.OPENINGS_R2_BUCKET_PURPOSE !== PURPOSE
    || typeof env.OPENINGS_R2_ACCOUNT_ID !== 'string' || !/^[a-f0-9]{32}$/u.test(env.OPENINGS_R2_ACCOUNT_ID)
    || typeof env.OPENINGS_R2_BUCKET !== 'string'
    || !/^openings-[a-z0-9-]*public[a-z0-9-]*social[a-z0-9-]*media[a-z0-9-]*$/u.test(env.OPENINGS_R2_BUCKET)
    || typeof env.OPENINGS_R2_ACCESS_KEY_ID !== 'string' || env.OPENINGS_R2_ACCESS_KEY_ID.length < 4
    || typeof env.OPENINGS_R2_SECRET_ACCESS_KEY !== 'string' || env.OPENINGS_R2_SECRET_ACCESS_KEY.length < 8) fail();
  const publicOrigin = plainHttpsOrigin(env.OPENINGS_R2_PUBLIC_ORIGIN);
  const endpoint = `https://${env.OPENINGS_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const config = { endpoint, bucket: env.OPENINGS_R2_BUCKET, publicOrigin, region: 'auto' };
  Object.defineProperty(config, 'credentials', {
    value: { accessKeyId: env.OPENINGS_R2_ACCESS_KEY_ID, secretAccessKey: env.OPENINGS_R2_SECRET_ACCESS_KEY },
    enumerable: false,
  });
  return Object.freeze(config);
}

export function createOpeningsR2Client(config) {
  return new S3Client({ region: config.region, endpoint: config.endpoint, credentials: config.credentials });
}

export function readOpeningsR2Capacity(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail('Openings R2 capacity evidence is stale or invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'activeObjectCount,classAOperations,observedAt,retainedBytes,standardStorageBytes') {
    fail('Openings R2 capacity evidence is stale or invalid');
  }
  return Object.freeze(parsed);
}

function validateCapacity(capacity, instant, files) {
  if (!capacity || typeof capacity !== 'object' || !Number.isFinite(Date.parse(capacity.observedAt))
    || Math.abs(instant.getTime() - Date.parse(capacity.observedAt)) > MAX_EVIDENCE_AGE_MS) {
    fail('Openings R2 capacity evidence is stale or invalid');
  }
  for (const key of ['standardStorageBytes', 'classAOperations', 'activeObjectCount', 'retainedBytes']) {
    if (!Number.isSafeInteger(capacity[key]) || capacity[key] < 0) fail('Openings R2 capacity evidence is stale or invalid');
  }
  const bytes = files.reduce((total, file) => total + file.byteSize, 0);
  if (files.length > 3 || bytes > MAX_RUN_BYTES || capacity.retainedBytes + bytes > MAX_RETAINED_BYTES
    || capacity.activeObjectCount + files.length > MAX_ACTIVE_OBJECTS
    || capacity.classAOperations + files.length > MAX_CLASS_A_OPERATIONS) {
    fail('Openings R2 safe admission limit reached');
  }
}

function missing(error) {
  return error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;
}

function precondition(error) {
  return error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412;
}

function matchesHead(head, file) {
  return head && head.ContentLength === file.byteSize && head.ContentType === file.mediaType
    && head.Metadata?.sha256 === file.sha256;
}

export async function ensureOpeningsR2Objects({
  config,
  manifest,
  preparationDirectory,
  capacity,
  now = () => new Date(),
  client = createOpeningsR2Client(config),
  checkpoint = async () => {},
}) {
  let next = validateOpeningsR2Manifest(manifest, manifest);
  const instant = now();
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) fail('Openings R2 capacity evidence is stale or invalid');
  const pending = next.files.filter((file) => file.uploadState === 'pending' || file.uploadState === 'ambiguous');
  validateCapacity(capacity, instant, pending);
  for (const file of pending) {
    const target = { Bucket: config.bucket, Key: file.objectKey };
    let head;
    try {
      head = await client.send(new HeadObjectCommand(target));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (!head) {
      const body = await readFile(join(preparationDirectory, file.fileName));
      if (body.byteLength !== file.byteSize || sha256(body) !== file.sha256) {
        throw new Error('Prepared R2 media bytes do not match manifest');
      }
      try {
        await client.send(new PutObjectCommand({
          ...target,
          Body: body,
          ContentLength: file.byteSize,
          ContentType: file.mediaType,
          CacheControl: 'public, max-age=31536000, immutable',
          Metadata: { sha256: file.sha256 },
          IfNoneMatch: '*',
        }));
      } catch (error) {
        if (!precondition(error)) {
          next = updateOpeningsR2FileState(next, file.role, 'ambiguous');
          await checkpoint(next);
          throw error;
        }
        head = await client.send(new HeadObjectCommand(target));
        if (!matchesHead(head, file)) throw new Error('Existing R2 object conflicts with immutable manifest');
      }
    } else if (!matchesHead(head, file)) {
      throw new Error('Existing R2 object conflicts with immutable manifest');
    }
    next = updateOpeningsR2FileState(next, file.role, 'uploaded');
    await checkpoint(next);
  }
  return next;
}
