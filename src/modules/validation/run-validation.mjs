import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TID } from '@atproto/common-web';
import sharp from 'sharp';

import { runDryRun } from '../../cli/dry-run.mjs';
import { runPreflight } from '../../cli/preflight.mjs';
import { parsePublicationRequest } from '../../cli/publish.mjs';

import {
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  INSTAGRAM_CARD_VERSION,
  MAX_CHANNEL_ATTEMPTS,
  OPENINGS_ORIGIN,
  STARVATION_THRESHOLD_MS,
  STATE_SCHEMA_VERSION,
} from '../../config/constants.mjs';
import { readEnvironment } from '../../config/env.mjs';
import { escapeAttribute, escapeHtml } from '../../shared/escape.mjs';
import { sha256 } from '../../shared/hash.mjs';
import { fetchJson } from '../../shared/http.mjs';
import { assertValidJobId, buildCanonicalJobUrl, isValidJobId } from '../../shared/job-id.mjs';
import {
  listSnapshotCommits,
  readJsonAtCommit,
  resolveGitCommit,
} from '../data/git-json.mjs';
import { loadSnapshot } from '../data/load-snapshot.mjs';
import { collectBridgeJobs, collectDelta } from '../intake/collect-delta.mjs';
import { isEligibleNewJob } from '../intake/eligibility.mjs';
import {
  blueskyRecordKey,
  publishToBluesky,
} from '../networks/bluesky-client.mjs';
import {
  mastodonIdempotencyKey,
  publishToMastodon,
} from '../networks/mastodon-client.mjs';
import { publishToInstagram } from '../networks/instagram-client.mjs';
import { publishToThreads } from '../networks/threads-client.mjs';
import {
  buildRepositoryDispatchRequest,
  requestIncrementalBridgeDeployment,
} from '../deploy/web-deploy-client.mjs';
import { verifyPublicBridge } from '../deploy/public-verifier.mjs';
import {
  countGraphemes,
  formatSalary,
  formatSocialPost,
} from '../render/format-job.mjs';
import { createBridgeHtml } from '../render/html-page.mjs';
import { createSocialCardSvg, renderSocialCardPng } from '../render/social-card.mjs';
import * as socialCardModule from '../render/social-card.mjs';
import { createCjkFontStyle, SOCIAL_CARD_FONT_STACK } from '../render/cjk-fonts.mjs';
import { createBridgePublisher } from '../publishing/bridge-publisher.mjs';
import {
  processIntakeSnapshots,
  processOnePublication,
} from '../publishing/orchestrator.mjs';
import { decideScheduledWork } from '../publishing/scheduled-work.mjs';
import {
  enqueueBridgeWork,
  enqueueJob,
  markJobClosed,
  resetFailedStage,
  selectNextQueueItem,
  transitionQueueStage,
} from '../state/queue-operations.mjs';
import { loadStateFile } from '../state/load-state.mjs';
import { saveStateFile } from '../state/save-state.mjs';
import {
  assertNoSensitiveKeys,
  validateIntakeState,
  validatePublicationsState,
  validateQueueState,
} from '../state/state-model.mjs';

const validations = [];

function validation(name, run) {
  validations.push({ name, run });
}

validation('exports the approved immutable constants', () => {
  assert.equal(STATE_SCHEMA_VERSION, 2);
  assert.equal(OPENINGS_ORIGIN, 'https://openings.dev');
  assert.equal(MAX_CHANNEL_ATTEMPTS, 3);
  assert.equal(STARVATION_THRESHOLD_MS, 24 * 60 * 60 * 1000);
  assert.deepEqual([IMAGE_WIDTH, IMAGE_HEIGHT], [1200, 630]);
});

validation('installs Noto CJK before every Ubuntu social-card render', async () => {
  const [validationWorkflow, publicationWorkflow, packageSource] = await Promise.all([
    readFile(fileURLToPath(new URL('../../../.github/workflows/validate.yml', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../../../.github/workflows/publish-social.yml', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
  ]);
  for (const workflow of [validationWorkflow, publicationWorkflow]) {
    assert.match(workflow, /apt-get install --yes fonts-noto-cjk/u);
    assert.ok(workflow.indexOf('fonts-noto-cjk') < workflow.indexOf('npm run'));
  }
  assert.doesNotMatch(packageSource, /@fontsource\/noto-sans-(?:jp|kr|sc)/u);
});

validation('escapes untrusted HTML and attribute values', () => {
  assert.equal(escapeHtml('<script>"jobs" & roles</script>'), '&lt;script&gt;&quot;jobs&quot; &amp; roles&lt;/script&gt;');
  assert.equal(escapeAttribute("' onload='publish()"), '&#39; onload=&#39;publish()');
});

validation('creates deterministic SHA-256 hashes', () => {
  assert.equal(sha256('openings'), 'add875e192edf555f22898d640b2e2acd69cd7b84008318423a8d13ee1202464');
});

validation('resolves safe Git refs and lists every immutable snapshot boundary', async () => {
  const previous = '1'.repeat(40);
  const manifestCommit = '2'.repeat(40);
  const current = '3'.repeat(40);
  const calls = [];
  const execFileImpl = async (_command, argumentsList) => {
    calls.push(argumentsList);
    if (argumentsList.includes('rev-parse')) return { stdout: `${current}\n` };
    if (argumentsList.includes('merge-base')) return { stdout: '' };
    if (argumentsList.includes('rev-list')) return { stdout: `${manifestCommit}\n` };
    throw new Error('Unexpected fake Git call');
  };
  assert.equal(await resolveGitCommit('/data', 'main', { execFileImpl }), current);
  assert.deepEqual(
    await listSnapshotCommits('/data', previous, current, { execFileImpl }),
    [previous, manifestCommit, current],
  );
  assert.equal(calls.some((call) => call.includes('--reverse')), true);
  await assert.rejects(resolveGitCommit('/data', '--upload-pack=evil', { execFileImpl }), /reference/i);
  await assert.rejects(listSnapshotCommits('/data', previous, current, {
    execFileImpl: async (_command, argumentsList) => {
      if (argumentsList.includes('merge-base')) throw new Error('not ancestor');
      return { stdout: '' };
    },
  }), /ancestor/i);
});

validation('accepts only canonical job identifiers', () => {
  const id = 'gh_0123456789abcdef01234567';
  assert.equal(isValidJobId(id), true);
  assert.equal(isValidJobId('gh_0123'), false);
  assert.equal(isValidJobId('../jobs'), false);
  assert.equal(assertValidJobId(id), id);
  assert.throws(() => assertValidJobId('gh_Z123456789abcdef01234567'), /Invalid job ID/);
  assert.equal(buildCanonicalJobUrl(id), `${OPENINGS_ORIGIN}/jobs/${id}`);
});

validation('keeps dry runs operational without secrets', () => {
  const config = readEnvironment({ env: {}, mode: 'dry-run' });
  assert.equal(config.publishEnabled, false);
  assert.equal(config.publicSiteOrigin, OPENINGS_ORIGIN);
});

validation('requires exact manual publication and reset gates', () => {
  const jobId = 'gh_0123456789abcdef01234567';
  assert.deepEqual(parsePublicationRequest({
    mode: 'controlled',
    jobId,
    confirmation: 'PUBLISH_ONE_JOB',
  }), { mode: 'controlled', jobId, stage: null });
  assert.throws(() => parsePublicationRequest({
    mode: 'controlled',
    jobId,
    confirmation: 'publish one job',
  }), /exact confirmation/i);
  assert.deepEqual(parsePublicationRequest({
    mode: 'retry-stage',
    jobId,
    stage: 'mastodon',
    confirmation: 'RESET_FAILED_STAGE',
  }), { mode: 'retry-stage', jobId, stage: 'mastodon' });
  assert.throws(() => parsePublicationRequest({
    mode: 'retry-stage',
    jobId,
    stage: 'all',
    confirmation: 'RESET_FAILED_STAGE',
  }), /retry stage/i);
});

validation('accepts bounded JSON responses and rejects unsafe response types', async () => {
  const response = await fetchJson('https://example.test/data.json', {
    fetchImpl: async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  });
  assert.deepEqual(response, { ok: true });
  await assert.rejects(
    fetchJson('https://example.test/page', {
      fetchImpl: async () => new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    }),
    /JSON content type/,
  );
});

validation('enables scheduled publication only for exact true with every credential', () => {
  const env = {
    SOCIAL_AUTO_PUBLISH: 'true',
    WEB_DEPLOY_TOKEN: 'github-fine-grained-token',
    BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
    BLUESKY_APP_PASSWORD: 'app-secret',
    MASTODON_ACCESS_TOKEN: 'mastodon-secret',
  };
  assert.equal(readEnvironment({ env, mode: 'scheduled' }).publishEnabled, true);
  assert.equal(readEnvironment({ env: { ...env, SOCIAL_AUTO_PUBLISH: 'TRUE' }, mode: 'scheduled' }).publishEnabled, false);
  assert.throws(
    () => readEnvironment({ env: { ...env, WEB_DEPLOY_TOKEN: '' }, mode: 'controlled' }),
    (error) => error.message.includes('WEB_DEPLOY_TOKEN') && !error.message.includes('github-fine-grained-token'),
  );
});

validation('enables Meta channels independently and requires only their own credentials', () => {
  const base = {
    SOCIAL_AUTO_PUBLISH: 'true',
    WEB_DEPLOY_TOKEN: 'github-fine-grained-token',
    BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
    BLUESKY_APP_PASSWORD: 'app-secret',
    MASTODON_ACCESS_TOKEN: 'mastodon-secret',
  };
  const disabled = readEnvironment({ env: base, mode: 'scheduled' });
  assert.deepEqual(disabled.enabledChannels, ['bluesky', 'mastodon']);

  const threads = readEnvironment({
    env: { ...base, THREADS_AUTO_PUBLISH: 'true', THREADS_ACCESS_TOKEN: 'threads-secret' },
    mode: 'scheduled',
  });
  assert.deepEqual(threads.enabledChannels, ['bluesky', 'mastodon', 'threads']);
  assert.throws(
    () => readEnvironment({ env: { ...base, THREADS_AUTO_PUBLISH: 'true' }, mode: 'scheduled' }),
    /THREADS_ACCESS_TOKEN/u,
  );

  const instagram = readEnvironment({
    env: {
      ...base,
      INSTAGRAM_AUTO_PUBLISH: 'true',
      INSTAGRAM_ACCESS_TOKEN: 'instagram-secret',
      INSTAGRAM_USER_ID: '17841400000000000',
      META_GRAPH_VERSION: 'v23.0',
    },
    mode: 'scheduled',
  });
  assert.deepEqual(instagram.enabledChannels, ['bluesky', 'mastodon', 'instagram']);
  assert.equal(instagram.instagram.userId, '17841400000000000');
  assert.equal(instagram.instagram.apiVersion, 'v23.0');
});

validation('enables Meta only for jobs enqueued after activation', () => {
  const snapshot = makeLoadedSnapshot({
    commit: '8'.repeat(40),
    generatedAt: '2026-08-25T19:00:00.000Z',
    dataHash: '8'.repeat(64),
    jobs: [],
  });
  const historical = makeJob({ id: 'gh_888888888888888888888881' });
  const future = makeJob({ id: 'gh_888888888888888888888882' });
  const initial = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job: historical,
    snapshot,
    discoveredAt: '2026-08-25T18:59:00.000Z',
  });
  const activated = enqueueJob(initial, {
    job: future,
    snapshot,
    discoveredAt: '2026-08-25T19:01:00.000Z',
    enabledChannels: ['bluesky', 'mastodon', 'threads', 'instagram'],
  });

  assert.equal(activated.items[0].threads.status, 'skipped_disabled');
  assert.equal(activated.items[0].instagram.status, 'skipped_disabled');
  assert.equal(activated.items[1].threads.status, 'pending');
  assert.equal(activated.items[1].instagram.status, 'pending');
});

validation('skips disabled and up-to-date schedules before expensive setup', () => {
  const dataHash = 'a'.repeat(64);
  const intakeState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    processedSnapshot: {
      commit: '1'.repeat(40),
      generatedAt: '2026-08-23T12:00:00.000Z',
      dataHash,
    },
    pendingBridges: [],
    removedJobs: [],
  };
  const queueState = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };

  assert.deepEqual(decideScheduledWork({
    publishEnabled: false,
    intakeState,
    queueState,
    currentDataHash: 'b'.repeat(64),
  }), { shouldRun: false, reason: 'disabled', queueDepth: 0 });
  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    intakeState,
    queueState,
    currentDataHash: dataHash,
  }), { shouldRun: false, reason: 'up_to_date', queueDepth: 0 });
  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    intakeState,
    queueState,
    currentDataHash: 'b'.repeat(64),
  }), { shouldRun: true, reason: 'snapshot_changed', queueDepth: 0 });
});

validation('runs schedules while social or bridge work is ready', () => {
  const dataHash = 'a'.repeat(64);
  const intakeState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    processedSnapshot: {
      commit: '1'.repeat(40),
      generatedAt: '2026-08-23T12:00:00.000Z',
      dataHash,
    },
    pendingBridges: [],
    removedJobs: [],
  };
  const job = makeJob();
  const snapshot = makeLoadedSnapshot({
    commit: '1'.repeat(40),
    generatedAt: '2026-08-23T12:00:00.000Z',
    dataHash,
    jobs: [job],
  });
  const queueState = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-23T12:01:00.000Z',
  });

  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    intakeState,
    queueState,
    currentDataHash: dataHash,
  }), { shouldRun: true, reason: 'queued', queueDepth: 1 });

  const bridgeState = enqueueBridgeWork(intakeState, { job, snapshot, reason: 'changed' });
  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    intakeState: bridgeState,
    queueState: { schemaVersion: STATE_SCHEMA_VERSION, items: [] },
    currentDataHash: dataHash,
  }), { shouldRun: true, reason: 'bridge_queued', queueDepth: 0 });
});

validation('preflight avoids remote reads for queued work and fails open on manifest errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-social-preflight-'));
  const job = makeJob();
  const snapshot = makeLoadedSnapshot({
    commit: '1'.repeat(40),
    generatedAt: '2026-08-23T12:00:00.000Z',
    dataHash: 'a'.repeat(64),
    jobs: [job],
  });
  const intakeState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    processedSnapshot: {
      commit: snapshot.commit,
      generatedAt: snapshot.generatedAt,
      dataHash: snapshot.dataHash,
    },
    pendingBridges: [],
    removedJobs: [],
  };
  const queueState = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-23T12:01:00.000Z',
  });
  try {
    await saveStateFile(join(directory, 'intake.json'), intakeState, validateIntakeState);
    await saveStateFile(join(directory, 'queue.json'), queueState, validateQueueState);
    let fetchCalls = 0;
    const queued = await runPreflight({
      eventName: 'schedule',
      publishEnabled: true,
      stateDirectory: directory,
      fetchManifest: async () => { fetchCalls += 1; return { dataHash: snapshot.dataHash }; },
      log: () => {},
    });
    assert.deepEqual(queued, { shouldRun: true, reason: 'queued', queueDepth: 1 });
    assert.equal(fetchCalls, 0);

    await saveStateFile(join(directory, 'queue.json'), { schemaVersion: STATE_SCHEMA_VERSION, items: [] }, validateQueueState);
    const unavailable = await runPreflight({
      eventName: 'schedule',
      publishEnabled: true,
      stateDirectory: directory,
      fetchManifest: async () => { throw new Error('temporary network error'); },
      log: () => {},
    });
    assert.deepEqual(unavailable, { shouldRun: true, reason: 'preflight_unavailable', queueDepth: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('validates the tracked state schemas', async () => {
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const intake = await loadStateFile(join(repositoryRoot, 'state/intake.json'), validateIntakeState);
  const queue = await loadStateFile(join(repositoryRoot, 'state/queue.json'), validateQueueState);
  const publications = await loadStateFile(join(repositoryRoot, 'state/publications.json'), validatePublicationsState);
  assert.equal(intake.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(queue.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(Array.isArray(queue.items), true);
  assert.equal(publications.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(typeof publications.jobs, 'object');
});

validation('rejects unknown state versions, duplicates, and sensitive keys', () => {
  assert.throws(() => validateIntakeState({ schemaVersion: 99, processedSnapshot: null, pendingBridges: [], removedJobs: [] }), /schemaVersion/);
  assert.throws(
    () => validateQueueState({ schemaVersion: STATE_SCHEMA_VERSION, items: [{ jobId: 'gh_0123456789abcdef01234567' }, { jobId: 'gh_0123456789abcdef01234567' }] }),
    /duplicate/i,
  );
  assert.throws(() => assertNoSensitiveKeys({ nested: { accessToken: 'never-track-this' } }), /sensitive/i);
});

validation('writes state atomically with stable formatting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-social-publisher-state-'));
  const file = join(directory, 'queue.json');
  const value = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };
  try {
    await saveStateFile(file, value, validateQueueState);
    assert.equal(await readFile(file, 'utf8'), `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function makeJob(overrides = {}) {
  return {
    id: 'gh_0123456789abcdef01234567',
    sourceId: 'openings-fixtures/jobs#42',
    title: 'Senior TypeScript Engineer',
    description: 'Build reliable developer tools.',
    issueState: 'open',
    contentHash: '55b48a8e62f73da8021d3f8bdc70ec9cfb9ee89d5b5243d4b2b5b6b24f9fca95',
    repository: 'openings-fixtures/jobs',
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    url: 'https://github.com/openings-fixtures/jobs/issues/42',
    sourceType: 'github-issue',
    ...overrides,
  };
}

function makeSnapshotFiles(jobs, overrides = {}) {
  const generatedAt = overrides.generatedAt ?? '2026-08-20T13:00:00.000Z';
  const manifest = {
    generatedAt,
    schemaVersion: 4,
    pageSize: 20,
    dataHash: 'a'.repeat(64),
    totals: {
      openOpportunities: jobs.length,
      pages: 1,
    },
    files: { jobIds: 'api/job-ids.json' },
    facets: {},
    pages: [{ page: 1, file: 'api/pages/page-0001.json', count: jobs.length }],
    ...overrides.manifest,
  };
  return {
    'snapshots/opportunities/api/manifest.json': manifest,
    'snapshots/opportunities/api/job-ids.json': { generatedAt, ids: jobs.map((job) => job.id) },
    'snapshots/opportunities/api/pages/page-0001.json': {
      generatedAt,
      page: 1,
      pageSize: 20,
      nextPage: null,
      ids: jobs.map((job) => job.id),
      items: jobs,
    },
  };
}

validation('reads JSON from a fixed Git commit without shell interpolation', async () => {
  const calls = [];
  const result = await readJsonAtCommit('/safe/repository', 'a'.repeat(40), 'snapshots/data.json', {
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      return { stdout: '{"ok":true}' };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{
    command: 'git',
    args: ['-C', '/safe/repository', 'show', `${'a'.repeat(40)}:snapshots/data.json`],
  }]);
  await assert.rejects(readJsonAtCommit('/safe/repository', 'a'.repeat(40), '../secrets.json'), /repository-relative/);
});

validation('loads one complete immutable data snapshot', async () => {
  const jobs = [makeJob()];
  const files = makeSnapshotFiles(jobs);
  const snapshot = await loadSnapshot('/data', 'b'.repeat(40), {
    readJson: async (_repository, _commit, path) => structuredClone(files[path]),
  });
  assert.equal(snapshot.commit, 'b'.repeat(40));
  assert.equal(snapshot.generatedAt, '2026-08-20T13:00:00.000Z');
  assert.deepEqual([...snapshot.jobsById.keys()], [jobs[0].id]);
});

validation('loads incrementally written artifacts from one immutable commit', async () => {
  const files = makeSnapshotFiles([makeJob()]);
  files['snapshots/opportunities/api/pages/page-0001.json'].generatedAt = '2026-08-20T13:05:00.000Z';
  const snapshot = await loadSnapshot('/data', 'c'.repeat(40), {
    readJson: async (_repository, _commit, path) => structuredClone(files[path]),
  });

  assert.equal(snapshot.jobsById.size, 1);
});

validation('rejects duplicate and inconsistent snapshot artifacts', async () => {
  const duplicate = makeJob();
  const files = makeSnapshotFiles([duplicate, duplicate]);
  await assert.rejects(
    loadSnapshot('/data', 'c'.repeat(40), { readJson: async (_repository, _commit, path) => structuredClone(files[path]) }),
    /duplicate/i,
  );

  const badCount = makeSnapshotFiles([makeJob()]);
  badCount['snapshots/opportunities/api/manifest.json'].pages[0].count = 2;
  await assert.rejects(
    loadSnapshot('/data', 'e'.repeat(40), { readJson: async (_repository, _commit, path) => structuredClone(badCount[path]) }),
    /count/i,
  );
});

validation('classifies new, changed, removed, and bridge-only work', () => {
  const unchanged = makeJob();
  const changedBefore = makeJob({
    id: 'gh_111111111111111111111111',
    contentHash: '1'.repeat(64),
  });
  const removed = makeJob({
    id: 'gh_222222222222222222222222',
    contentHash: '2'.repeat(64),
  });
  const changedAfter = { ...changedBefore, contentHash: '3'.repeat(64) };
  const added = makeJob({
    id: 'gh_333333333333333333333333',
    contentHash: '4'.repeat(64),
  });
  const previous = { jobsById: new Map([[unchanged.id, unchanged], [changedBefore.id, changedBefore], [removed.id, removed]]) };
  const current = { jobsById: new Map([[unchanged.id, unchanged], [changedAfter.id, changedAfter], [added.id, added]]) };
  const delta = collectDelta(previous, current);
  assert.deepEqual(delta.new.map((job) => job.id), [added.id]);
  assert.deepEqual(delta.changed.map((job) => job.id), [changedAfter.id]);
  assert.deepEqual(delta.removed.map((job) => job.id), [removed.id]);
  assert.deepEqual(collectBridgeJobs(delta).map((job) => job.id), [added.id, changedAfter.id]);
});

validation('enqueues only genuinely new open GitHub issues', () => {
  const previousGeneratedAt = '2026-08-20T10:00:00.000Z';
  const eligible = makeJob({ createdAt: '2026-08-20T10:00:01.000Z' });
  assert.equal(isEligibleNewJob(eligible, previousGeneratedAt, { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} }), true);
  assert.equal(isEligibleNewJob({ ...eligible, createdAt: previousGeneratedAt }, previousGeneratedAt, { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} }), false);
  assert.equal(isEligibleNewJob({ ...eligible, issueState: 'closed' }, previousGeneratedAt, { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} }), false);
  assert.equal(isEligibleNewJob({ ...eligible, sourceType: 'github-discussion' }, previousGeneratedAt, { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} }), false);
  assert.equal(isEligibleNewJob(eligible, previousGeneratedAt, {
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: { [eligible.id]: { completedAt: '2026-08-20T11:00:00.000Z' } },
  }), false);
});

function snapshotReference(overrides = {}) {
  return {
    commit: 'f'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: 'a'.repeat(64),
    ...overrides,
  };
}

validation('enqueues jobs and bridge refreshes idempotently', () => {
  const job = makeJob();
  const snapshot = snapshotReference();
  const initialQueue = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };
  const first = enqueueJob(initialQueue, { job, snapshot, discoveredAt: '2026-08-20T13:01:00.000Z' });
  const second = enqueueJob(first, { job, snapshot, discoveredAt: '2026-08-20T13:05:00.000Z' });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].discoveredAt, '2026-08-20T13:01:00.000Z');
  assert.equal(second.items[0].bluesky.status, 'pending');
  assert.equal(second.items[0].mastodon.status, 'pending');
  assert.equal(second.items[0].threads.status, 'skipped_disabled');
  assert.equal(second.items[0].instagram.status, 'skipped_disabled');

  const withMeta = enqueueJob(initialQueue, {
    job,
    snapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
    enabledChannels: ['bluesky', 'mastodon', 'threads', 'instagram'],
  });
  assert.equal(withMeta.items[0].threads.status, 'pending');
  assert.equal(withMeta.items[0].instagram.status, 'pending');

  const intake = { schemaVersion: STATE_SCHEMA_VERSION, processedSnapshot: null, pendingBridges: [], removedJobs: [] };
  const withBridge = enqueueBridgeWork(intake, { job, snapshot, reason: 'new' });
  const refreshed = enqueueBridgeWork(withBridge, {
    job: { ...job, contentHash: 'b'.repeat(64) },
    snapshot: { ...snapshot, dataHash: 'c'.repeat(64) },
    reason: 'changed',
  });
  assert.equal(refreshed.pendingBridges.length, 1);
  assert.equal(refreshed.pendingBridges[0].reason, 'changed');
  assert.equal(refreshed.pendingBridges[0].contentHash, 'b'.repeat(64));
});

validation('keeps network transitions independent and caps attempts', () => {
  const job = makeJob();
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot: snapshotReference(),
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  queue = transitionQueueStage(queue, job.id, 'bluesky', 'publishing', { at: '2026-08-20T13:02:00.000Z' });
  queue = transitionQueueStage(queue, job.id, 'bluesky', 'published', {
    at: '2026-08-20T13:02:10.000Z',
    result: { uri: 'at://did:plc:fixture/app.bsky.feed.post/opening-fixture' },
  });
  assert.equal(queue.items[0].bluesky.status, 'published');
  assert.equal(queue.items[0].mastodon.status, 'pending');
  assert.throws(() => transitionQueueStage(queue, job.id, 'bluesky', 'pending'), /transition/i);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    queue = transitionQueueStage(queue, job.id, 'mastodon', 'publishing', { at: `2026-08-20T13:0${attempt + 3}:00.000Z` });
    queue = transitionQueueStage(queue, job.id, 'mastodon', 'retryable', {
      at: `2026-08-20T13:0${attempt + 3}:10.000Z`,
      errorCode: 'provider_timeout',
    });
  }
  assert.equal(queue.items[0].mastodon.status, 'failed');
  assert.equal(queue.items[0].mastodon.attempts, 3);
  assert.deepEqual(Object.keys(queue.items[0].mastodon.lastError).sort(), ['at', 'code']);
  queue = resetFailedStage(queue, job.id, 'mastodon', {
    at: '2026-08-20T14:00:00.000Z',
    reason: 'credential_rotated',
  });
  assert.equal(queue.items[0].mastodon.status, 'pending');
  assert.equal(queue.items[0].mastodon.attempts, 0);
});

validation('selects newest work unless an older item is starving', () => {
  const oldJob = makeJob({ id: 'gh_111111111111111111111111', createdAt: '2026-08-18T10:00:00.000Z' });
  const newJob = makeJob({ id: 'gh_222222222222222222222222', createdAt: '2026-08-20T12:00:00.000Z' });
  let queue = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };
  queue = enqueueJob(queue, { job: oldJob, snapshot: snapshotReference(), discoveredAt: '2026-08-20T10:00:00.000Z' });
  queue = enqueueJob(queue, { job: newJob, snapshot: snapshotReference(), discoveredAt: '2026-08-20T12:30:00.000Z' });
  assert.equal(selectNextQueueItem(queue, '2026-08-20T14:00:00.000Z').jobId, newJob.id);
  assert.equal(selectNextQueueItem(queue, '2026-08-21T11:00:00.000Z').jobId, oldJob.id);
  const restarted = structuredClone(queue);
  assert.equal(selectNextQueueItem(restarted, '2026-08-21T11:00:00.000Z').jobId, oldJob.id);
});

validation('prioritizes cross-channel work over a starving legacy-channel item', () => {
  const legacyJob = makeJob({ id: 'gh_333333333333333333333333', createdAt: '2026-08-18T10:00:00.000Z' });
  const crossChannelJob = makeJob({ id: 'gh_444444444444444444444444', createdAt: '2026-08-20T12:00:00.000Z' });
  let queue = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };
  queue = enqueueJob(queue, {
    job: legacyJob,
    snapshot: snapshotReference(),
    discoveredAt: '2026-08-20T10:00:00.000Z',
  });
  queue = enqueueJob(queue, {
    job: crossChannelJob,
    snapshot: snapshotReference(),
    discoveredAt: '2026-08-20T12:30:00.000Z',
    enabledChannels: ['bluesky', 'mastodon', 'threads', 'instagram'],
  });

  assert.equal(
    selectNextQueueItem(queue, '2026-08-21T11:00:00.000Z').jobId,
    crossChannelJob.id,
  );
});

validation('marks a closed queued job without publishing either channel', () => {
  const job = makeJob();
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot: snapshotReference(),
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  queue = markJobClosed(queue, job.id, '2026-08-20T13:30:00.000Z');
  assert.equal(queue.items[0].bridge.status, 'skipped_closed');
  assert.equal(queue.items[0].bluesky.status, 'skipped_closed');
  assert.equal(queue.items[0].mastodon.status, 'skipped_closed');
  assert.equal(queue.items[0].threads.status, 'skipped_disabled');
  assert.equal(queue.items[0].instagram.status, 'skipped_disabled');
  assert.equal(selectNextQueueItem(queue, '2026-08-20T14:00:00.000Z'), null);
});

validation('formats salary bounds without turning a maximum into an exact salary', () => {
  assert.equal(formatSalary({ currency: 'USD', min: 9000, period: 'month' }), 'From $9,000/month');
  assert.equal(formatSalary({ currency: 'USD', max: 12000, period: 'month' }), 'Up to $12,000/month');
  assert.equal(formatSalary({ currency: 'USD', min: 9000, max: 12000, period: 'month' }), '$9,000–$12,000/month');
  assert.equal(formatSalary({ currency: 'USD', min: 12000, max: 9000, period: 'month' }), null);
  assert.equal(formatSalary(null), null);
});

validation('writes concise English framing while preserving the original title', () => {
  const post = formatSocialPost(makeJob({
    title: 'Desenvolvedor(a) TypeScript Sênior',
    community: { name: 'Openings Fixtures' },
    country: 'Brazil',
    region: 'South America',
    tags: ['remote', 'senior', 'typescript'],
    salary: { currency: 'BRL', min: 12000, max: 18000, period: 'month' },
  }));
  assert.equal(post.title, 'Desenvolvedor(a) TypeScript Sênior');
  assert.match(post.text, /^New job on openings\.dev\n\nDesenvolvedor\(a\) TypeScript Sênior/);
  assert.match(post.text, /Openings Fixtures · Brazil · South America/);
  assert.match(post.text, /R\$12,000–R\$18,000\/month/);
  assert.match(post.text, /View the listing:\nhttps:\/\/openings\.dev\/jobs\/gh_0123456789abcdef01234567/);
  assert.match(post.text, /#TechJobs #TypeScript$/);
});

validation('omits unknown metadata and unsafe stack hashtags', () => {
  const post = formatSocialPost(makeJob({
    community: null,
    country: 'Unknown',
    region: '',
    tags: ['remote', 'senior', 'c++'],
    salary: null,
  }));
  assert.equal(post.metadataLine, null);
  assert.equal(post.salaryLine, null);
  assert.equal(post.hashtags, '#TechJobs');
  assert.doesNotMatch(post.text, /Unknown|undefined|null|#C/);
});

validation('formats an Instagram caption for discovery and conversation', async () => {
  const { formatInstagramCaption } = await import('../render/instagram-caption.mjs');
  const remoteJob = makeJob({
    title: 'Senior TypeScript Engineer',
    community: { name: 'Openings Fixtures' },
    country: 'Remote',
    region: 'Worldwide',
    tags: ['typescript', 'remote', 'senior'],
  });
  const remotePost = formatSocialPost(remoteJob);
  const remoteCaption = formatInstagramCaption(remoteJob, remotePost);

  assert.match(remoteCaption, /Senior TypeScript Engineer/u);
  assert.match(remoteCaption, new RegExp(remotePost.canonicalUrl));
  assert.match(remoteCaption, /Know someone who fits\? Tag them below\./u);
  assert.match(remoteCaption, /Follow @openingshq for more jobs from public communities\./u);
  assert.match(remoteCaption, /#TechJobs #TypeScript #Hiring #RemoteJobs$/u);
  assert.equal((remoteCaption.match(/https:\/\/openings\.dev\/jobs\//gu) ?? []).length, 1);

  const onsiteJob = makeJob({
    title: 'Frontend Engineer in Tokyo',
    country: 'Japan',
    region: 'Tokyo',
    tags: ['typescript', 'frontend'],
  });
  const onsiteCaption = formatInstagramCaption(onsiteJob, formatSocialPost(onsiteJob));
  const hashtags = onsiteCaption.match(/#[\p{L}\p{N}]+/gu) ?? [];
  assert.doesNotMatch(onsiteCaption, /#RemoteJobs/u);
  assert.equal(new Set(hashtags).size, hashtags.length);
  assert.ok(hashtags.length <= 4);

  const onsiteCjkJob = makeJob({
    title: '[广州 / 线下] Bitcoin 开发工程师',
    country: 'Global',
    region: 'Worldwide',
    tags: ['engineering'],
  });
  const onsiteCjkCaption = formatInstagramCaption(onsiteCjkJob, formatSocialPost(onsiteCjkJob));
  assert.doesNotMatch(onsiteCjkCaption, /#RemoteJobs/u);
});

validation('keeps long Unicode posts within the Bluesky grapheme limit', () => {
  const title = `${'高性能ソフトウェアエンジニア🚀'.repeat(24)} final`;
  const post = formatSocialPost(makeJob({
    title,
    community: { name: 'A very long international community name that may be omitted' },
    country: 'Worldwide',
    region: 'Global',
    tags: ['typescript'],
  }));
  assert.ok(countGraphemes(post.text) <= 300);
  assert.ok(post.title.endsWith('…'));
  assert.equal((post.text.match(/https:\/\/openings\.dev\/jobs\//g) ?? []).length, 1);
  assert.match(post.text, /View the listing:/);
  assert.match(post.text, /#TechJobs #TypeScript$/);
});

validation('renders a complete escaped canonical job bridge', () => {
  const job = makeJob({
    title: '<script>publish()</script> Senior Engineer',
    excerpt: 'Build tools & keep users safe. <img src=x onerror=publish()>',
    community: { name: 'Openings & Friends' },
  });
  const html = createBridgeHtml(job);
  const canonicalUrl = `https://openings.dev/jobs/${job.id}`;
  assert.match(html, /<!doctype html>/i);
  assert.match(html, new RegExp(`<link rel="canonical" href="${canonicalUrl}"`));
  assert.match(html, new RegExp(`<meta property="og:url" content="${canonicalUrl}"`));
  assert.match(html, new RegExp(`<meta property="og:image" content="${canonicalUrl}/opengraph-image.png"`));
  assert.match(html, /<meta property="og:image:width" content="1200">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, new RegExp(`<meta name="openings:data-hash" content="${job.contentHash}"`));
  assert.match(html, /<meta name="openings:instagram-card-version" content="2">/u);
  assert.match(html, /&lt;script&gt;publish\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img src=x|onerror=/);
  assert.match(html, new RegExp(`location\\.replace\\("https://openings\\.dev/\\?job=${job.id}"\\)`));
});

validation('renders the production social-card system to a bounded PNG', async () => {
  const job = makeJob({
    title: 'Senior TypeScript Engineer building reliable community tools',
    excerpt: 'Build reliable developer tools with a distributed open source team.',
    community: { name: 'Openings Fixtures' },
    country: 'Remote',
    region: 'Worldwide',
    tags: ['typescript', 'remote', 'senior'],
    salary: { currency: 'USD', min: 9000, max: 12000, period: 'month' },
  });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302e"/></svg>';
  const svg = createSocialCardSvg(job, { wordmarkSvg });
  assert.match(svg, /width="1200" height="630"/);
  for (const color of ['#f5f3ef', '#fffefa', '#21302e', '#5e6663', '#d8d8d1', '#eeefeb', '#b0ec9c', '#315d35']) {
    assert.match(svg, new RegExp(color));
  }
  assert.match(svg, /data:image\/svg\+xml;base64,/);
  assert.match(svg, /Senior TypeScript Engineer/);
  assert.match(svg, /View job/);

  const png = await renderSocialCardPng(job, { wordmarkSvg });
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 630);
  assert.ok(png.byteLength < 2 * 1024 * 1024);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dispatch = buildRepositoryDispatchRequest({
    jobId: job.id,
    contentHash: job.contentHash,
    html: Buffer.from(createBridgeHtml(job)),
    image: png,
    instagramSvg: Buffer.from(socialCardModule.createInstagramCardSvg(job, { wordmarkSvg })),
    repository: 'openings-dev/web-deploy',
  });
  assert.ok(dispatch.body.length < 60_000);
});

validation('keeps a long salary period intact in the social-card sidebar', () => {
  const job = makeJob({
    salary: { currency: 'BRL', min: 7000, max: 12000, period: 'month' },
  });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const svg = createSocialCardSvg(job, { wordmarkSvg });

  assert.match(svg, />R\$7,000–R\$12,000<\/text>/u);
  assert.match(svg, />\/month<\/text>/u);
  assert.doesNotMatch(svg, />mon<\/text>.*>th<\/text>/su);
});

validation('bounds long Unicode card titles to three lines', () => {
  const job = makeJob({ title: '高性能ソフトウェアエンジニア🚀'.repeat(20) });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const svg = createSocialCardSvg(job, { wordmarkSvg });
  const titleLines = svg.match(/data-title-line="true"/g) ?? [];
  assert.ok(titleLines.length >= 1 && titleLines.length <= 3);
  assert.match(svg, /…/);
});

validation('renders multilingual CJK social cards with the system font contract', async () => {
  const job = makeJob({
    title: '全球远程 ソフトウェアエンジニア 소프트웨어 엔지니어',
    community: { name: '国際開発コミュニティ' },
  });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const svg = createSocialCardSvg(job, { wordmarkSvg });

  assert.doesNotMatch(svg, /data:font\/woff2;base64,/u);
  assert.match(svg, /Noto Sans CJK SC/u);
  assert.match(svg, /Noto Sans CJK JP/u);
  assert.match(svg, /Noto Sans CJK KR/u);

  const png = await renderSocialCardPng(job, { wordmarkSvg });
  const metadata = await sharp(png).metadata();
  assert.deepEqual([metadata.width, metadata.height], [1200, 630]);
});

validation('uses installed Noto CJK fonts instead of ignored embedded web fonts', () => {
  assert.equal(createCjkFontStyle('全球远程 ソフトウェア 엔지니어'), '');
  assert.equal(
    SOCIAL_CARD_FONT_STACK,
    'Noto Sans CJK SC, Noto Sans CJK JP, Noto Sans CJK KR, Arial, sans-serif',
  );
});

validation('defines a dedicated portrait-safe Instagram card', () => {
  assert.equal(typeof socialCardModule.createInstagramCardSvg, 'function');
  const job = makeJob({
    title: '[广州 / 线下] 招聘Bitcoin创新开发工程师 | 国内BTC底层开发团队',
    community: { name: 'rebase-network' },
    country: 'Global',
  });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const svg = socialCardModule.createInstagramCardSvg(job, { wordmarkSvg });

  assert.match(svg, /width="1080" height="1350" viewBox="0 0 1080 1350"/u);
  assert.match(svg, /data-instagram-card="true"/u);
  assert.match(svg, /data-safe-area="true"[^>]*x="56"[^>]*width="968"/u);
  assert.match(svg, /data-instagram-title-line="true"/u);
  assert.match(svg, /工程师—国内/u);
  assert.doesNotMatch(svg, />\|<\/text>/u);
  assert.match(svg, /data-instagram-wordmark="true"[^>]*width="320"/u);
  assert.match(svg, />@openingshq<\/text>/u);
  assert.match(svg, /data-instagram-facts="true"[^>]*y="830"/u);
  assert.match(svg, /font-size="25"[^>]*data-instagram-fact-value="true"/u);
  assert.match(svg, />COMMUNITY<\/text>/u);
  assert.match(svg, />rebase-network<\/text>/u);
  assert.match(svg, /data-instagram-cta="true"[^>]*y="1146"[^>]*height="108"/u);
  assert.match(svg, /View this opening on openings\.dev/u);
  assert.doesNotMatch(svg, /data:font\/woff2;base64,/u);

  const shortSvg = socialCardModule.createInstagramCardSvg(
    makeJob({ title: 'Senior Product Engineer', tags: ['typescript'] }),
    { wordmarkSvg },
  );
  assert.match(shortSvg, /font-size="88"[^>]*data-instagram-title-line="true"/u);
  assert.match(shortSvg, /font-size="27"[^>]*>Shared through/u);
  assert.match(shortSvg, /data-instagram-tag="true"[^>]*height="48"/u);
});

validation('renders a bounded 1080 by 1350 Instagram JPEG preview', async () => {
  assert.equal(typeof socialCardModule.renderInstagramCardJpeg, 'function');
  const job = makeJob({ title: 'Senior ソフトウェア Engineer' });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const jpeg = await socialCardModule.renderInstagramCardJpeg(job, { wordmarkSvg });
  const metadata = await sharp(jpeg).metadata();

  assert.deepEqual([metadata.format, metadata.width, metadata.height], ['jpeg', 1080, 1350]);
  assert.ok(jpeg.byteLength < 2 * 1024 * 1024);
});

validation('dry run emits the canonical bridge and both platform image previews', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-social-publisher-dry-run-'));
  const fixturePath = join(directory, 'job.json');
  const wordmarkPath = join(directory, 'wordmark.svg');
  const outputPath = join(directory, 'output');
  const beforeState = await readFile(fileURLToPath(new URL('../../../state/queue.json', import.meta.url)), 'utf8');
  try {
    await writeFile(fixturePath, `${JSON.stringify(makeJob({ community: { name: 'Openings Fixtures' } }), null, 2)}\n`);
    await writeFile(wordmarkPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302e"/></svg>');
    const result = await runDryRun({ fixturePath, wordmarkPath, outputPath, log: () => {} });
    const files = (await readdir(outputPath, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath ?? entry.path, entry.name).slice(outputPath.length + 1))
      .sort();
    assert.deepEqual(files, [
      `jobs/${result.jobId}/index.html`,
      `jobs/${result.jobId}/instagram-image.jpg`,
      `jobs/${result.jobId}/opengraph-image.png`,
    ]);
    assert.equal(await readFile(fileURLToPath(new URL('../../../state/queue.json', import.meta.url)), 'utf8'), beforeState);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('publishes rendered bridge artifacts through web-deploy without FTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-social-publisher-bridge-'));
  const job = makeJob();
  const calls = [];
  try {
    const publishBridge = createBridgePublisher({
      config: {
        publicSiteOrigin: OPENINGS_ORIGIN,
        webDeploy: {
          repository: 'openings-dev/web-deploy',
          token: 'github-secret',
        },
      },
      wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
      outputRoot: directory,
      requestDeployment: async (input) => {
        calls.push(input);
        return {
          status: 'deployed',
          verification: {
            canonicalUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}`,
            imageUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/opengraph-image.png`,
            instagramImageUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/instagram-image.jpg`,
          },
        };
      },
    });
    const result = await publishBridge({ job, reason: 'instagram_card_upgrade' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].repository, 'openings-dev/web-deploy');
    assert.equal(calls[0].token, 'github-secret');
    assert.match(calls[0].html.toString('utf8'), new RegExp(job.id));
    assert.equal(sha256(calls[0].image), calls[0].expectedPngHash);
    assert.match(calls[0].instagramSvg.toString('utf8'), /data-instagram-card="true"/u);
    assert.equal(sha256(calls[0].instagramSvg), calls[0].expectedInstagramSvgHash);
    assert.equal(calls[0].expectedInstagramCardVersion, '2');
    assert.equal(calls[0].forceDeployment, true);
    assert.equal(result.status, 'deployed');
    assert.equal(result.canonicalUrl, `${OPENINGS_ORIGIN}/jobs/${job.id}`);
    assert.equal(result.instagramImageUrl, `${OPENINGS_ORIGIN}/jobs/${job.id}/instagram-image.jpg`);
    assert.equal(result.instagramCardVersion, '2');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('builds a bounded repository dispatch without credentials in its body', () => {
  const html = Buffer.from('<!doctype html><html></html>');
  const image = Buffer.from('fixture-image');
  const instagramSvg = Buffer.from('<svg width="1080" height="1350"></svg>');
  const request = buildRepositoryDispatchRequest({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    html,
    image,
    instagramSvg,
    repository: 'openings-dev/web-deploy',
  });
  assert.equal(request.url, 'https://api.github.com/repos/openings-dev/web-deploy/dispatches');
  assert.ok(request.body.length < 60_000);
  const body = JSON.parse(request.body);
  assert.equal(body.event_type, 'publish_job_bridge');
  assert.deepEqual(Object.keys(body.client_payload).sort(), [
    'content_hash',
    'html_base64',
    'html_sha256',
    'image_base64',
    'image_sha256',
    'instagram_svg_base64',
    'instagram_svg_sha256',
    'job_id',
  ]);
  assert.equal(body.client_payload.html_sha256, sha256(html));
  assert.equal(body.client_payload.image_sha256, sha256(image));
  assert.equal(body.client_payload.instagram_svg_sha256, sha256(instagramSvg));
  assert.doesNotMatch(request.body, /token|password|ftp/iu);
  assert.throws(() => buildRepositoryDispatchRequest({
    jobId: '../escape',
    contentHash: 'a'.repeat(64),
    html,
    image,
    instagramSvg,
    repository: 'openings-dev/web-deploy',
  }), /Invalid job ID/);
  assert.throws(() => buildRepositoryDispatchRequest({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    html,
    image: Buffer.alloc(60_000),
    instagramSvg,
    repository: 'openings-dev/web-deploy',
  }), /payload.*large/i);
});

validation('verifies public HTML, exact PNG bytes, and the Instagram JPEG derivative', async () => {
  const job = makeJob();
  const html = createBridgeHtml(job);
  const png = await renderSocialCardPng(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const canonicalUrl = `https://openings.dev/jobs/${job.id}`;
  const imageUrl = `${canonicalUrl}/opengraph-image.png`;
  const instagramImageUrl = `${canonicalUrl}/instagram-image.jpg`;
  const instagramImage = await socialCardModule.renderInstagramCardJpeg(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const fetchImpl = async (url) => {
    if (url === canonicalUrl) {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url === imageUrl) {
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url === instagramImageUrl) {
      return new Response(instagramImage, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('missing', { status: 404 });
  };
  const result = await verifyPublicBridge({
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: sha256(png),
    fetchImpl,
  });
  assert.equal(result.matches, true);
  assert.equal(result.canonicalUrl, canonicalUrl);
  assert.equal(result.instagramImageUrl, instagramImageUrl);
  assert.equal(result.instagramCardVersion, '2');

  const staleHtml = html.replace(
    'name="openings:instagram-card-version" content="2"',
    'name="openings:instagram-card-version" content="1"',
  );
  const staleVersion = await verifyPublicBridge({
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: sha256(png),
    fetchImpl: async (url) => {
      if (url === canonicalUrl) {
        return new Response(staleHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return fetchImpl(url);
    },
    allowMismatch: true,
  });
  assert.equal(staleVersion.matches, false);
  assert.equal(staleVersion.reason, 'instagram_card_version_mismatch');

  const mismatch = await verifyPublicBridge({
    jobId: job.id,
    contentHash: 'b'.repeat(64),
    expectedPngHash: sha256(png),
    fetchImpl,
    allowMismatch: true,
  });
  assert.equal(mismatch.matches, false);
  assert.equal(mismatch.reason, 'content_hash_mismatch');
});

validation('accepts the canonical Hostinger trailing-slash redirect only', async () => {
  const job = makeJob();
  const html = createBridgeHtml(job);
  const png = await renderSocialCardPng(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const canonicalUrl = `https://openings.dev/jobs/${job.id}`;
  const redirectedUrl = `${canonicalUrl}/`;
  const imageUrl = `${canonicalUrl}/opengraph-image.png`;
  const instagramImageUrl = `${canonicalUrl}/instagram-image.jpg`;
  const instagramImage = await socialCardModule.renderInstagramCardJpeg(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === canonicalUrl) {
      return new Response(null, { status: 301, headers: { location: redirectedUrl } });
    }
    if (url === redirectedUrl) {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url === imageUrl) {
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url === instagramImageUrl) {
      return new Response(instagramImage, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('missing', { status: 404 });
  };

  const result = await verifyPublicBridge({
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: sha256(png),
    fetchImpl,
  });

  assert.equal(result.matches, true);
  assert.deepEqual(calls, [canonicalUrl, redirectedUrl, imageUrl, instagramImageUrl]);
});

validation('verifies exact public assets when Cloudflare blocks Node HTML requests', async () => {
  const job = makeJob();
  const png = await renderSocialCardPng(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const canonicalUrl = `https://openings.dev/jobs/${job.id}`;
  const redirectedUrl = `${canonicalUrl}/`;
  const imageUrl = `${canonicalUrl}/opengraph-image.png`;
  const instagramImageUrl = `${canonicalUrl}/instagram-image.jpg`;
  const instagramImage = await socialCardModule.renderInstagramCardJpeg(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const fetchImpl = async (url) => {
    if (url === canonicalUrl) {
      return new Response(null, { status: 301, headers: { location: redirectedUrl } });
    }
    if (url === redirectedUrl) {
      return new Response('Bot Verification', {
        status: 403,
        headers: { 'content-type': 'text/html', server: 'cloudflare' },
      });
    }
    if (url === imageUrl) {
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url === instagramImageUrl) {
      return new Response(instagramImage, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('missing', { status: 404 });
  };

  const result = await verifyPublicBridge({
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: sha256(png),
    fetchImpl,
  });

  assert.equal(result.matches, true);
  assert.equal(result.htmlVerification, 'edge_blocked_assets_verified');
});

validation('rejects public bridge redirects outside the canonical job directory', async () => {
  const job = makeJob();
  const mismatch = await verifyPublicBridge({
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: 'a'.repeat(64),
    fetchImpl: async () => new Response(null, {
      status: 301,
      headers: { location: 'https://example.test/untrusted' },
    }),
    allowMismatch: true,
  });

  assert.equal(mismatch.matches, false);
  assert.equal(mismatch.reason, 'html_redirect_mismatch');
});

validation('skips current bridges and dispatches stale bridges exactly once', async () => {
  const calls = [];
  const verificationInputs = [];
  const html = Buffer.from('<!doctype html><html></html>');
  const image = Buffer.from('fixture-image');
  const instagramSvg = Buffer.from('<svg width="1080" height="1350"></svg>');
  const currentVerification = {
    matches: true,
    canonicalUrl: 'https://openings.dev/jobs/gh_0123456789abcdef01234567',
    imageUrl: 'https://openings.dev/jobs/gh_0123456789abcdef01234567/opengraph-image.png',
  };
  const matching = await requestIncrementalBridgeDeployment({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    expectedPngHash: sha256(image),
    expectedInstagramSvgHash: sha256(instagramSvg),
    html,
    image,
    instagramSvg,
    repository: 'openings-dev/web-deploy',
    token: 'github-secret',
    expectedInstagramCardVersion: '2',
    verifyPublic: async (input) => {
      verificationInputs.push(input);
      return currentVerification;
    },
    fetchImpl: async () => { calls.push('dispatch'); return new Response(null, { status: 204 }); },
  });
  assert.equal(matching.status, 'already_current');
  assert.deepEqual(calls, []);
  assert.equal(verificationInputs[0].expectedInstagramCardVersion, '2');

  const forcedCalls = [];
  const forced = await requestIncrementalBridgeDeployment({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    expectedPngHash: sha256(image),
    expectedInstagramSvgHash: sha256(instagramSvg),
    expectedInstagramCardVersion: '2',
    forceDeployment: true,
    html,
    image,
    instagramSvg,
    repository: 'openings-dev/web-deploy',
    token: 'github-secret',
    verifyPublic: async () => currentVerification,
    fetchImpl: async (url, options) => {
      forcedCalls.push({ url, options });
      return new Response(null, { status: 204 });
    },
    sleep: async () => {},
  });
  assert.equal(forced.status, 'deployed');
  assert.equal(forcedCalls.length, 1);

  let verification = 0;
  const deployed = await requestIncrementalBridgeDeployment({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    expectedPngHash: sha256(image),
    expectedInstagramSvgHash: sha256(instagramSvg),
    html,
    image,
    instagramSvg,
    repository: 'openings-dev/web-deploy',
    token: 'github-secret',
    verifyPublic: async () => {
      verification += 1;
      return verification === 1 ? { matches: false, reason: 'not_found' } : currentVerification;
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: 204 });
    },
    sleep: async () => {},
  });
  assert.equal(deployed.status, 'deployed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer github-secret');
  assert.equal(calls[0].options.headers['x-github-api-version'], '2026-03-10');
  assert.doesNotMatch(calls[0].options.body, /github-secret/u);

  await assert.rejects(
    requestIncrementalBridgeDeployment({
      jobId: 'gh_0123456789abcdef01234567',
      contentHash: 'a'.repeat(64),
      expectedPngHash: sha256(image),
      expectedInstagramSvgHash: sha256(instagramSvg),
      html,
      image,
      instagramSvg,
      repository: 'openings-dev/web-deploy',
      token: 'github-secret',
      verifyPublic: async () => ({ matches: false, reason: 'not_found' }),
      fetchImpl: async () => new Response('forbidden', { status: 403 }),
      sleep: async () => {},
      pollAttempts: 2,
    }),
    (error) => /dispatch failed/i.test(error.message) && !error.message.includes('github-secret'),
  );
});

function createFakeBlueskyAgent({ existing = null, uploadError = null, putError = null } = {}) {
  const calls = { login: [], get: [], upload: [], put: [] };
  const agent = {
    session: null,
    async login(credentials) {
      calls.login.push(credentials);
      this.session = { did: 'did:plc:openingsfixture', handle: 'openingshq.bsky.social' };
    },
    async uploadBlob(bytes, options) {
      calls.upload.push({ bytes, options });
      if (uploadError) throw uploadError;
      return { data: { blob: { $type: 'blob', ref: { $link: 'bafkfixture' }, mimeType: 'image/png', size: bytes.byteLength } } };
    },
    com: {
      atproto: {
        repo: {
          async getRecord(input) {
            calls.get.push(input);
            if (!existing) {
              const error = new Error('not found');
              error.error = 'RecordNotFound';
              throw error;
            }
            return { data: existing };
          },
          async putRecord(input) {
            calls.put.push(input);
            if (putError) throw putError;
            return {
              data: {
                uri: `at://did:plc:openingsfixture/app.bsky.feed.post/${input.rkey}`,
                cid: 'bafyreipublished',
              },
            };
          },
        },
      },
    },
  };
  return { agent, calls };
}

validation('publishes one deterministic Bluesky external-card record', async () => {
  const job = makeJob({ community: { name: 'Openings Fixtures' }, tags: ['typescript'] });
  const post = formatSocialPost(job);
  const png = Buffer.from([137, 80, 78, 71]);
  const { agent, calls } = createFakeBlueskyAgent();
  const result = await publishToBluesky({
    job,
    post,
    png,
    publicationCreatedAt: '2026-08-20T13:01:00.000Z',
    credentials: { identifier: 'openingshq.bsky.social', appPassword: 'fixture-secret' },
    agentFactory: () => agent,
  });
  const rkey = blueskyRecordKey(job.id, '2026-08-20T13:01:00.000Z');
  assert.equal(result.status, 'published');
  assert.equal(result.url, `https://bsky.app/profile/openingshq.bsky.social/post/${rkey}`);
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0].rkey, rkey);
  assert.equal(calls.put[0].record.createdAt, '2026-08-20T13:01:00.000Z');
  assert.equal(calls.put[0].record.embed.external.uri, post.canonicalUrl);
  assert.equal(calls.put[0].record.embed.external.thumb.mimeType, 'image/png');
  assert.ok(calls.put[0].record.facets.some((facet) => facet.features.some((feature) => feature.$type === 'app.bsky.richtext.facet#link')));
  assert.ok(calls.put[0].record.facets.some((facet) => facet.features.some((feature) => feature.$type === 'app.bsky.richtext.facet#tag')));
});

validation('reconciles an existing matching Bluesky record without uploading', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const rkey = blueskyRecordKey(job.id, '2026-08-20T13:01:00.000Z');
  const { agent, calls } = createFakeBlueskyAgent({
    existing: {
      uri: `at://did:plc:openingsfixture/app.bsky.feed.post/${rkey}`,
      cid: 'bafyreiexisting',
      value: { embed: { external: { uri: post.canonicalUrl } } },
    },
  });
  const result = await publishToBluesky({
    job,
    post,
    png: Buffer.from([1]),
    publicationCreatedAt: '2026-08-20T13:01:00.000Z',
    credentials: { identifier: 'openingshq.bsky.social', appPassword: 'fixture-secret' },
    agentFactory: () => agent,
  });
  assert.equal(result.status, 'reconciled');
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.put.length, 0);
});

validation('derives deterministic Bluesky TIDs from the job and publication time', () => {
  const time = '2026-08-20T13:01:00.000Z';
  const first = blueskyRecordKey('gh_0123456789abcdef01234567', time);
  const same = blueskyRecordKey('gh_0123456789abcdef01234567', time);
  const otherJob = blueskyRecordKey('gh_1123456789abcdef01234567', time);
  const otherTime = blueskyRecordKey('gh_0123456789abcdef01234567', '2026-08-20T13:01:01.000Z');

  assert.equal(TID.is(first), true);
  assert.equal(first.length, 13);
  assert.equal(first, same);
  assert.notEqual(first, otherJob);
  assert.notEqual(first, otherTime);
});

validation('rejects conflicting or failed Bluesky writes without leaking credentials', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const conflict = createFakeBlueskyAgent({
    existing: {
      uri: 'at://did:plc:openingsfixture/app.bsky.feed.post/conflict',
      cid: 'conflict',
      value: { embed: { external: { uri: 'https://openings.dev/jobs/gh_ffffffffffffffffffffffff' } } },
    },
  });
  await assert.rejects(publishToBluesky({
    job,
    post,
    png: Buffer.from([1]),
    publicationCreatedAt: '2026-08-20T13:01:00.000Z',
    credentials: { identifier: 'openingshq.bsky.social', appPassword: 'fixture-secret' },
    agentFactory: () => conflict.agent,
  }), /conflicting deterministic record/i);

  const failed = createFakeBlueskyAgent({ uploadError: new Error('fixture-secret provider detail') });
  await assert.rejects(
    publishToBluesky({
      job,
      post,
      png: Buffer.from([1]),
      publicationCreatedAt: '2026-08-20T13:01:00.000Z',
      credentials: { identifier: 'openingshq.bsky.social', appPassword: 'fixture-secret' },
      agentFactory: () => failed.agent,
    }),
    (error) => error.code === 'bluesky_thumbnail_upload'
      && /thumbnail upload failed/i.test(error.message)
      && !error.message.includes('fixture-secret'),
  );

  const putError = new Error('Invalid record from fixture-secret for openingshq.bsky.social');
  putError.error = 'InvalidRequest';
  putError.status = 400;
  const putFailed = createFakeBlueskyAgent({ putError });
  await assert.rejects(
    publishToBluesky({
      job,
      post,
      png: Buffer.from([1]),
      publicationCreatedAt: '2026-08-20T13:01:00.000Z',
      credentials: { identifier: 'openingshq.bsky.social', appPassword: 'fixture-secret' },
      agentFactory: () => putFailed.agent,
    }),
    (error) => error.code === 'bluesky_publication'
      && /record publication failed/i.test(error.message)
      && error.diagnostic?.status === 400
      && error.diagnostic?.providerCode === 'InvalidRequest'
      && /\[redacted\]/u.test(error.diagnostic?.message ?? '')
      && !JSON.stringify(error.diagnostic).includes('fixture-secret')
      && !JSON.stringify(error.diagnostic).includes('openingshq.bsky.social'),
  );
});

validation('persists safe provider stage codes without provider details', async () => {
  const job = makeJob();
  const snapshot = makeLoadedSnapshot({
    commit: 'f'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: 'f'.repeat(64),
    jobs: [job],
  });
  const queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  const providerError = new Error('Bluesky thumbnail upload failed');
  providerError.code = 'bluesky_thumbnail_upload';
  const result = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async () => ({ status: 'deployed' }),
    publishBluesky: async () => { throw providerError; },
    publishMastodon: async () => ({ status: 'published' }),
    now: '2026-08-20T13:02:00.000Z',
  });

  assert.equal(result.queueState.items[0].bluesky.lastError.code, 'bluesky_thumbnail_upload');
  assert.doesNotMatch(JSON.stringify(result.queueState), /provider detail|fixture-secret/u);
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function createFakeMastodonFetch({ statuses = [], postError = null, cards = [] } = {}) {
  const calls = [];
  let cardIndex = 0;
  const created = {
    id: '109876543210',
    url: 'https://mastodon.social/@openingshq/109876543210',
    content: '<p>New job</p>',
    card: null,
  };
  return {
    calls,
    async fetch(url, options = {}) {
      calls.push({ url: String(url), options });
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v1/accounts/verify_credentials') {
        return jsonResponse({ id: '12345', username: 'openingshq' });
      }
      if (parsed.pathname === '/api/v1/accounts/12345/statuses') {
        return jsonResponse(statuses);
      }
      if (parsed.pathname === '/api/v1/statuses' && options.method === 'POST') {
        if (postError) throw postError;
        return jsonResponse(created);
      }
      if (parsed.pathname === `/api/v1/statuses/${created.id}`) {
        const card = cards[Math.min(cardIndex, Math.max(0, cards.length - 1))] ?? null;
        cardIndex += 1;
        return jsonResponse({ ...created, card });
      }
      return jsonResponse({ error: 'missing' }, 404);
    },
  };
}

validation('publishes a link-only Mastodon status with deterministic idempotency', async () => {
  const job = makeJob({ community: { name: 'Openings Fixtures' } });
  const post = formatSocialPost(job);
  const fake = createFakeMastodonFetch({
    cards: [null, { url: post.canonicalUrl, title: job.title }],
  });
  const result = await publishToMastodon({
    job,
    post,
    accessToken: 'fixture-token',
    fetchImpl: fake.fetch,
    sleep: async () => {},
    cardPollAttempts: 2,
  });
  assert.equal(result.status, 'published');
  assert.equal(result.cardStatus, 'resolved');
  const publication = fake.calls.find((call) => new URL(call.url).pathname === '/api/v1/statuses' && call.options.method === 'POST');
  assert.equal(publication.options.headers['Idempotency-Key'], mastodonIdempotencyKey(job.id));
  assert.equal(publication.options.headers.Authorization, 'Bearer fixture-token');
  const body = new URLSearchParams(publication.options.body);
  assert.equal(body.get('status'), post.text);
  assert.equal(body.get('visibility'), 'public');
  assert.equal(body.has('media_ids[]'), false);
});

validation('reconciles a recent Mastodon status by exact canonical URL', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const fake = createFakeMastodonFetch({
    statuses: [{
      id: 'existing',
      url: 'https://mastodon.social/@openingshq/existing',
      content: `<p>View: <a href="${post.canonicalUrl}">${post.canonicalUrl}</a></p>`,
      card: { url: post.canonicalUrl },
    }],
  });
  const result = await publishToMastodon({
    job,
    post,
    accessToken: 'fixture-token',
    fetchImpl: fake.fetch,
    sleep: async () => {},
  });
  assert.equal(result.status, 'reconciled');
  assert.equal(result.id, 'existing');
  assert.equal(result.cardStatus, 'resolved');
  assert.equal(fake.calls.some((call) => call.options.method === 'POST'), false);
});

validation('does not duplicate Mastodon posts after an ambiguous response', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const failed = createFakeMastodonFetch({ postError: new Error('fixture-token connection reset') });
  await assert.rejects(
    publishToMastodon({
      job,
      post,
      accessToken: 'fixture-token',
      fetchImpl: failed.fetch,
      sleep: async () => {},
    }),
    (error) => /publication failed/i.test(error.message) && !error.message.includes('fixture-token'),
  );

  const retry = createFakeMastodonFetch({
    statuses: [{
      id: 'created-during-timeout',
      url: 'https://mastodon.social/@openingshq/created-during-timeout',
      content: `<p><a href="${post.canonicalUrl}">${post.canonicalUrl}</a></p>`,
      card: null,
    }],
  });
  const result = await publishToMastodon({
    job,
    post,
    accessToken: 'fixture-token',
    fetchImpl: retry.fetch,
    sleep: async () => {},
  });
  assert.equal(result.status, 'reconciled');
  assert.equal(result.cardStatus, 'pending');
  assert.equal(retry.calls.some((call) => call.options.method === 'POST'), false);
});

validation('records a delayed Mastodon PreviewCard without retrying the status', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const fake = createFakeMastodonFetch({ cards: [null, null] });
  const result = await publishToMastodon({
    job,
    post,
    accessToken: 'fixture-token',
    fetchImpl: fake.fetch,
    sleep: async () => {},
    cardPollAttempts: 2,
  });
  assert.equal(result.status, 'published');
  assert.equal(result.cardStatus, 'pending');
  assert.equal(fake.calls.filter((call) => call.options.method === 'POST').length, 1);

  const unrelated = createFakeMastodonFetch({ cards: [{ url: 'https://example.test/not-the-job' }] });
  const unrelatedResult = await publishToMastodon({
    job,
    post,
    accessToken: 'fixture-token',
    fetchImpl: unrelated.fetch,
    sleep: async () => {},
    cardPollAttempts: 1,
  });
  assert.equal(unrelatedResult.cardStatus, 'pending');
});

validation('publishes and reconciles a link-preview Threads post', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const calls = [];
  let published = false;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(url);
    if (parsed.pathname === '/v1.0/me/threads' && options.method !== 'POST') {
      return jsonResponse({
        data: published ? [{ id: 'thread-1', text: post.text, permalink: 'https://www.threads.net/@openingshq/post/thread-1' }] : [],
      });
    }
    if (parsed.pathname === '/v1.0/me/threads' && options.method === 'POST') {
      published = true;
      return jsonResponse({ id: 'thread-1' });
    }
    if (parsed.pathname === '/v1.0/thread-1') {
      return jsonResponse({
        id: 'thread-1',
        permalink: 'https://www.threads.net/@openingshq/post/thread-1',
      });
    }
    return jsonResponse({ error: 'missing' }, 404);
  };

  const result = await publishToThreads({
    job,
    post,
    accessToken: 'threads-secret',
    fetchImpl,
  });
  assert.equal(result.status, 'published');
  assert.equal(result.id, 'thread-1');
  assert.equal(result.url, 'https://www.threads.net/@openingshq/post/thread-1');
  const publication = calls.find((call) => call.options.method === 'POST');
  const body = new URLSearchParams(publication.options.body);
  assert.equal(body.get('media_type'), 'TEXT');
  assert.equal(body.get('text'), post.text);
  assert.equal(body.get('link_attachment'), post.canonicalUrl);
  assert.equal(body.get('auto_publish_text'), 'true');
  assert.equal(body.get('reply_control'), 'everyone');
  assert.equal(publication.options.headers.Authorization, 'Bearer threads-secret');

  const reconciled = await publishToThreads({
    job,
    post,
    accessToken: 'threads-secret',
    fetchImpl,
  });
  assert.equal(reconciled.status, 'reconciled');
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
});

validation('publishes and reconciles one Instagram image by canonical job URL', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const imageUrl = `${post.canonicalUrl}/instagram-image.jpg`;
  const calls = [];
  let published = false;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(url);
    if (parsed.pathname === '/v23.0/17841400000000000/media' && options.method !== 'POST') {
      return jsonResponse({
        data: published ? [{ id: 'media-1', caption: `New opening\n${post.canonicalUrl}`, permalink: 'https://www.instagram.com/p/media-1/' }] : [],
      });
    }
    if (parsed.pathname === '/v23.0/17841400000000000/media' && options.method === 'POST') {
      return jsonResponse({ id: 'container-1' });
    }
    if (parsed.pathname === '/v23.0/container-1') {
      return jsonResponse({ id: 'container-1', status_code: 'FINISHED' });
    }
    if (parsed.pathname === '/v23.0/17841400000000000/media_publish') {
      published = true;
      return jsonResponse({ id: 'media-1' });
    }
    if (parsed.pathname === '/v23.0/media-1') {
      return jsonResponse({
        id: 'media-1',
        permalink: 'https://www.instagram.com/p/media-1/',
      });
    }
    return jsonResponse({ error: 'missing' }, 404);
  };

  const result = await publishToInstagram({
    job,
    post,
    imageUrl,
    accessToken: 'instagram-secret',
    userId: '17841400000000000',
    apiVersion: 'v23.0',
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(result.status, 'published');
  assert.equal(result.id, 'media-1');
  assert.equal(result.url, 'https://www.instagram.com/p/media-1/');
  const container = calls.find((call) => new URL(call.url).pathname.endsWith('/media') && call.options.method === 'POST');
  const body = new URLSearchParams(container.options.body);
  assert.equal(body.get('image_url'), imageUrl);
  assert.match(body.get('caption'), new RegExp(post.canonicalUrl));
  assert.match(body.get('caption'), /Follow @openingshq for more jobs from public communities\./u);
  assert.match(body.get('caption'), /Know someone who fits\? Tag them below\./u);
  assert.equal(container.options.headers.Authorization, 'Bearer instagram-secret');

  const reconciled = await publishToInstagram({
    job,
    post,
    imageUrl,
    accessToken: 'instagram-secret',
    userId: '17841400000000000',
    apiVersion: 'v23.0',
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(reconciled.status, 'reconciled');
  assert.equal(calls.filter((call) => new URL(call.url).pathname.endsWith('/media_publish')).length, 1);
});

function makeLoadedSnapshot({ commit, generatedAt, dataHash, jobs }) {
  return {
    commit,
    generatedAt,
    dataHash,
    schemaVersion: 4,
    jobsById: new Map(jobs.map((job) => [job.id, job])),
  };
}

validation('baselines the current snapshot without bridge work or social backfill', async () => {
  const current = makeLoadedSnapshot({
    commit: '1'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '1'.repeat(64),
    jobs: [makeJob()],
  });
  const bridgeCalls = [];
  const result = await processIntakeSnapshots({
    intakeState: { schemaVersion: STATE_SCHEMA_VERSION, processedSnapshot: null, pendingBridges: [], removedJobs: [] },
    queueState: { schemaVersion: STATE_SCHEMA_VERSION, items: [] },
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    snapshots: [current],
    publishBridge: async (input) => bridgeCalls.push(input),
    now: '2026-08-20T13:01:00.000Z',
  });
  assert.equal(result.summary.baseline, true);
  assert.equal(result.intakeState.processedSnapshot.commit, current.commit);
  assert.deepEqual(result.queueState.items, []);
  assert.deepEqual(bridgeCalls, []);
});

validation('deploys every new or changed bridge but queues only genuinely new issues', async () => {
  const unchanged = makeJob();
  const changedBefore = makeJob({ id: 'gh_111111111111111111111111', contentHash: '1'.repeat(64) });
  const changedAfter = { ...changedBefore, contentHash: '2'.repeat(64), updatedAt: '2026-08-20T11:30:00.000Z' };
  const eligible = makeJob({
    id: 'gh_222222222222222222222222',
    contentHash: '3'.repeat(64),
    createdAt: '2026-08-20T10:00:01.000Z',
  });
  const historical = makeJob({
    id: 'gh_333333333333333333333333',
    contentHash: '4'.repeat(64),
    createdAt: '2026-08-19T10:00:00.000Z',
  });
  const removed = makeJob({ id: 'gh_444444444444444444444444', contentHash: '5'.repeat(64) });
  const previous = makeLoadedSnapshot({
    commit: '1'.repeat(40),
    generatedAt: '2026-08-20T10:00:00.000Z',
    dataHash: '1'.repeat(64),
    jobs: [unchanged, changedBefore, removed],
  });
  const current = makeLoadedSnapshot({
    commit: '2'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '2'.repeat(64),
    jobs: [unchanged, changedAfter, eligible, historical],
  });
  const bridgeCalls = [];
  const result = await processIntakeSnapshots({
    intakeState: {
      schemaVersion: STATE_SCHEMA_VERSION,
      processedSnapshot: snapshotReference({ commit: previous.commit, generatedAt: previous.generatedAt, dataHash: previous.dataHash }),
      pendingBridges: [],
      removedJobs: [],
    },
    queueState: { schemaVersion: STATE_SCHEMA_VERSION, items: [] },
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    snapshots: [previous, current],
    publishBridge: async ({ job, reason }) => {
      bridgeCalls.push(`${job.id}:${reason}`);
      return { status: 'deployed', canonicalUrl: `https://openings.dev/jobs/${job.id}` };
    },
    now: '2026-08-20T13:01:00.000Z',
  });
  assert.deepEqual(bridgeCalls, [
    `${eligible.id}:new`,
    `${historical.id}:new`,
    `${changedAfter.id}:changed`,
  ]);
  assert.deepEqual(result.queueState.items.map((item) => item.jobId), [eligible.id]);
  assert.equal(result.queueState.items[0].bridge.status, 'published');
  assert.deepEqual(result.intakeState.pendingBridges, []);
  assert.deepEqual(result.intakeState.removedJobs, [removed.id]);
  assert.equal(result.intakeState.processedSnapshot.commit, current.commit);
});

validation('deploys before providers and preserves partial success for a retry', async () => {
  const job = makeJob({ community: { name: 'Openings Fixtures' }, tags: ['typescript'] });
  const snapshot = makeLoadedSnapshot({
    commit: '3'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '3'.repeat(64),
    jobs: [job],
  });
  const queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  const order = [];
  const first = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async () => { order.push('bridge'); return { status: 'deployed' }; },
    publishBluesky: async ({ post }) => { order.push('bluesky'); return { status: 'published', uri: 'at://fixture', cid: 'cid', url: post.canonicalUrl }; },
    publishMastodon: async () => { order.push('mastodon'); throw new Error('Mastodon publication failed'); },
    now: '2026-08-20T13:02:00.000Z',
  });
  assert.deepEqual(order, ['bridge', 'bluesky', 'mastodon']);
  assert.equal(first.queueState.items[0].bridge.status, 'published');
  assert.equal(first.queueState.items[0].bluesky.status, 'published');
  assert.equal(first.queueState.items[0].mastodon.status, 'retryable');
  assert.deepEqual(first.publicationsState.jobs, {});

  order.length = 0;
  const second = await processOnePublication({
    queueState: first.queueState,
    publicationsState: first.publicationsState,
    currentSnapshot: snapshot,
    publishBridge: async () => { order.push('bridge'); return { status: 'deployed' }; },
    publishBluesky: async () => { order.push('bluesky'); return { status: 'published' }; },
    publishMastodon: async ({ post }) => { order.push('mastodon'); return { status: 'reconciled', id: 'status', url: post.canonicalUrl, cardStatus: 'resolved' }; },
    now: '2026-08-20T15:02:00.000Z',
  });
  assert.deepEqual(order, ['mastodon']);
  assert.equal(second.queueState.items[0].mastodon.status, 'published');
  assert.equal(second.publicationsState.jobs[job.id].status, 'completed');
});

validation('refreshes a stale queued Instagram card before publication', async () => {
  const job = makeJob();
  const snapshot = makeLoadedSnapshot({
    commit: '9'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '9'.repeat(64),
    jobs: [job],
  });
  const makePublishedBridgeQueue = (instagramCardVersion) => {
    let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
      job,
      snapshot,
      discoveredAt: '2026-08-20T13:01:00.000Z',
      enabledChannels: ['instagram'],
    });
    queue = transitionQueueStage(queue, job.id, 'bridge', 'publishing', {
      at: '2026-08-20T13:01:10.000Z',
    });
    return transitionQueueStage(queue, job.id, 'bridge', 'published', {
      at: '2026-08-20T13:01:20.000Z',
      result: { status: 'deployed', instagramCardVersion },
    });
  };

  const staleOrder = [];
  const stale = await processOnePublication({
    queueState: makePublishedBridgeQueue('1'),
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async ({ reason }) => {
      assert.equal(reason, 'instagram_card_upgrade');
      staleOrder.push('bridge');
      return { status: 'deployed', instagramCardVersion: INSTAGRAM_CARD_VERSION };
    },
    publishBluesky: async () => { throw new Error('Bluesky is disabled'); },
    publishMastodon: async () => { throw new Error('Mastodon is disabled'); },
    publishInstagram: async () => {
      staleOrder.push('instagram');
      return { status: 'published', id: 'media-stale', url: 'https://www.instagram.com/p/media-stale/' };
    },
    enabledChannels: ['instagram'],
    now: '2026-08-20T13:02:00.000Z',
  });
  assert.deepEqual(staleOrder, ['bridge', 'instagram']);
  assert.equal(stale.queueState.items[0].bridge.result.instagramCardVersion, INSTAGRAM_CARD_VERSION);

  const currentOrder = [];
  await processOnePublication({
    queueState: makePublishedBridgeQueue(INSTAGRAM_CARD_VERSION),
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async () => { currentOrder.push('bridge'); return { status: 'deployed' }; },
    publishBluesky: async () => { throw new Error('Bluesky is disabled'); },
    publishMastodon: async () => { throw new Error('Mastodon is disabled'); },
    publishInstagram: async () => {
      currentOrder.push('instagram');
      return { status: 'published', id: 'media-current', url: 'https://www.instagram.com/p/media-current/' };
    },
    enabledChannels: ['instagram'],
    now: '2026-08-20T13:02:00.000Z',
  });
  assert.deepEqual(currentOrder, ['instagram']);
});

validation('controlled publication can enqueue one explicit current job', async () => {
  const job = makeJob({
    id: 'gh_cccccccccccccccccccccccc',
    createdAt: '2026-08-20T12:47:52.000Z',
  });
  const snapshot = makeLoadedSnapshot({
    commit: 'c'.repeat(40),
    generatedAt: '2026-08-20T15:27:19.163Z',
    dataHash: 'c'.repeat(64),
    jobs: [job],
  });
  const calls = [];
  const result = await processOnePublication({
    queueState: { schemaVersion: STATE_SCHEMA_VERSION, items: [] },
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async () => { calls.push('bridge'); return { status: 'deployed' }; },
    publishBluesky: async () => { calls.push('bluesky'); return { status: 'published' }; },
    publishMastodon: async () => { calls.push('mastodon'); return { status: 'published' }; },
    now: '2026-08-20T15:30:00.000Z',
    jobId: job.id,
  });

  assert.equal(result.outcome, 'completed');
  assert.equal(result.selectedJobId, job.id);
  assert.deepEqual(calls, ['bridge', 'bluesky', 'mastodon']);
  assert.equal(result.queueState.items[0].jobId, job.id);
});

validation('controlled publication never republishes a completed job', async () => {
  const job = makeJob({ id: 'gh_dddddddddddddddddddddddd' });
  const snapshot = makeLoadedSnapshot({
    commit: 'd'.repeat(40),
    generatedAt: '2026-08-20T15:27:19.163Z',
    dataHash: 'd'.repeat(64),
    jobs: [job],
  });
  const publications = {
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: {
      [job.id]: {
        status: 'completed',
        contentHash: job.contentHash,
        dataCommit: snapshot.commit,
        dataHash: snapshot.dataHash,
        completedAt: '2026-08-20T15:00:00.000Z',
        bluesky: { status: 'published' },
        mastodon: { status: 'published' },
      },
    },
  };
  const calls = [];
  const result = await processOnePublication({
    queueState: { schemaVersion: STATE_SCHEMA_VERSION, items: [] },
    publicationsState: publications,
    currentSnapshot: snapshot,
    publishBridge: async () => { calls.push('bridge'); },
    publishBluesky: async () => { calls.push('bluesky'); },
    publishMastodon: async () => { calls.push('mastodon'); },
    now: '2026-08-20T15:30:00.000Z',
    jobId: job.id,
  });

  assert.equal(result.outcome, 'already_published');
  assert.equal(result.selectedJobId, job.id);
  assert.deepEqual(result.queueState.items, []);
  assert.deepEqual(calls, []);
});

validation('rerenders changed queued work and skips jobs no longer open', async () => {
  const before = makeJob({ contentHash: '1'.repeat(64) });
  const after = { ...before, contentHash: '2'.repeat(64), title: 'Updated title' };
  const previousSnapshot = makeLoadedSnapshot({
    commit: '4'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '4'.repeat(64),
    jobs: [before],
  });
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job: before,
    snapshot: previousSnapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  const currentSnapshot = makeLoadedSnapshot({
    commit: '5'.repeat(40),
    generatedAt: '2026-08-20T14:00:00.000Z',
    dataHash: '5'.repeat(64),
    jobs: [after],
  });
  const rendered = [];
  const changed = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot,
    publishBridge: async ({ job }) => { rendered.push(job.contentHash); return { status: 'deployed' }; },
    publishBluesky: async () => ({ status: 'published', uri: 'at://fixture', cid: 'cid', url: 'https://bsky.app/post' }),
    publishMastodon: async () => ({ status: 'published', id: 'status', url: 'https://mastodon.social/status', cardStatus: 'pending' }),
    now: '2026-08-20T14:01:00.000Z',
  });
  assert.deepEqual(rendered, [after.contentHash]);
  assert.equal(changed.queueState.items[0].contentHash, after.contentHash);

  queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job: before,
    snapshot: previousSnapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  const closed = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: { ...currentSnapshot, jobsById: new Map() },
    publishBridge: async () => { throw new Error('must not deploy'); },
    publishBluesky: async () => { throw new Error('must not post'); },
    publishMastodon: async () => { throw new Error('must not post'); },
    now: '2026-08-20T14:01:00.000Z',
  });
  assert.equal(closed.outcome, 'skipped_closed');
  assert.equal(closed.queueState.items[0].bluesky.status, 'skipped_closed');
});

validation('publishes at most one job and never bypasses a failed bridge', async () => {
  const firstJob = makeJob({
    id: 'gh_aaaaaaaaaaaaaaaaaaaaaaaa',
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-20T12:00:00.000Z',
  });
  const secondJob = makeJob({
    id: 'gh_bbbbbbbbbbbbbbbbbbbbbbbb',
    contentHash: 'b'.repeat(64),
    createdAt: '2026-08-20T11:00:00.000Z',
  });
  const snapshot = makeLoadedSnapshot({
    commit: '6'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '6'.repeat(64),
    jobs: [firstJob, secondJob],
  });
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job: firstJob,
    snapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  queue = enqueueJob(queue, {
    job: secondJob,
    snapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  const providerJobs = [];
  const result = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async ({ job }) => {
      if (job.id === firstJob.id) throw new Error('FTP deployment failed');
      return { status: 'deployed' };
    },
    publishBluesky: async ({ job }) => { providerJobs.push(job.id); return { status: 'published' }; },
    publishMastodon: async ({ job }) => { providerJobs.push(job.id); return { status: 'published' }; },
    now: '2026-08-20T13:02:00.000Z',
  });
  assert.equal(result.outcome, 'bridge_retryable');
  assert.deepEqual(providerJobs, []);
  assert.equal(result.queueState.items[1].bridge.status, 'pending');
});

validation('keeps validation read-only and production publishing explicitly gated', async () => {
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const validationWorkflow = await readFile(join(repositoryRoot, '.github/workflows/validate.yml'), 'utf8');
  const productionWorkflow = await readFile(join(repositoryRoot, '.github/workflows/publish-social.yml'), 'utf8');
  assert.match(validationWorkflow, /pull_request:/u);
  assert.match(validationWorkflow, /push:/u);
  assert.match(validationWorkflow, /contents:\s*read/u);
  assert.match(validationWorkflow, /npm ci/u);
  assert.match(validationWorkflow, /npm run validate/u);
  assert.match(validationWorkflow, /npm run dry-run/u);
  assert.doesNotMatch(validationWorkflow, /secrets\./u);
  assert.doesNotMatch(validationWorkflow, /npm run (?:intake|publish)/u);
  assert.match(productionWorkflow, /cron:\s*['"]17 \*\/2 \* \* \*['"]/u);
  assert.match(productionWorkflow, /workflow_dispatch:/u);
  assert.doesNotMatch(productionWorkflow, /^\s{2}(?:push|pull_request):/mu);
  assert.match(productionWorkflow, /contents:\s*write/u);
  assert.match(productionWorkflow, /cancel-in-progress:\s*false/u);
  assert.match(productionWorkflow, /PUBLISH_ONE_JOB/u);
  assert.match(productionWorkflow, /RESET_FAILED_STAGE/u);
  assert.match(productionWorkflow, /chore\(state\): record social intake/u);
  assert.match(productionWorkflow, /chore\(state\): record social publication/u);
  assert.match(productionWorkflow, /WEB_DEPLOY_TOKEN/u);
  assert.match(productionWorkflow, /THREADS_AUTO_PUBLISH/u);
  assert.match(productionWorkflow, /INSTAGRAM_AUTO_PUBLISH/u);
  assert.match(productionWorkflow, /THREADS_ACCESS_TOKEN/u);
  assert.match(productionWorkflow, /INSTAGRAM_ACCESS_TOKEN/u);
  assert.match(productionWorkflow, /META_GRAPH_VERSION/u);
  assert.match(productionWorkflow, /id:\s*preflight/u);
  assert.match(productionWorkflow, /src\/cli\/preflight\.mjs/u);
  assert.match(productionWorkflow, /steps\.preflight\.outputs\.should_run == 'true'/u);
  const stateCheckout = productionWorkflow.match(
    /- name: Check out social-publisher state and source(?<block>[\s\S]*?)(?=\n\s+- name:)/u,
  )?.groups?.block ?? '';
  assert.match(stateCheckout, /ref:\s*\$\{\{ github\.ref_name \}\}/u);
  assert.doesNotMatch(productionWorkflow, /FTP_(?:SERVER|USERNAME|PASSWORD|JOB_ROOT)|Install LFTP/u);
  const actionUses = [...`${validationWorkflow}\n${productionWorkflow}`.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/gu)];
  assert.ok(actionUses.length >= 5);
  assert.equal(actionUses.every((match) => /^[0-9a-f]{40}$/u.test(match[1])), true);
});

let passed = 0;

for (const { name, run } of validations) {
  try {
    await run();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

console.log(`Validated ${passed} deterministic contracts.`);
