import assert from 'node:assert/strict';
import test from 'node:test';

import { readEnvironment } from '../src/config/env.mjs';

function base() {
  return {
    SOCIAL_AUTO_PUBLISH: 'true', OPENINGS_R2_ENABLED: 'true',
    OPENINGS_R2_ACCOUNT_ID: 'a'.repeat(32), OPENINGS_R2_BUCKET: 'openings-public-social-media',
    OPENINGS_R2_BUCKET_PURPOSE: 'openings-public-social-media-v1',
    OPENINGS_R2_PUBLIC_ORIGIN: 'https://media.openings.dev', OPENINGS_R2_ACCESS_KEY_ID: 'access-key',
    OPENINGS_R2_SECRET_ACCESS_KEY: 'secret-key',
    OPENINGS_R2_CAPACITY_JSON: JSON.stringify({ observedAt: '2026-09-10T12:00:00.000Z',
      standardStorageBytes: 0, classAOperations: 0, activeObjectCount: 0, retainedBytes: 0 }),
    BLUESKY_IDENTIFIER: 'openingshq.bsky.social', BLUESKY_APP_PASSWORD: 'app-secret',
    MASTODON_ACCESS_TOKEN: 'mastodon-secret', BUFFER_API_KEY: 'buffer-secret',
    BUFFER_ORGANIZATION_ID: 'org', BUFFER_TWITTER_CHANNEL_ID: 'twitter',
  };
}

test('selects direct R2 hosting without requiring a web deploy credential', () => {
  const config = readEnvironment({ env: base(), mode: 'scheduled' });
  assert.equal(config.r2Enabled, true);
  assert.equal(config.webDeploy, null);
  assert.equal(config.linkedinProvider, 'direct');
});

test('requires the dedicated R2 configuration only when direct hosting is enabled', () => {
  for (const key of ['OPENINGS_R2_ACCOUNT_ID', 'OPENINGS_R2_BUCKET', 'OPENINGS_R2_BUCKET_PURPOSE',
    'OPENINGS_R2_PUBLIC_ORIGIN', 'OPENINGS_R2_ACCESS_KEY_ID', 'OPENINGS_R2_SECRET_ACCESS_KEY',
    'OPENINGS_R2_CAPACITY_JSON']) {
    const env = base(); delete env[key];
    assert.throws(() => readEnvironment({ env, mode: 'scheduled' }), new RegExp(key, 'u'));
  }
});
