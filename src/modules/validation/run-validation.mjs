import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { runDryRun } from '../../cli/dry-run.mjs';

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
import {
  buildLftpUploadScript,
  deployAndVerifyBridge,
} from '../deploy/lftp-client.mjs';
import { verifyPublicBridge } from '../deploy/public-verifier.mjs';
import {
  countGraphemes,
  formatSalary,
  formatSocialPost,
} from '../render/format-job.mjs';
import { createBridgeHtml } from '../render/html-page.mjs';
import { createSocialCardSvg, renderSocialCardPng } from '../render/social-card.mjs';
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
  const initialQueue = { schemaVersion: 1, items: [] };
  const first = enqueueJob(initialQueue, { job, snapshot, discoveredAt: '2026-08-20T13:01:00.000Z' });
  const second = enqueueJob(first, { job, snapshot, discoveredAt: '2026-08-20T13:05:00.000Z' });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].discoveredAt, '2026-08-20T13:01:00.000Z');
  assert.equal(second.items[0].bluesky.status, 'pending');
  assert.equal(second.items[0].mastodon.status, 'pending');

  const intake = { schemaVersion: 1, processedSnapshot: null, pendingBridges: [], removedJobs: [] };
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
  let queue = enqueueJob({ schemaVersion: 1, items: [] }, {
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
  let queue = { schemaVersion: 1, items: [] };
  queue = enqueueJob(queue, { job: oldJob, snapshot: snapshotReference(), discoveredAt: '2026-08-20T10:00:00.000Z' });
  queue = enqueueJob(queue, { job: newJob, snapshot: snapshotReference(), discoveredAt: '2026-08-20T12:30:00.000Z' });
  assert.equal(selectNextQueueItem(queue, '2026-08-20T14:00:00.000Z').jobId, newJob.id);
  assert.equal(selectNextQueueItem(queue, '2026-08-21T11:00:00.000Z').jobId, oldJob.id);
  const restarted = structuredClone(queue);
  assert.equal(selectNextQueueItem(restarted, '2026-08-21T11:00:00.000Z').jobId, oldJob.id);
});

validation('marks a closed queued job without publishing either channel', () => {
  const job = makeJob();
  let queue = enqueueJob({ schemaVersion: 1, items: [] }, {
    job,
    snapshot: snapshotReference(),
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  queue = markJobClosed(queue, job.id, '2026-08-20T13:30:00.000Z');
  assert.equal(queue.items[0].bridge.status, 'skipped_closed');
  assert.equal(queue.items[0].bluesky.status, 'skipped_closed');
  assert.equal(queue.items[0].mastodon.status, 'skipped_closed');
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
});

validation('bounds long Unicode card titles to three lines', () => {
  const job = makeJob({ title: '高性能ソフトウェアエンジニア🚀'.repeat(20) });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const svg = createSocialCardSvg(job, { wordmarkSvg });
  const titleLines = svg.match(/data-title-line="true"/g) ?? [];
  assert.ok(titleLines.length >= 1 && titleLines.length <= 3);
  assert.match(svg, /…/);
});

validation('dry run emits exactly the two deployable job files without state mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-social-dry-run-'));
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
      `jobs/${result.jobId}/opengraph-image.png`,
    ]);
    assert.equal(await readFile(fileURLToPath(new URL('../../../state/queue.json', import.meta.url)), 'utf8'), beforeState);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('builds a restricted atomic LFTP upload without recursive deletion', () => {
  const script = buildLftpUploadScript({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    htmlPath: '/tmp/job/index.html',
    imagePath: '/tmp/job/opengraph-image.png',
    ftp: {
      server: 'ftp.example.test',
      username: 'publisher',
      password: 'fixture-password',
      jobRoot: '/public_html/jobs',
    },
  });
  assert.doesNotMatch(script, /\bmirror\b|--delete|mrm|rm -r/);
  assert.match(script, /mkdir -p "\/public_html\/jobs\/gh_0123456789abcdef01234567"/);
  assert.ok(script.indexOf('put "/tmp/job/opengraph-image.png"') < script.indexOf('put "/tmp/job/index.html"'));
  assert.ok(script.indexOf('mv -f "/public_html/jobs/gh_0123456789abcdef01234567/.opengraph-image.') < script.indexOf('mv -f "/public_html/jobs/gh_0123456789abcdef01234567/.index.'));
  assert.throws(() => buildLftpUploadScript({
    jobId: '../escape',
    contentHash: 'a'.repeat(64),
    htmlPath: '/tmp/index.html',
    imagePath: '/tmp/image.png',
    ftp: { server: 'host', username: 'user', password: 'pass', jobRoot: '/public_html/jobs' },
  }), /Invalid job ID/);
  assert.throws(() => buildLftpUploadScript({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    htmlPath: '/tmp/index.html',
    imagePath: '/tmp/image.png',
    ftp: { server: 'host', username: 'user', password: 'pass', jobRoot: '/public_html/../secrets' },
  }), /job root/i);
  assert.throws(() => buildLftpUploadScript({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    htmlPath: '/tmp/index.html',
    imagePath: '/tmp/image.png',
    ftp: { server: 'host\nput /etc/passwd', username: 'user', password: 'pass', jobRoot: '/public_html/jobs' },
  }), /unsupported control/i);
});

validation('verifies public HTML metadata and exact PNG bytes', async () => {
  const job = makeJob();
  const html = createBridgeHtml(job);
  const png = await renderSocialCardPng(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const canonicalUrl = `https://openings.dev/jobs/${job.id}`;
  const imageUrl = `${canonicalUrl}/opengraph-image.png`;
  const fetchImpl = async (url) => {
    if (url === canonicalUrl) {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url === imageUrl) {
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
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

validation('skips matching bridges and deploys stale bridges exactly once', async () => {
  const calls = [];
  const matching = await deployAndVerifyBridge({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    expectedPngHash: 'b'.repeat(64),
    htmlPath: '/tmp/index.html',
    imagePath: '/tmp/image.png',
    ftp: { server: 'host', username: 'user', password: 'pass', jobRoot: '/public_html/jobs' },
    verifyPublic: async () => ({ matches: true }),
    runLftp: async () => calls.push('upload'),
  });
  assert.equal(matching.status, 'already_current');
  assert.deepEqual(calls, []);

  let verification = 0;
  const deployed = await deployAndVerifyBridge({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    expectedPngHash: 'b'.repeat(64),
    htmlPath: '/tmp/index.html',
    imagePath: '/tmp/image.png',
    ftp: { server: 'host', username: 'user', password: 'pass', jobRoot: '/public_html/jobs' },
    verifyPublic: async () => {
      verification += 1;
      return verification === 1 ? { matches: false, reason: 'not_found' } : { matches: true };
    },
    runLftp: async (script) => calls.push(script),
  });
  assert.equal(deployed.status, 'deployed');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /put/);

  await assert.rejects(
    deployAndVerifyBridge({
      jobId: 'gh_0123456789abcdef01234567',
      contentHash: 'a'.repeat(64),
      expectedPngHash: 'b'.repeat(64),
      htmlPath: '/tmp/index.html',
      imagePath: '/tmp/image.png',
      ftp: { server: 'host', username: 'user', password: 'super-secret', jobRoot: '/public_html/jobs' },
      verifyPublic: async () => ({ matches: false, reason: 'not_found' }),
      runLftp: async () => { throw new Error('super-secret leaked upstream'); },
    }),
    (error) => /FTP upload failed/.test(error.message) && !error.message.includes('super-secret'),
  );
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
