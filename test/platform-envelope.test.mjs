import assert from 'node:assert/strict';
import test from 'node:test';
import { stagePlatformHandoff } from '@trebla/publishing';

import { preparePlatformHandoff, toPlatformShadowEnvelope } from '../src/modules/publishing/platform-envelope.mjs';

const hash = 'a'.repeat(64);
const job = {
  id: 'gh_0123456789abcdef01234567',
  sourceId: 'openings-fixtures/jobs#42',
  title: 'Senior TypeScript Engineer',
  description: 'Build reliable developer tools.',
  issueState: 'open',
  contentHash: hash,
  repository: 'openings-fixtures/jobs',
  createdAt: '2026-08-20T12:00:00.000Z',
  updatedAt: '2026-08-20T12:00:00.000Z',
  url: 'https://github.com/openings-fixtures/jobs/issues/42',
  sourceType: 'github-issue',
};

test('maps one eligible opening to web and provider-neutral social deliveries', () => {
  const envelope = toPlatformShadowEnvelope({
    job,
    socialPost: { text: 'New job on openings.dev', canonicalUrl: `https://openings.dev/jobs/${job.id}` },
    artifacts: [{ sha256: hash, byteSize: 2048, mediaType: 'image/png' }],
  });

  assert.equal(envelope.identity.tenant, 'openings');
  assert.deepEqual(envelope.deliveries.map(({ adapter }) => adapter), ['web.r2', 'social.shadow']);
  assert.equal(envelope.artifacts[0].locator, `temporary/openings/${job.id}/${hash}.png`);
  assert.deepEqual(envelope.deliveries[1].dependsOn, [{ deliveryId: 'web', state: 'complete' }]);
  assert.doesNotMatch(JSON.stringify(envelope), /token|secret|credential/iu);
});

test('keeps local paths beside, but never inside, the publication envelope', () => {
  const handoff = preparePlatformHandoff({
    job,
    socialPost: { text: 'New job on openings.dev', canonicalUrl: `https://openings.dev/jobs/${job.id}` },
    artifacts: [{ sha256: hash, byteSize: 2048, mediaType: 'image/png', filePath: '/runtime/card.png' }],
  });
  assert.deepEqual(handoff.uploads, [{ reference: handoff.envelope.artifacts[0], filePath: '/runtime/card.png' }]);
  assert.doesNotMatch(JSON.stringify(handoff.envelope), /\/runtime\//u);
});

test('rejects a closed opening', () => {
  assert.throws(() => toPlatformShadowEnvelope({
    job: { ...job, issueState: 'closed' },
    socialPost: { text: 'New job', canonicalUrl: `https://openings.dev/jobs/${job.id}` },
    artifacts: [],
  }), /open job/iu);
});

test('stages the handoff through the shared client without network access', async () => {
  const handoff = preparePlatformHandoff({
    job,
    socialPost: { text: 'New job on openings.dev', canonicalUrl: `https://openings.dev/jobs/${job.id}` },
    artifacts: [{ sha256: hash, byteSize: 2048, mediaType: 'image/png', filePath: '/runtime/card.png' }],
  });
  let staged;
  await stagePlatformHandoff(handoff, { prepare: (envelope) => {
    staged = envelope;
    return Promise.resolve({ id: 'local', path: '/runtime/outbox/local.json', envelope });
  } });
  assert.equal(staged, handoff.envelope);
});
