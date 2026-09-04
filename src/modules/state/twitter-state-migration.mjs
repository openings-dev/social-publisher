import { STATE_SCHEMA_VERSION } from '../../config/constants.mjs';

function historicalStage(at) {
  return {
    status: 'skipped_before_activation',
    attempts: 0,
    updatedAt: at,
    lastError: null,
    lastReset: null,
    result: null,
  };
}

function assertCurrentVersion(value, label) {
  if (!value || value.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`${label} must use schemaVersion ${STATE_SCHEMA_VERSION}`);
  }
}

export function migrateTwitterState({ queueState, publicationsState, at }) {
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
    throw new Error('Twitter activation timestamp must be an ISO date');
  }
  assertCurrentVersion(queueState, 'queue state');
  assertCurrentVersion(publicationsState, 'publications state');
  if (!Array.isArray(queueState.items)
    || !publicationsState.jobs
    || typeof publicationsState.jobs !== 'object'
    || Array.isArray(publicationsState.jobs)) {
    throw new Error('Twitter state migration input is invalid');
  }

  return {
    queueState: {
      ...queueState,
      items: queueState.items.map((item) => ({
        ...item,
        twitter: item.twitter ?? historicalStage(at),
      })),
    },
    publicationsState: {
      ...publicationsState,
      jobs: Object.fromEntries(Object.entries(publicationsState.jobs).map(([jobId, publication]) => [
        jobId,
        { ...publication, twitter: publication.twitter ?? null },
      ])),
    },
  };
}
