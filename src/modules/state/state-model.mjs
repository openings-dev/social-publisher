import { MAX_CHANNEL_ATTEMPTS, SOCIAL_CHANNELS, STATE_SCHEMA_VERSION } from '../../config/constants.mjs';
import { isValidJobId } from '../../shared/job-id.mjs';

const SENSITIVE_KEY_PATTERN = /(?:authorization|credential|password|private.?key|secret|token)/i;
const STAGE_STATUSES = new Set([
  'pending',
  'publishing',
  'published',
  'retryable',
  'failed',
  'skipped_closed',
  'skipped_disabled',
  'skipped_before_activation',
]);
const BRIDGE_REASONS = new Set(['new', 'changed']);

function migratedStoryStage() {
  return {
    status: 'skipped_before_activation',
    attempts: 0,
    updatedAt: null,
    lastError: null,
    lastReset: null,
    result: null,
  };
}

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

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function validateStageState(value, label = 'stage') {
  const stage = assertObject(value, label);
  if (!STAGE_STATUSES.has(stage.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  if (!Number.isInteger(stage.attempts) || stage.attempts < 0 || stage.attempts > MAX_CHANNEL_ATTEMPTS) {
    throw new Error(`${label}.attempts is invalid`);
  }
  if (stage.updatedAt !== null) {
    assertIsoDate(stage.updatedAt, `${label}.updatedAt`);
  }
  if (stage.lastError !== null) {
    const error = assertObject(stage.lastError, `${label}.lastError`);
    if (typeof error.code !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(error.code)) {
      throw new Error(`${label}.lastError.code is invalid`);
    }
    assertIsoDate(error.at, `${label}.lastError.at`);
  }
  if (stage.lastReset !== null) {
    const reset = assertObject(stage.lastReset, `${label}.lastReset`);
    assertIsoDate(reset.at, `${label}.lastReset.at`);
    if (typeof reset.reason !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(reset.reason)) {
      throw new Error(`${label}.lastReset.reason is invalid`);
    }
  }
  if (stage.result !== null) {
    assertObject(stage.result, `${label}.result`);
  }
  return stage;
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

function migrateVersion(value, transform) {
  const state = assertObject(value, 'state');
  if (state.schemaVersion === STATE_SCHEMA_VERSION) return state;
  if (state.schemaVersion !== 2 || STATE_SCHEMA_VERSION !== 3) return state;
  return transform(state);
}

export function migrateIntakeState(value) {
  return migrateVersion(value, (state) => ({ ...state, schemaVersion: STATE_SCHEMA_VERSION }));
}

export function migrateQueueState(value) {
  return migrateVersion(value, (state) => ({
    ...state,
    schemaVersion: STATE_SCHEMA_VERSION,
    items: Array.isArray(state.items)
      ? state.items.map((item) => ({
        ...item,
        linkedin: item.linkedin ?? migratedStoryStage(),
        instagramStory: item.instagramStory ?? migratedStoryStage(),
      }))
      : state.items,
  }));
}

export function migratePublicationsState(value) {
  return migrateVersion(value, (state) => ({
    ...state,
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: state.jobs && typeof state.jobs === 'object' && !Array.isArray(state.jobs)
      ? Object.fromEntries(Object.entries(state.jobs).map(([jobId, publication]) => [
        jobId,
        publication && typeof publication === 'object' && !Array.isArray(publication)
          ? {
            ...publication,
            linkedin: publication.linkedin ?? null,
            instagramStory: publication.instagramStory ?? null,
          }
          : publication,
      ]))
      : state.jobs,
  }));
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
    assertHash(bridge.dataHash, 'pending bridge dataHash');
    if (typeof bridge.dataCommit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(bridge.dataCommit)) {
      throw new Error('pending bridge dataCommit is invalid');
    }
    if (!BRIDGE_REASONS.has(bridge.reason)) {
      throw new Error('pending bridge reason is invalid');
    }
    validateStageState(bridge.stage, 'pending bridge stage');
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
    for (const key of ['sourceId', 'dataCommit']) {
      assertString(item[key], `queue ${key}`);
    }
    assertHash(item.dataHash, 'queue dataHash');
    assertHash(item.contentHash, 'queue contentHash');
    assertIsoDate(item.discoveredAt, 'queue discoveredAt');
    assertIsoDate(item.createdAt, 'queue createdAt');
    assertIsoDate(item.publicationCreatedAt, 'queue publicationCreatedAt');
    validateStageState(item.bridge, 'queue bridge');
    for (const channel of SOCIAL_CHANNELS) {
      validateStageState(item[channel], `queue ${channel}`);
    }
    validateStageState(item.instagramStory, 'queue instagramStory');
  }
  assertNoSensitiveKeys(state);
  return state;
}

export function validatePublicationsState(value) {
  const state = assertObject(value, 'publications state');
  assertSchemaVersion(state.schemaVersion);
  assertObject(state.jobs, 'publications jobs');
  for (const [jobId, value] of Object.entries(state.jobs)) {
    if (!isValidJobId(jobId)) {
      throw new Error('publication jobId is invalid');
    }
    const publication = assertObject(value, `publication ${jobId}`);
    if (!Object.hasOwn(publication, 'linkedin')) {
      throw new Error(`publication ${jobId}.linkedin is required`);
    }
    if (publication.linkedin !== null) {
      assertObject(publication.linkedin, `publication ${jobId}.linkedin`);
    }
  }
  assertNoSensitiveKeys(state);
  return state;
}
