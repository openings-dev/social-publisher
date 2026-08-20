import { spawn } from 'node:child_process';
import path from 'node:path';

import { verifyPublicBridge } from './public-verifier.mjs';
import { assertValidJobId } from '../../shared/job-id.mjs';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertContentHash(value) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error('Bridge contentHash is invalid');
  }
  return value;
}

function assertJobRoot(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || path.posix.normalize(value) !== value || value.includes('..')) {
    throw new Error('FTP job root must be a safe absolute path');
  }
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(value)) {
    throw new Error('FTP job root contains unsupported characters');
  }
  return value.replace(/\/$/u, '');
}

function quote(value) {
  return `"${String(value).replace(/[\\"$`]/gu, (character) => `\\${character}`)}"`;
}

function assertNoControlCharacters(value, label) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} contains unsupported control characters`);
  }
  return value;
}

export function buildLftpUploadScript({ jobId, contentHash, htmlPath, imagePath, ftp }) {
  const safeJobId = assertValidJobId(jobId);
  const safeHash = assertContentHash(contentHash);
  const root = assertJobRoot(ftp.jobRoot);
  assertNoControlCharacters(htmlPath, 'HTML path');
  assertNoControlCharacters(imagePath, 'Image path');
  for (const key of ['server', 'username', 'password']) {
    if (typeof ftp[key] !== 'string' || ftp[key].length === 0) {
      throw new Error(`FTP ${key} is required`);
    }
    assertNoControlCharacters(ftp[key], `FTP ${key}`);
  }
  const remoteDirectory = `${root}/${safeJobId}`;
  const suffix = safeHash.slice(0, 12);
  const remoteImageTemporary = `${remoteDirectory}/.opengraph-image.${suffix}.tmp`;
  const remoteHtmlTemporary = `${remoteDirectory}/.index.${suffix}.tmp`;
  const remoteImage = `${remoteDirectory}/opengraph-image.png`;
  const remoteHtml = `${remoteDirectory}/index.html`;

  return [
    'set cmd:fail-exit yes',
    'set ftp:passive-mode yes',
    'set ftp:ssl-allow no',
    'set net:timeout 120',
    'set net:max-retries 2',
    'set net:reconnect-interval-base 5',
    `open --user ${quote(ftp.username)} --password ${quote(ftp.password)} ${quote(ftp.server)}`,
    `mkdir -p ${quote(remoteDirectory)}`,
    `put ${quote(imagePath)} -o ${quote(remoteImageTemporary)}`,
    `put ${quote(htmlPath)} -o ${quote(remoteHtmlTemporary)}`,
    `mv -f ${quote(remoteImageTemporary)} ${quote(remoteImage)}`,
    `mv -f ${quote(remoteHtmlTemporary)} ${quote(remoteHtml)}`,
    'bye',
    '',
  ].join('\n');
}

export async function executeLftpScript(script, { spawnImpl = spawn } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawnImpl('lftp', ['--norc'], { stdio: ['pipe', 'ignore', 'pipe'] });
    child.once('error', () => reject(new Error('Could not start LFTP')));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('LFTP command failed'));
    });
    child.stderr?.resume();
    child.stdin.end(script);
  });
}

export async function deployAndVerifyBridge({
  jobId,
  contentHash,
  expectedPngHash,
  htmlPath,
  imagePath,
  ftp,
  origin,
  fetchImpl,
  verifyPublic = verifyPublicBridge,
  runLftp = executeLftpScript,
}) {
  const verificationInput = { jobId, contentHash, expectedPngHash, origin, fetchImpl };
  const current = await verifyPublic({ ...verificationInput, allowMismatch: true });
  if (current.matches) {
    return Object.freeze({ status: 'already_current', verification: current });
  }

  const script = buildLftpUploadScript({ jobId, contentHash, htmlPath, imagePath, ftp });
  try {
    await runLftp(script);
  } catch {
    throw new Error(`FTP upload failed for job ${jobId}`);
  }

  const published = await verifyPublic({ ...verificationInput, allowMismatch: false });
  if (!published.matches) {
    throw new Error(`Public bridge verification failed after upload for job ${jobId}`);
  }
  return Object.freeze({ status: 'deployed', verification: published });
}
