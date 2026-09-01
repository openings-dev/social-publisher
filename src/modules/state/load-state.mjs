import { readFile } from 'node:fs/promises';

export async function loadStateFile(path, validate, migrate = (value) => value) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not load state file: ${path}`, { cause: error });
  }
  return validate(migrate(parsed));
}
