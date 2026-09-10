import {
  DEFAULT_SOCIAL_CHANNELS,
  MAX_CHANNEL_ATTEMPTS,
  OPENINGS_ORIGIN,
  SOCIAL_CHANNELS,
  STARVATION_THRESHOLD_MS,
} from '../../config/constants.mjs';
import { validateIntakeState, validateQueueState } from './state-model.mjs';
import { assertValidJobId } from '../../shared/job-id.mjs';
import { artworkAt, defaultArtworkDirection } from '../render/job-poster-model.mjs';

export function queuedArtworkDirection(queueState, jobId) {
  const item = queueState.items.find(item => item.jobId === jobId);
  return item?.visualDirection ?? item?.bridge?.result?.visualDirection
    ?? defaultArtworkDirection(jobId);
}

export function reservePublicationArtwork(queueState, jobId) {
  const current = queueState.items.find(item => item.jobId === jobId);
  if (!current) throw new Error('Artwork reservation requires a queued job');
  if (current.visualDirection) return queueState;
  const started = SOCIAL_CHANNELS.some(channel => current[channel].attempts > 0 || current[channel].status === 'published');
  const index = queueState.items.reduce((next, item) => Math.max(next, (item.visualSequence ?? -1) + 1), 0);
  return replaceItem(queueState, jobId, item => ({ ...item,
    visualDirection: started ? queuedArtworkDirection(queueState, jobId) : artworkAt(index),
    ...(started ? {} : { visualSequence: index }),
  }));
}

const STAGES = new Set(['bridge', ...SOCIAL_CHANNELS, 'instagramStory']);
const READY_STATUSES = new Set(['pending', 'retryable']);
const TERMINAL_STATUSES = new Set([
  'published',
  'failed',
  'skipped_closed',
  'skipped_disabled',
  'skipped_before_activation',
]);
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(['publishing', 'retryable', 'failed', 'skipped_closed']),
  publishing: new Set(['published', 'retryable', 'failed']),
  retryable: new Set(['publishing', 'failed', 'skipped_closed']),
  published: new Set(),
  failed: new Set(),
  skipped_closed: new Set(),
  skipped_disabled: new Set(),
  skipped_before_activation: new Set(),
});

function stageState(status = 'pending') {
  return {
    status,
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

function replacePendingBridge(intakeState, jobId, update) {
  const index = intakeState.pendingBridges.findIndex((item) => item.jobId === jobId);
  if (index < 0) {
    throw new Error(`Pending bridge not found: ${jobId}`);
  }
  const pendingBridges = intakeState.pendingBridges.slice();
  pendingBridges[index] = update(pendingBridges[index]);
  return validateIntakeState({ ...intakeState, pendingBridges });
}

function transitionStage(current, nextStatus, {
  at = new Date().toISOString(),
  errorCode,
  result,
  intent,
} = {}) {
  assertIsoDate(at, 'transition timestamp');
  if (current.status === nextStatus) {
    return current;
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
  return {
    ...current,
    status: effectiveStatus,
    attempts,
    updatedAt: at,
    lastError: ['retryable', 'failed'].includes(effectiveStatus)
      ? { code: sanitizeCode(errorCode), at }
      : null,
    result: effectiveStatus === 'published'
      ? { ...(current.result ?? {}), ...(result ?? {}) }
      : nextStatus === 'publishing' && intent
        ? { ...(current.result ?? {}), ...intent }
        : current.result,
  };
}

export function enqueueJob(queueState, {
  job,
  snapshot,
  discoveredAt,
  enabledChannels = DEFAULT_SOCIAL_CHANNELS,
  instagramStoryEnabled = false,
}) {
  validateQueueState(queueState);
  if (queueState.items.some((item) => item.jobId === job.id)) {
    return queueState;
  }
  assertIsoDate(discoveredAt, 'discoveredAt');
  assertIsoDate(job.createdAt, 'job.createdAt');
  const enabled = new Set(enabledChannels);
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
    ...Object.fromEntries(SOCIAL_CHANNELS.map((channel) => [
      channel,
      stageState(enabled.has(channel) ? 'pending' : 'skipped_disabled'),
    ])),
    instagramStory: stageState(
      instagramStoryEnabled && enabled.has('instagram') ? 'pending' : 'skipped_disabled',
    ),
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
  intent,
} = {}) {
  if (!STAGES.has(stageName)) {
    throw new Error(`Unknown queue stage: ${stageName}`);
  }
  return replaceItem(queueState, jobId, (item) => ({
    ...item,
    [stageName]: transitionStage(item[stageName], nextStatus, {
      at, errorCode, result, intent,
    }),
  }));
}

export function transitionPendingBridgeStage(intakeState, jobId, nextStatus, options = {}) {
  validateIntakeState(intakeState);
  return replacePendingBridge(intakeState, jobId, (bridge) => ({
    ...bridge,
    stage: transitionStage(bridge.stage, nextStatus, options),
  }));
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
    if (stageName === 'instagram'
      && item.instagram.lastError?.code === 'instagram_image_ambiguous') {
      throw new Error('Instagram image ambiguity review hold cannot be reset');
    }
    return {
      ...item,
      [stageName]: {
        ...stageState(),
        ...(stageName === 'bridge' && item.bridge.result?.socialTitle
          ? { result: { socialTitle: item.bridge.result.socialTitle } } : {}),
        ...(stageName === 'mastodon' && item.mastodon.result?.executionOwner === 'cloudflare'
          ? { result: item.mastodon.result } : {}),
        updatedAt: at,
        lastReset: { at, reason: sanitizeCode(reason, 'manual_reset') },
      },
    };
  });
}

export function resetFailedPendingBridge(intakeState, jobId, { at, reason }) {
  validateIntakeState(intakeState);
  assertIsoDate(at, 'reset timestamp');
  return replacePendingBridge(intakeState, jobId, (bridge) => {
    if (bridge.stage.status !== 'failed') {
      throw new Error('Only a failed pending bridge can be reset');
    }
    return {
      ...bridge,
      stage: {
        ...stageState(),
        updatedAt: at,
        lastReset: { at, reason: sanitizeCode(reason, 'manual_reset') },
      },
    };
  });
}

export function resetPublishedMetaStages(queueState, jobId, {
  at,
  reason = 'meta_publication_migration',
}) {
  assertIsoDate(at, 'reset timestamp');
  return replaceItem(queueState, jobId, (item) => {
    const metaStages = [item.threads, item.instagram];
    const hasCompletePublishedResults = metaStages.every((stage) => stage.status === 'published'
      && typeof stage.result?.id === 'string'
      && stage.result.id.length > 0
      && typeof stage.result?.url === 'string'
      && stage.result.url.length > 0);
    if (!hasCompletePublishedResults) {
      throw new Error('Only complete published Meta stages can be reset');
    }
    const resetStage = {
      ...stageState(),
      updatedAt: at,
      lastReset: { at, reason: sanitizeCode(reason, 'meta_publication_migration') },
    };
    return {
      ...item,
      threads: { ...resetStage },
      instagram: { ...resetStage },
    };
  });
}

export function markJobClosed(queueState, jobId, at) {
  assertIsoDate(at, 'closed timestamp');
  return replaceItem(queueState, jobId, (item) => {
    const closeStage = (stage) => TERMINAL_STATUSES.has(stage.status)
      ? stage
      : { ...stage, status: 'skipped_closed', updatedAt: at, lastError: null };
    const instagram = isInterruptedInstagramImage(item)
      ? {
        ...item.instagram,
        status: 'failed',
        updatedAt: at,
        lastError: { code: 'instagram_image_ambiguous', at },
      }
      : closeStage(item.instagram);
    return {
      ...item,
      bridge: closeStage(item.bridge),
      ...Object.fromEntries(SOCIAL_CHANNELS.map((channel) => [
        channel,
        channel === 'instagram' ? instagram : closeStage(item[channel]),
      ])),
      instagramStory: closeStage(item.instagramStory),
    };
  });
}

export function markMissingJobsClosed(queueState, openJobIds, at) {
  validateQueueState(queueState);
  assertIsoDate(at, 'closed timestamp');
  const open = new Set(openJobIds);
  return queueState.items.reduce((next, item) => (
    open.has(item.jobId) ? next : markJobClosed(next, item.jobId, at)
  ), queueState);
}

export function isReadyQueueItem(item) {
  if (READY_STATUSES.has(item.bridge.status)) return true;
  return item.bridge.status === 'published'
    && (SOCIAL_CHANNELS.some((channel) => READY_STATUSES.has(item[channel].status))
      || isInterruptedInstagramImage(item));
}

export function isInterruptedInstagramImage(item) {
  return item?.instagram?.status === 'publishing'
    && item.instagram.result?.publicationKind === 'image'
    && item.instagram.result?.canonicalUrl === `${OPENINGS_ORIGIN}/jobs/${item.jobId}`;
}

function readySocialChannelCount(item) {
  const ready = SOCIAL_CHANNELS
    .filter((channel) => READY_STATUSES.has(item[channel].status))
    .length;
  return ready + (isInterruptedInstagramImage(item) ? 1 : 0);
}

export function selectNextQueueItem(queueState, now = new Date().toISOString()) {
  validateQueueState(queueState);
  const nowMs = Date.parse(assertIsoDate(now, 'selection timestamp'));
  const ready = queueState.items.filter(isReadyQueueItem);
  if (ready.length === 0) {
    return null;
  }
  const maximumReadyChannels = Math.max(...ready.map(readySocialChannelCount));
  const highestCoverage = ready
    .filter((item) => readySocialChannelCount(item) === maximumReadyChannels);
  const starved = highestCoverage
    .filter((item) => nowMs - Date.parse(item.discoveredAt) >= STARVATION_THRESHOLD_MS)
    .sort((left, right) => Date.parse(left.discoveredAt) - Date.parse(right.discoveredAt) || left.jobId.localeCompare(right.jobId));
  if (starved.length > 0) {
    return starved[0];
  }
  return highestCoverage.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || Date.parse(right.discoveredAt) - Date.parse(left.discoveredAt)
    || left.jobId.localeCompare(right.jobId))[0];
}

export function selectNextInstagramStory(queueState, jobId = null) {
  validateQueueState(queueState);
  if (jobId !== null) assertValidJobId(jobId);
  return queueState.items
    .filter((item) => (READY_STATUSES.has(item.instagramStory.status) || item.instagramStory.status === 'publishing')
      && (jobId === null || item.jobId === jobId)
      && item.instagram.status === 'published'
      && typeof item.instagram.result?.id === 'string'
      && item.instagram.result.id.length > 0
      && item.bridge.status === 'published'
      && typeof item.bridge.result?.socialVideoUrl === 'string'
      && item.bridge.result.socialVideoUrl.length > 0)
    .sort((left, right) => Date.parse(left.instagram.updatedAt) - Date.parse(right.instagram.updatedAt)
      || Date.parse(left.discoveredAt) - Date.parse(right.discoveredAt)
      || left.jobId.localeCompare(right.jobId))[0] ?? null;
}
