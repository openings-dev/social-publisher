import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as platform from '../src/modules/publishing/platform-mastodon.mjs';
import { readEnvironment } from '../src/config/env.mjs';
import { enqueueJob, resetFailedStage } from '../src/modules/state/queue-operations.mjs';
import { processOnePublication } from '../src/modules/publishing/orchestrator.mjs';

const job = { id: 'gh_0123456789abcdef01234567', title: 'Engineer' };
const post = { canonicalUrl: `https://openings.dev/jobs/${job.id}`, text: `Engineer https://openings.dev/jobs/${job.id}` };
const transport = { baseUrl: 'https://publisher.example', clientId: 'test', secret: 'test-only' };

test('uses the Worker receipt and never sends a provider request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-mastodon-'));
  const calls = [];
  const options = { job, post, outboxDirectory: directory, pollAttempts: 1, transport: { ...transport,
    fetch: async (url, init) => {
      assert.equal(new URL(url).origin, transport.baseUrl);
      calls.push(init.method);
      if (init.method === 'POST') {
        const envelope = JSON.parse(init.body);
        assert.deepEqual(envelope.artifacts, []);
        assert.equal(envelope.deliveries[0].adapter, 'social.mastodon');
        return Response.json({ publicationId: 'pub-one' });
      }
      return Response.json({ publicationId: 'pub-one', deliveries: [{ id: 'mastodon', adapter: 'social.mastodon', state: 'verified',
        provider: 'social.mastodon', remoteId: '123', remoteUrl: 'https://mastodon.social/@openingshq/123' }] });
    },
  } };
  assert.deepEqual(await platform.publishMastodonThroughPlatform(options), {
    status: 'published', id: '123', url: 'https://mastodon.social/@openingshq/123', cardStatus: 'pending',
  });
  assert.equal((await platform.publishMastodonThroughPlatform(options)).status, 'reconciled');
  assert.deepEqual(calls, ['POST', 'GET', 'GET']);
});

test('an accepted but unconfirmed publication stays pending without native fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-mastodon-'));
  const calls = [];
  const options = { job, post, outboxDirectory: directory, pollAttempts: 1, transport: { ...transport,
    fetch: async (_url, init) => {
      calls.push(init.method);
      return Response.json(init.method === 'POST' ? { publicationId: 'pub-one' } : {
        publicationId: 'pub-one', deliveries: [{ id: 'mastodon', adapter: 'social.mastodon', state: 'ambiguous', receipt: null }],
      });
    },
  } };
  await assert.rejects(platform.publishMastodonThroughPlatform(options), /awaiting confirmation/);
  await assert.rejects(platform.publishMastodonThroughPlatform(options), /awaiting confirmation/);
  assert.deepEqual(calls, ['POST', 'GET', 'GET']);
});

test('Cloudflare ownership removes the legacy token requirement while dry-run ignores credentials', () => {
  const env = { SOCIAL_AUTO_PUBLISH: 'true', WEB_DEPLOY_TOKEN: 'test', BLUESKY_IDENTIFIER: 'test', BLUESKY_APP_PASSWORD: 'test',
    BUFFER_API_KEY: 'test', BUFFER_ORGANIZATION_ID: 'test', BUFFER_TWITTER_CHANNEL_ID: 'test',
    MASTODON_AUTO_PUBLISH: 'true', PUBLISHING_MASTODON_ENABLED: 'true', PUBLISHING_ENDPOINT: transport.baseUrl, PUBLISHING_CLIENT_ID: 'test', PUBLISHING_CLIENT_SECRET: 'test' };
  const config = readEnvironment({ env, mode: 'scheduled' });
  assert.ok(config.platformMastodon);
  assert.equal(config.mastodonAccessToken, null);
  assert.equal(readEnvironment({ env, mode: 'dry-run' }).platformMastodon, null);
  assert.throws(() => readEnvironment({ env: { ...env, PUBLISHING_MASTODON_ENABLED: 'false' }, mode: 'scheduled' }), /MASTODON_ACCESS_TOKEN/);
});

test('Mastodon stays disabled unless its channel flag is explicitly enabled', () => {
  const env = {
    SOCIAL_AUTO_PUBLISH: 'true',
    WEB_DEPLOY_TOKEN: 'test',
    BLUESKY_IDENTIFIER: 'test',
    BLUESKY_APP_PASSWORD: 'test',
    BUFFER_API_KEY: 'test',
    BUFFER_ORGANIZATION_ID: 'test',
    BUFFER_TWITTER_CHANNEL_ID: 'test',
    PUBLISHING_MASTODON_ENABLED: 'true',
  };
  const disabled = readEnvironment({ env, mode: 'scheduled' });
  assert.deepEqual(disabled.enabledChannels, ['bluesky', 'twitter']);
  assert.equal(disabled.platformMastodon, null);
  assert.equal(disabled.mastodonAccessToken, null);
});

test('tracked acceptance resumes with GET only on a new runner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'platform-mastodon-'));
  await assert.rejects(platform.publishMastodonThroughPlatform({ job, post, outboxDirectory: directory,
    acceptedPublicationId: 'pub-one', pollAttempts: 1, transport: { ...transport, fetch: async (_url, init) => {
      assert.equal(init.method, 'GET');
      return Response.json({ publicationId: 'pub-one', deliveries: [{ id: 'mastodon', adapter: 'social.mastodon', state: 'ambiguous' }] });
    } },
  }), error => error.platformPublicationId === 'pub-one');
});

test('unclaimed work cannot use the Cloudflare executor and claimed work cannot fall back', () => {
  assert.equal(platform.mastodonExecutionOwner({ result: { executionOwner: 'cloudflare' } }, false), 'cloudflare');
  assert.throws(() => platform.mastodonExecutionOwner({ result: null }, true), /ownership/);
  assert.equal(platform.mastodonExecutionOwner({ result: null }, false), 'legacy');
});

test('claims only untouched jobs and retains acceptance in the tracked queue after partial success', async () => {
  const fullJob = JSON.parse(await readFile(new URL('../assets/fixtures/job.json', import.meta.url)));
  const snapshot = { commit: 'a'.repeat(40), dataHash: 'b'.repeat(64), generatedAt: fullJob.createdAt, jobsById: new Map([[fullJob.id, fullJob]]) };
  const queue = enqueueJob({ schemaVersion: 3, items: [] }, { job: fullJob, snapshot, discoveredAt: fullJob.createdAt });
  const claimed = platform.claimMastodonOwnership(queue);
  assert.equal(claimed.items[0].mastodon.result.executionOwner, 'cloudflare');
  const existing = structuredClone(queue);
  existing.items[0].mastodon.attempts = 1;
  assert.equal(platform.claimMastodonOwnership(existing).items[0].mastodon.result, null);
  existing.items[0].mastodon.attempts = 0;
  existing.items[0].mastodon.lastReset = { at: '2026-09-07T04:59:00.000Z', reason: 'manual_reset' };
  assert.equal(platform.claimMastodonOwnership(existing).items[0].mastodon.result, null);
  const result = await processOnePublication({ queueState: claimed, publicationsState: { schemaVersion: 3, jobs: {} }, currentSnapshot: snapshot,
    publishBridge: async () => ({ status: 'deployed' }), publishBluesky: async () => ({ status: 'published' }),
    publishTwitter: async () => ({ status: 'published' }),
    publishMastodon: async () => { const error = new Error('awaiting confirmation'); error.platformPublicationId = 'pub-one'; throw error; },
    now: '2026-09-07T05:00:00.000Z',
  });
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.queueState.items[0].mastodon.result, { executionOwner: 'cloudflare', platformPublicationId: 'pub-one' });
  const failed = structuredClone(result.queueState);
  failed.items[0].mastodon.status = 'failed';
  const reset = resetFailedStage(failed, fullJob.id, 'mastodon', { at: '2026-09-07T05:01:00.000Z', reason: 'manual_reset' });
  assert.deepEqual(reset.items[0].mastodon.result, { executionOwner: 'cloudflare', platformPublicationId: 'pub-one' });
});
