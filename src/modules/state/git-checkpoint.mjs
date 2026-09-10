import { execFile as execFileCallback } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const QUEUE_RELATIVE_PATH = 'state/queue.json';
const CHECKPOINT_MESSAGE = 'chore(state): checkpoint social publication [skip ci]';

function configurationError() {
  return new Error('Invalid state checkpoint configuration');
}

function validBranchName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !value.startsWith('-')
    && !value.startsWith('.')
    && !value.startsWith('refs/')
    && !value.endsWith('.')
    && !value.endsWith('/')
    && !value.includes('..')
    && !value.includes('//')
    && !value.includes('@{')
    && !value.split('/').some((part) => part === '' || part.endsWith('.lock'))
    && !/[\u0000-\u0020\u007f~^:?*[\\]/u.test(value);
}

async function executeGit(args, { cwd, allowExitCodeOne }) {
  try {
    const result = await execFile('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout.trim() };
  } catch (error) {
    if (allowExitCodeOne && error?.code === 1) return { exitCode: 1 };
    throw error;
  }
}

export function createQueueGitCheckpoint({
  repositoryRoot,
  queuePath,
  remote,
  stateRef,
  runGit = executeGit,
}) {
  if (typeof repositoryRoot !== 'string'
    || !isAbsolute(repositoryRoot)
    || resolve(repositoryRoot) !== repositoryRoot
    || queuePath !== join(repositoryRoot, 'state', 'queue.json')
    || remote !== 'origin'
    || !validBranchName(stateRef)
    || typeof runGit !== 'function') {
    throw configurationError();
  }
  const options = (allowExitCodeOne = false) => ({
    cwd: repositoryRoot,
    allowExitCodeOne,
  });
  return async function checkpointQueue() {
    const root = await runGit(['rev-parse', '--show-toplevel'], options());
    const branch = await runGit(['branch', '--show-current'], options());
    if (root?.stdout !== repositoryRoot || branch?.stdout !== stateRef) {
      throw new Error('State checkpoint repository identity does not match');
    }
    await runGit(['add', '--', QUEUE_RELATIVE_PATH], options());
    const diff = await runGit(
      ['diff', '--cached', '--quiet', '--', QUEUE_RELATIVE_PATH],
      options(true),
    );
    if (diff?.exitCode !== 0 && diff?.exitCode !== 1) {
      throw new Error('Could not inspect queue checkpoint');
    }
    if (diff.exitCode === 1) {
      await runGit([
        'commit',
        '--only',
        '-m',
        CHECKPOINT_MESSAGE,
        '--',
        QUEUE_RELATIVE_PATH,
      ], options());
    }
    await runGit(['push', remote, `HEAD:refs/heads/${stateRef}`], options());
  };
}
