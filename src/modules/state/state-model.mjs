import { STATE_SCHEMA_VERSION } from '../../config/constants.mjs';
import { isValidJobId } from '../../shared/job-id.mjs';

const SENSITIVE_KEY_PATTERN = /(?:authorization|credential|password|private.?key|secret|token)/i;

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertSchemaVersion(value) {
  if (value !== STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported schemaVersion: ${String(value)}`);
  }
}

function assertIsoDate(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date`);
  }
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash`);
  }
}

function assertUniqueJobIds(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item?.jobId)) {
      throw new Error(`${label} contains duplicate job IDs`);
    }
    seen.add(item?.jobId);
  }
}

export function assertNoSensitiveKeys(value, path = 'state') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`));
    return value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new Error(`Sensitive key is not allowed in tracked state: ${path}.${key}`);
    }
    assertNoSensitiveKeys(nested, `${path}.${key}`);
  }
  return value;
}

export function validateSnapshotReference(value, label = 'processedSnapshot') {
  const snapshot = assertObject(value, label);
  if (typeof snapshot.commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(snapshot.commit)) {
    throw new Error(`${label}.commit is invalid`);
  }
  assertIsoDate(snapshot.generatedAt, `${label}.generatedAt`);
  assertHash(snapshot.dataHash, `${label}.dataHash`);
  return snapshot;
}

export function validateIntakeState(value) {
  const state = assertObject(value, 'intake state');
  assertSchemaVersion(state.schemaVersion);
  if (state.processedSnapshot !== null) {
    validateSnapshotReference(state.processedSnapshot);
  }
  if (!Array.isArray(state.pendingBridges) || !Array.isArray(state.removedJobs)) {
    throw new Error('intake state bridge/removal collections must be arrays');
  }
  assertUniqueJobIds(state.pendingBridges, 'pendingBridges');
  for (const bridge of state.pendingBridges) {
    if (!isValidJobId(bridge.jobId)) {
      throw new Error('pending bridge jobId is invalid');
    }
    assertHash(bridge.contentHash, 'pending bridge contentHash');
  }
  for (const jobId of state.removedJobs) {
    if (!isValidJobId(jobId)) {
      throw new Error('removed job ID is invalid');
    }
  }
  assertNoSensitiveKeys(state);
  return state;
}

export function validateQueueState(value) {
  const state = assertObject(value, 'queue state');
  assertSchemaVersion(state.schemaVersion);
  if (!Array.isArray(state.items)) {
    throw new Error('queue items must be an array');
  }
  assertUniqueJobIds(state.items, 'queue');
  for (const item of state.items) {
    if (!isValidJobId(item.jobId)) {
      throw new Error('queue jobId is invalid');
    }
  }
  assertNoSensitiveKeys(state);
  return state;
}

export function validatePublicationsState(value) {
  const state = assertObject(value, 'publications state');
  assertSchemaVersion(state.schemaVersion);
  assertObject(state.jobs, 'publications jobs');
  for (const jobId of Object.keys(state.jobs)) {
    if (!isValidJobId(jobId)) {
      throw new Error('publication jobId is invalid');
    }
  }
  assertNoSensitiveKeys(state);
  return state;
}
