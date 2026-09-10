import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createQueueGitCheckpoint } from '../src/modules/state/git-checkpoint.mjs';

const execFile = promisify(execFileCallback);
const workflow = readFileSync(new URL('../.github/workflows/publish-social.yml', import.meta.url), 'utf8');

function workflowStep(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return workflow.match(new RegExp(`^      - name: ${escaped}(?<block>[\\s\\S]*?)(?=^      - name:|(?![\\s\\S]))`, 'mu'))?.groups?.block ?? '';
}

async function git(cwd, args) {
  return execFile('git', args, { cwd, encoding: 'utf8' });
}

test('validates the exact repository, queue path, remote, and state ref before Git access', () => {
  const root = '/tmp/openings-checkpoint-fixture';
  const queuePath = `${root}/state/queue.json`;
  const valid = { repositoryRoot: root, queuePath, remote: 'origin', stateRef: 'main' };
  for (const change of [
    { repositoryRoot: 'relative/root' },
    { repositoryRoot: `${root}/../other` },
    { queuePath: `${root}/state/../publications.json` },
    { queuePath: `${root}/state/publications.json` },
    { intakePath: `${root}/state/publications.json` },
    { intakePath: `${root}/state/../intake.json` },
    { remote: 'upstream' },
    { remote: 'origin --force' },
    { stateRef: 'refs/heads/main' },
    { stateRef: '../main' },
    { stateRef: 'main:evil' },
    { stateRef: 'main\nleak' },
    { stateRef: '-main' },
  ]) {
    assert.throws(() => createQueueGitCheckpoint({ ...valid, ...change }), /checkpoint configuration/u);
  }
});

test('uses one narrow commit and push for the exact paired queue and intake paths', async () => {
  const root = '/tmp/openings-checkpoint-fixture'; const calls = [];
  const checkpoint = createQueueGitCheckpoint({
    repositoryRoot: root,
    queuePath: `${root}/state/queue.json`,
    intakePath: `${root}/state/intake.json`,
    remote: 'origin',
    stateRef: 'main',
    runGit: async (args, options) => {
      calls.push({ args, options });
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: root };
      if (args[0] === 'branch') return { exitCode: 0, stdout: 'main' };
      if (args[0] === 'diff') return { exitCode: 1, stdout: '' };
      return { exitCode: 0, stdout: '' };
    },
  });
  await checkpoint();
  const paths = ['state/queue.json', 'state/intake.json'];
  assert.deepEqual(calls.map(({ args }) => args), [
    ['rev-parse', '--show-toplevel'],
    ['branch', '--show-current'],
    ['add', '--', ...paths],
    ['diff', '--cached', '--quiet', '--', ...paths],
    ['commit', '--only', '-m', 'chore(state): checkpoint social publication [skip ci]', '--', ...paths],
    ['push', 'origin', 'HEAD:refs/heads/main'],
  ]);
});

test('uses narrow argument arrays, skips an unchanged commit, and still pushes HEAD', async () => {
  const root = '/tmp/openings-checkpoint-fixture';
  const calls = [];
  const checkpoint = createQueueGitCheckpoint({
    repositoryRoot: root,
    queuePath: `${root}/state/queue.json`,
    remote: 'origin',
    stateRef: 'main',
    runGit: async (args, options) => {
      calls.push({ args, options });
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: root };
      if (args[0] === 'branch') return { exitCode: 0, stdout: 'main' };
      return { exitCode: 0, stdout: '' };
    },
  });

  await checkpoint();

  assert.deepEqual(calls, [
    { args: ['rev-parse', '--show-toplevel'], options: { cwd: root, allowExitCodeOne: false } },
    { args: ['branch', '--show-current'], options: { cwd: root, allowExitCodeOne: false } },
    { args: ['add', '--', 'state/queue.json'], options: { cwd: root, allowExitCodeOne: false } },
    { args: ['diff', '--cached', '--quiet', '--', 'state/queue.json'], options: { cwd: root, allowExitCodeOne: true } },
    { args: ['push', 'origin', 'HEAD:refs/heads/main'], options: { cwd: root, allowExitCodeOne: false } },
  ]);
});

test('rejects a different Git root or current branch before staging state', async () => {
  const root = '/tmp/openings-checkpoint-fixture';
  for (const [rootReply, branchReply] of [
    ['/tmp/different-repository', 'main'],
    [root, 'release'],
  ]) {
    const calls = [];
    const checkpoint = createQueueGitCheckpoint({
      repositoryRoot: root,
      queuePath: `${root}/state/queue.json`,
      remote: 'origin',
      stateRef: 'main',
      runGit: async (args) => {
        calls.push(args);
        return {
          exitCode: 0,
          stdout: args[0] === 'rev-parse' ? rootReply : branchReply,
        };
      },
    });
    await assert.rejects(checkpoint(), /repository identity/u);
    assert.equal(calls.some((args) => args[0] === 'add'), false);
  }
});

test('commits only queue.json, leaves unrelated staged files alone, and pushes HEAD to the validated ref', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'openings-git-checkpoint-')));
  const repositoryRoot = join(directory, 'publisher');
  const remoteRoot = join(directory, 'remote.git');
  await Promise.all([mkdir(join(repositoryRoot, 'state'), { recursive: true }), mkdir(remoteRoot)]);
  await git(remoteRoot, ['init', '--bare', '--initial-branch=main']);
  await git(repositoryRoot, ['init', '--initial-branch=main']);
  await git(repositoryRoot, ['config', 'user.name', 'Checkpoint Test']);
  await git(repositoryRoot, ['config', 'user.email', 'checkpoint@example.invalid']);
  await Promise.all([
    writeFile(join(repositoryRoot, 'state', 'queue.json'), '{"version":1}\n'),
    writeFile(join(repositoryRoot, 'unrelated.txt'), 'initial\n'),
  ]);
  await git(repositoryRoot, ['add', '--', 'state/queue.json', 'unrelated.txt']);
  await git(repositoryRoot, ['commit', '-m', 'initial']);
  await git(repositoryRoot, ['remote', 'add', 'origin', remoteRoot]);
  await git(repositoryRoot, ['push', 'origin', 'HEAD:refs/heads/main']);

  await Promise.all([
    writeFile(join(repositoryRoot, 'state', 'queue.json'), '{"version":2}\n'),
    writeFile(join(repositoryRoot, 'unrelated.txt'), 'staged but unrelated\n'),
  ]);
  await git(repositoryRoot, ['add', '--', 'unrelated.txt']);

  const checkpoint = createQueueGitCheckpoint({
    repositoryRoot,
    queuePath: join(repositoryRoot, 'state', 'queue.json'),
    remote: 'origin',
    stateRef: 'main',
  });
  await checkpoint();

  assert.equal((await git(repositoryRoot, ['show', '--pretty=', '--name-only', 'HEAD'])).stdout.trim(), 'state/queue.json');
  assert.equal((await git(repositoryRoot, ['diff', '--cached', '--name-only'])).stdout.trim(), 'unrelated.txt');
  assert.equal(
    (await git(remoteRoot, ['show', 'refs/heads/main:state/queue.json'])).stdout,
    '{"version":2}\n',
  );
  assert.equal(await readFile(join(repositoryRoot, 'unrelated.txt'), 'utf8'), 'staged but unrelated\n');
});

test('retries a real failed push without a duplicate commit and makes the prior intent durable', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'openings-git-push-retry-')));
  const repositoryRoot = join(directory, 'publisher');
  const remoteRoot = join(directory, 'remote.git');
  await Promise.all([mkdir(join(repositoryRoot, 'state'), { recursive: true }), mkdir(remoteRoot)]);
  await git(remoteRoot, ['init', '--bare', '--initial-branch=main']);
  await git(repositoryRoot, ['init', '--initial-branch=main']);
  await git(repositoryRoot, ['config', 'user.name', 'Checkpoint Test']);
  await git(repositoryRoot, ['config', 'user.email', 'checkpoint@example.invalid']);
  await writeFile(join(repositoryRoot, 'state', 'queue.json'), '{"instagram":"pending"}\n');
  await git(repositoryRoot, ['add', '--', 'state/queue.json']);
  await git(repositoryRoot, ['commit', '-m', 'initial']);
  await git(repositoryRoot, ['remote', 'add', 'origin', remoteRoot]);
  await git(repositoryRoot, ['push', 'origin', 'HEAD:refs/heads/main']);

  await writeFile(join(repositoryRoot, 'state', 'queue.json'), '{"instagram":"publishing"}\n');
  const checkpoint = createQueueGitCheckpoint({
    repositoryRoot,
    queuePath: join(repositoryRoot, 'state', 'queue.json'),
    remote: 'origin',
    stateRef: 'main',
  });
  await git(repositoryRoot, ['remote', 'set-url', 'origin', join(directory, 'missing.git')]);
  await assert.rejects(checkpoint());
  const commitsAfterFailure = (await git(repositoryRoot, ['rev-list', '--count', 'HEAD'])).stdout.trim();
  assert.equal((await git(remoteRoot, ['show', 'refs/heads/main:state/queue.json'])).stdout, '{"instagram":"pending"}\n');

  await git(repositoryRoot, ['remote', 'set-url', 'origin', remoteRoot]);
  await checkpoint();

  assert.equal((await git(repositoryRoot, ['rev-list', '--count', 'HEAD'])).stdout.trim(), commitsAfterFailure);
  assert.equal((await git(remoteRoot, ['show', 'refs/heads/main:state/queue.json'])).stdout, '{"instagram":"publishing"}\n');
});

test('commits paired state atomically while preserving unrelated staging', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'openings-paired-checkpoint-')));
  const repositoryRoot = join(directory, 'publisher'); const remoteRoot = join(directory, 'remote.git');
  await Promise.all([mkdir(join(repositoryRoot, 'state'), { recursive: true }), mkdir(remoteRoot)]);
  await git(remoteRoot, ['init', '--bare', '--initial-branch=main']);
  await git(repositoryRoot, ['init', '--initial-branch=main']);
  await git(repositoryRoot, ['config', 'user.name', 'Checkpoint Test']);
  await git(repositoryRoot, ['config', 'user.email', 'checkpoint@example.invalid']);
  await Promise.all([
    writeFile(join(repositoryRoot, 'state', 'queue.json'), '{"queue":1}\n'),
    writeFile(join(repositoryRoot, 'state', 'intake.json'), '{"intake":1}\n'),
    writeFile(join(repositoryRoot, 'unrelated.txt'), 'initial\n'),
  ]);
  await git(repositoryRoot, ['add', '--', 'state/queue.json', 'state/intake.json', 'unrelated.txt']);
  await git(repositoryRoot, ['commit', '-m', 'initial']);
  await git(repositoryRoot, ['remote', 'add', 'origin', remoteRoot]);
  await git(repositoryRoot, ['push', 'origin', 'HEAD:refs/heads/main']);
  await Promise.all([
    writeFile(join(repositoryRoot, 'state', 'queue.json'), '{"queue":2}\n'),
    writeFile(join(repositoryRoot, 'state', 'intake.json'), '{"intake":2}\n'),
    writeFile(join(repositoryRoot, 'unrelated.txt'), 'staged unrelated\n'),
  ]);
  await git(repositoryRoot, ['add', '--', 'unrelated.txt']);
  const before = Number((await git(repositoryRoot, ['rev-list', '--count', 'HEAD'])).stdout.trim());
  await createQueueGitCheckpoint({
    repositoryRoot,
    queuePath: join(repositoryRoot, 'state', 'queue.json'),
    intakePath: join(repositoryRoot, 'state', 'intake.json'),
    remote: 'origin',
    stateRef: 'main',
  })();
  assert.equal(Number((await git(repositoryRoot, ['rev-list', '--count', 'HEAD'])).stdout.trim()), before + 1);
  assert.deepEqual((await git(repositoryRoot, ['show', '--pretty=', '--name-only', 'HEAD'])).stdout.trim().split('\n'),
    ['state/intake.json', 'state/queue.json']);
  assert.equal((await git(repositoryRoot, ['diff', '--cached', '--name-only'])).stdout.trim(), 'unrelated.txt');
  assert.equal((await git(remoteRoot, ['show', 'refs/heads/main:state/queue.json'])).stdout, '{"queue":2}\n');
  assert.equal((await git(remoteRoot, ['show', 'refs/heads/main:state/intake.json'])).stdout, '{"intake":2}\n');
});

test('retries a failed paired push without creating a duplicate commit', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'openings-paired-push-retry-')));
  const repositoryRoot = join(directory, 'publisher'); const remoteRoot = join(directory, 'remote.git');
  await Promise.all([mkdir(join(repositoryRoot, 'state'), { recursive: true }), mkdir(remoteRoot)]);
  await git(remoteRoot, ['init', '--bare', '--initial-branch=main']);
  await git(repositoryRoot, ['init', '--initial-branch=main']);
  await git(repositoryRoot, ['config', 'user.name', 'Checkpoint Test']);
  await git(repositoryRoot, ['config', 'user.email', 'checkpoint@example.invalid']);
  await Promise.all([
    writeFile(join(repositoryRoot, 'state', 'queue.json'), '{"queue":1}\n'),
    writeFile(join(repositoryRoot, 'state', 'intake.json'), '{"intake":1}\n'),
  ]);
  await git(repositoryRoot, ['add', '--', 'state/queue.json', 'state/intake.json']);
  await git(repositoryRoot, ['commit', '-m', 'initial']);
  await git(repositoryRoot, ['remote', 'add', 'origin', remoteRoot]);
  await git(repositoryRoot, ['push', 'origin', 'HEAD:refs/heads/main']);
  await Promise.all([
    writeFile(join(repositoryRoot, 'state', 'queue.json'), '{"queue":2}\n'),
    writeFile(join(repositoryRoot, 'state', 'intake.json'), '{"intake":2}\n'),
  ]);
  const checkpoint = createQueueGitCheckpoint({ repositoryRoot,
    queuePath: join(repositoryRoot, 'state', 'queue.json'), intakePath: join(repositoryRoot, 'state', 'intake.json'),
    remote: 'origin', stateRef: 'main' });
  await git(repositoryRoot, ['remote', 'set-url', 'origin', join(directory, 'missing.git')]);
  await assert.rejects(checkpoint());
  const afterFailure = (await git(repositoryRoot, ['rev-list', '--count', 'HEAD'])).stdout.trim();
  assert.equal((await git(remoteRoot, ['show', 'refs/heads/main:state/queue.json'])).stdout, '{"queue":1}\n');
  assert.equal((await git(remoteRoot, ['show', 'refs/heads/main:state/intake.json'])).stdout, '{"intake":1}\n');
  await git(repositoryRoot, ['remote', 'set-url', 'origin', remoteRoot]);
  await checkpoint();
  assert.equal((await git(repositoryRoot, ['rev-list', '--count', 'HEAD'])).stdout.trim(), afterFailure);
  assert.equal((await git(remoteRoot, ['show', 'refs/heads/main:state/queue.json'])).stdout, '{"queue":2}\n');
  assert.equal((await git(remoteRoot, ['show', 'refs/heads/main:state/intake.json'])).stdout, '{"intake":2}\n');
});

test('workflow configures one validated main state ref and enables durable queue checkpoints only for publication', () => {
  assert.match(workflow, /^      STATE_REF: main$/mu);
  assert.match(workflow, /^      STATE_GIT_REMOTE: origin$/mu);
  assert.match(workflowStep('Check out social-publisher state and source'), /ref: \$\{\{ env\.STATE_REF \}\}/u);
  assert.match(workflowStep('Publish at most one queued job'), /STATE_GIT_CHECKPOINT_ENABLED: 'true'/u);
  assert.equal([...workflow.matchAll(/STATE_GIT_CHECKPOINT_ENABLED:/gu)].length, 1);
  assert.doesNotMatch(workflow, /HEAD:\$\{GITHUB_REF_NAME\}/u);
  for (const match of workflow.matchAll(/git push origin "(?<ref>HEAD:[^"]+)"/gu)) {
    assert.equal(match.groups.ref, 'HEAD:refs/heads/${STATE_REF}');
  }
});

test('workflow establishes Git identity and rejects non-main manual writes before publication', () => {
  const identityIndex = workflow.indexOf('- name: Configure state checkpoint Git identity');
  const publicationIndex = workflow.indexOf('- name: Publish at most one queued job');
  assert.ok(identityIndex > 0 && identityIndex < publicationIndex);
  assert.match(workflowStep('Validate the manual gate before any write'), /SOURCE_REF/u);
  assert.match(workflowStep('Validate the manual gate before any write'), /SOURCE_REF" != "\$STATE_REF/u);
});

test('publication and Story finalization never rebase state before continuing', () => {
  for (const name of [
    'Commit and push publication or reset state',
    'Commit and push Instagram Story state',
  ]) {
    assert.doesNotMatch(workflowStep(name), /git (?:fetch|rebase)/u);
  }
});
