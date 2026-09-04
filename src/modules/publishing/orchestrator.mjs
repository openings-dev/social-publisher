import { collectBridgeJobs, collectDelta } from '../intake/collect-delta.mjs';
import {
  DEFAULT_SOCIAL_CHANNELS,
  INSTAGRAM_CARD_VERSION,
  SOCIAL_VIDEO_VERSION,
  SOCIAL_CHANNELS,
  TWITTER_POST_MAX_GRAPHEMES,
} from '../../config/constants.mjs';
import { isEligibleNewJob } from '../intake/eligibility.mjs';
import { formatSocialPost } from '../render/format-job.mjs';
import {
  enqueueBridgeWork,
  enqueueJob,
  markJobClosed,
  markMissingJobsClosed,
  selectNextQueueItem,
  transitionPendingBridgeStage,
  transitionQueueStage,
} from '../state/queue-operations.mjs';
import {
  validateIntakeState,
  validatePublicationsState,
  validateQueueState,
  validateSnapshotReference,
} from '../state/state-model.mjs';

const READY_STATUSES = new Set(['pending', 'retryable']);
const COMPLETED_STATUSES = new Set(['published', 'skipped_disabled', 'skipped_before_activation']);

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
  if ((stage === 'linkedin' || stage === 'twitter')
    && typeof error?.code === 'string'
    && /^buffer_(?:authentication|configuration|graphql|reconciliation|media|publication|processing|rate_limit|response)$/u
      .test(error.code)) {
    return error.code;
  }
  if (typeof error?.code === 'string'
    && new RegExp(`^${stage}_[a-z0-9_]{1,48}$`, 'u').test(error.code)) {
    return error.code;
  }
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

function removePendingBridges(intakeState, jobIds) {
  const removed = new Set(jobIds);
  return validateIntakeState({
    ...intakeState,
    pendingBridges: intakeState.pendingBridges.filter((bridge) => !removed.has(bridge.jobId)),
  });
}

function assertMaxBridgeAttempts(value) {
  if (value !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error('maxBridgeAttempts must be a positive integer');
  }
  return value;
}

function intakeSummary({ baseline = false, bridges = 0, queued = 0, removed = 0, complete, error = null }) {
  return Object.freeze({ baseline, bridges, queued, removed, complete, error });
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

function needsInstagramBridgeUpgrade(item) {
  return READY_STATUSES.has(item.instagram.status)
    && item.bridge.status === 'published'
    && (item.bridge.result?.instagramCardVersion !== INSTAGRAM_CARD_VERSION
      || item.bridge.result?.socialVideoVersion !== SOCIAL_VIDEO_VERSION);
}

function invalidateStaleInstagramBridge(queueState, jobId, at) {
  const index = queueState.items.findIndex((item) => item.jobId === jobId);
  if (index < 0) {
    throw new Error(`Queue item not found: ${jobId}`);
  }
  const current = queueState.items[index];
  if (!needsInstagramBridgeUpgrade(current)) {
    return queueState;
  }
  const items = queueState.items.slice();
  items[index] = {
    ...current,
    bridge: {
      status: 'pending',
      attempts: 0,
      updatedAt: at,
      lastError: null,
      lastReset: { at, reason: 'instagram_card_upgrade' },
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
    threads: item.threads.result,
    instagram: item.instagram.result,
    linkedin: item.linkedin.result,
    twitter: item.twitter.result,
    instagramStory: item.instagramStory.result,
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
  enabledChannels = DEFAULT_SOCIAL_CHANNELS,
  instagramStoryEnabled = false,
  maxBridgeAttempts = Number.POSITIVE_INFINITY,
  now = new Date().toISOString(),
}) {
  let nextIntake = validateIntakeState(intakeState);
  let nextQueue = validateQueueState(queueState);
  const publications = validatePublicationsState(publicationsState);
  assertNow(now);
  assertMaxBridgeAttempts(maxBridgeAttempts);
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
      summary: intakeSummary({ baseline: true, complete: true }),
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

    const bridgeJobs = collectBridgeJobs(delta);
    for (const job of bridgeJobs) {
      const reason = newIds.has(job.id) ? 'new' : 'changed';
      const checkpoint = nextIntake.pendingBridges.find((bridge) => (
        bridge.jobId === job.id && bridge.contentHash === job.contentHash
      ));
      if (checkpoint?.stage.status !== 'published' && bridgeCount >= maxBridgeAttempts) {
        return {
          intakeState: nextIntake,
          queueState: nextQueue,
          summary: intakeSummary({
            bridges: bridgeCount,
            queued: queuedCount,
            removed: removedCount,
            complete: false,
          }),
        };
      }
      nextIntake = enqueueBridgeWork(nextIntake, { job, snapshot: current, reason });
      let pendingBridge = nextIntake.pendingBridges.find((bridge) => bridge.jobId === job.id);
      let bridgeResult = pendingBridge.stage.result;
      if (pendingBridge.stage.status !== 'published') {
        if (pendingBridge.stage.status === 'failed') {
          return {
            intakeState: nextIntake,
            queueState: nextQueue,
            summary: intakeSummary({
              bridges: bridgeCount,
              queued: queuedCount,
              removed: removedCount,
              complete: false,
              error: pendingBridge.stage.lastError?.code ?? 'deployment',
            }),
          };
        }
        if (pendingBridge.stage.status === 'publishing') {
          nextIntake = transitionPendingBridgeStage(nextIntake, job.id, 'retryable', {
            at: now,
            errorCode: 'interrupted',
          });
          pendingBridge = nextIntake.pendingBridges.find((bridge) => bridge.jobId === job.id);
          if (pendingBridge.stage.status === 'failed') {
            return {
              intakeState: nextIntake,
              queueState: nextQueue,
              summary: intakeSummary({
                bridges: bridgeCount,
                queued: queuedCount,
                removed: removedCount,
                complete: false,
                error: pendingBridge.stage.lastError.code,
              }),
            };
          }
        }
        nextIntake = transitionPendingBridgeStage(nextIntake, job.id, 'publishing', { at: now });
        bridgeCount += 1;
        try {
          bridgeResult = await publishBridge({ job, snapshot: current, reason });
          nextIntake = transitionPendingBridgeStage(nextIntake, job.id, 'published', {
            at: now,
            result: bridgeResult,
          });
        } catch (error) {
          const errorCode = safeErrorCode(error, 'bridge');
          nextIntake = transitionPendingBridgeStage(nextIntake, job.id, 'retryable', {
            at: now,
            errorCode,
          });
          return {
            intakeState: nextIntake,
            queueState: nextQueue,
            summary: intakeSummary({
              bridges: bridgeCount,
              queued: queuedCount,
              removed: removedCount,
              complete: false,
              error: errorCode,
            }),
          };
        }
      }

      if (reason === 'new' && isEligibleNewJob(job, previous.generatedAt, publications)) {
        const beforeCount = nextQueue.items.length;
        nextQueue = enqueueJob(nextQueue, {
          job,
          snapshot: current,
          discoveredAt: now,
          enabledChannels,
          instagramStoryEnabled,
        });
        if (nextQueue.items.length > beforeCount) {
          queuedCount += 1;
        }
        nextQueue = queueBridgePublished(nextQueue, job.id, bridgeResult, now);
      }
    }

    nextIntake = removePendingBridges(nextIntake, bridgeJobs.map((job) => job.id));
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
    summary: intakeSummary({
      bridges: bridgeCount,
      queued: queuedCount,
      removed: removedCount,
      complete: true,
    }),
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
  publishTwitter,
  publishThreads,
  publishInstagram,
  publishLinkedIn,
  enabledChannels = DEFAULT_SOCIAL_CHANNELS,
  instagramStoryEnabled = false,
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

  let automaticallyClosedJobId = null;
  if (!jobId) {
    const previouslySelected = selectNextQueueItem(nextQueue, now);
    nextQueue = markMissingJobsClosed(nextQueue, currentSnapshot.jobsById.keys(), now);
    if (previouslySelected && !currentSnapshot.jobsById.has(previouslySelected.jobId)) {
      automaticallyClosedJobId = previouslySelected.jobId;
    }
  }

  if (jobId && !findQueueItem(nextQueue, jobId)) {
    if (nextPublications.jobs[jobId]?.status === 'completed') {
      return {
        queueState: nextQueue,
        publicationsState: nextPublications,
        outcome: 'already_published',
        selectedJobId: jobId,
      };
    }
    const controlledJob = currentSnapshot.jobsById.get(jobId);
    if (!controlledJob) {
      throw new Error(`Controlled job is not open in the current snapshot: ${jobId}`);
    }
    nextQueue = enqueueJob(nextQueue, {
      job: controlledJob,
      snapshot: currentSnapshot,
      discoveredAt: now,
      enabledChannels,
      instagramStoryEnabled,
    });
  }

  let selected = jobId ? findQueueItem(nextQueue, jobId) : selectNextQueueItem(nextQueue, now);
  if (!selected) {
    return {
      queueState: nextQueue,
      publicationsState: nextPublications,
      outcome: automaticallyClosedJobId ? 'skipped_closed' : 'idle',
      selectedJobId: automaticallyClosedJobId,
    };
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
  const instagramCardUpgrade = needsInstagramBridgeUpgrade(selected);
  nextQueue = invalidateStaleInstagramBridge(nextQueue, selected.jobId, now);
  selected = findQueueItem(nextQueue, selected.jobId);
  if (READY_STATUSES.has(selected.bridge.status)) {
    nextQueue = transitionQueueStage(nextQueue, selected.jobId, 'bridge', 'publishing', { at: now });
    try {
      const result = await publishBridge({
        job,
        snapshot: currentSnapshot,
        reason: instagramCardUpgrade ? 'instagram_card_upgrade' : (revisionChanged ? 'changed' : 'new'),
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
  const twitterPost = formatSocialPost(job, { maxGraphemes: TWITTER_POST_MAX_GRAPHEMES });
  const publishers = {
    bluesky: publishBluesky,
    mastodon: publishMastodon,
    twitter: publishTwitter,
    threads: publishThreads,
    instagram: publishInstagram,
    linkedin: publishLinkedIn,
  };
  for (const channel of SOCIAL_CHANNELS) {
    selected = findQueueItem(nextQueue, selected.jobId);
    nextQueue = await publishQueueStage({
      queueState: nextQueue,
      item: selected,
      stage: channel,
      publish: publishers[channel] ?? (async () => {
        throw new Error(`${channel} publisher is unavailable`);
      }),
      post: channel === 'twitter' ? twitterPost : post,
      job,
      now,
    });
  }

  selected = findQueueItem(nextQueue, selected.jobId);
  if (SOCIAL_CHANNELS.every((channel) => COMPLETED_STATUSES.has(selected[channel].status))) {
    nextPublications = completePublication(nextPublications, selected, now);
    return { queueState: nextQueue, publicationsState: nextPublications, outcome: 'completed', selectedJobId };
  }
  return { queueState: nextQueue, publicationsState: nextPublications, outcome: 'partial', selectedJobId };
}
