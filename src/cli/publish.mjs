import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readEnvironment } from '../config/env.mjs';
import { SOCIAL_CHANNELS } from '../config/constants.mjs';
import { resolveGitCommit } from '../modules/data/git-json.mjs';
import { loadSnapshot } from '../modules/data/load-snapshot.mjs';
import {
  createBridgePublisher,
  loadCanonicalWordmark,
} from '../modules/publishing/bridge-publisher.mjs';
import { processOnePublication } from '../modules/publishing/orchestrator.mjs';
import { publishToBluesky } from '../modules/networks/bluesky-client.mjs';
import { publishToMastodon } from '../modules/networks/mastodon-client.mjs';
import { publishToInstagram } from '../modules/networks/instagram-client.mjs';
import { publishToLinkedInViaBuffer } from '../modules/networks/buffer-linkedin-client.mjs';
import { publishToTwitterViaBuffer } from '../modules/networks/buffer-twitter-client.mjs';
import { publishToLinkedIn } from '../modules/networks/linkedin-client.mjs';
import { publishToThreads } from '../modules/networks/threads-client.mjs';
import { renderSocialCardPng } from '../modules/render/social-card.mjs';
import { loadStateFile } from '../modules/state/load-state.mjs';
import {
  resetFailedPendingBridge,
  resetFailedStage,
} from '../modules/state/queue-operations.mjs';
import { saveStateFile } from '../modules/state/save-state.mjs';
import {
  migrateIntakeState,
  migratePublicationsState,
  migrateQueueState,
  validateIntakeState,
  validatePublicationsState,
  validateQueueState,
} from '../modules/state/state-model.mjs';
import { assertValidJobId } from '../shared/job-id.mjs';

const STAGES = new Set(['bridge', ...SOCIAL_CHANNELS, 'instagramStory']);
const INTAKE_BRIDGE_STAGE = 'intake-bridge';
const RETRY_STAGES = new Set([...STAGES, INTAKE_BRIDGE_STAGE]);
const MODES = new Set(['scheduled', 'controlled', 'retry-stage']);

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

export function parsePublicationRequest({ mode = 'scheduled', jobId, stage, confirmation } = {}) {
  if (!MODES.has(mode)) {
    throw new Error('Publication mode is invalid');
  }
  if (mode === 'controlled') {
    assertValidJobId(jobId);
    if (confirmation !== 'PUBLISH_ONE_JOB') {
      throw new Error('Controlled publication requires the exact confirmation phrase');
    }
  }
  if (mode === 'retry-stage') {
    assertValidJobId(jobId);
    if (!RETRY_STAGES.has(stage)) {
      throw new Error(`Retry stage must be one of: ${[...RETRY_STAGES].join(', ')}`);
    }
    if (confirmation !== 'RESET_FAILED_STAGE') {
      throw new Error('Stage reset requires the exact confirmation phrase');
    }
  }
  return Object.freeze({ mode, jobId: jobId ?? null, stage: stage ?? null });
}

export async function runPublication({
  request,
  dataRepositoryPath,
  stateDirectory,
  wordmarkPath,
  outputPath,
  dataReference = 'HEAD',
  env = process.env,
  log = console.log,
  dependencies = {},
}) {
  const parsed = parsePublicationRequest(request);
  const intakePath = resolve(stateDirectory, 'intake.json');
  const queuePath = resolve(stateDirectory, 'queue.json');
  const publicationsPath = resolve(stateDirectory, 'publications.json');
  let queueState = await loadStateFile(queuePath, validateQueueState, migrateQueueState);
  const publicationsState = await loadStateFile(
    publicationsPath,
    validatePublicationsState,
    migratePublicationsState,
  );

  if (parsed.mode === 'retry-stage') {
    const resetOptions = { at: new Date().toISOString(), reason: 'manual_reset' };
    if (parsed.stage === INTAKE_BRIDGE_STAGE) {
      let intakeState = await loadStateFile(
        intakePath,
        validateIntakeState,
        migrateIntakeState,
      );
      intakeState = resetFailedPendingBridge(intakeState, parsed.jobId, resetOptions);
      await saveStateFile(intakePath, intakeState, validateIntakeState);
    } else {
      queueState = resetFailedStage(queueState, parsed.jobId, parsed.stage, resetOptions);
      await saveStateFile(queuePath, queueState, validateQueueState);
    }
    const result = { outcome: 'reset', jobId: parsed.jobId, stage: parsed.stage };
    log(JSON.stringify(result));
    return result;
  }

  const config = readEnvironment({ env, mode: parsed.mode });
  if (parsed.mode === 'scheduled' && !config.publishEnabled) {
    const result = { outcome: 'disabled', queueDepth: queueState.items.length };
    log(JSON.stringify(result));
    return result;
  }

  const [commit, wordmarkSvg] = await Promise.all([
    (dependencies.resolveGitCommit ?? resolveGitCommit)(dataRepositoryPath, dataReference),
    (dependencies.loadCanonicalWordmark ?? loadCanonicalWordmark)(wordmarkPath),
  ]);
  const snapshot = await (dependencies.loadSnapshot ?? loadSnapshot)(dataRepositoryPath, commit);
  const publishBridge = (dependencies.createBridgePublisher ?? createBridgePublisher)({
    config,
    wordmarkSvg,
    outputRoot: outputPath,
  });
  const publishBluesky = dependencies.publishBluesky ?? (async ({ job, post, queueItem }) => {
    const png = await renderSocialCardPng(job, { wordmarkSvg, direction: queueItem.visualDirection ?? queueItem.bridge.result?.visualDirection });
    try {
      return await publishToBluesky({
        job,
        post,
        png,
        publicationCreatedAt: queueItem.publicationCreatedAt,
        credentials: config.bluesky,
        service: config.blueskyServiceUrl,
      });
    } catch (error) {
      log(JSON.stringify({
        event: 'provider_failure',
        provider: 'bluesky',
        code: typeof error?.code === 'string' ? error.code : 'provider',
        diagnostic: error?.diagnostic ?? null,
      }));
      throw error;
    }
  });
  const publishMastodon = dependencies.publishMastodon ?? (({ job, post }) => publishToMastodon({
    job,
    post,
    accessToken: config.mastodonAccessToken,
    baseUrl: config.mastodonBaseUrl,
  }));
  const publishTwitter = dependencies.publishTwitter ?? (async ({ job, post, queueItem }) => {
    try {
      return await (dependencies.publishTwitterViaBuffer ?? publishToTwitterViaBuffer)({
        job,
        post,
        imageUrl: queueItem.bridge.result?.imageUrl,
        publicSiteOrigin: config.publicSiteOrigin,
        apiKey: config.twitter?.apiKey,
        organizationId: config.twitter?.organizationId,
        channelId: config.twitter?.channelId,
        apiOrigin: config.twitter?.apiOrigin,
      });
    } catch (error) {
      log(JSON.stringify({
        event: 'provider_failure',
        provider: 'twitter',
        code: typeof error?.code === 'string' ? error.code : 'provider',
        diagnostic: error?.diagnostic ?? null,
      }));
      throw error;
    }
  });
  const publishThreads = dependencies.publishThreads ?? (({ job, post }) => publishToThreads({
    job,
    post,
    accessToken: config.threads?.accessToken,
    apiUrl: config.threads?.apiUrl,
  }));
  const publishInstagram = dependencies.publishInstagram ?? (({ job, post, queueItem }) => publishToInstagram({
    job,
    post,
    videoUrl: queueItem.bridge.result?.socialVideoUrl,
    coverUrl: queueItem.bridge.result?.socialVideoCoverUrl,
    accessToken: config.instagram?.accessToken,
    userId: config.instagram?.userId,
    apiVersion: config.instagram?.apiVersion,
    apiOrigin: config.instagram?.apiOrigin,
  }));
  const publishLinkedIn = dependencies.publishLinkedIn ?? (async ({ job, post, queueItem }) => {
    const provider = config.linkedin?.provider === 'buffer' ? 'buffer' : 'linkedin';
    try {
      if (provider === 'buffer') {
        return await (dependencies.publishLinkedInViaBuffer ?? publishToLinkedInViaBuffer)({
          job,
          post,
          imageUrl: queueItem.bridge.result?.imageUrl,
          publicSiteOrigin: config.publicSiteOrigin,
          apiKey: config.linkedin?.apiKey,
          organizationId: config.linkedin?.organizationId,
          channelId: config.linkedin?.channelId,
          apiOrigin: config.linkedin?.apiOrigin,
        });
      }
      const png = await renderSocialCardPng(job, { wordmarkSvg, direction: queueItem.visualDirection ?? queueItem.bridge.result?.visualDirection });
      return await publishToLinkedIn({
        job,
        post,
        png,
        accessToken: config.linkedin?.accessToken,
        organizationId: config.linkedin?.organizationId,
        apiVersion: config.linkedin?.apiVersion,
        apiOrigin: config.linkedin?.apiOrigin,
      });
    } catch (error) {
      log(JSON.stringify({
        event: 'provider_failure',
        provider,
        code: typeof error?.code === 'string' ? error.code : 'provider',
      }));
      throw error;
    }
  });
  const result = await processOnePublication({
    queueState,
    publicationsState,
    currentSnapshot: snapshot,
    publishBridge,
    publishBluesky,
    publishMastodon,
    publishTwitter,
    publishThreads,
    publishInstagram,
    publishLinkedIn,
    enabledChannels: config.enabledChannels,
    instagramStoryEnabled: config.instagramStoryEnabled,
    jobId: parsed.jobId ?? undefined,
  });
  await saveStateFile(queuePath, result.queueState, validateQueueState);
  await saveStateFile(publicationsPath, result.publicationsState, validatePublicationsState);
  const selectedItem = result.queueState.items.find((item) => item.jobId === result.selectedJobId) ?? null;
  const summary = {
    outcome: result.outcome,
    selected: result.selectedJobId,
    bridge: selectedItem?.bridge.status ?? null,
    bluesky: selectedItem?.bluesky.status ?? null,
    blueskyError: selectedItem?.bluesky.lastError?.code ?? null,
    mastodon: selectedItem?.mastodon.status ?? null,
    mastodonError: selectedItem?.mastodon.lastError?.code ?? null,
    twitter: selectedItem?.twitter.status ?? null,
    twitterError: selectedItem?.twitter.lastError?.code ?? null,
    threads: selectedItem?.threads.status ?? null,
    threadsError: selectedItem?.threads.lastError?.code ?? null,
    instagram: selectedItem?.instagram.status ?? null,
    instagramError: selectedItem?.instagram.lastError?.code ?? null,
    linkedin: selectedItem?.linkedin.status ?? null,
    linkedinError: selectedItem?.linkedin.lastError?.code ?? null,
    queueDepth: result.queueState.items.filter((item) => [
      item.bridge,
      ...SOCIAL_CHANNELS.map((channel) => item[channel]),
    ]
      .some((stage) => stage.status === 'pending' || stage.status === 'retryable')).length,
  };
  log(JSON.stringify(summary));
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  await runPublication({
    request: {
      mode: args.mode ?? 'scheduled',
      jobId: args.job,
      stage: args.stage,
      confirmation: args.confirmation,
    },
    dataRepositoryPath: resolve(args.data ?? '../data-pipeline'),
    stateDirectory: resolve(args.state ?? 'state'),
    wordmarkPath: resolve(args.wordmark ?? '../web/public/openings-wordmark-light.svg'),
    outputPath: resolve(args.output ?? '.tmp/publish'),
    dataReference: args.ref ?? 'HEAD',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Publication failed');
    process.exitCode = 1;
  });
}
