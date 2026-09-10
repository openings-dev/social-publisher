import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256 } from '../../shared/hash.mjs';
import { describeOpeningsMediaFile } from './openings-media-files.mjs';

function invalid() {
  throw new Error('Invalid public R2 media');
}

function exactOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { invalid(); }
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash
    || parsed.username || parsed.password || (value !== parsed.origin && value !== `${parsed.origin}/`)) invalid();
  return parsed.origin;
}

async function readExact(response, expectedBytes) {
  if (!(response.body instanceof ReadableStream)) invalid();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) invalid();
    total += value.byteLength;
    if (total > expectedBytes) {
      try { await reader.cancel(); } catch { /* Size failure remains authoritative. */ }
      invalid();
    }
    chunks.push(value);
  }
  if (total !== expectedBytes) invalid();
  return Buffer.concat(chunks, total);
}

async function inspectDownloaded(bytes, file) {
  const directory = await mkdtemp(join(tmpdir(), 'openings-r2-verify-'));
  try {
    const path = join(directory, file.fileName);
    await writeFile(path, bytes, { flag: 'wx' });
    await describeOpeningsMediaFile({ ...file, filePath: path });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyOpeningsR2File(file, {
  publicOrigin,
  fetchImpl = fetch,
  inspectBytes = inspectDownloaded,
  timeoutMs = 15_000,
} = {}) {
  const origin = exactOrigin(publicOrigin);
  if (!file || typeof file !== 'object' || typeof file.objectKey !== 'string'
    || file.url !== `${origin}/${file.objectKey}` || !file.objectKey.startsWith('openings/jobs/')
    || !Number.isSafeInteger(file.byteSize) || file.byteSize < 1 || file.byteSize > 50_000_000
    || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) invalid();
  let response;
  try {
    response = await fetchImpl(file.url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch { invalid(); }
  if (!(response instanceof Response) || !response.ok
    || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== file.mediaType) invalid();
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) !== file.byteSize)) invalid();
  const bytes = await readExact(response, file.byteSize);
  if (sha256(bytes) !== file.sha256) invalid();
  try { await inspectBytes(bytes, file); } catch { invalid(); }
  return { ...file, uploadState: 'verified' };
}
