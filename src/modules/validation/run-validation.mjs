import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
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
import { readJsonAtCommit } from '../data/git-json.mjs';
import { loadSnapshot } from '../data/load-snapshot.mjs';
import { collectBridgeJobs, collectDelta } from '../intake/collect-delta.mjs';
import { isEligibleNewJob } from '../intake/eligibility.mjs';
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
  assert.equal(STATE_SCHEMA_VERSION, 1);
  assert.equal(OPENINGS_ORIGIN, 'https://openings.dev');
  assert.equal(MAX_CHANNEL_ATTEMPTS, 3);
  assert.equal(STARVATION_THRESHOLD_MS, 24 * 60 * 60 * 1000);
  assert.deepEqual([IMAGE_WIDTH, IMAGE_HEIGHT], [1200, 630]);
});

validation('escapes untrusted HTML and attribute values', () => {
  assert.equal(escapeHtml('<script>"jobs" & roles</script>'), '&lt;script&gt;&quot;jobs&quot; &amp; roles&lt;/script&gt;');
  assert.equal(escapeAttribute("' onload='publish()"), '&#39; onload=&#39;publish()');
});

validation('creates deterministic SHA-256 hashes', () => {
  assert.equal(sha256('openings'), 'add875e192edf555f22898d640b2e2acd69cd7b84008318423a8d13ee1202464');
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
    FTP_SERVER: 'ftp.example.test',
    FTP_USERNAME: 'publisher',
    FTP_PASSWORD: 'super-secret',
    BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
    BLUESKY_APP_PASSWORD: 'app-secret',
    MASTODON_ACCESS_TOKEN: 'mastodon-secret',
  };
  assert.equal(readEnvironment({ env, mode: 'scheduled' }).publishEnabled, true);
  assert.equal(readEnvironment({ env: { ...env, SOCIAL_AUTO_PUBLISH: 'TRUE' }, mode: 'scheduled' }).publishEnabled, false);
  assert.throws(
    () => readEnvironment({ env: { ...env, FTP_PASSWORD: '' }, mode: 'controlled' }),
    (error) => error.message.includes('FTP_PASSWORD') && !error.message.includes('super-secret'),
  );
});

validation('validates the tracked initial state schemas', async () => {
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const intake = await loadStateFile(join(repositoryRoot, 'state/intake.json'), validateIntakeState);
  const queue = await loadStateFile(join(repositoryRoot, 'state/queue.json'), validateQueueState);
  const publications = await loadStateFile(join(repositoryRoot, 'state/publications.json'), validatePublicationsState);
  assert.equal(intake.schemaVersion, 1);
  assert.deepEqual(queue.items, []);
  assert.deepEqual(publications.jobs, {});
});

validation('rejects unknown state versions, duplicates, and sensitive keys', () => {
  assert.throws(() => validateIntakeState({ schemaVersion: 99, processedSnapshot: null, pendingBridges: [], removedJobs: [] }), /schemaVersion/);
  assert.throws(
    () => validateQueueState({ schemaVersion: 1, items: [{ jobId: 'gh_0123456789abcdef01234567' }, { jobId: 'gh_0123456789abcdef01234567' }] }),
    /duplicate/i,
  );
  assert.throws(() => assertNoSensitiveKeys({ nested: { accessToken: 'never-track-this' } }), /sensitive/i);
});

validation('writes state atomically with stable formatting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-social-state-'));
  const file = join(directory, 'queue.json');
  const value = { schemaVersion: 1, items: [] };
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

validation('rejects mixed, duplicate, and inconsistent snapshot artifacts', async () => {
  const duplicate = makeJob();
  const files = makeSnapshotFiles([duplicate, duplicate]);
  await assert.rejects(
    loadSnapshot('/data', 'c'.repeat(40), { readJson: async (_repository, _commit, path) => structuredClone(files[path]) }),
    /duplicate/i,
  );

  const mixed = makeSnapshotFiles([makeJob()]);
  mixed['snapshots/opportunities/api/pages/page-0001.json'].generatedAt = '2026-08-20T13:05:00.000Z';
  await assert.rejects(
    loadSnapshot('/data', 'd'.repeat(40), { readJson: async (_repository, _commit, path) => structuredClone(mixed[path]) }),
    /generation/i,
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
  assert.equal(isEligibleNewJob(eligible, previousGeneratedAt, { schemaVersion: 1, jobs: {} }), true);
  assert.equal(isEligibleNewJob({ ...eligible, createdAt: previousGeneratedAt }, previousGeneratedAt, { schemaVersion: 1, jobs: {} }), false);
  assert.equal(isEligibleNewJob({ ...eligible, issueState: 'closed' }, previousGeneratedAt, { schemaVersion: 1, jobs: {} }), false);
  assert.equal(isEligibleNewJob({ ...eligible, sourceType: 'github-discussion' }, previousGeneratedAt, { schemaVersion: 1, jobs: {} }), false);
  assert.equal(isEligibleNewJob(eligible, previousGeneratedAt, {
    schemaVersion: 1,
    jobs: { [eligible.id]: { completedAt: '2026-08-20T11:00:00.000Z' } },
  }), false);
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
