import { validateIntakeState, validateQueueState } from '../state/state-model.mjs';

const READY_STATUSES = new Set(['pending', 'retryable']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function isReadyStage(stage) {
  return READY_STATUSES.has(stage.status);
}

function isReadyQueueItem(item) {
  return [item.bridge, item.bluesky, item.mastodon].some(isReadyStage);
}

export function decideScheduledWork({
  publishEnabled,
  intakeState,
  queueState,
  currentDataHash,
}) {
  validateIntakeState(intakeState);
  validateQueueState(queueState);
  const queueDepth = queueState.items.filter(isReadyQueueItem).length;

  if (publishEnabled !== true) {
    return { shouldRun: false, reason: 'disabled', queueDepth };
  }
  if (queueDepth > 0) {
    return { shouldRun: true, reason: 'queued', queueDepth };
  }
  if (intakeState.pendingBridges.some((bridge) => isReadyStage(bridge.stage))) {
    return { shouldRun: true, reason: 'bridge_queued', queueDepth };
  }
  if (typeof currentDataHash !== 'string' || !SHA256_PATTERN.test(currentDataHash)) {
    throw new Error('Current data hash must be a SHA-256 hash');
  }
  if (intakeState.processedSnapshot?.dataHash !== currentDataHash) {
    return { shouldRun: true, reason: 'snapshot_changed', queueDepth };
  }
  return { shouldRun: false, reason: 'up_to_date', queueDepth };
}
