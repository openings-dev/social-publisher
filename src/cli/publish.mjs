import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readEnvironment } from '../config/env.mjs';
import { resolveGitCommit } from '../modules/data/git-json.mjs';
import { loadSnapshot } from '../modules/data/load-snapshot.mjs';
import {
  createBridgePublisher,
  loadCanonicalWordmark,
} from '../modules/publishing/bridge-publisher.mjs';
import { processOnePublication } from '../modules/publishing/orchestrator.mjs';
import { publishToBluesky } from '../modules/networks/bluesky-client.mjs';
import { publishToMastodon } from '../modules/networks/mastodon-client.mjs';
import { renderSocialCardPng } from '../modules/render/social-card.mjs';
import { loadStateFile } from '../modules/state/load-state.mjs';
import { resetFailedStage } from '../modules/state/queue-operations.mjs';
import { saveStateFile } from '../modules/state/save-state.mjs';
import { validatePublicationsState, validateQueueState } from '../modules/state/state-model.mjs';
import { assertValidJobId } from '../shared/job-id.mjs';

const STAGES = new Set(['bridge', 'bluesky', 'mastodon']);
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
    if (!STAGES.has(stage)) {
      throw new Error('Retry stage must be bridge, bluesky, or mastodon');
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
  const queuePath = resolve(stateDirectory, 'queue.json');
  const publicationsPath = resolve(stateDirectory, 'publications.json');
  let queueState = await loadStateFile(queuePath, validateQueueState);
  const publicationsState = await loadStateFile(publicationsPath, validatePublicationsState);

  if (parsed.mode === 'retry-stage') {
    queueState = resetFailedStage(queueState, parsed.jobId, parsed.stage, {
      at: new Date().toISOString(),
      reason: 'manual_reset',
    });
    await saveStateFile(queuePath, queueState, validateQueueState);
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
    const png = await renderSocialCardPng(job, { wordmarkSvg });
    return publishToBluesky({
      job,
      post,
      png,
      publicationCreatedAt: queueItem.publicationCreatedAt,
      credentials: config.bluesky,
      service: config.blueskyServiceUrl,
    });
  });
  const publishMastodon = dependencies.publishMastodon ?? (({ job, post }) => publishToMastodon({
    job,
    post,
    accessToken: config.mastodonAccessToken,
    baseUrl: config.mastodonBaseUrl,
  }));
  const result = await processOnePublication({
    queueState,
    publicationsState,
    currentSnapshot: snapshot,
    publishBridge,
    publishBluesky,
    publishMastodon,
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
    mastodon: selectedItem?.mastodon.status ?? null,
    queueDepth: result.queueState.items.filter((item) => [item.bridge, item.bluesky, item.mastodon]
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
