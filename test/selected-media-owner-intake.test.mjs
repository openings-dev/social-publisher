import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runIntake } from '../src/cli/intake.mjs';
import { readEnvironment } from '../src/config/env.mjs';
import {
  processIntakeSnapshots,
  processOnePublication,
} from '../src/modules/publishing/orchestrator.mjs';
import { saveStateFile } from '../src/modules/state/save-state.mjs';
import {
  resetFailedStage,
  selectNextQueueItem,
} from '../src/modules/state/queue-operations.mjs';
import { validateQueueState } from '../src/modules/state/state-model.mjs';

const at = '2026-09-10T12:00:00.000Z';
const previous = snapshot('a', '2026-09-10T10:00:00.000Z', []);

function job(index, overrides = {}) {
  const id = `gh_${index.toString(16).padStart(24, '0')}`;
  return {
    id,
    sourceId: `openings/jobs#${index}`,
    sourceType: 'github-issue',
    issueState: 'open',
    title: `Engineer ${index}`,
    repository: 'openings/jobs',
    url: `https://github.com/openings/jobs/issues/${index}`,
    contentHash: index.toString(16).padStart(64, '0'),
    createdAt: '2026-09-10T10:00:01.000Z',
    updatedAt: '2026-09-10T10:00:01.000Z',
    ...overrides,
  };
}

function snapshot(character, generatedAt, jobs) {
  return {
    schemaVersion: 4,
    commit: character.repeat(40),
    generatedAt,
    dataHash: character.repeat(64),
    jobsById: new Map(jobs.map((item) => [item.id, item])),
  };
}

function intake(processedSnapshot = previous) {
  return {
    schemaVersion: 3,
    processedSnapshot: processedSnapshot === null ? null : {
      commit: processedSnapshot.commit,
      generatedAt: processedSnapshot.generatedAt,
      dataHash: processedSnapshot.dataHash,
    },
    pendingBridges: [],
    removedJobs: [],
  };
}

function queue(items = []) { return { schemaVersion: 3, items }; }
function publications(jobs = {}) { return { schemaVersion: 3, jobs }; }

function failedCheckpoint(item, current) {
  return {
    jobId: item.id,
    contentHash: item.contentHash,
    dataCommit: current.commit,
    dataHash: current.dataHash,
    reason: 'new',
    stage: {
      status: 'failed', attempts: 3, updatedAt: at,
      lastError: { code: 'bridge_deployment', at },
      lastReset: { reason: 'operator_retry', at },
      result: { status: 'deployed', legacyRemoteId: 'keep-me' },
    },
  };
}

test('selected owner intake rejects an invalid strategy before any supplied callback', async () => {
  let calls = 0;
  await assert.rejects(processIntakeSnapshots({
    strategy: 'unknown',
    intakeState: intake(), queueState: queue(), publicationsState: publications(),
    snapshots: [previous], publishBridge: async () => { calls += 1; },
  }), /strategy/u);
  assert.equal(calls, 0);
});

test('selected owner intake queues only eligible new jobs with pending media and never renders changed or ineligible jobs', async () => {
  const changedBefore = job(1, { contentHash: '1'.repeat(64), createdAt: '2026-09-09T00:00:00.000Z' });
  const changedAfter = { ...changedBefore, contentHash: '2'.repeat(64), updatedAt: at };
  const eligible = job(2);
  const historical = job(3, { createdAt: previous.generatedAt });
  const closed = job(4, { issueState: 'closed' });
  const current = snapshot('b', '2026-09-10T13:00:00.000Z', [changedAfter, eligible, historical, closed]);
  const result = await processIntakeSnapshots({
    strategy: 'selected-media-owner',
    intakeState: intake(), queueState: queue(), publicationsState: publications(),
    snapshots: [{ ...previous, jobsById: new Map([[changedBefore.id, changedBefore]]) }, current],
    enabledChannels: ['bluesky', 'instagram'], instagramStoryEnabled: true, now: at,
  });
  assert.equal(result.summary.bridges, 0);
  assert.equal(result.summary.queued, 1);
  assert.equal(result.summary.complete, true);
  assert.equal(result.intakeState.processedSnapshot.commit, current.commit);
  assert.deepEqual(result.intakeState.pendingBridges, []);
  assert.deepEqual(result.queueState.items.map((item) => item.jobId), [eligible.id]);
  assert.equal(result.queueState.items[0].bridge.status, 'pending');
  assert.equal(result.queueState.items[0].instagram.status, 'pending');
  assert.equal(result.queueState.items[0].instagramStory.status, 'pending');
  assert.equal(result.queueState.items[0].mastodon.status, 'skipped_disabled');
});

test('selected owner intake transfers only an exact failed checkpoint with immutable provenance', async () => {
  const eligible = job(5);
  const current = snapshot('c', '2026-09-10T13:00:00.000Z', [eligible]);
  const checkpoint = failedCheckpoint(eligible, current);
  const initial = { ...intake(), pendingBridges: [checkpoint] };
  const result = await processIntakeSnapshots({
    strategy: 'selected-media-owner', intakeState: initial, queueState: queue(),
    publicationsState: publications(), snapshots: [previous, current], now: at,
  });
  const item = result.queueState.items[0];
  assert.deepEqual(item.bridge, checkpoint.stage);
  assert.deepEqual(item.legacyBridgeProvenance, {
    jobId: eligible.id,
    contentHash: eligible.contentHash,
    dataCommit: current.commit,
    dataHash: current.dataHash,
    reason: 'new',
  });
  assert.equal(selectNextQueueItem(result.queueState, at), null);
  assert.deepEqual(item.bridge.lastReset, checkpoint.stage.lastReset);
  assert.deepEqual(result.intakeState.pendingBridges, []);
});

test('selected owner intake cap counts only new additions and resumes the same transition idempotently', async () => {
  const jobs = [job(6), job(7), job(8)];
  const current = snapshot('d', '2026-09-10T13:00:00.000Z', jobs);
  const first = await processIntakeSnapshots({
    strategy: 'selected-media-owner', maxQueueAdditions: 1,
    intakeState: intake(), queueState: queue(), publicationsState: publications(),
    snapshots: [previous, current], now: at,
  });
  assert.equal(first.summary.complete, false);
  assert.equal(first.intakeState.processedSnapshot.commit, previous.commit);
  assert.deepEqual(first.queueState.items.map((item) => item.jobId), [jobs[0].id]);

  const second = await processIntakeSnapshots({
    strategy: 'selected-media-owner', maxQueueAdditions: 1,
    intakeState: first.intakeState, queueState: first.queueState, publicationsState: publications(),
    snapshots: [previous, current], now: at,
  });
  assert.equal(second.summary.complete, false);
  assert.deepEqual(second.queueState.items.map((item) => item.jobId), [jobs[0].id, jobs[1].id]);

  const third = await processIntakeSnapshots({
    strategy: 'selected-media-owner', maxQueueAdditions: 1,
    intakeState: second.intakeState, queueState: second.queueState, publicationsState: publications(),
    snapshots: [previous, current], now: at,
  });
  assert.equal(third.summary.complete, true);
  assert.equal(third.intakeState.processedSnapshot.commit, current.commit);
  assert.deepEqual(third.queueState.items.map((item) => item.jobId), jobs.map((item) => item.id));
});

test('selected owner intake baselines newest without work and rejects a missing exact watermark boundary', async () => {
  const current = snapshot('e', '2026-09-10T13:00:00.000Z', [job(9)]);
  const baseline = await processIntakeSnapshots({
    strategy: 'selected-media-owner', intakeState: intake(null), queueState: queue(),
    publicationsState: publications(), snapshots: [previous, current], now: at,
  });
  assert.equal(baseline.summary.baseline, true);
  assert.equal(baseline.intakeState.processedSnapshot.commit, current.commit);
  assert.deepEqual(baseline.queueState.items, []);
  await assert.rejects(processIntakeSnapshots({
    strategy: 'selected-media-owner', intakeState: intake(snapshot('f', at, [])), queueState: queue(),
    publicationsState: publications(), snapshots: [previous, current], now: at,
  }), /watermark/u);
});

test('selected owner intake preserves removals and watermark until an entire transition is traversed', async () => {
  const removed = job(10, { createdAt: '2026-09-09T00:00:00.000Z' });
  const start = { ...previous, jobsById: new Map([[removed.id, removed]]) };
  const additions = [job(11), job(12)];
  const current = snapshot('1', '2026-09-10T13:00:00.000Z', additions);
  const first = await processIntakeSnapshots({
    strategy: 'selected-media-owner', maxQueueAdditions: 1,
    intakeState: intake(start), queueState: queue(), publicationsState: publications(),
    snapshots: [start, current], now: at,
  });
  assert.equal(first.summary.complete, false);
  assert.deepEqual(first.intakeState.removedJobs, []);
  assert.equal(first.intakeState.processedSnapshot.commit, start.commit);
  const second = await processIntakeSnapshots({
    strategy: 'selected-media-owner', maxQueueAdditions: 1,
    intakeState: first.intakeState, queueState: first.queueState, publicationsState: publications(),
    snapshots: [start, current], now: at,
  });
  assert.equal(second.summary.complete, true);
  assert.deepEqual(second.intakeState.removedJobs, [removed.id]);
  assert.equal(second.intakeState.processedSnapshot.commit, current.commit);
});

test('selected owner intake applies one addition cap across transitions and resumes at the exact transition boundary', async () => {
  const firstJob = job(20); const secondJob = job(21, { createdAt: '2026-09-10T11:00:01.000Z' });
  const middle = snapshot('8', '2026-09-10T11:00:00.000Z', [firstJob]);
  const current = snapshot('9', '2026-09-10T13:00:00.000Z', [firstJob, secondJob]);
  const first = await processIntakeSnapshots({
    strategy: 'selected-media-owner', maxQueueAdditions: 1,
    intakeState: intake(), queueState: queue(), publicationsState: publications(),
    snapshots: [previous, middle, current], now: at,
  });
  assert.equal(first.summary.complete, false);
  assert.equal(first.intakeState.processedSnapshot.commit, middle.commit);
  assert.deepEqual(first.queueState.items.map((item) => item.jobId), [firstJob.id]);
  const resumed = await processIntakeSnapshots({
    strategy: 'selected-media-owner', maxQueueAdditions: 1,
    intakeState: first.intakeState, queueState: first.queueState, publicationsState: publications(),
    snapshots: [previous, middle, current], now: at,
  });
  assert.equal(resumed.summary.complete, true);
  assert.equal(resumed.intakeState.processedSnapshot.commit, current.commit);
  assert.deepEqual(resumed.queueState.items.map((item) => item.jobId), [firstJob.id, secondJob.id]);
});

test('selected owner intake counts a transferred hold but not an existing queue item against its cap', async () => {
  const existingJob = job(22); const transferredJob = job(23); const deferredJob = job(24);
  const current = snapshot('b', '2026-09-10T13:00:00.000Z', [existingJob, transferredJob, deferredJob]);
  const seeded = await processIntakeSnapshots({
    strategy: 'selected-media-owner', intakeState: intake(), queueState: queue(), publicationsState: publications(),
    snapshots: [previous, snapshot('c', '2026-09-10T11:00:00.000Z', [existingJob])], now: at,
  });
  const checkpoint = failedCheckpoint(transferredJob, current);
  const first = await processIntakeSnapshots({
    strategy: 'selected-media-owner', maxQueueAdditions: 1,
    intakeState: { ...intake(), pendingBridges: [checkpoint] }, queueState: seeded.queueState,
    publicationsState: publications(), snapshots: [previous, current], now: at,
  });
  assert.equal(first.summary.complete, false);
  assert.deepEqual(first.queueState.items.map((item) => item.jobId), [existingJob.id, transferredJob.id]);
  assert.equal(first.queueState.items[1].bridge.status, 'failed');
  assert.deepEqual(first.intakeState.pendingBridges, []);
});

test('selected owner intake preserves stale, changed-reason, and published checkpoints', async () => {
  const eligible = job(13); const current = snapshot('2', '2026-09-10T13:00:00.000Z', [eligible]);
  for (const mutate of [
    (checkpoint) => { checkpoint.contentHash = 'f'.repeat(64); },
    (checkpoint) => { checkpoint.dataCommit = 'f'.repeat(40); },
    (checkpoint) => { checkpoint.dataHash = 'f'.repeat(64); },
    (checkpoint) => { checkpoint.reason = 'changed'; },
    (checkpoint) => { checkpoint.stage.status = 'published'; checkpoint.stage.lastError = null; },
  ]) {
    const checkpoint = structuredClone(failedCheckpoint(eligible, current)); mutate(checkpoint);
    const result = await processIntakeSnapshots({
      strategy: 'selected-media-owner', intakeState: { ...intake(), pendingBridges: [checkpoint] },
      queueState: queue(), publicationsState: publications(), snapshots: [previous, current], now: at,
    });
    assert.equal(result.queueState.items[0].bridge.status, 'pending');
    assert.equal(Object.hasOwn(result.queueState.items[0], 'legacyBridgeProvenance'), false);
    assert.deepEqual(result.intakeState.pendingBridges, [checkpoint]);
  }
});

test('selected owner intake preserves an existing queue item and matching legacy checkpoint independently', async () => {
  const eligible = job(14); const current = snapshot('3', '2026-09-10T13:00:00.000Z', [eligible]);
  const queued = await processIntakeSnapshots({
    strategy: 'selected-media-owner', intakeState: intake(), queueState: queue(),
    publicationsState: publications(), snapshots: [previous, current], now: at,
  });
  const existing = structuredClone(queued.queueState.items[0]);
  existing.bridge = { ...existing.bridge, status: 'published', attempts: 1, updatedAt: at,
    result: { legacyRemoteId: 'existing-receipt' } };
  const checkpoint = failedCheckpoint(eligible, current);
  const replay = await processIntakeSnapshots({
    strategy: 'selected-media-owner', intakeState: { ...intake(), pendingBridges: [checkpoint] },
    queueState: queue([existing]), publicationsState: publications(), snapshots: [previous, current], now: at,
  });
  assert.deepEqual(replay.queueState.items, [existing]);
  assert.deepEqual(replay.intakeState.pendingBridges, [checkpoint]);
  assert.equal(replay.summary.queued, 0);
});

test('legacy checkpoint provenance is exact, bound, and survives reset, revision update, and replacement', async () => {
  const eligible = job(15); const current = snapshot('4', '2026-09-10T13:00:00.000Z', [eligible]);
  const transferred = await processIntakeSnapshots({
    strategy: 'selected-media-owner', intakeState: { ...intake(), pendingBridges: [failedCheckpoint(eligible, current)] },
    queueState: queue(), publicationsState: publications(), snapshots: [previous, current],
    enabledChannels: [], now: at,
  });
  const item = transferred.queueState.items[0];
  for (const provenance of [
    { ...item.legacyBridgeProvenance, extra: true },
    { ...item.legacyBridgeProvenance, dataCommit: 'bad' },
    { ...item.legacyBridgeProvenance, jobId: job(16).id },
    { ...item.legacyBridgeProvenance, reason: 'changed' },
  ]) {
    assert.throws(() => validateQueueState(queue([{ ...item, legacyBridgeProvenance: provenance }])), /legacyBridgeProvenance/u);
  }
  const reset = resetFailedStage(transferred.queueState, eligible.id, 'bridge', { at, reason: 'operator_retry' });
  const historicalProvenance = structuredClone(reset.items[0].legacyBridgeProvenance);
  const revisedJob = { ...eligible, contentHash: 'f'.repeat(64), updatedAt: '2026-09-10T13:30:00.000Z' };
  const revisedSnapshot = snapshot('e', '2026-09-10T14:00:00.000Z', [revisedJob]);
  const result = await processOnePublication({
    queueState: reset,
    publicationsState: publications(),
    currentSnapshot: revisedSnapshot,
    publishBridge: async () => ({ status: 'deployed', replacement: true }),
    publishBluesky: async () => assert.fail('disabled channel must not publish'),
    publishMastodon: async () => assert.fail('disabled channel must not publish'),
    jobId: eligible.id,
    now: '2026-09-10T14:01:00.000Z',
  });
  assert.equal(result.queueState.items[0].contentHash, revisedJob.contentHash);
  assert.equal(result.queueState.items[0].dataCommit, revisedSnapshot.commit);
  assert.equal(result.queueState.items[0].dataHash, revisedSnapshot.dataHash);
  assert.deepEqual(result.queueState.items[0].legacyBridgeProvenance, historicalProvenance);
  assert.equal(result.queueState.items[0].bridge.result.replacement, true);
});

test('selected owner intake requires a finite positive queue-addition cap', async () => {
  for (const maxQueueAdditions of [0, -1, Number.POSITIVE_INFINITY, 1.5]) {
    await assert.rejects(processIntakeSnapshots({
      strategy: 'selected-media-owner', maxQueueAdditions,
      intakeState: intake(), queueState: queue(), publicationsState: publications(), snapshots: [previous],
    }), /maxQueueAdditions/u);
  }
});

test('selected owner intake defaults to twenty-five actual queue additions', async () => {
  const jobs = Array.from({ length: 26 }, (_, index) => job(100 + index));
  const current = snapshot('6', '2026-09-10T13:00:00.000Z', jobs);
  const first = await processIntakeSnapshots({
    strategy: 'selected-media-owner', intakeState: intake(), queueState: queue(),
    publicationsState: publications(), snapshots: [previous, current], now: at,
  });
  assert.equal(first.summary.complete, false);
  assert.equal(first.summary.queued, 25);
  assert.equal(first.queueState.items.length, 25);
  assert.equal(first.intakeState.processedSnapshot.commit, previous.commit);
  const resumed = await processIntakeSnapshots({
    strategy: 'selected-media-owner', intakeState: first.intakeState, queueState: first.queueState,
    publicationsState: publications(), snapshots: [previous, current], now: at,
  });
  assert.equal(resumed.summary.complete, true);
  assert.equal(resumed.summary.queued, 1);
  assert.equal(resumed.queueState.items.length, 26);
});

test('selected owner intake preserves completed and intentionally skipped exclusions', async () => {
  const completed = job(27); const skipped = job(28); const eligible = job(29);
  const current = snapshot('7', '2026-09-10T13:00:00.000Z', [completed, skipped, eligible]);
  const result = await processIntakeSnapshots({
    strategy: 'selected-media-owner', intakeState: intake(), queueState: queue(), snapshots: [previous, current],
    publicationsState: publications({
      [completed.id]: { status: 'completed', completedAt: at, linkedin: null, twitter: null },
      [skipped.id]: { intentionallySkippedAt: at, linkedin: null, twitter: null },
    }), now: at,
  });
  assert.deepEqual(result.queueState.items.map((item) => item.jobId), [eligible.id]);
});

test('selected owner intake relaxes deploy credentials only for intake mode', () => {
  assert.equal(readEnvironment({ env: {}, mode: 'intake', intakeStrategy: 'selected-media-owner' }).webDeploy, null);
  assert.throws(() => readEnvironment({ env: {}, mode: 'intake' }), /WEB_DEPLOY_TOKEN/u);
  assert.throws(() => readEnvironment({ env: {}, mode: 'scheduled', intakeStrategy: 'selected-media-owner' }),
    /WEB_DEPLOY_TOKEN/u);
});

async function intakeDirectory(t, initialIntake = intake()) {
  const directory = await mkdtemp(join(tmpdir(), 'openings-selected-owner-intake-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(directory, 'intake.json'), `${JSON.stringify(initialIntake)}\n`),
    writeFile(join(directory, 'queue.json'), `${JSON.stringify(queue())}\n`),
    writeFile(join(directory, 'publications.json'), `${JSON.stringify(publications())}\n`),
  ]);
  return directory;
}

function runtimeDependencies(current, overrides = {}) {
  return {
    resolveGitCommit: async () => current.commit,
    listSnapshotCommits: async () => [previous.commit, current.commit],
    loadSnapshot: async (_repository, commit) => commit === previous.commit ? previous : current,
    loadCanonicalWordmark: async () => assert.fail('owner intake must not load the wordmark'),
    createBridgePublisher: () => assert.fail('owner intake must not construct the bridge publisher'),
    ...overrides,
  };
}

test('selected owner runtime avoids legacy credentials and saves queue then intake before its awaited checkpoint', async (t) => {
  const eligible = job(17); const current = snapshot('5', '2026-09-10T13:00:00.000Z', [eligible]);
  const directory = await intakeDirectory(t); const order = [];
  const result = await runIntake({
    strategy: 'selected-media-owner', dataRepositoryPath: '/fixture/data', stateDirectory: directory,
    wordmarkPath: '/missing/wordmark.svg', outputPath: '/unused/output', env: {}, log: () => {},
    checkpoint: async () => {
      order.push('checkpoint');
      const durableQueue = JSON.parse(await readFile(join(directory, 'queue.json'), 'utf8'));
      const durableIntake = JSON.parse(await readFile(join(directory, 'intake.json'), 'utf8'));
      assert.deepEqual(durableQueue.items.map((item) => item.jobId), [eligible.id]);
      assert.equal(durableIntake.processedSnapshot.commit, current.commit);
    },
    dependencies: runtimeDependencies(current, {
      saveStateFile: async (path, value, validator) => {
        order.push(path.endsWith('queue.json') ? 'queue' : 'intake');
        return saveStateFile(path, value, validator);
      },
    }),
  });
  assert.deepEqual(order, ['queue', 'intake', 'checkpoint']);
  assert.equal(result.queueState.items[0].bridge.status, 'pending');
});

test('selected owner runtime rejects its strategy before configuration, files, or dependencies', async () => {
  let calls = 0;
  await assert.rejects(runIntake({
    strategy: 'invalid', dataRepositoryPath: '/missing', stateDirectory: '/missing',
    wordmarkPath: '/missing', outputPath: '/missing', env: {},
    dependencies: { resolveGitCommit: async () => { calls += 1; } },
  }), /strategy/u);
  assert.equal(calls, 0);
});

test('selected owner runtime does not advance intake when the queue save fails', async (t) => {
  const eligible = job(18); const current = snapshot('6', '2026-09-10T13:00:00.000Z', [eligible]);
  const directory = await intakeDirectory(t); const saved = [];
  await assert.rejects(runIntake({
    strategy: 'selected-media-owner', dataRepositoryPath: '/fixture/data', stateDirectory: directory,
    wordmarkPath: '/unused', outputPath: '/unused', env: {}, log: () => {},
    checkpoint: async () => assert.fail('checkpoint must not run'),
    dependencies: runtimeDependencies(current, {
      saveStateFile: async (path) => { saved.push(path); throw new Error('queue save unavailable'); },
    }),
  }), /queue save unavailable/u);
  assert.deepEqual(saved, [join(directory, 'queue.json')]);
  assert.equal(JSON.parse(await readFile(join(directory, 'intake.json'), 'utf8')).processedSnapshot.commit, previous.commit);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'queue.json'), 'utf8')).items, []);
});

test('selected owner runtime restarts from a durable queue after intake save failure without duplication', async (t) => {
  const eligible = job(19); const current = snapshot('7', '2026-09-10T13:00:00.000Z', [eligible]);
  const directory = await intakeDirectory(t); let checkpointCalls = 0;
  await assert.rejects(runIntake({
    strategy: 'selected-media-owner', dataRepositoryPath: '/fixture/data', stateDirectory: directory,
    wordmarkPath: '/unused', outputPath: '/unused', env: {}, log: () => {},
    checkpoint: async () => { checkpointCalls += 1; },
    dependencies: runtimeDependencies(current, {
      saveStateFile: async (path, value, validator) => {
        if (path.endsWith('intake.json')) throw new Error('intake save unavailable');
        return saveStateFile(path, value, validator);
      },
    }),
  }), /intake save unavailable/u);
  assert.equal(checkpointCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'queue.json'), 'utf8')).items.map((item) => item.jobId),
    [eligible.id]);
  assert.equal(JSON.parse(await readFile(join(directory, 'intake.json'), 'utf8')).processedSnapshot.commit, previous.commit);

  await runIntake({
    strategy: 'selected-media-owner', dataRepositoryPath: '/fixture/data', stateDirectory: directory,
    wordmarkPath: '/unused', outputPath: '/unused', env: {}, log: () => {},
    checkpoint: async () => { checkpointCalls += 1; }, dependencies: runtimeDependencies(current),
  });
  assert.equal(checkpointCalls, 1);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'queue.json'), 'utf8')).items.map((item) => item.jobId),
    [eligible.id]);
  assert.equal(JSON.parse(await readFile(join(directory, 'intake.json'), 'utf8')).processedSnapshot.commit, current.commit);
});

test('selected owner runtime preserves transferred failed-stage identity across an intake-save restart', async (t) => {
  const eligible = job(25); const current = snapshot('d', '2026-09-10T13:00:00.000Z', [eligible]);
  const checkpoint = failedCheckpoint(eligible, current);
  const directory = await intakeDirectory(t, { ...intake(), pendingBridges: [checkpoint] });
  await assert.rejects(runIntake({
    strategy: 'selected-media-owner', dataRepositoryPath: '/fixture/data', stateDirectory: directory,
    wordmarkPath: '/unused', outputPath: '/unused', env: {}, log: () => {},
    dependencies: runtimeDependencies(current, {
      saveStateFile: async (path, value, validator) => {
        if (path.endsWith('intake.json')) throw new Error('intake save unavailable');
        return saveStateFile(path, value, validator);
      },
    }),
  }), /intake save unavailable/u);
  const durableQueue = JSON.parse(await readFile(join(directory, 'queue.json'), 'utf8'));
  assert.deepEqual(durableQueue.items[0].bridge, checkpoint.stage);
  assert.deepEqual(durableQueue.items[0].legacyBridgeProvenance, {
    jobId: eligible.id, contentHash: eligible.contentHash,
    dataCommit: current.commit, dataHash: current.dataHash, reason: 'new',
  });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'intake.json'), 'utf8')).pendingBridges, [checkpoint]);
  await runIntake({
    strategy: 'selected-media-owner', dataRepositoryPath: '/fixture/data', stateDirectory: directory,
    wordmarkPath: '/unused', outputPath: '/unused', env: {}, log: () => {}, dependencies: runtimeDependencies(current),
  });
  const restartedQueue = JSON.parse(await readFile(join(directory, 'queue.json'), 'utf8'));
  assert.equal(restartedQueue.items.length, 1);
  assert.deepEqual(restartedQueue.items[0].bridge, checkpoint.stage);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'intake.json'), 'utf8')).pendingBridges, [checkpoint]);
});

test('selected owner runtime propagates checkpoint failure after both state files are durable', async (t) => {
  const eligible = job(26); const current = snapshot('e', '2026-09-10T13:00:00.000Z', [eligible]);
  const directory = await intakeDirectory(t);
  await assert.rejects(runIntake({
    strategy: 'selected-media-owner', dataRepositoryPath: '/fixture/data', stateDirectory: directory,
    wordmarkPath: '/unused', outputPath: '/unused', env: {}, log: () => {},
    checkpoint: async () => { throw new Error('checkpoint push unavailable'); },
    dependencies: runtimeDependencies(current),
  }), /checkpoint push unavailable/u);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'queue.json'), 'utf8')).items.map((item) => item.jobId),
    [eligible.id]);
  assert.equal(JSON.parse(await readFile(join(directory, 'intake.json'), 'utf8')).processedSnapshot.commit, current.commit);
});
