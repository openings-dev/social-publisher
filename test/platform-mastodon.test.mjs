import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as platform from '../src/modules/publishing/platform-mastodon.mjs';
import { readEnvironment } from '../src/config/env.mjs';

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
    PUBLISHING_MASTODON_ENABLED: 'true', PUBLISHING_ENDPOINT: transport.baseUrl, PUBLISHING_CLIENT_ID: 'test', PUBLISHING_CLIENT_SECRET: 'test' };
  const config = readEnvironment({ env, mode: 'scheduled' });
  assert.ok(config.platformMastodon);
  assert.equal(config.mastodonAccessToken, null);
  assert.equal(readEnvironment({ env, mode: 'dry-run' }).platformMastodon, null);
  assert.throws(() => readEnvironment({ env: { ...env, PUBLISHING_MASTODON_ENABLED: 'false' }, mode: 'scheduled' }), /MASTODON_ACCESS_TOKEN/);
});
