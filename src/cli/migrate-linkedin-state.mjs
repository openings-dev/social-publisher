import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { STATE_SCHEMA_VERSION } from '../config/constants.mjs';
import { migrateLinkedInState } from '../modules/state/linkedin-state-migration.mjs';
import { saveStateFile } from '../modules/state/save-state.mjs';
import {
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

async function readRawState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not load state file: ${path}`, { cause: error });
  }
}

export async function runLinkedInStateMigration({
  stateDirectory,
  at = new Date().toISOString(),
  confirmation,
}) {
  if (confirmation !== 'MIGRATE_LINKEDIN_STATE') {
    throw new Error('LinkedIn state migration requires the exact confirmation phrase');
  }
  const intakePath = resolve(stateDirectory, 'intake.json');
  const queuePath = resolve(stateDirectory, 'queue.json');
  const publicationsPath = resolve(stateDirectory, 'publications.json');
  const [intakeState, queueState, publicationsState] = await Promise.all([
    readRawState(intakePath),
    readRawState(queuePath),
    readRawState(publicationsPath),
  ]);
  const migrated = migrateLinkedInState({ intakeState, queueState, publicationsState, at });
  validateIntakeState(migrated.intakeState);
  validateQueueState(migrated.queueState);
  validatePublicationsState(migrated.publicationsState);
  await saveStateFile(intakePath, migrated.intakeState, validateIntakeState);
  await saveStateFile(queuePath, migrated.queueState, validateQueueState);
  await saveStateFile(publicationsPath, migrated.publicationsState, validatePublicationsState);
  return {
    queueItems: migrated.queueState.items.length,
    publications: Object.keys(migrated.publicationsState.jobs).length,
    schemaVersion: STATE_SCHEMA_VERSION,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const result = await runLinkedInStateMigration({
    stateDirectory: resolve(args.state ?? 'state'),
    at: args.at,
    confirmation: args.confirmation,
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'LinkedIn state migration failed');
    process.exitCode = 1;
  });
}
