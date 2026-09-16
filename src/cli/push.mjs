import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveGitCommit, listSnapshotCommits } from '../modules/data/git-json.mjs';
import { loadSnapshot } from '../modules/data/load-snapshot.mjs';
import { readPushConfig } from '../modules/push/push-config.mjs';
import { sendOneSignalPush } from '../modules/push/onesignal-client.mjs';
import { applyPushResult, preparePushSubmission } from '../modules/push/push-orchestrator.mjs';
import { ingestPushSnapshots, validatePushState } from '../modules/push/push-state.mjs';
import { loadStateFile } from '../modules/state/load-state.mjs';
import { saveStateFile } from '../modules/state/save-state.mjs';

const MODES = new Set(['intake', 'prepare', 'deliver', 'activate', 'disable']);

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid command argument near ${key ?? 'end'}`);
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

export async function runPush({ mode, dataRepositoryPath, stateDirectory, dataReference = 'HEAD', confirmation, env = process.env, now = new Date().toISOString(), log = console.log, dependencies = {} }) {
  if (!MODES.has(mode)) throw new Error('Push mode is invalid');
  const statePath = resolve(stateDirectory, 'push.json');
  let state = await (dependencies.loadStateFile ?? loadStateFile)(statePath, validatePushState);
  const commit = await (dependencies.resolveGitCommit ?? resolveGitCommit)(dataRepositoryPath, dataReference);
  const current = await (dependencies.loadSnapshot ?? loadSnapshot)(dataRepositoryPath, commit);

  if (mode === 'activate') {
    if (confirmation !== 'ENABLE_NEW_JOB_PUSH') throw new Error('Push activation requires the exact confirmation phrase');
    readPushConfig(env, { now });
    const boundary = { commit: current.commit, generatedAt: current.generatedAt, dataHash: current.dataHash };
    state = { ...state, enabled: true, paused: null, activatedAt: now, activationBoundary: boundary, processedSnapshot: boundary, intents: [] };
  } else if (mode === 'disable') {
    if (confirmation !== 'DISABLE_NEW_JOB_PUSH') throw new Error('Push disable requires the exact confirmation phrase');
    state = { ...state, enabled: false };
  } else if (mode === 'intake') {
    if (!state.enabled) return { outcome: 'disabled' };
    const commits = await (dependencies.listSnapshotCommits ?? listSnapshotCommits)(dataRepositoryPath, state.processedSnapshot.commit, commit);
    const snapshots = [];
    for (const snapshotCommit of commits) snapshots.push(await (dependencies.loadSnapshot ?? loadSnapshot)(dataRepositoryPath, snapshotCommit));
    state = ingestPushSnapshots(state, snapshots);
  } else if (mode === 'prepare') {
    const prepared = preparePushSubmission(state, current, { now });
    state = prepared.state;
    await (dependencies.saveStateFile ?? saveStateFile)(statePath, state, validatePushState);
    const result = { outcome: prepared.reason, jobId: prepared.intent?.jobId ?? null };
    log(JSON.stringify(result));
    return result;
  } else {
    const intent = state.intents.find(({ status }) => status === 'submitting');
    if (!intent) return { outcome: 'up_to_date' };
    const config = readPushConfig(env, { now });
    if (config.audienceVersion !== intent.audienceVersion) throw new Error('Push audience version does not match persisted intent');
    const result = await (dependencies.sendOneSignalPush ?? sendOneSignalPush)(intent, config);
    state = applyPushResult(state, intent.jobId, result, { now });
  }

  await (dependencies.saveStateFile ?? saveStateFile)(statePath, state, validatePushState);
  const result = { outcome: mode, enabled: state.enabled, pending: state.intents.filter(({ status }) => ['pending', 'retryable', 'uncertain', 'submitting'].includes(status)).length };
  log(JSON.stringify(result));
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  await runPush({ mode: args.mode, dataRepositoryPath: resolve(args.data ?? '../data-pipeline'), stateDirectory: resolve(args.state ?? 'state'), dataReference: args.ref ?? 'HEAD', confirmation: args.confirmation });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Push operation failed');
    process.exitCode = 1;
  });
}
