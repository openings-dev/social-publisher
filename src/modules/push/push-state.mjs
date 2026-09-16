import { randomUUID } from 'node:crypto';

import { collectDelta } from '../intake/collect-delta.mjs';
import { isValidJobId } from '../../shared/job-id.mjs';

export const PUSH_STATE_SCHEMA_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/iu;
const STATUSES = new Set(['pending', 'submitting', 'accepted', 'retryable', 'uncertain', 'failed', 'skipped_closed', 'skipped_stale']);

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO date`);
}

function snapshotReference(snapshot) {
  return { commit: snapshot.commit, generatedAt: snapshot.generatedAt, dataHash: snapshot.dataHash };
}

function validateSnapshotReference(value, label) {
  const reference = assertObject(value, label);
  if (!COMMIT_PATTERN.test(reference.commit)) throw new Error(`${label}.commit is invalid`);
  if (!HASH_PATTERN.test(reference.dataHash)) throw new Error(`${label}.dataHash is invalid`);
  assertIso(reference.generatedAt, `${label}.generatedAt`);
}

function localizedPayload(job) {
  const headings = {
    en: 'New job on Openings',
    'pt-BR': 'Nova vaga no Openings',
    es: 'Nueva vacante en Openings',
    it: 'Nuova offerta su Openings',
    fr: 'Nouvelle offre sur Openings',
    de: 'Neue Stelle bei Openings',
  };
  return {
    headings,
    contents: Object.fromEntries(Object.keys(headings).map((locale) => [locale, job.title.trim()])),
    data: { type: 'openings.job', version: 1, jobId: job.id },
  };
}

export function createPushState(snapshot, {
  activatedAt,
  audienceVersion,
  dailyCap,
  maxAgeHours,
}) {
  const state = {
    schemaVersion: PUSH_STATE_SCHEMA_VERSION,
    enabled: false,
    activationBoundary: snapshotReference(snapshot),
    processedSnapshot: snapshotReference(snapshot),
    activatedAt,
    audienceVersion,
    policy: { dailyCap, maxAgeHours, idempotencyWindowDays: 30 },
    paused: null,
    intents: [],
  };
  return validatePushState(state);
}

export function validatePushState(value) {
  const state = assertObject(value, 'push state');
  if (state.schemaVersion !== PUSH_STATE_SCHEMA_VERSION) throw new Error('Unsupported push state schemaVersion');
  if (typeof state.enabled !== 'boolean') throw new Error('push state enabled is invalid');
  validateSnapshotReference(state.activationBoundary, 'activationBoundary');
  validateSnapshotReference(state.processedSnapshot, 'processedSnapshot');
  assertIso(state.activatedAt, 'activatedAt');
  if (typeof state.audienceVersion !== 'string' || !/^[a-z0-9_-]{1,64}$/u.test(state.audienceVersion)) throw new Error('audienceVersion is invalid');
  const policy = assertObject(state.policy, 'policy');
  if (!Number.isInteger(policy.dailyCap) || policy.dailyCap < 1 || policy.dailyCap > 100) throw new Error('policy.dailyCap is invalid');
  if (!Number.isInteger(policy.maxAgeHours) || policy.maxAgeHours < 1 || policy.maxAgeHours > 168) throw new Error('policy.maxAgeHours is invalid');
  if (policy.idempotencyWindowDays !== 30) throw new Error('policy.idempotencyWindowDays is invalid');
  if (state.paused !== null) {
    const paused = assertObject(state.paused, 'paused');
    if (typeof paused.code !== 'string' || !/^[a-z0-9_-]{1,64}$/u.test(paused.code)) throw new Error('paused.code is invalid');
    assertIso(paused.at, 'paused.at');
  }
  if (!Array.isArray(state.intents)) throw new Error('intents must be an array');
  const seen = new Set();
  for (const intent of state.intents) {
    assertObject(intent, 'intent');
    if (!isValidJobId(intent.jobId) || seen.has(intent.jobId)) throw new Error('intent jobId is invalid or duplicated');
    seen.add(intent.jobId);
    if (!UUID_PATTERN.test(intent.idempotencyKey)) throw new Error('intent idempotencyKey is invalid');
    if (!STATUSES.has(intent.status)) throw new Error('intent status is invalid');
    if (!COMMIT_PATTERN.test(intent.dataCommit) || !HASH_PATTERN.test(intent.dataHash) || !HASH_PATTERN.test(intent.contentHash)) throw new Error('intent source identity is invalid');
    assertIso(intent.createdAt, 'intent.createdAt');
    assertObject(intent.payload, 'intent.payload');
    if (intent.payload?.data?.jobId !== intent.jobId || intent.payload?.data?.type !== 'openings.job' || intent.payload?.data?.version !== 1) throw new Error('intent payload identity is invalid');
    if (intent.audienceVersion !== state.audienceVersion) throw new Error('intent audience version is invalid');
    if (!Number.isInteger(intent.attempts) || intent.attempts < 0 || intent.attempts > 3) throw new Error('intent attempts are invalid');
    if (intent.updatedAt !== null) assertIso(intent.updatedAt, 'intent.updatedAt');
    if (intent.result !== null) assertObject(intent.result, 'intent.result');
  }
  return state;
}

export function ingestPushSnapshots(state, snapshots, { uuid = randomUUID } = {}) {
  validatePushState(state);
  let next = structuredClone(state);
  let previous = null;
  for (const snapshot of snapshots) {
    if (snapshot.commit === next.processedSnapshot.commit) {
      previous = snapshot;
      continue;
    }
    if (!previous) {
      previous = snapshot;
      continue;
    }
    const delta = collectDelta(previous, snapshot);
    for (const candidate of delta.new) {
      if (next.intents.some(({ jobId }) => jobId === candidate.id)) continue;
      next.intents.push({
        jobId: candidate.id,
        sourceId: candidate.sourceId,
        dataCommit: snapshot.commit,
        dataHash: snapshot.dataHash,
        contentHash: candidate.contentHash,
        sourceCreatedAt: candidate.createdAt,
        createdAt: snapshot.generatedAt,
        audienceVersion: next.audienceVersion,
        idempotencyKey: uuid(),
        payload: localizedPayload(candidate),
        status: 'pending',
        attempts: 0,
        firstSubmittedAt: null,
        updatedAt: null,
        retryAfter: null,
        result: null,
      });
    }
    const currentIds = snapshot.jobsById;
    next.intents = next.intents.map((intent) => (
      ['pending', 'retryable'].includes(intent.status) && !currentIds.has(intent.jobId)
        ? { ...intent, status: 'skipped_closed', updatedAt: snapshot.generatedAt }
        : intent
    ));
    next.processedSnapshot = snapshotReference(snapshot);
    previous = snapshot;
  }
  return validatePushState(next);
}
