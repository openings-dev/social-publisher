import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { prepareSocialPublication, submitSocialPublication, readSocialPublication } from '../src/modules/publishing/platform-publisher.mjs';
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

test('checks acceptance before upload and persists acceptance for duplicate invocations', async () => {
  const prepared = await prepareSocialPublication(await fixture());
  const calls = [];
  const transport = {
    baseUrl: 'https://publisher.example', clientId: 'test-client', secret: 'test-only-secret',
    fetch: async (url, init) => {
      calls.push(init.method);
      if (calls.length === 1) return Response.json({ code: 'ARTIFACT_NOT_READY' }, { status: 409 });
      if (init.method === 'PUT') {
        await new Response(init.body).arrayBuffer();
        return Response.json({ status: 'stored' });
      }
      assert.ok(init.headers);
      return Response.json({ publicationId: 'publication-1' });
    },
  };
  assert.equal((await submitSocialPublication({ path: prepared.path, transport })).outcome, 'accepted');
  assert.deepEqual(calls, ['POST', 'PUT', 'POST']);
  assert.equal((await submitSocialPublication({ path: prepared.path, transport })).outcome, 'already-accepted');
  assert.deepEqual(calls, ['POST', 'PUT', 'POST']);
});

test('capacity rejection retains handoff without uploading media', async () => {
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
  assert.deepEqual(calls, ['POST']);
  assert.ok(await readFile(prepared.path));
});

test('changed source bytes fail before upload when remote intake needs the artifact', async () => {
  const input = await fixture();
  const prepared = await prepareSocialPublication(input);
  await writeFile(input.mediaPath, 'changed artwork');
  await assert.rejects(submitSocialPublication({ path: prepared.path, transport: {
    baseUrl: 'https://publisher.example', clientId: 'test-client', secret: 'test-only-secret',
    fetch: async (_url, init) => {
      assert.equal(init.method, 'POST');
      return Response.json({ code: 'ARTIFACT_NOT_READY' }, { status: 409 });
    },
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
      if (calls.length === 1) return Response.json({ code: 'ARTIFACT_NOT_READY' }, { status: 409 });
      if (init.method === 'PUT') {
        await new Response(init.body).arrayBuffer();
        return Response.json({ status: 'stored' });
      }
      return Response.json({ publicationId: 'bridge-shadow' });
    },
    requestDeployment: async () => { calls.push('legacy-bridge'); return { status: 'verified', verification: {} }; },
  });
  await publish({ job: input.job });
  assert.deepEqual(calls, ['POST', 'PUT', 'POST', 'legacy-bridge']);
});

test('recovers remote acceptance after media is deleted without uploading', async () => {
  const input = await fixture();
  const prepared = await prepareSocialPublication(input);
  await unlink(input.mediaPath);
  const calls = [];
  const result = await submitSocialPublication({ path: prepared.path, transport: {
    baseUrl: 'https://publisher.example', clientId: 'test-client', secret: 'test-only-secret',
    fetch: async (_url, init) => {
      calls.push(init.method);
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), prepared.handoff.envelope);
      return Response.json({ publicationId: 'existing-publication' }, { status: 202 });
    },
  } });
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.publicationId, 'existing-publication');
  assert.deepEqual(calls, ['POST']);
});

test('dry run never reads the social signing secret even if the gate is enabled', () => {
  const env = { PUBLISHING_SOCIAL_SHADOW_ENABLED: 'true',
    get PUBLISHING_CLIENT_SECRET() { assert.fail('dry run must not access credentials'); },
  };
  assert.equal(readEnvironment({ env, mode: 'dry-run' }).platformShadow, null);
});
test('reads a receipt through a signed GET without uploading or submitting', async () => {
  const result = await readSocialPublication({ publicationId: 'publication-1', transport: {
    baseUrl: 'https://publisher.example', clientId: 'test-client', secret: 'test-only-secret',
    fetch: async (url, init) => {
      assert.equal(url, 'https://publisher.example/v1/publications/publication-1');
      assert.equal(init.method, 'GET');
      assert.ok(new Headers(init.headers).get('x-pub-signature'));
      assert.equal(init.body, undefined);
      return Response.json({ publicationId: 'publication-1', deliveries: [{ state: 'verified' }] });
    },
  } });
  assert.equal(result.deliveries[0].state, 'verified');
});

test('a local acceptance cannot bypass Openings shadow ownership validation', async () => {
  const prepared = await prepareSocialPublication(await fixture());
  const directory = dirname(prepared.path);
  const changed = structuredClone(prepared.handoff);
  changed.envelope.identity.tenant = 'another-tenant';
  await writeFile(prepared.path, JSON.stringify(changed));
  await mkdir(join(directory, 'accepted'));
  await writeFile(join(directory, 'accepted', `${basename(directory)}.json`), JSON.stringify({ publicationId: 'copied' }));
  await assert.rejects(submitSocialPublication({ path: prepared.path, transport: {
    baseUrl: 'https://publisher.example', clientId: 'test-client', secret: 'test-only-secret',
    fetch: () => assert.fail('invalid handoff must not use transport'),
  } }), /Only one Openings shadow delivery/);
});
