import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256 } from '../src/shared/hash.mjs';
import { verifyOpeningsR2File } from '../src/modules/publishing/openings-r2-verifier.mjs';

const body = Buffer.from('public image bytes');
const file = {
  role: 'opengraph', fileName: 'opengraph-image.png', logicalArtifactId: 'opengraph',
  objectKey: `openings/jobs/gh_${'a'.repeat(24)}/${'b'.repeat(64)}/${'c'.repeat(64)}/opengraph-image.png`,
  url: `https://media.openings.dev/openings/jobs/gh_${'a'.repeat(24)}/${'b'.repeat(64)}/${'c'.repeat(64)}/opengraph-image.png`,
  sha256: sha256(body), byteSize: body.length, mediaType: 'image/png', width: 1200, height: 630,
  renderVersion: '2', uploadState: 'uploaded', consumers: [],
};

test('verifies exact public bytes without redirects before marking an object verified', async () => {
  const calls = [];
  const result = await verifyOpeningsR2File(file, {
    publicOrigin: 'https://media.openings.dev',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(body, { headers: { 'content-type': 'image/png', 'content-length': String(body.length) } });
    },
    inspectBytes: async (bytes, descriptor) => {
      assert.deepEqual(bytes, body); assert.equal(descriptor.width, 1200);
    },
  });
  assert.equal(result.uploadState, 'verified');
  assert.equal(calls[0].url, file.url);
  assert.equal(calls[0].init.redirect, 'error');
});

test('rejects wrong origins, redirects, MIME, length, digest, and oversized streams', async () => {
  for (const response of [
    new Response(body, { status: 302, headers: { location: 'https://other.example/file' } }),
    new Response(body, { headers: { 'content-type': 'text/plain', 'content-length': String(body.length) } }),
    new Response(body, { headers: { 'content-type': 'image/png', 'content-length': String(body.length + 1) } }),
    new Response(Buffer.from('different bytes'), { headers: { 'content-type': 'image/png' } }),
  ]) await assert.rejects(verifyOpeningsR2File(file, {
    publicOrigin: 'https://media.openings.dev', fetchImpl: async () => response,
    inspectBytes: async () => {},
  }), /public R2 media/u);
  await assert.rejects(verifyOpeningsR2File({ ...file, url: file.url.replace('media.openings.dev', 'evil.example') }, {
    publicOrigin: 'https://media.openings.dev', fetchImpl: async () => assert.fail('must not fetch'),
  }), /public R2 media/u);
});
