import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestIncrementalBridgeDeployment } from '../src/modules/deploy/web-deploy-client.mjs';
import { verifyPublicBridge } from '../src/modules/deploy/public-verifier.mjs';
import { sha256 } from '../src/shared/hash.mjs';

const id = 'gh_2ae9c1200647b294684ff5fd';
const canonical = `https://openings.dev/jobs/${id}`;
const input = {
  jobId: id, contentHash: 'a'.repeat(64), expectedPngHash: sha256('png'),
  expectedInstagramSvgHash: sha256('<svg/>'), html: '<html></html>',
  image: Buffer.from('png'), instagramSvg: Buffer.from('<svg/>'),
  repository: 'openings-dev/web-deploy', token: 'test-only-token',
  origin: 'https://openings.dev', pollAttempts: 0,
};

test('marks an incompatible platform page without dispatching a legacy deploy', async () => {
  let writes = 0;
  const fetchImpl = async (_url, options) => {
    if (options?.method === 'POST') {
      writes += 1;
      return new Response(null, { status: 204 });
    }
    return new Response(`<html><head><link rel="canonical" href="${canonical}">
      <meta property="og:url" content="${canonical}"></head></html>`, {
      headers: { 'content-type': 'text/html', 'x-publishing-revision': 'approved-revision' },
    });
  };
  const result = await verifyPublicBridge({ ...input, fetchImpl, allowMismatch: true });
  assert.equal(result.runtime, 'publishing-platform');
  assert.equal(result.reason, 'open_graph_image_mismatch');
  await assert.rejects(requestIncrementalBridgeDeployment({ ...input, fetchImpl }),
    error => error.code === 'bridge_platform_media_pending');
  assert.equal(writes, 0);
});

test('a forced upgrade cannot send a platform-owned page to the legacy deployer', async () => {
  let writes = 0;
  await assert.rejects(requestIncrementalBridgeDeployment({
    ...input, forceDeployment: true,
    verifyPublic: async () => ({ matches: true, runtime: 'publishing-platform' }),
    fetchImpl: async () => { writes += 1; return new Response(null, { status: 204 }); },
  }), error => error.code === 'bridge_platform_media_pending');
  assert.equal(writes, 0);
});

test('a fully matching platform bridge remains usable without deployment', async () => {
  const result = await requestIncrementalBridgeDeployment({
    ...input, verifyPublic: async () => ({ matches: true, runtime: 'publishing-platform' }),
    fetchImpl: async () => { throw new Error('No network write expected'); },
  });
  assert.equal(result.status, 'already_current');
});

for (const redirectCase of ['unexpected-location', 'target-fails', 'target-without-marker']) {
  test(`a platform redirect cannot lose its owner marker: ${redirectCase}`, async () => {
    let reads = 0;
    let writes = 0;
    const fetchImpl = async (_url, options) => {
      if (options?.method === 'POST') {
        writes += 1;
        return new Response(null, { status: 204 });
      }
      reads += 1;
      if (reads === 1) return new Response(null, { status: 308, headers: {
        'x-publishing-revision': 'approved-revision',
        location: redirectCase === 'unexpected-location' ? 'https://other.example/' : `${canonical}/`,
      } });
      if (redirectCase === 'target-fails') throw new Error('Unavailable');
      return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    };
    await assert.rejects(requestIncrementalBridgeDeployment({ ...input, fetchImpl }),
      error => error.code === 'bridge_platform_media_pending');
    assert.equal(writes, 0);
  });
}
