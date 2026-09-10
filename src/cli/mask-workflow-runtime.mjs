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

function parseSourceEvent(event) {
  const payload = event.action === 'openings_source_committed_v1' ? event.client_payload : null;
  const expectedKeys = [
    'data_hash', 'event_id', 'previous_commit', 'schema_version', 'source_commit', 'source_repository',
  ];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
    || JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expectedKeys)
    || payload.schema_version !== 1
    || payload.source_repository !== 'openings-dev/data-pipeline'
    || !/^[0-9a-f]{40}$/u.test(payload.source_commit)
    || !/^[0-9a-f]{40}$/u.test(payload.previous_commit)
    || !/^[0-9a-f]{64}$/u.test(payload.data_hash)
    || payload.event_id !== `openings:data:${payload.source_commit}`) {
    throw invalidMetadata();
  }
  return payload;
}

export function buildRuntimeMetadata({ kind, eventName, event, runId, runAttempt }) {
  if (kind !== 'social' && kind !== 'editorial') throw invalidMetadata();
  if (!['schedule', 'workflow_dispatch', 'repository_dispatch'].includes(eventName)) throw invalidMetadata();
  if (event === null || typeof event !== 'object' || Array.isArray(event)) throw invalidMetadata();
  if (eventName === 'repository_dispatch' && kind !== 'social') throw invalidMetadata();

  const id = requirePositiveInteger(runId);
  const attempt = requirePositiveInteger(runAttempt);
  const mode = eventName === 'workflow_dispatch' ? event.inputs?.mode : 'scheduled';
  const supported = kind === 'social' ? SOCIAL_MODES : EDITORIAL_MANUAL_MODES;
  if (eventName === 'workflow_dispatch' && !supported.has(mode)) throw invalidMetadata();

  if (kind === 'social') {
    const metadata = { RUN_MODE: mode, STORY_OPERATION_KEY: `job-story-${id}-${attempt}` };
    if (eventName === 'repository_dispatch') {
      const payload = parseSourceEvent(event);
      metadata.SOURCE_EVENT_COMMIT = payload.source_commit;
      metadata.SOURCE_EVENT_DATA_HASH = payload.data_hash;
    }
    return metadata;
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
