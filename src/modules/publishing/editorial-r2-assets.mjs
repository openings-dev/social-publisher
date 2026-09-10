import { HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';

import { sha256 } from '../../shared/hash.mjs';

const MAX_RUN_BYTES = 32 * 1024 * 1024;
const MAX_RETAINED_BYTES = 512 * 1024 * 1024;
const MAX_ACTIVE_OBJECTS = 1_000;
const MAX_RUN_STORAGE_OPERATIONS = 22;

function fail(message) {
  throw new Error(message);
}

function missing(error) {
  return error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;
}

function precondition(error) {
  return error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412;
}

function matches(head, asset) {
  return head?.ContentLength === asset.byteSize && head?.ContentType === 'image/jpeg'
    && head?.Metadata?.sha256 === asset.sha256;
}

async function observeCapacity(storage, bucket) {
  const result = await storage.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: MAX_ACTIVE_OBJECTS }));
  if (!result || result.IsTruncated === true || (result.Contents !== undefined && !Array.isArray(result.Contents))) {
    fail('Editorial R2 bounded observation could not establish safe capacity');
  }
  const contents = result.Contents ?? [];
  let retainedBytes = 0;
  for (const object of contents) {
    if (typeof object?.Key !== 'string' || !Number.isSafeInteger(object.Size) || object.Size < 0) {
      fail('Editorial R2 bounded observation could not establish safe capacity');
    }
    retainedBytes += object.Size;
    if (!Number.isSafeInteger(retainedBytes)) fail('Editorial R2 bounded observation could not establish safe capacity');
  }
  return { activeObjectCount: contents.length, retainedBytes };
}

function validateCapacity(capacity, missingAssets) {
  const bytes = missingAssets.reduce((sum, asset) => sum + asset.byteSize, 0);
  const conservativeOperations = 1 + 7 + missingAssets.length * 2;
  if (missingAssets.length > 7 || bytes > MAX_RUN_BYTES || capacity.retainedBytes + bytes > MAX_RETAINED_BYTES
    || capacity.activeObjectCount + missingAssets.length > MAX_ACTIVE_OBJECTS
    || conservativeOperations > MAX_RUN_STORAGE_OPERATIONS) {
    fail('Openings R2 safe admission limit reached');
  }
}

async function renderSlides(carouselSvgs) {
  if (!Array.isArray(carouselSvgs) || carouselSvgs.length !== 7) fail('Editorial carousel must contain seven slides');
  return Promise.all(carouselSvgs.map(async (svg) => {
    const bytes = await sharp(Buffer.from(svg)).flatten({ background: '#FFFEFA' })
      .jpeg({ quality: 86, chromaSubsampling: '4:4:4' }).toBuffer();
    const metadata = await sharp(bytes).metadata();
    if (metadata.format !== 'jpeg' || metadata.width !== 1080 || metadata.height !== 1350 || bytes.byteLength >= 4 * 1024 * 1024) {
      fail('Rendered editorial asset is invalid');
    }
    return bytes;
  }));
}

async function verify(asset, fetchImpl) {
  let response;
  try { response = await fetchImpl(asset.url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { fail('Invalid public editorial R2 asset'); }
  if (!(response instanceof Response) || !response.ok
    || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'image/jpeg') {
    fail('Invalid public editorial R2 asset');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) !== asset.byteSize) fail('Invalid public editorial R2 asset');
  if (!(response.body instanceof ReadableStream)) fail('Invalid public editorial R2 asset');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) fail('Invalid public editorial R2 asset');
    total += value.byteLength;
    if (total > asset.byteSize) {
      try { await reader.cancel(); } catch { /* The size failure remains authoritative. */ }
      fail('Invalid public editorial R2 asset');
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, total);
  if (bytes.byteLength !== asset.byteSize || sha256(bytes) !== asset.sha256) fail('Invalid public editorial R2 asset');
}

export async function publishEditorialAssetsToR2({
  content, carouselSvgs, renderVersion, config, client, fetchImpl = fetch,
}) {
  if (!content || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(content.id)
    || !/^[1-9][0-9]*$/u.test(content.version) || !/^[1-9][0-9]*$/u.test(renderVersion)
    || typeof config?.bucket !== 'string' || typeof config?.publicOrigin !== 'string') {
    fail('Editorial R2 configuration is invalid');
  }
  const origin = new URL(config.publicOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) fail('Editorial R2 configuration is invalid');
  const slides = await renderSlides(carouselSvgs);
  const prefix = `openings/editorial/${content.id}/${content.version}/${renderVersion}`;
  const assets = slides.map((body, index) => {
    const fileName = `slide-${String(index + 1).padStart(2, '0')}.jpg`;
    const objectKey = `${prefix}/${fileName}`;
    return { body, byteSize: body.byteLength, sha256: sha256(body), objectKey, url: `${origin.origin}/${objectKey}` };
  });
  const storage = client ?? new S3Client({ region: config.region, endpoint: config.endpoint, credentials: config.credentials });
  const capacity = await observeCapacity(storage, config.bucket);
  const missingAssets = [];
  for (const asset of assets) {
    const target = { Bucket: config.bucket, Key: asset.objectKey };
    let head;
    try { head = await storage.send(new HeadObjectCommand(target)); } catch (error) { if (!missing(error)) throw error; }
    if (!head) missingAssets.push(asset);
    else if (!matches(head, asset)) fail('Existing R2 object conflicts with immutable editorial asset');
  }
  validateCapacity(capacity, missingAssets);
  for (const asset of missingAssets) {
    const target = { Bucket: config.bucket, Key: asset.objectKey };
    try {
      await storage.send(new PutObjectCommand({ ...target, Body: asset.body, ContentLength: asset.byteSize,
        ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000, immutable',
        Metadata: { sha256: asset.sha256 }, IfNoneMatch: '*' }));
    } catch (error) {
      if (!precondition(error)) {
        if (error && typeof error === 'object' && typeof error.code === 'string') throw error;
        throw Object.assign(new Error('Editorial R2 upload was interrupted'), { code: 'editorial_r2_upload_interrupted' });
      }
      const head = await storage.send(new HeadObjectCommand(target));
      if (!matches(head, asset)) fail('Existing R2 object conflicts with immutable editorial asset');
    }
  }
  for (const asset of assets) {
    await verify(asset, fetchImpl);
  }
  return Object.freeze({ status: 'hosted', verification: Object.freeze({
    carouselUrls: Object.freeze(assets.map(({ url }) => url)),
    carouselMedia: Object.freeze(assets.map(({ url }) => Object.freeze({
      url, mediaType: 'image/jpeg', width: 1080, height: 1350,
    }))),
  }) });
}
