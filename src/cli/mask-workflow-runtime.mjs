import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOCIAL_MODES = new Set(['scheduled', 'dry-run', 'controlled', 'migrate-meta', 'retry-stage']);
const EDITORIAL_MANUAL_MODES = new Set(['dry-run', 'controlled']);

function invalidMetadata() {
  return new Error('invalid workflow runtime metadata');
}

function requirePositiveInteger(value) {
  const normalized = String(value ?? '');
  if (!/^[1-9][0-9]*$/u.test(normalized)) throw invalidMetadata();
  return normalized;
}

export function buildRuntimeMetadata({ kind, eventName, event, runId, runAttempt }) {
  if (kind !== 'social' && kind !== 'editorial') throw invalidMetadata();
  if (eventName !== 'schedule' && eventName !== 'workflow_dispatch') throw invalidMetadata();
  if (event === null || typeof event !== 'object' || Array.isArray(event)) throw invalidMetadata();

  const id = requirePositiveInteger(runId);
  const attempt = requirePositiveInteger(runAttempt);
  const mode = eventName === 'schedule' ? 'scheduled' : event.inputs?.mode;
  const supported = kind === 'social' ? SOCIAL_MODES : EDITORIAL_MANUAL_MODES;
  if (eventName === 'workflow_dispatch' && !supported.has(mode)) throw invalidMetadata();

  if (kind === 'social') {
    return { RUN_MODE: mode, STORY_OPERATION_KEY: `job-story-${id}-${attempt}` };
  }
  return { RUN_MODE: mode, EDITORIAL_OPERATION_KEY: `editorial-${id}-${attempt}` };
}

function workflowCommandValue(value) {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function parseKind(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== '--kind') throw invalidMetadata();
  return arguments_[1];
}

export async function writeMaskedRuntimeMetadata({ arguments_, environment, output = process.stdout }) {
  const eventPath = environment.GITHUB_EVENT_PATH;
  const environmentPath = environment.GITHUB_ENV;
  if (!eventPath || !environmentPath) throw invalidMetadata();

  let event;
  try {
    event = JSON.parse(await readFile(eventPath, 'utf8'));
  } catch {
    throw invalidMetadata();
  }
  const metadata = buildRuntimeMetadata({
    kind: parseKind(arguments_),
    eventName: environment.GITHUB_EVENT_NAME,
    event,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
  });
  const entries = Object.entries(metadata);
  output.write(entries.map(([, value]) => `::add-mask::${workflowCommandValue(value)}\n`).join(''));
  await appendFile(environmentPath, entries.map(([name, value]) => `${name}=${value}\n`).join(''));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await writeMaskedRuntimeMetadata({ arguments_: process.argv.slice(2), environment: process.env });
  } catch {
    process.stderr.write('Invalid workflow runtime metadata.\n');
    process.exitCode = 1;
  }
}
