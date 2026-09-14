import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { sha256 } from '../../shared/hash.mjs';
import {
  updateOpeningsR2FileState,
  validateOpeningsR2Manifest,
} from './openings-r2-manifest.mjs';

const PURPOSE = 'openings-public-social-media-v1';
const MAX_RUN_BYTES = 60 * 1024 * 1024;
const MAX_RETAINED_BYTES = 512 * 1024 * 1024;
const MAX_ACTIVE_OBJECTS = 1_000;
const MAX_RUN_STORAGE_OPERATIONS = 10;

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

async function observeCapacity(client, bucket) {
  const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: MAX_ACTIVE_OBJECTS }));
  if (!result || result.IsTruncated !== false
    || (result.Contents !== undefined && !Array.isArray(result.Contents))) {
    fail('Openings R2 bounded observation could not establish safe capacity');
  }
  const contents = result.Contents ?? [];
  let retainedBytes = 0;
  for (const object of contents) {
    if (typeof object?.Key !== 'string' || object.Key.length === 0
      || !Number.isSafeInteger(object.Size) || object.Size < 0) {
      fail('Openings R2 bounded observation could not establish safe capacity');
    }
    retainedBytes += object.Size;
    if (!Number.isSafeInteger(retainedBytes)) {
      fail('Openings R2 bounded observation could not establish safe capacity');
    }
  }
  return { activeObjectCount: contents.length, retainedBytes };
}

function validateCapacity(capacity, files, pendingCount) {
  const bytes = files.reduce((total, file) => total + file.byteSize, 0);
  const conservativeOperations = 1 + pendingCount + (files.length * 2);
  if (files.length > 3 || bytes > MAX_RUN_BYTES || capacity.retainedBytes + bytes > MAX_RETAINED_BYTES
    || capacity.activeObjectCount + files.length > MAX_ACTIVE_OBJECTS
    || conservativeOperations > MAX_RUN_STORAGE_OPERATIONS) {
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
  client = createOpeningsR2Client(config),
  checkpoint = async () => {},
}) {
  let next = validateOpeningsR2Manifest(manifest, manifest);
  const pending = next.files.filter((file) => file.uploadState === 'pending' || file.uploadState === 'ambiguous');
  const capacity = await observeCapacity(client, config.bucket);
  const missingFiles = [];
  for (const file of pending) {
    const target = { Bucket: config.bucket, Key: file.objectKey };
    let head;
    try {
      head = await client.send(new HeadObjectCommand(target));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (!head) missingFiles.push(file);
    else if (!matchesHead(head, file)) throw new Error('Existing R2 object conflicts with immutable manifest');
  }
  validateCapacity(capacity, missingFiles, pending.length);
  const missingRoles = new Set(missingFiles.map((file) => file.role));
  for (const file of pending) {
    const target = { Bucket: config.bucket, Key: file.objectKey };
    if (missingRoles.has(file.role)) {
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
        const raceHead = await client.send(new HeadObjectCommand(target));
        if (!matchesHead(raceHead, file)) throw new Error('Existing R2 object conflicts with immutable manifest');
      }
    }
    next = updateOpeningsR2FileState(next, file.role, 'uploaded');
    await checkpoint(next);
  }
  return next;
}
