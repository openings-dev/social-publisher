import { MAX_CHANNEL_ATTEMPTS, STARVATION_THRESHOLD_MS } from '../../config/constants.mjs';
import { validateIntakeState, validateQueueState } from './state-model.mjs';

const STAGES = new Set(['bridge', 'bluesky', 'mastodon']);
const READY_STATUSES = new Set(['pending', 'retryable']);
const TERMINAL_STATUSES = new Set(['published', 'failed', 'skipped_closed']);
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(['publishing', 'retryable', 'failed', 'skipped_closed']),
  publishing: new Set(['published', 'retryable', 'failed']),
  retryable: new Set(['publishing', 'failed', 'skipped_closed']),
  published: new Set(),
  failed: new Set(),
  skipped_closed: new Set(),
});

function stageState() {
  return {
    status: 'pending',
    attempts: 0,
    updatedAt: null,
    lastError: null,
    lastReset: null,
    result: null,
  };
}

function assertIsoDate(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date`);
  }
  return value;
}

function sanitizeCode(value, fallback = 'unknown_error') {
  return typeof value === 'string' && /^[a-z0-9_-]{1,64}$/.test(value) ? value : fallback;
}

function replaceItem(queueState, jobId, update) {
  const index = queueState.items.findIndex((item) => item.jobId === jobId);
  if (index < 0) {
    throw new Error(`Queue item not found: ${jobId}`);
  }
  const items = queueState.items.slice();
  items[index] = update(items[index]);
  return validateQueueState({ ...queueState, items });
}

export function enqueueJob(queueState, { job, snapshot, discoveredAt }) {
  validateQueueState(queueState);
  if (queueState.items.some((item) => item.jobId === job.id)) {
    return queueState;
  }
  assertIsoDate(discoveredAt, 'discoveredAt');
  assertIsoDate(job.createdAt, 'job.createdAt');
  const item = {
    jobId: job.id,
    sourceId: job.sourceId,
    dataCommit: snapshot.commit,
    dataHash: snapshot.dataHash,
    contentHash: job.contentHash,
    discoveredAt,
    createdAt: job.createdAt,
    publicationCreatedAt: discoveredAt,
    bridge: stageState(),
    bluesky: stageState(),
    mastodon: stageState(),
  };
  return validateQueueState({ ...queueState, items: [...queueState.items, item] });
}

export function enqueueBridgeWork(intakeState, { job, snapshot, reason }) {
  validateIntakeState(intakeState);
  const bridge = {
    jobId: job.id,
    contentHash: job.contentHash,
    dataCommit: snapshot.commit,
    dataHash: snapshot.dataHash,
    reason,
    stage: stageState(),
  };
  const existingIndex = intakeState.pendingBridges.findIndex((item) => item.jobId === job.id);
  if (existingIndex < 0) {
    return validateIntakeState({
      ...intakeState,
      pendingBridges: [...intakeState.pendingBridges, bridge],
    });
  }
  const existing = intakeState.pendingBridges[existingIndex];
  if (existing.contentHash === job.contentHash && existing.stage.status === 'published') {
    return intakeState;
  }
  if (existing.contentHash === job.contentHash) {
    return intakeState;
  }
  const pendingBridges = intakeState.pendingBridges.slice();
  pendingBridges[existingIndex] = bridge;
  return validateIntakeState({ ...intakeState, pendingBridges });
}

export function transitionQueueStage(queueState, jobId, stageName, nextStatus, {
  at = new Date().toISOString(),
  errorCode,
  result,
} = {}) {
  if (!STAGES.has(stageName)) {
    throw new Error(`Unknown queue stage: ${stageName}`);
  }
  assertIsoDate(at, 'transition timestamp');
  return replaceItem(queueState, jobId, (item) => {
    const current = item[stageName];
    if (current.status === nextStatus) {
      return item;
    }
    if (!ALLOWED_TRANSITIONS[current.status]?.has(nextStatus)) {
      throw new Error(`Invalid stage transition: ${current.status} -> ${nextStatus}`);
    }
    let attempts = current.attempts;
    if (nextStatus === 'publishing') {
      if (attempts >= MAX_CHANNEL_ATTEMPTS) {
        throw new Error('Maximum stage attempts reached');
      }
      attempts += 1;
    }
    const effectiveStatus = nextStatus === 'retryable' && attempts >= MAX_CHANNEL_ATTEMPTS
      ? 'failed'
      : nextStatus;
    const next = {
      ...current,
      status: effectiveStatus,
      attempts,
      updatedAt: at,
      lastError: ['retryable', 'failed'].includes(effectiveStatus)
        ? { code: sanitizeCode(errorCode), at }
        : null,
      result: effectiveStatus === 'published' ? { ...(result ?? {}) } : current.result,
    };
    return { ...item, [stageName]: next };
  });
}

export function resetFailedStage(queueState, jobId, stageName, { at, reason }) {
  if (!STAGES.has(stageName)) {
    throw new Error(`Unknown queue stage: ${stageName}`);
  }
  assertIsoDate(at, 'reset timestamp');
  return replaceItem(queueState, jobId, (item) => {
    if (item[stageName].status !== 'failed') {
      throw new Error('Only a failed stage can be reset');
    }
    return {
      ...item,
      [stageName]: {
        ...stageState(),
        updatedAt: at,
        lastReset: { at, reason: sanitizeCode(reason, 'manual_reset') },
      },
    };
  });
}

export function markJobClosed(queueState, jobId, at) {
  assertIsoDate(at, 'closed timestamp');
  return replaceItem(queueState, jobId, (item) => {
    const closeStage = (stage) => TERMINAL_STATUSES.has(stage.status)
      ? stage
      : { ...stage, status: 'skipped_closed', updatedAt: at, lastError: null };
    return {
      ...item,
      bridge: closeStage(item.bridge),
      bluesky: closeStage(item.bluesky),
      mastodon: closeStage(item.mastodon),
    };
  });
}

function isReady(item) {
  return [item.bridge, item.bluesky, item.mastodon].some((stage) => READY_STATUSES.has(stage.status));
}

export function selectNextQueueItem(queueState, now = new Date().toISOString()) {
  validateQueueState(queueState);
  const nowMs = Date.parse(assertIsoDate(now, 'selection timestamp'));
  const ready = queueState.items.filter(isReady);
  if (ready.length === 0) {
    return null;
  }
  const starved = ready
    .filter((item) => nowMs - Date.parse(item.discoveredAt) >= STARVATION_THRESHOLD_MS)
    .sort((left, right) => Date.parse(left.discoveredAt) - Date.parse(right.discoveredAt) || left.jobId.localeCompare(right.jobId));
  if (starved.length > 0) {
    return starved[0];
  }
  return ready.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || Date.parse(right.discoveredAt) - Date.parse(left.discoveredAt)
    || left.jobId.localeCompare(right.jobId))[0];
}
