import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPublication } from '../src/cli/publish.mjs';
import { processOnePublication } from '../src/modules/publishing/orchestrator.mjs';
import { decideScheduledWork } from '../src/modules/publishing/scheduled-work.mjs';
import { enqueueJob } from '../src/modules/state/queue-operations.mjs';

const now = '2026-09-08T12:00:00.000Z';
const job = Object.freeze({
  id: 'gh_0123456789abcdef01234567',
  sourceId: 'openings-fixtures/jobs#42',
  title: 'Senior TypeScript Engineer',
  description: 'Build reliable developer tools.',
  issueState: 'open',
  contentHash: '5'.repeat(64),
  repository: 'openings-fixtures/jobs',
  createdAt: '2026-08-20T12:00:00.000Z',
  updatedAt: '2026-08-20T12:00:00.000Z',
  url: 'https://github.com/openings-fixtures/jobs/issues/42',
  sourceType: 'github-issue',
});
const canonicalUrl = `https://openings.dev/jobs/${job.id}`;
const snapshot = Object.freeze({
  commit: '7'.repeat(40),
  generatedAt: '2026-09-01T13:00:00.000Z',
  dataHash: '7'.repeat(64),
  jobsById: new Map([[job.id, job]]),
});

function publications(jobs = {}) {
  return { schemaVersion: 3, jobs };
}

function queued(enabledChannels) {
  let queue = enqueueJob({ schemaVersion: 3, items: [] }, {
    job,
    snapshot,
    discoveredAt: now,
    enabledChannels,
  });
  queue.items[0].bridge = {
    ...queue.items[0].bridge,
    status: 'published',
    attempts: 1,
    updatedAt: now,
    result: {
      status: 'deployed',
      instagramImageUrl: `${canonicalUrl}/instagram-image.jpg?v=7.fixture`,
      completedBufferIds: ['buffer-one'],
      scheduledBufferIds: ['buffer-two'],
      nested: { preserved: true },
      visualDirection: 'night',
      instagramCardVersion: '7',
      socialVideoVersion: '8',
    },
  };
  queue.items[0].visualDirection = 'night';
  queue.items[0].visualSequence = 0;
  return queue;
}

function baseInput(queueState, overrides = {}) {
  const forbidden = async () => assert.fail('unexpected publisher call');
  return {
    queueState,
    publicationsState: publications(),
    currentSnapshot: snapshot,
    publishBridge: forbidden,
    publishBluesky: forbidden,
    publishMastodon: forbidden,
    publishTwitter: forbidden,
    publishThreads: forbidden,
    publishInstagram: forbidden,
    publishLinkedIn: forbidden,
    now,
    ...overrides,
  };
}

test('awaits intent and receipt checkpoints around each provider in channel order', async () => {
  const events = [];
  const result = await processOnePublication(baseInput(queued(['bluesky', 'mastodon']), {
    publishBluesky: async () => { events.push('provider:bluesky'); return { id: 'bsky-one' }; },
    publishMastodon: async () => { events.push('provider:mastodon'); return { id: 'masto-one' }; },
    checkpoint: async ({ phase, stage, queueState }) => {
      events.push(`${phase}:${stage}`);
      assert.equal(queueState.items[0][stage].status, phase === 'intent' ? 'publishing' : 'published');
    },
  }));

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(events, [
    'intent:bluesky', 'provider:bluesky', 'receipt:bluesky',
    'intent:mastodon', 'provider:mastodon', 'receipt:mastodon',
  ]);
});

test('checkpoint failures propagate and halt providers while ordinary provider failures continue', async () => {
  let providerCalls = 0;
  await assert.rejects(processOnePublication(baseInput(queued(['bluesky', 'mastodon']), {
    publishBluesky: async () => { providerCalls += 1; return { id: 'never' }; },
    publishMastodon: async () => { providerCalls += 1; return { id: 'never' }; },
    checkpoint: async ({ phase, stage }) => {
      if (phase === 'intent' && stage === 'bluesky') throw new Error('storage unavailable');
    },
  })), /storage unavailable/);
  assert.equal(providerCalls, 0);

  const events = [];
  await assert.rejects(processOnePublication(baseInput(queued(['bluesky', 'mastodon']), {
    publishBluesky: async () => { events.push('provider:bluesky'); return { id: 'remote-one' }; },
    publishMastodon: async () => { events.push('provider:mastodon'); return { id: 'never' }; },
    checkpoint: async ({ phase, stage }) => {
      events.push(`${phase}:${stage}`);
      if (phase === 'receipt' && stage === 'bluesky') throw new Error('receipt storage unavailable');
    },
  })), /receipt storage unavailable/);
  assert.deepEqual(events, ['intent:bluesky', 'provider:bluesky', 'receipt:bluesky']);

  const continued = [];
  const result = await processOnePublication(baseInput(queued(['bluesky', 'mastodon']), {
    publishBluesky: async () => { continued.push('bluesky'); throw new Error('provider down'); },
    publishMastodon: async () => { continued.push('mastodon'); return { id: 'masto-two' }; },
    checkpoint: async () => {},
  }));
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(continued, ['bluesky', 'mastodon']);
});

test('serializes an image intent before provider access and resumes only in reconciliation mode', async () => {
  let durableIntent;
  let providerCalls = 0;
  await assert.rejects(processOnePublication(baseInput(queued(['instagram']), {
    publishInstagram: async () => { providerCalls += 1; return { id: 'must-not-run' }; },
    checkpoint: async ({ phase, stage, queueState }) => {
      if (phase === 'intent' && stage === 'instagram') {
        durableIntent = JSON.parse(JSON.stringify(queueState));
        throw new Error('interrupt after intent');
      }
    },
  })), /interrupt after intent/);
  assert.equal(providerCalls, 0);
  assert.deepEqual(durableIntent.items[0].instagram.result, {
    mediaKind: 'image',
    canonicalUrl,
  });

  const result = await processOnePublication(baseInput(JSON.parse(JSON.stringify(durableIntent)), {
    publishInstagram: async ({ reconcileOnly, queueItem, post }) => {
      providerCalls += 1;
      assert.equal(reconcileOnly, true);
      assert.equal(post.canonicalUrl, canonicalUrl);
      assert.deepEqual(queueItem.instagram.result, { mediaKind: 'image', canonicalUrl });
      return { status: 'reconciled', id: 'instagram-one', url: 'https://www.instagram.com/p/one/' };
    },
    checkpoint: async () => {},
  }));

  assert.equal(providerCalls, 1);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.queueState.items[0].instagram.result, {
    mediaKind: 'image',
    canonicalUrl,
    status: 'reconciled',
    id: 'instagram-one',
    url: 'https://www.instagram.com/p/one/',
  });
});

test('a provider receipt interrupted before its durable checkpoint resumes from the prior image intent', async () => {
  let durableIntent;
  let firstProviderCalls = 0;
  await assert.rejects(processOnePublication(baseInput(queued(['instagram']), {
    publishInstagram: async () => {
      firstProviderCalls += 1;
      return { id: 'provider-returned' };
    },
    checkpoint: async ({ phase, stage, queueState }) => {
      if (stage !== 'instagram') return;
      if (phase === 'intent') durableIntent = JSON.parse(JSON.stringify(queueState));
      if (phase === 'receipt') throw new Error('receipt push failed');
    },
  })), /receipt push failed/);
  assert.equal(firstProviderCalls, 1);
  assert.equal(durableIntent.items[0].instagram.status, 'publishing');

  let recoveryCalls = 0;
  const recovered = await processOnePublication(baseInput(durableIntent, {
    publishInstagram: async ({ reconcileOnly }) => {
      recoveryCalls += 1;
      assert.equal(reconcileOnly, true);
      return { status: 'reconciled', id: 'provider-returned' };
    },
    checkpoint: async () => {},
  }));
  assert.equal(recoveryCalls, 1);
  assert.equal(recovered.queueState.items[0].instagram.result.id, 'provider-returned');
});

test('an ambiguous image is a terminal review hold and does not block a later channel', async () => {
  const queue = queued(['instagram', 'linkedin']);
  const unaffectedBefore = structuredClone({
    bridge: queue.items[0].bridge,
    instagramStory: queue.items[0].instagramStory,
  });
  let linkedinCalls = 0;
  const result = await processOnePublication(baseInput(queue, {
    publishInstagram: async () => {
      const error = new Error('safe review hold');
      error.code = 'instagram_image_ambiguous';
      throw error;
    },
    publishLinkedIn: async () => { linkedinCalls += 1; return { id: 'linkedin-one' }; },
    checkpoint: async () => {},
  }));

  assert.equal(result.queueState.items[0].instagram.status, 'failed');
  assert.equal(result.queueState.items[0].instagram.lastError.code, 'instagram_image_ambiguous');
  assert.equal(linkedinCalls, 1);
  assert.deepEqual({
    bridge: result.queueState.items[0].bridge,
    instagramStory: result.queueState.items[0].instagramStory,
  }, unaffectedBefore);
});

test('preserves Mastodon execution ownership and accepted IDs through intent, failure, and success', async () => {
  const queue = queued(['mastodon']);
  queue.items[0].mastodon.result = {
    executionOwner: 'cloudflare',
    platformPublicationId: 'accepted-one',
  };
  const failed = await processOnePublication(baseInput(queue, {
    publishMastodon: async () => {
      const error = new Error('still pending');
      error.platformPublicationId = 'accepted-two';
      throw error;
    },
    checkpoint: async () => {},
  }));
  assert.deepEqual(failed.queueState.items[0].mastodon.result, {
    executionOwner: 'cloudflare',
    platformPublicationId: 'accepted-two',
  });

  const retry = structuredClone(failed.queueState);
  const succeeded = await processOnePublication(baseInput(retry, {
    publishMastodon: async () => ({ id: 'mastodon-remote', url: 'https://mastodon.social/@openingshq/1' }),
    checkpoint: async () => {},
  }));
  assert.deepEqual(succeeded.queueState.items[0].mastodon.result, {
    executionOwner: 'cloudflare',
    platformPublicationId: 'accepted-two',
    id: 'mastodon-remote',
    url: 'https://mastodon.social/@openingshq/1',
  });
});

test('repairs a missing ledger entry from durable completed queue receipts without provider calls', async () => {
  const queue = queued(['bluesky']);
  queue.items[0].bluesky = {
    ...queue.items[0].bluesky,
    status: 'published',
    attempts: 1,
    updatedAt: now,
    result: { id: 'bsky-durable' },
  };
  const existingId = 'gh_aaaaaaaaaaaaaaaaaaaaaaaa';
  const existing = Object.freeze({ status: 'completed', preserved: { byteShape: true }, linkedin: null, twitter: null });
  const result = await processOnePublication(baseInput(queue, {
    publicationsState: publications({ [existingId]: existing }),
  }));

  assert.equal(result.outcome, 'idle');
  assert.strictEqual(result.publicationsState.jobs[existingId], existing);
  assert.equal(result.publicationsState.jobs[job.id].bluesky.id, 'bsky-durable');
});

test('failure and image recovery leave every unrelated partial-success receipt deeply unchanged', async () => {
  const queue = queued(['bluesky', 'mastodon', 'twitter', 'threads', 'instagram', 'linkedin']);
  const item = queue.items[0];
  item.bluesky = { ...item.bluesky, status: 'published', attempts: 1, updatedAt: now, result: { id: 'bsky-one', nested: { value: 1 } } };
  item.mastodon = { ...item.mastodon, status: 'published', attempts: 1, updatedAt: now, result: {
    executionOwner: 'cloudflare', platformPublicationId: 'platform-one', id: 'masto-one',
  } };
  item.twitter = { ...item.twitter, status: 'published', attempts: 1, updatedAt: now, result: {
    id: 'twitter-one', completedBufferIds: ['complete-one'], scheduledBufferIds: ['scheduled-one'],
  } };
  item.threads = { ...item.threads, status: 'published', attempts: 1, updatedAt: now, result: { id: 'threads-one' } };
  item.linkedin = { ...item.linkedin, status: 'published', attempts: 1, updatedAt: now, result: {
    id: 'linkedin-one', completedBufferIds: ['complete-two'], scheduledBufferIds: ['scheduled-two'],
  } };
  item.instagramStory = { ...item.instagramStory, status: 'published', attempts: 1, updatedAt: now, result: {
    id: 'story-existing', url: 'https://www.instagram.com/stories/openingshq/1/',
  } };
  const unaffected = structuredClone({
    bridge: item.bridge,
    bluesky: item.bluesky,
    mastodon: item.mastodon,
    twitter: item.twitter,
    threads: item.threads,
    linkedin: item.linkedin,
    instagramStory: item.instagramStory,
  });
  const existingId = 'gh_bbbbbbbbbbbbbbbbbbbbbbbb';
  const existingLedger = { status: 'completed', linkedin: null, twitter: null, nested: { unchanged: true } };

  const failed = await processOnePublication(baseInput(queue, {
    publicationsState: publications({ [existingId]: existingLedger }),
    publishInstagram: async () => {
      const error = new Error('container unavailable');
      error.code = 'instagram_container';
      throw error;
    },
    checkpoint: async () => {},
  }));
  assert.equal(failed.queueState.items[0].instagram.status, 'retryable');
  assert.deepEqual({
    bridge: failed.queueState.items[0].bridge,
    bluesky: failed.queueState.items[0].bluesky,
    mastodon: failed.queueState.items[0].mastodon,
    twitter: failed.queueState.items[0].twitter,
    threads: failed.queueState.items[0].threads,
    linkedin: failed.queueState.items[0].linkedin,
    instagramStory: failed.queueState.items[0].instagramStory,
  }, unaffected);
  assert.strictEqual(failed.publicationsState.jobs[existingId], existingLedger);

  const resumed = await processOnePublication(baseInput(JSON.parse(JSON.stringify(failed.queueState)), {
    publicationsState: failed.publicationsState,
    publishInstagram: async () => ({ id: 'instagram-recovered' }),
    checkpoint: async () => {},
  }));
  assert.equal(resumed.outcome, 'completed');
  assert.deepEqual({
    bridge: resumed.queueState.items[0].bridge,
    bluesky: resumed.queueState.items[0].bluesky,
    mastodon: resumed.queueState.items[0].mastodon,
    twitter: resumed.queueState.items[0].twitter,
    threads: resumed.queueState.items[0].threads,
    linkedin: resumed.queueState.items[0].linkedin,
    instagramStory: resumed.queueState.items[0].instagramStory,
  }, unaffected);
  assert.deepEqual(resumed.publicationsState.jobs[job.id].instagram, {
    mediaKind: 'image', canonicalUrl, id: 'instagram-recovered',
  });
  assert.strictEqual(resumed.publicationsState.jobs[existingId], existingLedger);
});

test('an interrupted image missing from the snapshot becomes an explicit review hold', async () => {
  const queue = queued(['instagram']);
  queue.items[0].instagram = {
    ...queue.items[0].instagram,
    status: 'publishing',
    attempts: 1,
    updatedAt: now,
    result: { mediaKind: 'image', canonicalUrl },
  };
  const emptySnapshot = { ...snapshot, jobsById: new Map() };

  const result = await processOnePublication(baseInput(queue, { currentSnapshot: emptySnapshot }));

  assert.equal(result.queueState.items[0].instagram.status, 'failed');
  assert.equal(result.queueState.items[0].instagram.lastError.code, 'instagram_image_ambiguous');
  assert.deepEqual(result.queueState.items[0].instagram.result, { mediaKind: 'image', canonicalUrl });
  assert.notEqual(result.queueState.items[0].instagram.status, 'skipped_closed');
});

test('scheduled preflight runs for a lone interrupted image without making publishing globally ready', () => {
  const queue = queued(['instagram']);
  queue.items[0].instagram = {
    ...queue.items[0].instagram,
    status: 'publishing',
    attempts: 1,
    updatedAt: now,
    result: { mediaKind: 'image', canonicalUrl },
  };
  const intakeState = {
    schemaVersion: 3,
    processedSnapshot: { commit: snapshot.commit, generatedAt: snapshot.generatedAt, dataHash: snapshot.dataHash },
    pendingBridges: [],
    removedJobs: [],
  };

  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    intakeState,
    queueState: queue,
    currentDataHash: snapshot.dataHash,
  }), { shouldRun: true, reason: 'queued', queueDepth: 1 });

  queue.items[0].instagram.result = null;
  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    intakeState,
    queueState: queue,
    currentDataHash: snapshot.dataHash,
  }), { shouldRun: false, reason: 'up_to_date', queueDepth: 0 });
});

test('the CLI atomically saves each queue transition before its injected durable Git checkpoint', async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'openings-publication-checkpoint-'));
  const stateDirectory = join(repositoryRoot, 'state');
  await mkdir(stateDirectory);
  await Promise.all([
    writeFile(join(stateDirectory, 'queue.json'), JSON.stringify({ schemaVersion: 3, items: [] })),
    writeFile(join(stateDirectory, 'publications.json'), JSON.stringify(publications())),
  ]);
  const durableStates = [];
  let factoryInput;
  const env = {
    WEB_DEPLOY_TOKEN: 'deploy-secret',
    BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
    BLUESKY_APP_PASSWORD: 'bluesky-secret',
    MASTODON_ACCESS_TOKEN: 'mastodon-secret',
    BUFFER_API_KEY: 'buffer-secret',
    BUFFER_ORGANIZATION_ID: '68b68d3ac159685850cf2b8d',
    BUFFER_TWITTER_CHANNEL_ID: '68b68e0fc159685850cf2c22',
    STATE_GIT_CHECKPOINT_ENABLED: 'true',
    STATE_GIT_REMOTE: 'origin',
    STATE_REF: 'main',
  };

  const result = await runPublication({
    request: { mode: 'controlled', jobId: job.id, confirmation: 'PUBLISH_ONE_JOB' },
    repositoryRoot,
    dataRepositoryPath: '/fixture/data',
    stateDirectory,
    wordmarkPath: '/fixture/wordmark.svg',
    outputPath: join(repositoryRoot, 'output'),
    env,
    log: () => {},
    dependencies: {
      resolveGitCommit: async () => snapshot.commit,
      loadCanonicalWordmark: async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      loadSnapshot: async () => snapshot,
      createBridgePublisher: () => async () => ({
        status: 'deployed',
        visualDirection: 'night',
        instagramCardVersion: '7',
        socialVideoVersion: '8',
      }),
      publishBluesky: async () => ({ id: 'bsky-cli' }),
      publishMastodon: async () => ({ id: 'masto-cli' }),
      publishTwitter: async () => ({ id: 'twitter-cli' }),
      createQueueGitCheckpoint: (input) => {
        factoryInput = input;
        return async ({ phase, stage }) => {
          const saved = JSON.parse(await readFile(join(stateDirectory, 'queue.json'), 'utf8'));
          durableStates.push({ phase, stage, status: saved.items[0][stage].status });
        };
      },
    },
  });

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(factoryInput, {
    repositoryRoot,
    queuePath: join(stateDirectory, 'queue.json'),
    remote: 'origin',
    stateRef: 'main',
  });
  assert.deepEqual(durableStates, [
    { phase: 'intent', stage: 'bridge', status: 'publishing' },
    { phase: 'receipt', stage: 'bridge', status: 'published' },
    { phase: 'intent', stage: 'bluesky', status: 'publishing' },
    { phase: 'receipt', stage: 'bluesky', status: 'published' },
    { phase: 'intent', stage: 'mastodon', status: 'publishing' },
    { phase: 'receipt', stage: 'mastodon', status: 'published' },
    { phase: 'intent', stage: 'twitter', status: 'publishing' },
    { phase: 'receipt', stage: 'twitter', status: 'published' },
  ]);
});
