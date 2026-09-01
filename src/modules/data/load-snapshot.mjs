import path from 'node:path';

import { isValidJobId } from '../../shared/job-id.mjs';
import { readJsonAtCommit } from './git-json.mjs';

const SNAPSHOT_ROOT = 'snapshots/opportunities';
const SUPPORTED_SCHEMA_VERSIONS = new Set([4, 5, 6]);
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertIsoDate(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date`);
  }
}

function assertRelativeApiPath(value, label) {
  if (typeof value !== 'string' || !value.startsWith('api/') || path.posix.normalize(value) !== value) {
    throw new Error(`${label} must be a safe API path`);
  }
  return value;
}

function validateJob(job) {
  assertObject(job, 'job');
  if (!isValidJobId(job.id)) {
    throw new Error('Snapshot job has an invalid ID');
  }
  if (job.issueState !== 'open') {
    throw new Error(`Snapshot job ${job.id} is not open`);
  }
  for (const key of ['sourceId', 'title', 'repository', 'url', 'sourceType']) {
    if (typeof job[key] !== 'string' || job[key].trim() === '') {
      throw new Error(`Snapshot job ${job.id} has an invalid ${key}`);
    }
  }
  if (!HASH_PATTERN.test(job.contentHash)) {
    throw new Error(`Snapshot job ${job.id} has an invalid contentHash`);
  }
  assertIsoDate(job.createdAt, `Snapshot job ${job.id} createdAt`);
  return job;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicate IDs`);
  }
}

export async function loadSnapshot(repositoryPath, commit, {
  readJson = readJsonAtCommit,
  snapshotRoot = SNAPSHOT_ROOT,
} = {}) {
  const manifestPath = path.posix.join(snapshotRoot, 'api/manifest.json');
  const manifest = assertObject(await readJson(repositoryPath, commit, manifestPath), 'manifest');

  if (!SUPPORTED_SCHEMA_VERSIONS.has(manifest.schemaVersion)) {
    throw new Error(`Unsupported data schemaVersion: ${String(manifest.schemaVersion)}`);
  }
  assertIsoDate(manifest.generatedAt, 'manifest.generatedAt');
  if (!HASH_PATTERN.test(manifest.dataHash)) {
    throw new Error('manifest.dataHash must be a SHA-256 hash');
  }
  if (!Number.isInteger(manifest.pageSize) || manifest.pageSize <= 0) {
    throw new Error('manifest.pageSize must be a positive integer');
  }
  if (!Array.isArray(manifest.pages) || !Number.isInteger(manifest.totals?.pages)) {
    throw new Error('manifest pages contract is invalid');
  }
  if (manifest.pages.length !== manifest.totals.pages) {
    throw new Error('manifest page count is inconsistent');
  }

  const jobIdsPath = path.posix.join(snapshotRoot, assertRelativeApiPath(manifest.files?.jobIds, 'manifest.files.jobIds'));
  const jobIdsPayload = assertObject(await readJson(repositoryPath, commit, jobIdsPath), 'job IDs');
  assertIsoDate(jobIdsPayload.generatedAt, 'job IDs generatedAt');
  if (!Array.isArray(jobIdsPayload.ids)) {
    throw new Error('job IDs payload must contain ids');
  }
  assertUnique(jobIdsPayload.ids, 'job IDs payload');

  const jobs = [];
  const pageNumbers = new Set();
  for (let index = 0; index < manifest.pages.length; index += 1) {
    const descriptor = assertObject(manifest.pages[index], `manifest.pages[${index}]`);
    const expectedPage = index + 1;
    if (descriptor.page !== expectedPage || pageNumbers.has(descriptor.page)) {
      throw new Error('manifest pages must be unique and sequential');
    }
    pageNumbers.add(descriptor.page);
    const pagePath = path.posix.join(snapshotRoot, assertRelativeApiPath(descriptor.file, 'manifest page file'));
    const payload = assertObject(await readJson(repositoryPath, commit, pagePath), `page ${expectedPage}`);
    assertIsoDate(payload.generatedAt, `page ${expectedPage} generatedAt`);
    if (payload.page !== expectedPage || payload.pageSize !== manifest.pageSize) {
      throw new Error(`page ${expectedPage} metadata is inconsistent`);
    }
    if (!Array.isArray(payload.ids) || !Array.isArray(payload.items)) {
      throw new Error(`page ${expectedPage} must contain ids and items`);
    }
    if (payload.items.length !== descriptor.count || payload.ids.length !== descriptor.count) {
      throw new Error(`page ${expectedPage} count is inconsistent`);
    }
    const itemIds = payload.items.map((job) => validateJob(job).id);
    if (JSON.stringify(itemIds) !== JSON.stringify(payload.ids)) {
      throw new Error(`page ${expectedPage} item IDs are inconsistent`);
    }
    jobs.push(...payload.items);
  }

  const ids = jobs.map((job) => job.id);
  assertUnique(ids, 'snapshot');
  if (JSON.stringify(ids) !== JSON.stringify(jobIdsPayload.ids)) {
    throw new Error('job IDs payload does not match snapshot pages');
  }
  if (manifest.totals?.openOpportunities !== jobs.length) {
    throw new Error('manifest opportunity count is inconsistent');
  }

  return Object.freeze({
    commit,
    generatedAt: manifest.generatedAt,
    dataHash: manifest.dataHash,
    schemaVersion: manifest.schemaVersion,
    jobsById: new Map(jobs.map((job) => [job.id, Object.freeze(job)])),
  });
}
