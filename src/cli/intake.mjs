import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readEnvironment } from '../config/env.mjs';
import { SOCIAL_CHANNELS } from '../config/constants.mjs';
import { listSnapshotCommits, resolveGitCommit } from '../modules/data/git-json.mjs';
import { loadSnapshot } from '../modules/data/load-snapshot.mjs';
import {
  createBridgePublisher,
  loadCanonicalWordmark,
} from '../modules/publishing/bridge-publisher.mjs';
import { processIntakeSnapshots } from '../modules/publishing/orchestrator.mjs';
import { loadStateFile } from '../modules/state/load-state.mjs';
import { saveStateFile } from '../modules/state/save-state.mjs';
import {
  migrateIntakeState,
  migratePublicationsState,
  migrateQueueState,
  validateIntakeState,
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

export async function runIntake({
  dataRepositoryPath,
  stateDirectory,
  wordmarkPath,
  outputPath,
  dataReference = 'HEAD',
  mode = 'intake',
  env = process.env,
  log = console.log,
  dependencies = {},
}) {
  const config = readEnvironment({ env, mode });
  const intakePath = resolve(stateDirectory, 'intake.json');
  const queuePath = resolve(stateDirectory, 'queue.json');
  const publicationsPath = resolve(stateDirectory, 'publications.json');
  const [intakeState, queueState, publicationsState, currentCommit, wordmarkSvg] = await Promise.all([
    loadStateFile(intakePath, validateIntakeState, migrateIntakeState),
    loadStateFile(queuePath, validateQueueState, migrateQueueState),
    loadStateFile(publicationsPath, validatePublicationsState, migratePublicationsState),
    (dependencies.resolveGitCommit ?? resolveGitCommit)(dataRepositoryPath, dataReference),
    (dependencies.loadCanonicalWordmark ?? loadCanonicalWordmark)(wordmarkPath),
  ]);
  const commits = intakeState.processedSnapshot === null
    ? [currentCommit]
    : await (dependencies.listSnapshotCommits ?? listSnapshotCommits)(
      dataRepositoryPath,
      intakeState.processedSnapshot.commit,
      currentCommit,
    );
  const snapshots = [];
  for (const commit of commits) {
    snapshots.push(await (dependencies.loadSnapshot ?? loadSnapshot)(dataRepositoryPath, commit));
  }
  const publishBridge = (dependencies.createBridgePublisher ?? createBridgePublisher)({
    config,
    wordmarkSvg,
    outputRoot: outputPath,
  });
  const result = await processIntakeSnapshots({
    intakeState,
    queueState,
    publicationsState,
    snapshots,
    publishBridge,
    enabledChannels: config.enabledChannels,
    instagramStoryEnabled: config.instagramStoryEnabled,
  });
  await saveStateFile(intakePath, result.intakeState, validateIntakeState);
  await saveStateFile(queuePath, result.queueState, validateQueueState);
  log(JSON.stringify({
    snapshot: result.intakeState.processedSnapshot?.commit ?? null,
    ...result.summary,
    queueDepth: result.queueState.items.filter((item) => [
      item.bridge,
      ...SOCIAL_CHANNELS.map((channel) => item[channel]),
    ]
      .some((stage) => stage.status === 'pending' || stage.status === 'retryable')).length,
  }));
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  await runIntake({
    dataRepositoryPath: resolve(args.data ?? '../data-pipeline'),
    stateDirectory: resolve(args.state ?? 'state'),
    wordmarkPath: resolve(args.wordmark ?? '../web/public/openings-wordmark-light.svg'),
    outputPath: resolve(args.output ?? '.tmp/intake'),
    dataReference: args.ref ?? 'HEAD',
    mode: 'intake',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Intake failed');
    process.exitCode = 1;
  });
}
