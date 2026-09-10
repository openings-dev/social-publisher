import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPublication } from '../src/cli/publish.mjs';
import { runPreflight } from '../src/cli/preflight.mjs';
import { publishImageToInstagram } from '../src/modules/networks/instagram-client.mjs';
import { processOnePublication } from '../src/modules/publishing/orchestrator.mjs';
import { decideScheduledWork } from '../src/modules/publishing/scheduled-work.mjs';
import { enqueueJob, resetFailedStage } from '../src/modules/state/queue-operations.mjs';

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
    checkpoint: async ({ phase, stage }) => { continued.push(`${phase}:${stage}`); },
  }));
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(continued, [
    'intent:bluesky', 'bluesky', 'failure:bluesky',
    'intent:mastodon', 'mastodon', 'receipt:mastodon',
  ]);

  const stopped = [];
  await assert.rejects(processOnePublication(baseInput(queued(['bluesky', 'mastodon']), {
    publishBluesky: async () => { stopped.push('bluesky'); throw new Error('provider down'); },
    publishMastodon: async () => { stopped.push('mastodon'); return { id: 'must-not-run' }; },
    checkpoint: async ({ phase, stage }) => {
      stopped.push(`${phase}:${stage}`);
      if (phase === 'failure') throw new Error('failure checkpoint unavailable');
    },
  })), /failure checkpoint unavailable/);
  assert.deepEqual(stopped, ['intent:bluesky', 'bluesky', 'failure:bluesky']);
});

test('a bridge failure is durable before its outcome returns or any channel starts', async () => {
  const queue = queued(['bluesky']);
  queue.items[0].bridge = {
    status: 'pending', attempts: 0, updatedAt: null, lastError: null, lastReset: null, result: null,
  };
  const events = [];
  await assert.rejects(processOnePublication(baseInput(queue, {
    publishBridge: async () => { events.push('provider:bridge'); throw new Error('deploy failed'); },
    publishBluesky: async () => { events.push('provider:bluesky'); return { id: 'must-not-run' }; },
    checkpoint: async ({ phase, stage, queueState }) => {
      events.push(`${phase}:${stage}`);
      if (phase === 'failure') {
        assert.equal(queueState.items[0].bridge.status, 'retryable');
        throw new Error('bridge failure checkpoint unavailable');
      }
    },
  })), /bridge failure checkpoint unavailable/);
  assert.deepEqual(events, ['intent:bridge', 'provider:bridge', 'failure:bridge']);
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
    publicationKind: 'image',
    canonicalUrl,
  });

  const result = await processOnePublication(baseInput(JSON.parse(JSON.stringify(durableIntent)), {
    publishInstagram: async ({ reconcileOnly, queueItem, post }) => {
      providerCalls += 1;
      assert.equal(reconcileOnly, true);
      assert.equal(post.canonicalUrl, canonicalUrl);
      assert.deepEqual(queueItem.instagram.result, { publicationKind: 'image', canonicalUrl });
      return { status: 'reconciled', id: 'instagram-one', url: 'https://www.instagram.com/p/one/' };
    },
    checkpoint: async () => {},
  }));

  assert.equal(providerCalls, 1);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.queueState.items[0].instagram.result, {
    publicationKind: 'image',
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

test('an interrupted image recovery error cannot fall through to a fresh attempt in the same invocation', async () => {
  const queue = queued(['instagram']);
  queue.items[0].instagram = {
    ...queue.items[0].instagram,
    status: 'publishing',
    attempts: 1,
    updatedAt: now,
    result: { publicationKind: 'image', canonicalUrl },
  };
  const modes = [];
  const result = await processOnePublication(baseInput(queue, {
    publishInstagram: async ({ reconcileOnly }) => {
      modes.push(reconcileOnly);
      const error = new Error('temporary adapter failure');
      error.code = 'instagram_provider';
      throw error;
    },
    checkpoint: async () => {},
  }));
  assert.deepEqual(modes, [true]);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.queueState.items[0].instagram.status, 'failed');
  assert.equal(result.queueState.items[0].instagram.lastError.code, 'instagram_image_ambiguous');
});

test('an interrupted real-adapter configuration error remains a terminal hold across JSON reload', async () => {
  const queue = queued(['instagram']);
  const priorIntent = { publicationKind: 'image', canonicalUrl };
  queue.items[0].instagram = {
    ...queue.items[0].instagram,
    status: 'publishing',
    attempts: 1,
    updatedAt: now,
    result: priorIntent,
  };
  const adapter = ({ job: selectedJob, post, queueItem, reconcileOnly, apiVersion, fetchImpl }) => (
    publishImageToInstagram({
      job: selectedJob,
      post,
      imageUrl: queueItem.bridge.result.instagramImageUrl,
      accessToken: 'instagram-secret',
      userId: '17841400000000000',
      apiVersion,
      fetchImpl,
      reconcileOnly,
      sleep: async () => {},
    })
  );

  const first = await processOnePublication(baseInput(queue, {
    publishInstagram: (input) => adapter({ ...input, apiVersion: 'invalid-version', fetchImpl: async () => {
      assert.fail('invalid configuration must fail before provider access');
    } }),
    checkpoint: async () => {},
  }));
  assert.equal(first.queueState.items[0].instagram.status, 'failed');
  assert.equal(first.queueState.items[0].instagram.lastError.code, 'instagram_image_ambiguous');
  assert.deepEqual(first.queueState.items[0].instagram.result, priorIntent);

  const stateDirectory = await mkdtemp(join(tmpdir(), 'openings-image-review-hold-'));
  const queueBytes = `${JSON.stringify(first.queueState, null, 2)}\n`;
  await Promise.all([
    writeFile(join(stateDirectory, 'queue.json'), queueBytes),
    writeFile(join(stateDirectory, 'publications.json'), `${JSON.stringify(publications(), null, 2)}\n`),
  ]);
  await assert.rejects(runPublication({
    request: {
      mode: 'retry-stage',
      jobId: job.id,
      stage: 'instagram',
      confirmation: 'RESET_FAILED_STAGE',
    },
    stateDirectory,
    env: {},
    log: () => {},
  }), /review hold/u);
  assert.equal(await readFile(join(stateDirectory, 'queue.json'), 'utf8'), queueBytes);

  const ordinaryFailure = structuredClone(first.queueState);
  ordinaryFailure.items[0].instagram.lastError.code = 'instagram_provider';
  const resetOrdinary = resetFailedStage(ordinaryFailure, job.id, 'instagram', {
    at: '2026-09-08T12:01:00.000Z',
    reason: 'manual_reset',
  });
  assert.equal(resetOrdinary.items[0].instagram.status, 'pending');

  let posts = 0;
  const reloaded = JSON.parse(await readFile(join(stateDirectory, 'queue.json'), 'utf8'));
  const second = await processOnePublication(baseInput(reloaded, {
    publishInstagram: (input) => adapter({
      ...input,
      apiVersion: 'v23.0',
      fetchImpl: async (url, options = {}) => {
        if (options.method === 'POST') posts += 1;
        const path = new URL(url).pathname;
        if (path.endsWith('/media') && options.method !== 'POST') {
          return Response.json({ data: [] });
        }
        if (path.endsWith('/media') && options.method === 'POST') {
          return Response.json({ id: 'container-one' });
        }
        if (path.endsWith('/container-one')) return Response.json({ status_code: 'FINISHED' });
        if (path.endsWith('/media_publish')) return Response.json({ id: 'published-one' });
        if (path.endsWith('/published-one')) return Response.json({ id: 'published-one' });
        throw new Error(`Unexpected request: ${path}`);
      },
    }),
    checkpoint: async () => {},
  }));

  assert.equal(posts, 0);
  assert.deepEqual(second.queueState.items[0].instagram.result, priorIntent);
  assert.equal(second.queueState.items[0].instagram.status, 'failed');
});

test('successful interrupted image recovery never upgrades source or renders a bridge in that invocation', async () => {
  const queue = queued(['instagram']);
  queue.items[0].instagram = {
    ...queue.items[0].instagram,
    status: 'publishing',
    attempts: 1,
    updatedAt: now,
    result: { publicationKind: 'image', canonicalUrl },
  };
  const durableBridge = structuredClone(queue.items[0].bridge);
  const revisedJob = { ...job, title: 'Changed title', contentHash: '9'.repeat(64) };
  const revisedSnapshot = {
    ...snapshot,
    commit: '9'.repeat(40),
    dataHash: '9'.repeat(64),
    jobsById: new Map([[job.id, revisedJob]]),
  };
  let bridgeCalls = 0;
  const result = await processOnePublication(baseInput(queue, {
    currentSnapshot: revisedSnapshot,
    publishBridge: async () => { bridgeCalls += 1; return {}; },
    publishInstagram: async ({ reconcileOnly }) => {
      assert.equal(reconcileOnly, true);
      return { id: 'instagram-recovered' };
    },
    checkpoint: async () => {},
  }));
  assert.equal(result.outcome, 'completed');
  assert.equal(bridgeCalls, 0);
  assert.deepEqual(result.queueState.items[0].bridge, durableBridge);
  assert.equal(result.queueState.items[0].contentHash, job.contentHash);
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

  assert.equal(result.outcome, 'ledger_repaired');
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
    publicationKind: 'image', canonicalUrl, id: 'instagram-recovered',
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
    result: { publicationKind: 'image', canonicalUrl },
  };
  const emptySnapshot = { ...snapshot, jobsById: new Map() };

  const result = await processOnePublication(baseInput(queue, { currentSnapshot: emptySnapshot }));

  assert.equal(result.queueState.items[0].instagram.status, 'failed');
  assert.equal(result.queueState.items[0].instagram.lastError.code, 'instagram_image_ambiguous');
  assert.deepEqual(result.queueState.items[0].instagram.result, { publicationKind: 'image', canonicalUrl });
  assert.notEqual(result.queueState.items[0].instagram.status, 'skipped_closed');
});

test('scheduled preflight runs for a lone interrupted image without making publishing globally ready', () => {
  const queue = queued(['instagram']);
  queue.items[0].instagram = {
    ...queue.items[0].instagram,
    status: 'publishing',
    attempts: 1,
    updatedAt: now,
    result: { publicationKind: 'image', canonicalUrl },
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
    publicationsState: publications(),
    currentDataHash: snapshot.dataHash,
  }), { shouldRun: true, reason: 'queued', queueDepth: 1 });

  queue.items[0].instagram.result = null;
  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    intakeState,
    queueState: queue,
    publicationsState: publications(),
    currentDataHash: snapshot.dataHash,
  }), { shouldRun: false, reason: 'up_to_date', queueDepth: 0 });
});

test('generic interrupted publication stages report bounded review work without becoming runnable', async () => {
  const queue = queued(['mastodon']);
  queue.items[0].mastodon = {
    ...queue.items[0].mastodon,
    status: 'publishing',
    attempts: 1,
    updatedAt: now,
    result: { executionOwner: 'cloudflare', platformPublicationId: 'accepted-review' },
  };
  const durableQueue = JSON.parse(JSON.stringify(queue));
  const stateDirectory = await mkdtemp(join(tmpdir(), 'openings-generic-review-'));
  await Promise.all([
    writeFile(join(stateDirectory, 'intake.json'), JSON.stringify({
      schemaVersion: 3,
      processedSnapshot: {
        commit: snapshot.commit,
        generatedAt: snapshot.generatedAt,
        dataHash: snapshot.dataHash,
      },
      pendingBridges: [],
      removedJobs: [],
    })),
    writeFile(join(stateDirectory, 'queue.json'), JSON.stringify(queue)),
    writeFile(join(stateDirectory, 'publications.json'), JSON.stringify(publications())),
  ]);

  let manifestReads = 0;
  const preflight = await runPreflight({
    eventName: 'schedule',
    publishEnabled: true,
    stateDirectory,
    fetchManifest: async () => {
      manifestReads += 1;
      return { dataHash: snapshot.dataHash };
    },
    log: () => {},
  });
  assert.deepEqual(preflight, {
    shouldRun: false,
    reason: 'review_required',
    queueDepth: 0,
    reviewRequiredCount: 1,
    reviewRequired: [{ jobId: job.id, stage: 'mastodon' }],
  });
  assert.equal(manifestReads, 1);

  const changed = await runPreflight({
    eventName: 'schedule',
    publishEnabled: true,
    stateDirectory,
    fetchManifest: async () => ({ dataHash: 'f'.repeat(64) }),
    log: () => {},
  });
  assert.deepEqual(changed, {
    shouldRun: true,
    reason: 'snapshot_changed',
    queueDepth: 0,
    reviewRequiredCount: 1,
    reviewRequired: [{ jobId: job.id, stage: 'mastodon' }],
  });

  const direct = await processOnePublication(baseInput(queue));
  assert.equal(direct.outcome, 'review_required');
  assert.deepEqual(direct.reviewRequired, [{ jobId: job.id, stage: 'mastodon' }]);
  assert.deepEqual(direct.queueState, durableQueue);
});

test('generic interrupted stages do not block an unrelated ready channel on the selected job', async () => {
  const queue = queued(['bluesky', 'mastodon']);
  queue.items[0].mastodon = {
    ...queue.items[0].mastodon,
    status: 'publishing',
    attempts: 1,
    updatedAt: now,
    result: { executionOwner: 'cloudflare', platformPublicationId: 'accepted-review' },
  };
  const durableMastodon = structuredClone(queue.items[0].mastodon);
  let blueskyCalls = 0;
  const result = await processOnePublication(baseInput(queue, {
    publishBluesky: async () => { blueskyCalls += 1; return { id: 'bsky-ready' }; },
    checkpoint: async () => {},
  }));
  assert.equal(result.outcome, 'partial');
  assert.equal(blueskyCalls, 1);
  assert.deepEqual(result.queueState.items[0].mastodon, durableMastodon);
});

test('scheduled preflight selects ledger-repair-only work and the normal CLI persists it with zero providers', async () => {
  const queue = queued(['bluesky']);
  queue.items[0].bluesky = {
    ...queue.items[0].bluesky,
    status: 'published',
    attempts: 1,
    updatedAt: now,
    result: { id: 'bsky-ledger-repair' },
  };
  const stateDirectory = await mkdtemp(join(tmpdir(), 'openings-ledger-preflight-'));
  const intakeState = {
    schemaVersion: 3,
    processedSnapshot: {
      commit: snapshot.commit,
      generatedAt: snapshot.generatedAt,
      dataHash: snapshot.dataHash,
    },
    pendingBridges: [],
    removedJobs: [],
  };
  await Promise.all([
    writeFile(join(stateDirectory, 'intake.json'), JSON.stringify(intakeState)),
    writeFile(join(stateDirectory, 'queue.json'), JSON.stringify(queue)),
    writeFile(join(stateDirectory, 'publications.json'), JSON.stringify(publications())),
  ]);

  const preflight = await runPreflight({
    eventName: 'schedule',
    publishEnabled: true,
    stateDirectory,
    fetchManifest: async () => assert.fail('repair-only work must be selected locally'),
    log: () => {},
  });
  assert.deepEqual(preflight, {
    shouldRun: true,
    reason: 'publication_ledger_repair',
    queueDepth: 0,
    repairCount: 1,
  });

  let providerCalls = 0;
  const forbidden = async () => { providerCalls += 1; throw new Error('provider must not run'); };
  const result = await runPublication({
    request: { mode: 'scheduled' },
    dataRepositoryPath: '/fixture/data',
    stateDirectory,
    wordmarkPath: '/fixture/wordmark.svg',
    outputPath: join(stateDirectory, 'output'),
    env: {
      SOCIAL_AUTO_PUBLISH: 'true',
      WEB_DEPLOY_TOKEN: 'deploy-secret',
      BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
      BLUESKY_APP_PASSWORD: 'bluesky-secret',
      MASTODON_ACCESS_TOKEN: 'mastodon-secret',
      BUFFER_API_KEY: 'buffer-secret',
      BUFFER_ORGANIZATION_ID: '68b68d3ac159685850cf2b8d',
      BUFFER_TWITTER_CHANNEL_ID: '68b68e0fc159685850cf2c22',
    },
    log: () => {},
    dependencies: {
      resolveGitCommit: async () => snapshot.commit,
      loadCanonicalWordmark: async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      loadSnapshot: async () => snapshot,
      createBridgePublisher: () => forbidden,
      publishBluesky: forbidden,
      publishMastodon: forbidden,
      publishTwitter: forbidden,
      publishThreads: forbidden,
      publishInstagram: forbidden,
      publishLinkedIn: forbidden,
    },
  });
  assert.equal(result.outcome, 'ledger_repaired');
  assert.equal(providerCalls, 0);
  assert.equal(
    JSON.parse(await readFile(join(stateDirectory, 'publications.json'), 'utf8'))
      .jobs[job.id].bluesky.id,
    'bsky-ledger-repair',
  );

  const afterRepair = await runPreflight({
    eventName: 'schedule',
    publishEnabled: true,
    stateDirectory,
    fetchManifest: async () => ({ dataHash: snapshot.dataHash }),
    log: () => {},
  });
  assert.deepEqual(afterRepair, { shouldRun: false, reason: 'up_to_date', queueDepth: 0 });
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
