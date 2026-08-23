import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { decideScheduledWork } from '../modules/publishing/scheduled-work.mjs';
import { loadStateFile } from '../modules/state/load-state.mjs';
import { validateIntakeState, validateQueueState } from '../modules/state/state-model.mjs';

const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/openings-dev/data-pipeline/main/snapshots/opportunities/api/manifest.json';
const MAX_MANIFEST_BYTES = 256 * 1024;

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

async function fetchManifestJson(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`Manifest request failed with HTTP ${response.status}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('Manifest response exceeds the size limit');
  }
  return JSON.parse(text);
}

export async function runPreflight({
  eventName,
  publishEnabled,
  stateDirectory,
  manifestUrl = DEFAULT_MANIFEST_URL,
  fetchManifest = fetchManifestJson,
  log = console.log,
}) {
  if (eventName !== 'schedule') {
    const result = { shouldRun: true, reason: 'manual', queueDepth: null };
    log(JSON.stringify(result));
    return result;
  }

  const [intakeState, queueState] = await Promise.all([
    loadStateFile(resolve(stateDirectory, 'intake.json'), validateIntakeState),
    loadStateFile(resolve(stateDirectory, 'queue.json'), validateQueueState),
  ]);
  const knownDataHash = intakeState.processedSnapshot?.dataHash ?? '0'.repeat(64);
  const localDecision = decideScheduledWork({
    publishEnabled,
    intakeState,
    queueState,
    currentDataHash: knownDataHash,
  });
  if (localDecision.reason !== 'up_to_date') {
    log(JSON.stringify(localDecision));
    return localDecision;
  }

  try {
    const manifest = await fetchManifest(manifestUrl);
    const result = decideScheduledWork({
      publishEnabled,
      intakeState,
      queueState,
      currentDataHash: manifest?.dataHash,
    });
    log(JSON.stringify(result));
    return result;
  } catch {
    const result = {
      shouldRun: true,
      reason: 'preflight_unavailable',
      queueDepth: localDecision.queueDepth,
    };
    log(JSON.stringify(result));
    return result;
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const result = await runPreflight({
    eventName: process.env.GITHUB_EVENT_NAME ?? 'workflow_dispatch',
    publishEnabled: process.env.SOCIAL_AUTO_PUBLISH === 'true',
    stateDirectory: resolve(args.state ?? 'state'),
    manifestUrl: process.env.DATA_MANIFEST_URL ?? DEFAULT_MANIFEST_URL,
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `should_run=${String(result.shouldRun)}\nreason=${result.reason}\n`,
      'utf8',
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Scheduled work\n\n\`${JSON.stringify(result)}\`\n`,
      'utf8',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Preflight failed');
    process.exitCode = 1;
  });
}
