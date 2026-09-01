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

function assertVersionTwo(value, label) {
  if (!value || value.schemaVersion !== 2) {
    throw new Error(`${label} must use schemaVersion 2`);
  }
}

export function migrateLinkedInState({ intakeState, queueState, publicationsState, at }) {
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
    throw new Error('LinkedIn activation timestamp must be an ISO date');
  }
  assertVersionTwo(intakeState, 'intake state');
  assertVersionTwo(queueState, 'queue state');
  assertVersionTwo(publicationsState, 'publications state');
  if (!Array.isArray(queueState.items)
    || !publicationsState.jobs
    || typeof publicationsState.jobs !== 'object'
    || Array.isArray(publicationsState.jobs)) {
    throw new Error('LinkedIn state migration input is invalid');
  }

  return {
    intakeState: { ...intakeState, schemaVersion: STATE_SCHEMA_VERSION },
    queueState: {
      ...queueState,
      schemaVersion: STATE_SCHEMA_VERSION,
      items: queueState.items.map((item) => ({
        ...item,
        linkedin: historicalStage(at),
      })),
    },
    publicationsState: {
      ...publicationsState,
      schemaVersion: STATE_SCHEMA_VERSION,
      jobs: Object.fromEntries(Object.entries(publicationsState.jobs).map(([jobId, publication]) => [
        jobId,
        { ...publication, linkedin: publication.linkedin ?? null },
      ])),
    },
  };
}
