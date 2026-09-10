import {
  validateIntakeState,
  validatePublicationsState,
  validateQueueState,
} from '../state/state-model.mjs';
import {
  interruptedPublicationReview,
  isReadyQueueItem,
  missingCompletedPublicationJobIds,
} from '../state/queue-operations.mjs';

const READY_STATUSES = new Set(['pending', 'retryable']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function isReadyStage(stage) {
  return READY_STATUSES.has(stage.status);
}

function isReadyStory(item) {
  return isReadyStage(item.instagramStory) || item.instagramStory.status === 'publishing';
}

export function decideScheduledWork({
  publishEnabled,
  storyPublishEnabled = false,
  intakeState,
  queueState,
  publicationsState,
  currentDataHash,
}) {
  validateIntakeState(intakeState);
  validateQueueState(queueState);
  validatePublicationsState(publicationsState);
  const review = interruptedPublicationReview(queueState);
  const reviewMetadata = review.reviewRequiredCount > 0 ? review : {};
  const queueDepth = queueState.items.filter((item) => (
    (publishEnabled && isReadyQueueItem(item)) || (storyPublishEnabled && isReadyStory(item))
  )).length;

  if (publishEnabled !== true && storyPublishEnabled !== true) {
    return { shouldRun: false, reason: 'disabled', queueDepth };
  }
  if (queueDepth > 0) {
    return { shouldRun: true, reason: 'queued', queueDepth, ...reviewMetadata };
  }
  if (publishEnabled !== true) {
    return { shouldRun: false, reason: 'story_up_to_date', queueDepth };
  }
  if (intakeState.pendingBridges.some((bridge) => isReadyStage(bridge.stage))) {
    return { shouldRun: true, reason: 'bridge_queued', queueDepth, ...reviewMetadata };
  }
  const repairJobIds = missingCompletedPublicationJobIds(queueState, publicationsState);
  if (repairJobIds.length > 0) {
    return {
      shouldRun: true,
      reason: 'publication_ledger_repair',
      queueDepth,
      repairCount: repairJobIds.length,
      ...reviewMetadata,
    };
  }
  if (typeof currentDataHash !== 'string' || !SHA256_PATTERN.test(currentDataHash)) {
    throw new Error('Current data hash must be a SHA-256 hash');
  }
  if (intakeState.processedSnapshot?.dataHash !== currentDataHash) {
    return { shouldRun: true, reason: 'snapshot_changed', queueDepth, ...reviewMetadata };
  }
  if (review.reviewRequiredCount > 0) {
    return { shouldRun: false, reason: 'review_required', queueDepth, ...review };
  }
  return { shouldRun: false, reason: 'up_to_date', queueDepth };
}
