import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;
const REF_PATTERN = /^(?:HEAD|[A-Za-z0-9][A-Za-z0-9._/-]{0,199})$/u;

function assertRepositoryRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || path.posix.isAbsolute(value)) {
    throw new Error('Git JSON path must be repository-relative');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Git JSON path must be repository-relative');
  }
  return normalized;
}

export async function readJsonAtCommit(repositoryPath, commit, filePath, {
  execFileImpl = execFileAsync,
} = {}) {
  if (typeof repositoryPath !== 'string' || repositoryPath.length === 0) {
    throw new Error('Repository path is required');
  }
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error('Git commit must be a hexadecimal object ID');
  }
  const safePath = assertRepositoryRelativePath(filePath);
  let stdout;
  try {
    ({ stdout } = await execFileImpl('git', [
      '-C',
      repositoryPath,
      'show',
      `${commit}:${safePath}`,
    ], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(`Could not read Git JSON at ${safePath}`, { cause: error });
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Git object is not valid JSON: ${safePath}`, { cause: error });
  }
}

function assertRepositoryPath(repositoryPath) {
  if (typeof repositoryPath !== 'string' || repositoryPath.length === 0) {
    throw new Error('Repository path is required');
  }
  return repositoryPath;
}

function assertGitReference(reference) {
  if (
    typeof reference !== 'string'
    || !REF_PATTERN.test(reference)
    || reference.startsWith('-')
    || reference.includes('..')
    || reference.includes('//')
  ) {
    throw new Error('Git reference is invalid');
  }
  return reference;
}

function parseCommits(stdout, label) {
  const commits = stdout.trim() === '' ? [] : stdout.trim().split(/\s+/u);
  if (commits.some((commit) => !COMMIT_PATTERN.test(commit))) {
    throw new Error(`${label} returned an invalid commit`);
  }
  return commits;
}

export async function resolveGitCommit(repositoryPath, reference = 'HEAD', {
  execFileImpl = execFileAsync,
} = {}) {
  assertRepositoryPath(repositoryPath);
  const safeReference = assertGitReference(reference);
  let stdout;
  try {
    ({ stdout } = await execFileImpl('git', [
      '-C',
      repositoryPath,
      'rev-parse',
      '--verify',
      `${safeReference}^{commit}`,
    ], { encoding: 'utf8' }));
  } catch (error) {
    throw new Error(`Could not resolve Git reference: ${safeReference}`, { cause: error });
  }
  const [commit] = parseCommits(stdout, 'git rev-parse');
  if (!commit) {
    throw new Error(`Git reference resolved to no commit: ${safeReference}`);
  }
  return commit;
}

export async function listSnapshotCommits(repositoryPath, fromCommit, toCommit, {
  manifestPath = 'snapshots/opportunities/api/manifest.json',
  execFileImpl = execFileAsync,
} = {}) {
  assertRepositoryPath(repositoryPath);
  if (!COMMIT_PATTERN.test(fromCommit) || !COMMIT_PATTERN.test(toCommit)) {
    throw new Error('Snapshot boundaries must be hexadecimal commit IDs');
  }
  const safeManifestPath = assertRepositoryRelativePath(manifestPath);
  if (fromCommit === toCommit) {
    return [fromCommit];
  }
  try {
    await execFileImpl('git', [
      '-C',
      repositoryPath,
      'merge-base',
      '--is-ancestor',
      fromCommit,
      toCommit,
    ], { encoding: 'utf8' });
  } catch (error) {
    throw new Error('Processed data commit is not an ancestor of the current commit', { cause: error });
  }
  let stdout;
  try {
    ({ stdout } = await execFileImpl('git', [
      '-C',
      repositoryPath,
      'rev-list',
      '--reverse',
      `${fromCommit}..${toCommit}`,
      '--',
      safeManifestPath,
    ], { encoding: 'utf8' }));
  } catch (error) {
    throw new Error('Could not list snapshot commits', { cause: error });
  }
  const changed = parseCommits(stdout, 'git rev-list');
  const sequence = [fromCommit, ...changed];
  if (sequence.at(-1) !== toCommit) {
    sequence.push(toCommit);
  }
  return [...new Set(sequence)];
}
