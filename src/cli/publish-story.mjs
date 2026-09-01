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

function withPublicationStory(publicationsState, jobId, result) {
  const publication = publicationsState.jobs[jobId];
  if (!publication) {
    throw new Error(`Completed publication not found for Story: ${jobId}`);
  }
  return validatePublicationsState({
    ...publicationsState,
    jobs: {
      ...publicationsState.jobs,
      [jobId]: { ...publication, instagramStory: { ...result } },
    },
  });
}

export async function runJobStoryPublication({
  stateDirectory,
  env = process.env,
  now = new Date().toISOString(),
  log = console.log,
  dependencies = {},
}) {
  const config = readEnvironment({ env, mode: 'story' });
  const queuePath = resolve(stateDirectory, 'queue.json');
  const publicationsPath = resolve(stateDirectory, 'publications.json');
  let [queueState, publicationsState] = await Promise.all([
    loadStateFile(queuePath, validateQueueState, migrateQueueState),
    loadStateFile(publicationsPath, validatePublicationsState, migratePublicationsState),
  ]);
  if (!config.instagramStoryEnabled) {
    const result = { outcome: 'disabled', selectedJobId: null, queueState, publicationsState };
    log(JSON.stringify({ outcome: result.outcome, selected: null }));
    return result;
  }
  const selected = selectNextInstagramStory(queueState);
  if (!selected) {
    const result = { outcome: 'idle', selectedJobId: null, queueState, publicationsState };
    log(JSON.stringify({ outcome: result.outcome, selected: null }));
    return result;
  }

  queueState = transitionQueueStage(queueState, selected.jobId, 'instagramStory', 'publishing', {
    at: now,
  });
  await saveStateFile(queuePath, queueState, validateQueueState);
  const publishStory = dependencies.publishStory ?? ((input) => publishStoryToInstagram({
    ...input,
    accessToken: config.instagram.accessToken,
    userId: config.instagram.userId,
    apiVersion: config.instagram.apiVersion,
    apiOrigin: config.instagram.apiOrigin,
  }));

  try {
    const story = await publishStory({
      mediaUrl: selected.bridge.result.socialVideoUrl,
      mediaKind: 'video',
    });
    queueState = transitionQueueStage(queueState, selected.jobId, 'instagramStory', 'published', {
      at: now,
      result: story,
    });
    publicationsState = withPublicationStory(publicationsState, selected.jobId, story);
    await Promise.all([
      saveStateFile(queuePath, queueState, validateQueueState),
      saveStateFile(publicationsPath, publicationsState, validatePublicationsState),
    ]);
    const result = {
      outcome: 'published',
      selectedJobId: selected.jobId,
      queueState,
      publicationsState,
    };
    log(JSON.stringify({ outcome: result.outcome, selected: selected.jobId, story: story.id }));
    return result;
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
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  await runJobStoryPublication({ stateDirectory: resolve(args.state ?? 'state') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Instagram Story publication failed');
    process.exitCode = 1;
  });
}
