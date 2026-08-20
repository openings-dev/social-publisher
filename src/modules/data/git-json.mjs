import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;

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
