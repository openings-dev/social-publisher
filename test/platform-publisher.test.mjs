import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareSocialPublication, submitSocialPublication } from '../src/modules/publishing/platform-publisher.mjs';
import { createBridgePublisher } from '../src/modules/publishing/bridge-publisher.mjs';
import { readEnvironment } from '../src/config/env.mjs';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'openings-handoff-'));
  const mediaPath = join(directory, 'card.png');
  await writeFile(mediaPath, Buffer.from('verified local media'));
  const job = JSON.parse(await readFile(new URL('../assets/fixtures/job.json', import.meta.url)));
  return { directory, mediaPath, job, outboxDirectory: join(directory, 'outbox') };
}

test('prepares real media locally with social ownership and content-sensitive identity', async () => {
  const input = await fixture();
  const first = await prepareSocialPublication(input);
  const second = await prepareSocialPublication(input);
  assert.equal(first.path, second.path);
  assert.deepEqual(first.handoff.envelope.deliveries.map(d => d.adapter), ['social.shadow']);
  assert.doesNotMatch(JSON.stringify(first.handoff.envelope), /web\.r2|filePath/);
  await writeFile(input.mediaPath, 'changed artwork');
  const changed = await prepareSocialPublication(input);
  assert.notEqual(changed.path, first.path);
});

test('uploads before signed submission and persists acceptance for duplicate invocations', async () => {
  const prepared = await prepareSocialPublication(await fixture());
  const calls = [];
  const transport = {
    baseUrl: 'https://publisher.example', clientId: 'test-client', secret: 'test-only-secret',
    fetch: async (url, init) => {
      calls.push(init.method);
      if (init.method === 'PUT') {
        await new Response(init.body).arrayBuffer();
        return Response.json({ status: 'stored' });
      }
      assert.ok(init.headers);
      return Response.json({ publicationId: 'publication-1' });
    },
  };
  assert.equal((await submitSocialPublication({ path: prepared.path, transport })).outcome, 'accepted');
  assert.deepEqual(calls, ['PUT', 'POST']);
  assert.equal((await submitSocialPublication({ path: prepared.path, transport })).outcome, 'already-accepted');
  assert.deepEqual(calls, ['PUT', 'POST']);
});

test('capacity rejection retains handoff and never submits the envelope', async () => {
  const prepared = await prepareSocialPublication(await fixture());
  const calls = [];
  const result = await submitSocialPublication({ path: prepared.path, transport: {
    baseUrl: 'https://publisher.example', clientId: 'test-client', secret: 'test-only-secret',
    fetch: async (_url, init) => {
      calls.push(init.method);
      await new Response(init.body).arrayBuffer();
      return Response.json({ code: 'CAPACITY_LIMIT' }, { status: 429 });
    },
  } });
  assert.equal(result.outcome, 'retry-later');
  assert.deepEqual(calls, ['PUT']);
  assert.ok(await readFile(prepared.path));
});

test('changed source bytes fail before any network request', async () => {
  const input = await fixture();
  const prepared = await prepareSocialPublication(input);
  await writeFile(input.mediaPath, 'changed artwork');
  await assert.rejects(submitSocialPublication({ path: prepared.path, transport: {
    baseUrl: 'https://publisher.example', clientId: 'test-client', secret: 'test-only-secret',
    fetch: () => assert.fail('network must not run'),
  } }), /changed after preparation/);
});

test('public or insecure endpoints and missing credentials fail before upload', async () => {
  const prepared = await prepareSocialPublication(await fixture());
  await assert.rejects(submitSocialPublication({ path: prepared.path, transport: {} }), /credentials/);
  await assert.rejects(submitSocialPublication({ path: prepared.path, transport: {
    baseUrl: 'http://publisher.example', clientId: 'test-client', secret: 'test-only-secret',
  } }), /HTTPS/);
});

test('the production bridge invokes the shared transport before its existing deployment', async () => {
  const input = await fixture();
  const calls = [];
  const publish = createBridgePublisher({
    config: {
      publicSiteOrigin: 'https://openings.dev', webDeploy: { repository: 'test', token: 'test' },
      platformShadow: { baseUrl: 'https://publisher.example', clientId: 'test-client', secret: 'test-only-secret' },
    },
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
    outputRoot: input.directory,
    fetchImpl: async (_url, init) => {
      calls.push(init.method);
      if (init.method === 'PUT') {
        await new Response(init.body).arrayBuffer();
        return Response.json({ status: 'stored' });
      }
      return Response.json({ publicationId: 'bridge-shadow' });
    },
    requestDeployment: async () => { calls.push('legacy-bridge'); return { status: 'verified', verification: {} }; },
  });
  await publish({ job: input.job });
  assert.deepEqual(calls, ['PUT', 'POST', 'legacy-bridge']);
});

test('dry run never reads the social signing secret even if the gate is enabled', () => {
  const env = { PUBLISHING_SOCIAL_SHADOW_ENABLED: 'true',
    get PUBLISHING_CLIENT_SECRET() { assert.fail('dry run must not access credentials'); },
  };
  assert.equal(readEnvironment({ env, mode: 'dry-run' }).platformShadow, null);
});
