import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareNextOpeningsMediaOwner } from '../src/modules/publishing/openings-media-preparation.mjs';
import { enqueueJob } from '../src/modules/state/queue-operations.mjs';
import { validateQueueState } from '../src/modules/state/state-model.mjs';

const preparedAt = '2026-09-10T00:00:00.000Z';
const expiresAt = '2026-09-17T00:00:00.000Z';
const jobId = `gh_${'a'.repeat(24)}`;
const job = {
  id: jobId, sourceId: 'openings/jobs#1', sourceType: 'github-issue', issueState: 'open',
  title: 'Software Engineer', description: 'Build useful systems.', contentHash: 'b'.repeat(64),
  createdAt: '2026-09-09T12:00:00.000Z', updatedAt: '2026-09-09T12:00:00.000Z',
  repository: 'openings/jobs', url: 'https://github.com/openings/jobs/issues/1',
};
const snapshot = {
  schemaVersion: 4, commit: 'd'.repeat(40), generatedAt: preparedAt, dataHash: 'e'.repeat(64),
  jobsById: new Map([[jobId, job]]),
};
const metadata = {
  schemaVersion: 1, tenant: 'openings', jobId, entityRevision: job.contentHash,
  entityContentSha256: 'c'.repeat(64), latestGeneration: 2, bridge: null,
};

function queued({ story = false } = {}) {
  return enqueueJob({ schemaVersion: 3, items: [] }, {
    job, snapshot, discoveredAt: preparedAt,
    enabledChannels: story ? ['instagram'] : ['bluesky'], instagramStoryEnabled: story,
  });
}

function dependencies(calls, { story = false } = {}) {
  const descriptor = (role) => {
    const format = role === 'opengraph'
      ? ['opengraph', 'image/png', 1200, 630, '2', 'a']
      : role === 'instagram-feed'
        ? ['instagram-feed', 'image/jpeg', 1080, 1350, '7', 'b']
        : ['social-video', 'video/mp4', 1080, 1920, '8', 'f'];
    return { role: format[0], logicalArtifactId: format[0], sha256: format[5].repeat(64),
      byteSize: role === 'social-video' ? 300 : role === 'opengraph' ? 100 : 200,
      mediaType: format[1], width: format[2], height: format[3], renderVersion: format[4] };
  };
  return {
    readMetadata: async () => { calls.push('metadata'); return metadata; },
    readContent: async () => { calls.push('content'); return { ...job, description: 'Authoritative description.' }; },
    renderBridgeArtifacts: async (_job, { outputRoot }) => {
      calls.push(`render:${_job.description}`);
      const directory = join(outputRoot, 'jobs', jobId); await mkdir(directory, { recursive: true });
      const imagePath = join(directory, 'opengraph-image.png');
      const instagramJpegPath = join(directory, 'instagram-image.jpg');
      await Promise.all([writeFile(imagePath, 'png'), writeFile(instagramJpegPath, 'jpeg')]);
      return { imagePath, instagramJpegPath, instagramSvg: Buffer.from('<svg/>') };
    },
    renderReelVideo: async ({ outputDirectory }) => {
      calls.push('story');
      const videoPath = join(outputDirectory, 'social-video.mp4'); await writeFile(videoPath, 'mp4');
      return { videoPath };
    },
    describeMediaFile: async ({ role }) => descriptor(role),
    ...(story ? {} : { renderReelVideo: async () => assert.fail('Story must stay disabled') }),
  };
}

test('prepares one immutable owner, exact handoff, and checkpoint before archive_required', async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'openings-owner-preparation-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const calls = [];
  const result = await prepareNextOpeningsMediaOwner({
    queueState: queued(), currentSnapshot: snapshot, transport: { baseUrl: 'https://publishing.example',
      clientId: 'producer', secret: 'secret' }, gatewayOrigin: 'https://media.openings.dev',
    expiresAt, outputRoot, wordmarkSvg: '<svg/>', now: () => new Date(preparedAt),
    checkpoint: async ({ queueState }) => {
      calls.push('checkpoint');
      assert.equal(queueState.items[0].mediaOwner.requestDigest.length, 64);
    },
    dependencies: dependencies(calls),
  });
  assert.equal(result.outcome, 'archive_required');
  assert.equal(result.selectedJobId, jobId);
  assert.equal(result.requestDigest, result.mediaOwner.requestDigest);
  assert.equal(result.mediaOwner.generation, 3);
  assert.equal(result.mediaOwner.preparedAt, preparedAt);
  assert.equal(result.mediaOwner.expiresAt, expiresAt);
  assert.equal(result.mediaOwner.canonical.title, 'Software Engineer');
  assert.equal(result.mediaOwner.canonical.summary, 'Authoritative description.');
  assert.equal(result.mediaOwner.socialTitle, 'Software Engineer');
  assert.deepEqual(result.mediaOwner.files.map(({ role, fileName, renderVersion }) => ({ role, fileName, renderVersion })), [
    { role: 'opengraph', fileName: 'opengraph-image.png', renderVersion: '2' },
    { role: 'instagram-feed', fileName: 'instagram-image.jpg', renderVersion: '7' },
  ]);
  assert.deepEqual(calls, ['metadata', 'content', 'render:Authoritative description.', 'checkpoint']);
  assert.equal(result.preparationDirectory, join(outputRoot, 'openings-media-owner', result.requestDigest));
  assert.equal(result.handoffPath, join(result.preparationDirectory, 'handoff.json'));
  const handoff = JSON.parse(await readFile(result.handoffPath, 'utf8'));
  assert.deepEqual(handoff.envelope, result.mediaOwner.envelope);
  assert.deepEqual(handoff.uploads.map(({ reference }) => reference), result.mediaOwner.envelope.artifacts);
  assert.doesNotThrow(() => validateQueueState(result.queueState));
  const injected = structuredClone(result.queueState);
  injected.items[0].mediaOwner.files[0].sha256 = 'f'.repeat(64);
  assert.throws(() => validateQueueState(injected), /owner contract/u);
});

test('returns the exact saved owner before source, transport, wordmark, or files are needed', async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'openings-owner-resume-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const first = await prepareNextOpeningsMediaOwner({
    queueState: queued(), currentSnapshot: snapshot, transport: { baseUrl: 'https://publishing.example',
      clientId: 'producer', secret: 'secret' }, gatewayOrigin: 'https://media.openings.dev', expiresAt,
    outputRoot, wordmarkSvg: '<svg/>', now: () => new Date(preparedAt), checkpoint: async () => {},
    dependencies: dependencies([]),
  });
  await rm(first.preparationDirectory, { recursive: true, force: true });
  const reloadedQueue = JSON.parse(JSON.stringify(first.queueState));
  const resumed = await prepareNextOpeningsMediaOwner({
    queueState: reloadedQueue,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
    dependencies: new Proxy({}, { get: () => () => assert.fail('resume must not call dependencies') }),
  });
  assert.equal(resumed.outcome, 'resume_needed');
  assert.equal(resumed.requestDigest, first.requestDigest);
  assert.deepEqual(resumed.mediaOwner, first.mediaOwner);
  assert.deepEqual(resumed.queueState, reloadedQueue);
});

test('requires the existing Story MP4 and preserves checkpoint failures without a returned state', async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'openings-owner-story-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const calls = [];
  let persistedQueue;
  await assert.rejects(prepareNextOpeningsMediaOwner({
    queueState: queued({ story: true }), currentSnapshot: snapshot,
    transport: { baseUrl: 'https://publishing.example', clientId: 'producer', secret: 'secret' },
    gatewayOrigin: 'https://media.openings.dev', expiresAt, outputRoot, wordmarkSvg: '<svg/>',
    now: () => new Date(preparedAt), checkpoint: async ({ queueState }) => {
      persistedQueue = structuredClone(queueState);
      throw new Error('queue checkpoint failed');
    },
    dependencies: dependencies(calls, { story: true }),
  }), /queue checkpoint failed/u);
  assert.deepEqual(calls, ['metadata', 'content', 'render:Authoritative description.', 'story']);
  const savedOwner = persistedQueue.items[0].mediaOwner;
  const finalized = join(outputRoot, 'openings-media-owner', savedOwner.requestDigest);
  assert.deepEqual(JSON.parse(await readFile(join(finalized, 'handoff.json'), 'utf8')).envelope, savedOwner.envelope);
  const resumed = await prepareNextOpeningsMediaOwner({
    queueState: persistedQueue,
    now: () => new Date('2026-09-20T00:00:00.000Z'),
    dependencies: new Proxy({}, { get: () => () => assert.fail('resume must not call dependencies') }),
  });
  assert.equal(resumed.outcome, 'resume_needed');
  assert.equal(resumed.requestDigest, savedOwner.requestDigest);
});

test('accepts an unchanged queued job from a newer committed snapshot without rebinding its historical provenance', async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'openings-owner-newer-snapshot-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const newerSnapshot = {
    ...snapshot,
    commit: '1'.repeat(40),
    dataHash: '2'.repeat(64),
    jobsById: new Map([[jobId, { ...job, description: 'Incidental snapshot metadata changed.' }]]),
  };
  const result = await prepareNextOpeningsMediaOwner({
    queueState: queued(), currentSnapshot: newerSnapshot,
    transport: { baseUrl: 'https://publishing.example', clientId: 'producer', secret: 'secret' },
    gatewayOrigin: 'https://media.openings.dev', expiresAt, outputRoot, wordmarkSvg: '<svg/>',
    now: () => new Date(preparedAt), checkpoint: async () => {}, dependencies: dependencies([]),
  });
  assert.equal(result.outcome, 'archive_required');
  assert.equal(result.mediaOwner.dataCommit, snapshot.commit);
  assert.equal(result.mediaOwner.dataHash, snapshot.dataHash);
  assert.equal(result.mediaOwner.contentHash, job.contentHash);
});

test('rejects owner state injection and a changed authoritative source', async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'openings-owner-invalid-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  await assert.rejects(prepareNextOpeningsMediaOwner({
    queueState: queued(), currentSnapshot: snapshot,
    transport: { baseUrl: 'https://publishing.example', clientId: 'producer', secret: 'secret' },
    gatewayOrigin: 'https://media.openings.dev', expiresAt, outputRoot, wordmarkSvg: '<svg/>',
    now: () => new Date(preparedAt), checkpoint: async () => {},
    dependencies: { ...dependencies([]), readContent: async () => ({ ...job, sourceId: 'changed' }) },
  }), /identity|source/u);
});

test('never overwrites or removes a pre-existing digest preparation directory', async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'openings-owner-existing-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const first = await prepareNextOpeningsMediaOwner({
    queueState: queued(), currentSnapshot: snapshot,
    transport: { baseUrl: 'https://publishing.example', clientId: 'producer', secret: 'secret' },
    gatewayOrigin: 'https://media.openings.dev', expiresAt, outputRoot, wordmarkSvg: '<svg/>',
    now: () => new Date(preparedAt), checkpoint: async () => {}, dependencies: dependencies([]),
  });
  const sentinel = join(first.preparationDirectory, 'sentinel');
  await writeFile(sentinel, 'keep');
  await assert.rejects(prepareNextOpeningsMediaOwner({
    queueState: queued(), currentSnapshot: snapshot,
    transport: { baseUrl: 'https://publishing.example', clientId: 'producer', secret: 'secret' },
    gatewayOrigin: 'https://media.openings.dev', expiresAt, outputRoot, wordmarkSvg: '<svg/>',
    now: () => new Date(preparedAt), checkpoint: async () => {}, dependencies: dependencies([]),
  }), /exist|EEXIST/u);
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});

test('rejects invalid expiry and generation overflow before rendering or checkpointing', async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'openings-owner-limits-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  for (const invalidExpiry of [preparedAt, '2026-09-17T00:00:00.001Z', '2026-09-17T00:00:00Z']) {
    const calls = [];
    await assert.rejects(prepareNextOpeningsMediaOwner({
      queueState: queued(), currentSnapshot: snapshot,
      transport: { baseUrl: 'https://publishing.example', clientId: 'producer', secret: 'secret' },
      gatewayOrigin: 'https://media.openings.dev', expiresAt: invalidExpiry, outputRoot, wordmarkSvg: '<svg/>',
      now: () => new Date(preparedAt), checkpoint: async () => { calls.push('checkpoint'); },
      dependencies: dependencies(calls),
    }), /expiry/u);
    assert.deepEqual(calls, []);
  }
  const calls = [];
  await assert.rejects(prepareNextOpeningsMediaOwner({
    queueState: queued(), currentSnapshot: snapshot,
    transport: { baseUrl: 'https://publishing.example', clientId: 'producer', secret: 'secret' },
    gatewayOrigin: 'https://media.openings.dev', expiresAt, outputRoot, wordmarkSvg: '<svg/>',
    now: () => new Date(preparedAt), checkpoint: async () => { calls.push('checkpoint'); },
    dependencies: { ...dependencies(calls), readMetadata: async () => ({
      ...metadata, latestGeneration: Number.MAX_SAFE_INTEGER,
    }) },
  }), /overflow/u);
  assert.deepEqual(calls, []);
});

test('preserves an established title, artwork, receipts, and historical owner after current queue revision changes', async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'openings-owner-established-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const existing = queued();
  existing.items[0].visualDirection = 'peach';
  existing.items[0].bridge.result = { socialTitle: 'Established Engineer', legacyRemoteId: 'keep' };
  existing.items[0].bluesky = { ...existing.items[0].bluesky, status: 'retryable', attempts: 1,
    updatedAt: preparedAt, lastError: { code: 'provider', at: preparedAt }, result: { id: 'prior-intent' } };
  const priorReceipt = structuredClone(existing.items[0].bluesky);
  const deps = dependencies([]);
  deps.renderBridgeArtifacts = async (renderedJob, { outputRoot: temporary }) => {
    assert.equal(renderedJob.socialTitle, 'Established Engineer');
    const directory = join(temporary, 'jobs', jobId); await mkdir(directory, { recursive: true });
    const imagePath = join(directory, 'opengraph-image.png');
    const instagramJpegPath = join(directory, 'instagram-image.jpg');
    await Promise.all([writeFile(imagePath, 'png'), writeFile(instagramJpegPath, 'jpeg')]);
    return { imagePath, instagramJpegPath, instagramSvg: '<svg/>' };
  };
  const result = await prepareNextOpeningsMediaOwner({
    queueState: existing, currentSnapshot: snapshot,
    transport: { baseUrl: 'https://publishing.example', clientId: 'producer', secret: 'secret' },
    gatewayOrigin: 'https://media.openings.dev', expiresAt, outputRoot, wordmarkSvg: '<svg/>',
    now: () => new Date(preparedAt), checkpoint: async () => {}, dependencies: deps,
  });
  assert.equal(result.mediaOwner.socialTitle, 'Established Engineer');
  assert.equal(result.mediaOwner.canonical.title, 'Established Engineer');
  assert.equal(result.mediaOwner.direction, 'peach');
  assert.deepEqual(result.queueState.items[0].bluesky, priorReceipt);
  const historical = structuredClone(result.queueState);
  historical.items[0].contentHash = 'f'.repeat(64);
  historical.items[0].dataCommit = '1'.repeat(40);
  historical.items[0].dataHash = '2'.repeat(64);
  assert.doesNotThrow(() => validateQueueState(historical));
  assert.deepEqual(historical.items[0].mediaOwner, result.mediaOwner);
});

test('fails closed when required Story output is absent or finalized bytes change', async (t) => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'openings-owner-proof-failure-'));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const failedStory = queued({ story: true });
  failedStory.items[0].instagramStory = { status: 'failed', attempts: 3, updatedAt: preparedAt,
    lastError: { code: 'provider', at: preparedAt }, lastReset: null, result: null };
  await assert.rejects(prepareNextOpeningsMediaOwner({
    queueState: failedStory, currentSnapshot: snapshot,
    transport: { baseUrl: 'https://publishing.example', clientId: 'producer', secret: 'secret' },
    gatewayOrigin: 'https://media.openings.dev', expiresAt, outputRoot, wordmarkSvg: '<svg/>',
    now: () => new Date(preparedAt), checkpoint: async () => {},
    dependencies: { ...dependencies([], { story: true }), renderReelVideo: async () => ({}) },
  }), /Story media/u);
  let descriptions = 0;
  await assert.rejects(prepareNextOpeningsMediaOwner({
    queueState: queued(), currentSnapshot: snapshot,
    transport: { baseUrl: 'https://publishing.example', clientId: 'producer', secret: 'secret' },
    gatewayOrigin: 'https://media.openings.dev', expiresAt, outputRoot, wordmarkSvg: '<svg/>',
    now: () => new Date(preparedAt), checkpoint: async () => assert.fail('invalid files must not checkpoint'),
    dependencies: { ...dependencies([]), describeMediaFile: async ({ role }) => {
      descriptions += 1;
      const format = role === 'opengraph' ? ['image/png', 1200, 630, '2'] : ['image/jpeg', 1080, 1350, '7'];
      return { role, logicalArtifactId: role, sha256: (descriptions > 2 ? 'f' : 'a').repeat(64),
        byteSize: 100, mediaType: format[0], width: format[1], height: format[2], renderVersion: format[3] };
    } },
  }), /changed after finalization/u);
});
