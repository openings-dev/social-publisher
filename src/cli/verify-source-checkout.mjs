import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const invalid = () => new Error('source event does not match checked-out snapshot');

export function verifySourceCheckout({ expectedCommit, expectedDataHash, actualCommit, manifest }) {
  if (!/^[0-9a-f]{40}$/u.test(expectedCommit ?? '')
    || !/^[0-9a-f]{64}$/u.test(expectedDataHash ?? '')
    || actualCommit !== expectedCommit
    || manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.dataHash !== expectedDataHash) {
    throw invalid();
  }
  return { sourceCommit: expectedCommit, dataHash: expectedDataHash };
}

function parseArguments(values) {
  if (values.length !== 4 || values[0] !== '--data' || values[2] !== '--commit') throw invalid();
  return { dataPath: values[1], actualCommit: values[3] };
}

async function main() {
  const { dataPath, actualCommit } = parseArguments(process.argv.slice(2));
  let manifest;
  try {
    manifest = JSON.parse(await readFile(
      resolve(dataPath, 'snapshots/opportunities/api/manifest.json'),
      'utf8',
    ));
  } catch {
    throw invalid();
  }
  const result = verifySourceCheckout({
    expectedCommit: process.env.SOURCE_EVENT_COMMIT,
    expectedDataHash: process.env.SOURCE_EVENT_DATA_HASH,
    actualCommit,
    manifest,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    process.stderr.write('Source event does not match checked-out snapshot.\n');
    process.exitCode = 1;
  });
}
