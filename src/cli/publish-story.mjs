import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readEnvironment } from '../config/env.mjs';
import { publishStoryToInstagram } from '../modules/networks/instagram-client.mjs';
import { loadStateFile } from '../modules/state/load-state.mjs';
import {
  selectNextInstagramStory,
  transitionQueueStage,
} from '../modules/state/queue-operations.mjs';
import { saveStateFile } from '../modules/state/save-state.mjs';
import {
  migratePublicationsState,
  migrateQueueState,
  validatePublicationsState,
  validateQueueState,
} from '../modules/state/state-model.mjs';

function parseArguments(argumentsList) {
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid command argument near ${key ?? 'end'}`);
    }
    values[key.slice(2)] = value;
  }
  return values;
}

function safeStoryErrorCode(error) {
  if (typeof error?.code === 'string' && /^instagram_[a-z0-9_]{1,48}$/u.test(error.code)) {
    return error.code;
  }
  const text = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : '';
  if (/rate.?limit|too many requests|\b429\b/u.test(text)) return 'instagram_rate_limit';
  if (/auth|credential|unauthorized|forbidden|\b401\b|\b403\b/u.test(text)) {
    return 'instagram_authentication';
  }
  return 'instagram_story_provider';
}

function assertOperationKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,96}$/u.test(value)) {
    throw new Error('Instagram Story operation key is required');
  }
  return value;
}

function withPublicationStory(publicationsState, jobId, result) {
  // The Instagram Story only needs the feed post and bridge to be published
  // (see selectNextInstagramStory), not every social channel. A job can
  // reach here while another channel (e.g. LinkedIn) is still retryable, in
  // which case completePublication in the orchestrator hasn't written this
  // job's entry yet. Recording the Story result must not depend on that:
  // default to a minimal entry rather than requiring one to pre-exist.
  const publication = publicationsState.jobs[jobId] ?? { linkedin: null, twitter: null };
  return validatePublicationsState({
    ...publicationsState,
    jobs: {
      ...publicationsState.jobs,
      [jobId]: { ...publication, instagramStory: { ...result } },
    },
  });
}

function storyResultId(value) {
  return typeof value?.id === 'string' && value.id.length > 0 ? value.id : null;
}

export function reconcileJobStoryState(queueState, publicationsState, {
  at = new Date().toISOString(),
} = {}) {
  let nextQueue = queueState;
  let nextPublications = publicationsState;
  for (const item of queueState.items) {
    const queueId = item.instagramStory.status === 'published'
      ? storyResultId(item.instagramStory.result)
      : null;
    const publicationStory = publicationsState.jobs[item.jobId]?.instagramStory ?? null;
    const publicationId = storyResultId(publicationStory);
    if (item.instagramStory.status === 'published' && queueId === null) {
      throw new Error(`Published Instagram Story is missing its provider ID: ${item.jobId}`);
    }
    if (queueId !== null && publicationId !== null && queueId !== publicationId) {
      throw new Error(`Instagram Story state disagrees for job: ${item.jobId}`);
    }
    if (queueId !== null && publicationId === null) {
      nextPublications = withPublicationStory(nextPublications, item.jobId, item.instagramStory.result);
      continue;
    }
    if (publicationId !== null && item.instagramStory.status === 'publishing') {
      nextQueue = transitionQueueStage(nextQueue, item.jobId, 'instagramStory', 'published', {
        at,
        result: publicationStory,
      });
      continue;
    }
    if (publicationId !== null && item.instagramStory.status !== 'published') {
      throw new Error(`Instagram Story ledger requires manual repair for job: ${item.jobId}`);
    }
  }
  return { queueState: nextQueue, publicationsState: nextPublications };
}

export async function runJobStoryPublication({
  stateDirectory,
  mode = 'publish',
  jobId = null,
  operationKey,
  env = process.env,
  now = new Date().toISOString(),
  log = console.log,
  dependencies = {},
}) {
  if (mode !== 'intent' && mode !== 'publish') throw new Error(`Unsupported Instagram Story mode: ${mode}`);
  const queuePath = resolve(stateDirectory, 'queue.json');
  const publicationsPath = resolve(stateDirectory, 'publications.json');
  let [queueState, publicationsState] = await Promise.all([
    loadStateFile(queuePath, validateQueueState, migrateQueueState),
    loadStateFile(publicationsPath, validatePublicationsState, migratePublicationsState),
  ]);
  const reconciled = reconcileJobStoryState(queueState, publicationsState, { at: now });
  if (reconciled.publicationsState !== publicationsState) {
    publicationsState = reconciled.publicationsState;
    await saveStateFile(publicationsPath, publicationsState, validatePublicationsState);
  }
  if (reconciled.queueState !== queueState) {
    queueState = reconciled.queueState;
    await saveStateFile(queuePath, queueState, validateQueueState);
  }
  if (env.INSTAGRAM_STORY_AUTO_PUBLISH !== 'true') {
    const result = { outcome: 'disabled', selectedJobId: null, queueState, publicationsState };
    log(JSON.stringify({ outcome: result.outcome, selected: null }));
    return result;
  }
  const safeOperationKey = assertOperationKey(operationKey);
  const selected = selectNextInstagramStory(queueState, jobId);
  if (!selected) {
    const result = { outcome: 'idle', selectedJobId: null, queueState, publicationsState };
    log(JSON.stringify({ outcome: result.outcome, selected: null }));
    return result;
  }
  const currentStory = selected.instagramStory;
  if (mode === 'intent') {
    if (currentStory.status === 'publishing') {
      if (currentStory.result?.operationKey === safeOperationKey) {
        const result = { outcome: 'prepared', selectedJobId: selected.jobId, queueState, publicationsState };
        log(JSON.stringify({ outcome: result.outcome, selected: selected.jobId }));
        return result;
      }
      queueState = transitionQueueStage(queueState, selected.jobId, 'instagramStory', 'failed', {
        at: now,
        errorCode: 'instagram_story_interrupted',
      });
      await saveStateFile(queuePath, queueState, validateQueueState);
      const result = { outcome: 'failed_manual_review', selectedJobId: selected.jobId, queueState, publicationsState };
      log(JSON.stringify({ outcome: result.outcome, selected: selected.jobId, error: 'instagram_story_interrupted' }));
      return result;
    }
    queueState = transitionQueueStage(queueState, selected.jobId, 'instagramStory', 'publishing', {
      at: now,
      intent: { operationKey: safeOperationKey },
    });
    await saveStateFile(queuePath, queueState, validateQueueState);
    const result = { outcome: 'prepared', selectedJobId: selected.jobId, queueState, publicationsState };
    log(JSON.stringify({ outcome: result.outcome, selected: selected.jobId }));
    return result;
  }
  if (currentStory.status !== 'publishing' || currentStory.result?.operationKey !== safeOperationKey) {
    const result = { outcome: 'blocked', selectedJobId: selected.jobId, queueState, publicationsState };
    log(JSON.stringify({ outcome: result.outcome, selected: selected.jobId }));
    return result;
  }
  const config = readEnvironment({ env, mode: 'story' });
  const publishStory = dependencies.publishStory ?? ((input) => publishStoryToInstagram({
    ...input,
    accessToken: config.instagram.accessToken,
    userId: config.instagram.userId,
    apiVersion: config.instagram.apiVersion,
    apiOrigin: config.instagram.apiOrigin,
  }));

  let story;
  try {
    story = await publishStory({
      mediaUrl: selected.bridge.result.socialVideoUrl,
      mediaKind: 'video',
    });
  } catch (error) {
    const code = safeStoryErrorCode(error);
    const terminal = code === 'instagram_story_ambiguous';
    queueState = transitionQueueStage(
      queueState,
      selected.jobId,
      'instagramStory',
      terminal ? 'failed' : 'retryable',
      { at: now, errorCode: code },
    );
    await saveStateFile(queuePath, queueState, validateQueueState);
    const result = {
      outcome: terminal ? 'failed_manual_review' : 'retryable',
      selectedJobId: selected.jobId,
      queueState,
      publicationsState,
    };
    log(JSON.stringify({ outcome: result.outcome, selected: selected.jobId, error: code }));
    return result;
  }
  queueState = transitionQueueStage(queueState, selected.jobId, 'instagramStory', 'published', {
    at: now,
    result: story,
  });
  // Persist the queue transition before touching publications.json: the
  // Instagram post above already happened for real, so the queue record of
  // that (with the provider's story id) must survive even if the
  // publications ledger update below fails, otherwise a retry would
  // re-select this job as still "publishing" and either post a duplicate
  // Story or, if the operation key no longer matches, get stuck requiring
  // manual review despite the Story having actually gone out.
  await saveStateFile(queuePath, queueState, validateQueueState);
  publicationsState = withPublicationStory(publicationsState, selected.jobId, story);
  await saveStateFile(publicationsPath, publicationsState, validatePublicationsState);
  const result = {
    outcome: 'published',
    selectedJobId: selected.jobId,
    queueState,
    publicationsState,
  };
  log(JSON.stringify({ outcome: result.outcome, selected: selected.jobId, story: story.id }));
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const result = await runJobStoryPublication({
    stateDirectory: resolve(args.state ?? 'state'),
    mode: args.mode ?? 'publish',
    jobId: args.job ?? null,
    operationKey: args.operation ?? process.env.STORY_OPERATION_KEY,
  });
  if (result.outcome === 'retryable' || result.outcome === 'failed_manual_review') {
    throw new Error(`Instagram Story did not complete: ${result.outcome}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Instagram Story publication failed');
    process.exitCode = 1;
  });
}
