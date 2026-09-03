import { processOnePublication } from './orchestrator.mjs';
import { resetPublishedMetaStages } from '../state/queue-operations.mjs';
import { validatePublicationsState, validateQueueState } from '../state/state-model.mjs';
import { assertValidJobId } from '../../shared/job-id.mjs';

export const META_MIGRATION_REVISION = 'white_band_poster_v4_social_video_v4';
export const META_RECONCILIATION_MARKER = '#OpeningsJobs';

function assertNow(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('Migration timestamp must be an ISO date');
  }
  return value;
}

function assertPublicationResult(value, label) {
  if (value === null || typeof value !== 'object'
    || typeof value.id !== 'string' || value.id.length === 0
    || typeof value.url !== 'string' || value.url.length === 0) {
    throw new Error(`${label} must include an ID and URL`);
  }
  return value;
}

function migrationHistory(metaMigration) {
  if (!metaMigration || typeof metaMigration !== 'object' || Array.isArray(metaMigration)) return [];
  const priorHistory = Array.isArray(metaMigration.history)
    ? structuredClone(metaMigration.history)
    : [];
  const previousRevision = structuredClone(metaMigration);
  delete previousRevision.history;
  return [...priorHistory, previousRevision];
}

export function parseMetaMigrationRequest({ jobIds, confirmation } = {}) {
  if (confirmation !== 'MIGRATE_META_POSTS') {
    throw new Error('Meta migration requires the exact confirmation phrase');
  }
  if (!Array.isArray(jobIds) || jobIds.length === 0 || jobIds.length > 20) {
    throw new Error('Meta migration requires between 1 and 20 job IDs');
  }
  const uniqueJobIds = [...new Set(jobIds)];
  if (uniqueJobIds.length !== jobIds.length) {
    throw new Error('Meta migration job IDs must be unique');
  }
  uniqueJobIds.forEach(assertValidJobId);
  return Object.freeze({ jobIds: Object.freeze(uniqueJobIds) });
}

export async function migrateMetaPublication({
  queueState,
  publicationsState,
  currentSnapshot,
  jobId,
  publishBridge,
  publishThreads,
  publishInstagram,
  deleteThreads,
  now = new Date().toISOString(),
}) {
  const queue = validateQueueState(queueState);
  const publications = validatePublicationsState(publicationsState);
  assertValidJobId(jobId);
  assertNow(now);
  for (const [label, callback] of Object.entries({
    publishBridge,
    publishThreads,
    publishInstagram,
  })) {
    if (typeof callback !== 'function') {
      throw new Error(`${label} must be a function`);
    }
  }
  if (deleteThreads !== undefined && typeof deleteThreads !== 'function') {
    throw new Error('deleteThreads must be a function when provided');
  }

  const previousPublication = publications.jobs[jobId];
  if (previousPublication?.metaMigration?.revision === META_MIGRATION_REVISION) {
    return {
      queueState: queue,
      publicationsState: publications,
      outcome: 'already_migrated',
      selectedJobId: jobId,
    };
  }
  if (previousPublication?.status !== 'completed') {
    throw new Error(`Completed publication not found for Meta migration: ${jobId}`);
  }
  if (!currentSnapshot?.jobsById?.has(jobId)) {
    throw new Error(`Meta migration job is not open in the current snapshot: ${jobId}`);
  }
  const previousThreads = assertPublicationResult(previousPublication.threads, 'Previous Threads publication');
  const previousInstagram = assertPublicationResult(previousPublication.instagram, 'Previous Instagram publication');
  const history = migrationHistory(previousPublication.metaMigration);
  const resetQueue = resetPublishedMetaStages(queue, jobId, {
    at: now,
    reason: 'meta_publication_migration',
  });

  const result = await processOnePublication({
    queueState: resetQueue,
    publicationsState: publications,
    currentSnapshot,
    publishBridge,
    publishBluesky: async () => {
      throw new Error('Meta migration must not publish to Bluesky');
    },
    publishMastodon: async () => {
      throw new Error('Meta migration must not publish to Mastodon');
    },
    publishThreads,
    publishInstagram,
    enabledChannels: ['bluesky', 'mastodon', 'threads', 'instagram'],
    now,
    jobId,
  });
  if (result.outcome !== 'completed') {
    throw new Error(`Meta replacement did not complete: ${jobId} (${result.outcome})`);
  }
  const replacement = result.publicationsState.jobs[jobId];
  const replacementThreads = assertPublicationResult(replacement.threads, 'Replacement Threads publication');
  const replacementInstagram = assertPublicationResult(replacement.instagram, 'Replacement Instagram publication');
  if (replacementThreads.id === previousThreads.id || replacementInstagram.id === previousInstagram.id) {
    throw new Error(`Meta replacement reconciled to a superseded publication: ${jobId}`);
  }

  let threadsCleanup = 'manual_required';
  if (deleteThreads) {
    await deleteThreads({ id: previousThreads.id });
    threadsCleanup = 'deleted';
  }
  const migratedPublication = {
    ...replacement,
    metaMigration: {
      revision: META_MIGRATION_REVISION,
      marker: META_RECONCILIATION_MARKER,
      completedAt: now,
      history,
      threads: {
        previous: previousThreads,
        replacement: replacementThreads,
        cleanup: threadsCleanup,
      },
      instagram: {
        previous: previousInstagram,
        replacement: replacementInstagram,
        cleanup: 'manual_required',
      },
    },
  };
  const nextPublications = validatePublicationsState({
    ...result.publicationsState,
    jobs: {
      ...result.publicationsState.jobs,
      [jobId]: migratedPublication,
    },
  });
  return {
    queueState: result.queueState,
    publicationsState: nextPublications,
    outcome: 'migrated',
    selectedJobId: jobId,
  };
}
