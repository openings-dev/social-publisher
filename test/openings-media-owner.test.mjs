import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpeningsMediaOwnerEnvelope,
  openingsMediaOwnerDigestPreimage,
  validateOpeningsMediaOwnerRecord,
  validateOpeningsMediaOwnerEnvelope,
} from '../src/modules/publishing/openings-media-owner.mjs';

const jobId = `gh_${'a'.repeat(24)}`;

function ownerInput() {
  return {
    jobId,
    entityRevision: 'revision-1',
    entityContentSha256: 'c'.repeat(64),
    generation: 1,
    expiresAt: '2026-09-17T00:00:00.000Z',
    canonical: {
      title: 'Engineer',
      summary: 'Remote role',
      canonicalUrl: `https://openings.dev/jobs/${jobId}`,
      language: 'en',
    },
    formattedText: 'Engineer — apply at Openings',
    media: [
      { role: 'opengraph', logicalArtifactId: 'og', sha256: 'a'.repeat(64), byteSize: 100,
        mediaType: 'image/png', width: 1200, height: 630, renderVersion: '1' },
      { role: 'instagram-feed', logicalArtifactId: 'feed', sha256: 'b'.repeat(64), byteSize: 200,
        mediaType: 'image/jpeg', width: 1080, height: 1350, renderVersion: '1' },
    ],
  };
}

test('builds the literal Worker-compatible immutable owner request', () => {
  const preimage = '{"contractVersion":"openings-media-owner/v1","formatterVersion":"openings-social-formatter/v1","tenant":"openings","sourceType":"social-media-owner","jobId":"gh_aaaaaaaaaaaaaaaaaaaaaaaa","entityRevision":"revision-1","entityContentSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","canonical":{"title":"Engineer","summary":"Remote role","canonicalUrl":"https://openings.dev/jobs/gh_aaaaaaaaaaaaaaaaaaaaaaaa","language":"en"},"formattedText":"Engineer — apply at Openings","generation":1,"expiresAt":"2026-09-17T00:00:00.000Z","media":[{"role":"opengraph","logicalArtifactId":"og","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","byteSize":100,"mediaType":"image/png","width":1200,"height":630,"renderVersion":"1"},{"role":"instagram-feed","logicalArtifactId":"feed","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","byteSize":200,"mediaType":"image/jpeg","width":1080,"height":1350,"renderVersion":"1"}]}';
  assert.equal(openingsMediaOwnerDigestPreimage(ownerInput()), preimage);
  const built = buildOpeningsMediaOwnerEnvelope(ownerInput());
  assert.equal(built.requestDigest, 'c00f7407c59e610a44b0fe62815cd69832273fbb72b83ab9fc96e89b1170f8d3');
  assert.equal(built.retainedBytes, 300);
  assert.deepEqual(built.envelope, {
    schemaVersion: 1,
    identity: {
      tenant: 'openings', sourceType: 'social-media-owner', sourceId: jobId,
      revision: `sha256:${built.requestDigest}`,
      idempotencyKey: `openings:social-media-owner:${jobId}:${built.requestDigest}`,
    },
    canonical: ownerInput().canonical,
    artifacts: [
      { id: 'og', storage: 'r2-temporary', sha256: 'a'.repeat(64), byteSize: 100,
        mediaType: 'image/png', locator: `temporary/openings/bridge/${built.requestDigest}/${'a'.repeat(64)}.png` },
      { id: 'feed', storage: 'r2-temporary', sha256: 'b'.repeat(64), byteSize: 200,
        mediaType: 'image/jpeg', locator: `temporary/openings/bridge/${built.requestDigest}/${'b'.repeat(64)}.jpg` },
    ],
    deliveries: [{
      id: 'media-owner', adapter: 'social.openings-media', operation: 'retain-media', required: true,
      payload: { type: 'social.post', text: ownerInput().formattedText, artifactIds: ['og', 'feed'] },
      providerOptions: {
        schemaVersion: 1, jobId, entityRevision: 'revision-1', entityContentSha256: 'c'.repeat(64),
        generation: 1, expiresAt: '2026-09-17T00:00:00.000Z', media: ownerInput().media,
      },
    }],
  });
  assert.deepEqual(validateOpeningsMediaOwnerEnvelope(built.envelope), built);
});

test('accepts the real multiline social formatter shape without bridge-string limits', () => {
  const input = ownerInput();
  input.formattedText = `New job on openings.dev\n\n${'Senior Engineer '.repeat(15)}\n\nView the listing:\n${input.canonical.canonicalUrl}`;
  assert.doesNotThrow(() => buildOpeningsMediaOwnerEnvelope(input));
});

test('validates one portable immutable queue record against its envelope and fixed files', () => {
  const input = ownerInput();
  input.entityRevision = 'b'.repeat(64);
  const built = buildOpeningsMediaOwnerEnvelope(input);
  const record = {
    schemaVersion: 1,
    jobId,
    sourceId: 'openings/jobs#1',
    dataCommit: 'd'.repeat(40),
    dataHash: 'e'.repeat(64),
    contentHash: input.entityRevision,
    entityRevision: input.entityRevision,
    entityContentSha256: input.entityContentSha256,
    generation: input.generation,
    preparedAt: '2026-09-10T00:00:00.000Z',
    expiresAt: input.expiresAt,
    requestDigest: built.requestDigest,
    canonical: input.canonical,
    formattedText: input.formattedText,
    socialTitle: 'Engineer',
    direction: 'night',
    storyRequired: false,
    envelope: built.envelope,
    files: input.media.map((media, index) => ({
      ...media,
      fileName: index === 0 ? 'opengraph-image.png' : 'instagram-image.jpg',
    })),
  };
  assert.equal(validateOpeningsMediaOwnerRecord(record, { jobId }).requestDigest, built.requestDigest);
  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { value.expiresAt = '2026-09-17T00:00:00.001Z'; },
    (value) => { value.files[0].fileName = '../opengraph-image.png'; },
    (value) => { value.files[0].sha256 = 'f'.repeat(64); },
    (value) => { value.envelope.identity.revision = `sha256:${'f'.repeat(64)}`; },
  ]) {
    const changed = structuredClone(record);
    mutate(changed);
    assert.throws(() => validateOpeningsMediaOwnerRecord(changed, { jobId }));
  }
});

test('rejects invalid owner structure even when its digest and envelope are rebuilt', () => {
  for (const mutate of [
    (input) => { input.extra = true; },
    (input) => { input.jobId = 'job'; },
    (input) => { input.entityRevision = 'bad\nrevision'; },
    (input) => { input.entityContentSha256 = 'A'.repeat(64); },
    (input) => { input.generation = 0; },
    (input) => { input.expiresAt = '2026-09-17T00:00:00Z'; },
    (input) => { input.canonical.extra = true; },
    (input) => { input.canonical.canonicalUrl += '/'; },
    (input) => { input.media.reverse(); },
    (input) => { input.media[0].logicalArtifactId = 'bad\nidentifier'; },
    (input) => { input.media[1].byteSize = 2 * 1024 * 1024; },
    (input) => { input.media[1].logicalArtifactId = input.media[0].logicalArtifactId; },
    (input) => { input.media[0].extra = true; },
  ]) {
    const input = ownerInput(); mutate(input);
    assert.throws(() => buildOpeningsMediaOwnerEnvelope(input));
  }
});

test('rejects tampered derived identity, locator, mapping, and extra envelope fields', () => {
  const valid = buildOpeningsMediaOwnerEnvelope(ownerInput()).envelope;
  for (const mutate of [
    (envelope) => { envelope.extra = true; },
    (envelope) => { envelope.identity.revision = `sha256:${'f'.repeat(64)}`; },
    (envelope) => { envelope.identity.idempotencyKey += 'x'; },
    (envelope) => { envelope.artifacts[0].locator = 'temporary/openings/shared.png'; },
    (envelope) => { envelope.artifacts.reverse(); },
    (envelope) => { envelope.deliveries[0].payload.artifactIds.reverse(); },
    (envelope) => { envelope.deliveries[0].required = false; },
    (envelope) => { envelope.deliveries[0].providerOptions.extra = true; },
  ]) {
    const changed = structuredClone(valid); mutate(changed);
    assert.throws(() => validateOpeningsMediaOwnerEnvelope(changed));
  }
});
