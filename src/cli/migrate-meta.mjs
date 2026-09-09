import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readEnvironment } from '../config/env.mjs';
import { resolveGitCommit } from '../modules/data/git-json.mjs';
import { loadSnapshot } from '../modules/data/load-snapshot.mjs';
import { publishToInstagram } from '../modules/networks/instagram-client.mjs';
import { publishToThreads } from '../modules/networks/threads-client.mjs';
import {
  createBridgePublisher,
  loadCanonicalWordmark,
} from '../modules/publishing/bridge-publisher.mjs';
import {
  META_RECONCILIATION_MARKER,
  migrateMetaPublication,
  parseMetaMigrationRequest,
} from '../modules/publishing/meta-migration.mjs';
import { loadStateFile } from '../modules/state/load-state.mjs';
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

function parseJobIds(value) {
  if (typeof value !== 'string') return [];
  return value.split(/[\s,]+/u).map((jobId) => jobId.trim()).filter(Boolean);
}

export async function runMetaMigration({
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
  const parsed = parseMetaMigrationRequest(request);
  const config = readEnvironment({ env, mode: 'meta-migration' });
  const queuePath = resolve(stateDirectory, 'queue.json');
  const publicationsPath = resolve(stateDirectory, 'publications.json');
  let [queueState, publicationsState] = await Promise.all([
    loadStateFile(queuePath, validateQueueState, migrateQueueState),
    loadStateFile(publicationsPath, validatePublicationsState, migratePublicationsState),
  ]);
  const [commit, wordmarkSvg] = await Promise.all([
    (dependencies.resolveGitCommit ?? resolveGitCommit)(dataRepositoryPath, dataReference),
    (dependencies.loadCanonicalWordmark ?? loadCanonicalWordmark)(wordmarkPath),
  ]);
  const currentSnapshot = await (dependencies.loadSnapshot ?? loadSnapshot)(dataRepositoryPath, commit);
  const publishBridge = (dependencies.createBridgePublisher ?? createBridgePublisher)({
    config,
    wordmarkSvg,
    outputRoot: outputPath,
    instagramFeedMediaKind: 'reel',
  });
  const publishThreads = dependencies.publishThreads ?? (({ job, post }) => publishToThreads({
    job,
    post,
    accessToken: config.threads.accessToken,
    apiUrl: config.threads.apiUrl,
    reconciliationMarker: META_RECONCILIATION_MARKER,
  }));
  const publishInstagram = dependencies.publishInstagram ?? (({ job, post, queueItem }) => publishToInstagram({
    job,
    post,
    videoUrl: queueItem.bridge.result?.socialVideoUrl,
    coverUrl: queueItem.bridge.result?.socialVideoCoverUrl,
    accessToken: config.instagram.accessToken,
    userId: config.instagram.userId,
    apiVersion: config.instagram.apiVersion,
    apiOrigin: config.instagram.apiOrigin,
    reconciliationMarker: META_RECONCILIATION_MARKER,
  }));
  const deleteThreads = dependencies.deleteThreads;

  const migrated = [];
  const skipped = [];
  for (const jobId of parsed.jobIds) {
    const result = await migrateMetaPublication({
      queueState,
      publicationsState,
      currentSnapshot,
      jobId,
      publishBridge,
      publishThreads,
      publishInstagram,
      deleteThreads,
    });
    queueState = result.queueState;
    publicationsState = result.publicationsState;
    if (result.outcome === 'migrated') migrated.push(jobId);
    else skipped.push(jobId);
    await saveStateFile(queuePath, queueState, validateQueueState);
    await saveStateFile(publicationsPath, publicationsState, validatePublicationsState);
    log(JSON.stringify({ event: 'meta_migration_job', jobId, outcome: result.outcome }));
  }
  const summary = Object.freeze({
    outcome: 'completed',
    requested: parsed.jobIds.length,
    migrated,
    skipped,
    instagramCleanupRequired: migrated.length,
    threadsCleanupRequired: migrated.length,
  });
  log(JSON.stringify(summary));
  return summary;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  await runMetaMigration({
    request: {
      jobIds: parseJobIds(args.jobs),
      confirmation: args.confirmation,
    },
    dataRepositoryPath: resolve(args.data ?? '../data-pipeline'),
    stateDirectory: resolve(args.state ?? 'state'),
    wordmarkPath: resolve(args.wordmark ?? '../web/public/openings-wordmark-light.svg'),
    outputPath: resolve(args.output ?? '.tmp/meta-migration'),
    dataReference: args.ref ?? 'HEAD',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Meta migration failed');
    process.exitCode = 1;
  });
}
