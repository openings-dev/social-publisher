import { collectBridgeJobs, collectDelta } from '../intake/collect-delta.mjs';
import { isEligibleNewJob } from '../intake/eligibility.mjs';
import { formatSocialPost } from '../render/format-job.mjs';
import {
  enqueueBridgeWork,
  enqueueJob,
  markJobClosed,
  selectNextQueueItem,
  transitionQueueStage,
} from '../state/queue-operations.mjs';
import {
  validateIntakeState,
  validatePublicationsState,
  validateQueueState,
  validateSnapshotReference,
} from '../state/state-model.mjs';

const PUBLISHABLE_CHANNELS = Object.freeze(['bluesky', 'mastodon']);
const READY_STATUSES = new Set(['pending', 'retryable']);

function snapshotReference(snapshot) {
  return validateSnapshotReference({
    commit: snapshot.commit,
    generatedAt: snapshot.generatedAt,
    dataHash: snapshot.dataHash,
  });
}

function assertSnapshot(snapshot, label) {
  if (!snapshot || !(snapshot.jobsById instanceof Map)) {
    throw new Error(`${label} must be a loaded snapshot`);
  }
  snapshotReference(snapshot);
  return snapshot;
}

function assertNow(now) {
  if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) {
    throw new Error('now must be an ISO date');
  }
  return now;
}

function sameSnapshot(left, right) {
  return left.commit === right.commit
    && left.generatedAt === right.generatedAt
    && left.dataHash === right.dataHash;
}

function safeErrorCode(error, stage) {
  const text = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : '';
  if (/rate.?limit|too many requests|\b429\b/.test(text)) {
    return 'rate_limit';
  }
  if (/auth|credential|unauthorized|forbidden|\b401\b|\b403\b/.test(text)) {
    return 'authentication';
  }
  if (/validation|invalid|schema/.test(text)) {
    return 'validation';
  }
  if (stage === 'bridge' || /ftp|deploy|verification/.test(text)) {
    return 'deployment';
  }
  return 'provider';
}

function removePendingBridge(intakeState, jobId) {
  return validateIntakeState({
    ...intakeState,
    pendingBridges: intakeState.pendingBridges.filter((bridge) => bridge.jobId !== jobId),
  });
}

function recordRemovedJobs(intakeState, removedJobs) {
  const removed = new Set(intakeState.removedJobs);
  for (const job of removedJobs) {
    removed.add(job.id);
  }
  return validateIntakeState({ ...intakeState, removedJobs: [...removed] });
}

function queueBridgePublished(queueState, jobId, result, at) {
  if (findQueueItem(queueState, jobId)?.bridge.status === 'published') {
    return queueState;
  }
  let next = transitionQueueStage(queueState, jobId, 'bridge', 'publishing', { at });
  next = transitionQueueStage(next, jobId, 'bridge', 'published', { at, result });
  return next;
}

function updateQueuedRevision(queueState, job, snapshot) {
  const index = queueState.items.findIndex((item) => item.jobId === job.id);
  if (index < 0) {
    throw new Error(`Queue item not found: ${job.id}`);
  }
  const current = queueState.items[index];
  if (current.contentHash === job.contentHash) {
    return queueState;
  }
  const items = queueState.items.slice();
  items[index] = {
    ...current,
    sourceId: job.sourceId,
    contentHash: job.contentHash,
    dataCommit: snapshot.commit,
    dataHash: snapshot.dataHash,
    bridge: {
      status: 'pending',
      attempts: 0,
      updatedAt: null,
      lastError: null,
      lastReset: null,
      result: null,
    },
  };
  return validateQueueState({ ...queueState, items });
}

function completePublication(publicationsState, item, at) {
  const publication = {
    status: 'completed',
    contentHash: item.contentHash,
    dataCommit: item.dataCommit,
    dataHash: item.dataHash,
    completedAt: at,
    bluesky: item.bluesky.result,
    mastodon: item.mastodon.result,
  };
  return validatePublicationsState({
    ...publicationsState,
    jobs: { ...publicationsState.jobs, [item.jobId]: publication },
  });
}

function findQueueItem(queueState, jobId) {
  return queueState.items.find((item) => item.jobId === jobId) ?? null;
}

export async function processIntakeSnapshots({
  intakeState,
  queueState,
  publicationsState,
  snapshots,
  publishBridge,
  now = new Date().toISOString(),
}) {
  let nextIntake = validateIntakeState(intakeState);
  let nextQueue = validateQueueState(queueState);
  const publications = validatePublicationsState(publicationsState);
  assertNow(now);
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error('At least one loaded snapshot is required');
  }
  snapshots.forEach((snapshot, index) => assertSnapshot(snapshot, `snapshots[${index}]`));
  if (typeof publishBridge !== 'function') {
    throw new Error('publishBridge must be a function');
  }

  const newestSnapshot = snapshots.at(-1);
  if (nextIntake.processedSnapshot === null) {
    nextIntake = validateIntakeState({
      ...nextIntake,
      processedSnapshot: snapshotReference(newestSnapshot),
    });
    return {
      intakeState: nextIntake,
      queueState: nextQueue,
      summary: Object.freeze({ baseline: true, bridges: 0, queued: 0, removed: 0 }),
    };
  }

  const startIndex = snapshots.findIndex((snapshot) => sameSnapshot(snapshot, nextIntake.processedSnapshot));
  if (startIndex < 0) {
    throw new Error('Snapshot sequence does not include the processed watermark');
  }

  let bridgeCount = 0;
  let queuedCount = 0;
  let removedCount = 0;
  for (let index = startIndex + 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    const delta = collectDelta(previous, current);
    const newIds = new Set(delta.new.map((job) => job.id));

    for (const job of collectBridgeJobs(delta)) {
      const reason = newIds.has(job.id) ? 'new' : 'changed';
      nextIntake = enqueueBridgeWork(nextIntake, { job, snapshot: current, reason });
      const bridgeResult = await publishBridge({ job, snapshot: current, reason });
      nextIntake = removePendingBridge(nextIntake, job.id);
      bridgeCount += 1;

      if (reason === 'new' && isEligibleNewJob(job, previous.generatedAt, publications)) {
        const beforeCount = nextQueue.items.length;
        nextQueue = enqueueJob(nextQueue, { job, snapshot: current, discoveredAt: now });
        if (nextQueue.items.length > beforeCount) {
          queuedCount += 1;
        }
        nextQueue = queueBridgePublished(nextQueue, job.id, bridgeResult, now);
      }
    }

    nextIntake = recordRemovedJobs(nextIntake, delta.removed);
    removedCount += delta.removed.length;
    nextIntake = validateIntakeState({
      ...nextIntake,
      processedSnapshot: snapshotReference(current),
    });
  }

  return {
    intakeState: nextIntake,
    queueState: nextQueue,
    summary: Object.freeze({ baseline: false, bridges: bridgeCount, queued: queuedCount, removed: removedCount }),
  };
}

async function publishQueueStage({ queueState, item, stage, publish, post, job, now }) {
  if (!READY_STATUSES.has(item[stage].status)) {
    return queueState;
  }
  let next = transitionQueueStage(queueState, item.jobId, stage, 'publishing', { at: now });
  try {
    const result = await publish({ job, post, queueItem: findQueueItem(next, item.jobId) });
    next = transitionQueueStage(next, item.jobId, stage, 'published', { at: now, result });
  } catch (error) {
    next = transitionQueueStage(next, item.jobId, stage, 'retryable', {
      at: now,
      errorCode: safeErrorCode(error, stage),
    });
  }
  return next;
}

export async function processOnePublication({
  queueState,
  publicationsState,
  currentSnapshot,
  publishBridge,
  publishBluesky,
  publishMastodon,
  now = new Date().toISOString(),
  jobId,
}) {
  let nextQueue = validateQueueState(queueState);
  let nextPublications = validatePublicationsState(publicationsState);
  assertSnapshot(currentSnapshot, 'currentSnapshot');
  assertNow(now);
  for (const [label, callback] of Object.entries({ publishBridge, publishBluesky, publishMastodon })) {
    if (typeof callback !== 'function') {
      throw new Error(`${label} must be a function`);
    }
  }

  let selected = jobId ? findQueueItem(nextQueue, jobId) : selectNextQueueItem(nextQueue, now);
  if (!selected) {
    return { queueState: nextQueue, publicationsState: nextPublications, outcome: 'idle', selectedJobId: null };
  }
  const selectedJobId = selected.jobId;
  const job = currentSnapshot.jobsById.get(selected.jobId);
  if (!job) {
    nextQueue = markJobClosed(nextQueue, selected.jobId, now);
    return { queueState: nextQueue, publicationsState: nextPublications, outcome: 'skipped_closed', selectedJobId };
  }

  const revisionChanged = selected.contentHash !== job.contentHash
    || selected.dataCommit !== currentSnapshot.commit
    || selected.dataHash !== currentSnapshot.dataHash;
  nextQueue = updateQueuedRevision(nextQueue, job, currentSnapshot);
  selected = findQueueItem(nextQueue, selected.jobId);
  if (READY_STATUSES.has(selected.bridge.status)) {
    nextQueue = transitionQueueStage(nextQueue, selected.jobId, 'bridge', 'publishing', { at: now });
    try {
      const result = await publishBridge({
        job,
        snapshot: currentSnapshot,
        reason: revisionChanged ? 'changed' : 'new',
      });
      nextQueue = transitionQueueStage(nextQueue, selected.jobId, 'bridge', 'published', { at: now, result });
    } catch (error) {
      nextQueue = transitionQueueStage(nextQueue, selected.jobId, 'bridge', 'retryable', {
        at: now,
        errorCode: safeErrorCode(error, 'bridge'),
      });
      return { queueState: nextQueue, publicationsState: nextPublications, outcome: 'bridge_retryable', selectedJobId };
    }
  }

  selected = findQueueItem(nextQueue, selected.jobId);
  if (selected.bridge.status !== 'published') {
    return { queueState: nextQueue, publicationsState: nextPublications, outcome: 'bridge_unavailable', selectedJobId };
  }

  const post = formatSocialPost(job);
  const publishers = { bluesky: publishBluesky, mastodon: publishMastodon };
  for (const channel of PUBLISHABLE_CHANNELS) {
    selected = findQueueItem(nextQueue, selected.jobId);
    nextQueue = await publishQueueStage({
      queueState: nextQueue,
      item: selected,
      stage: channel,
      publish: publishers[channel],
      post,
      job,
      now,
    });
  }

  selected = findQueueItem(nextQueue, selected.jobId);
  if (selected.bluesky.status === 'published' && selected.mastodon.status === 'published') {
    nextPublications = completePublication(nextPublications, selected, now);
    return { queueState: nextQueue, publicationsState: nextPublications, outcome: 'completed', selectedJobId };
  }
  return { queueState: nextQueue, publicationsState: nextPublications, outcome: 'partial', selectedJobId };
}
