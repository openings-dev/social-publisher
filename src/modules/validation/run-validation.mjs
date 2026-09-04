import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { TID } from '@atproto/common-web';
import sharp from 'sharp';

import { runDryRun } from '../../cli/dry-run.mjs';
import { parseEditorialRequest, renderEditorialDryRun } from '../../cli/editorial.mjs';
import { runIntake } from '../../cli/intake.mjs';
import { runLinkedInStateMigration } from '../../cli/migrate-linkedin-state.mjs';
import { runTwitterStateMigration } from '../../cli/migrate-twitter-state.mjs';
import { runPreflight } from '../../cli/preflight.mjs';
import { parsePublicationRequest, runPublication } from '../../cli/publish.mjs';
import { runJobStoryPublication } from '../../cli/publish-story.mjs';
import { EDITORIAL_CATALOG } from '../../content/editorial-catalog.mjs';
import {
  assertEditorialCopyPolicy,
  EDITORIAL_CONTENT_VERSION,
} from '../../content/editorial-copy-policy.mjs';

import {
  BUFFER_API_ORIGIN,
  DEFAULT_SOCIAL_CHANNELS,
  DEPLOY_POLL_ATTEMPTS,
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  INSTAGRAM_CARD_VERSION,
  MAX_CHANNEL_ATTEMPTS,
  MAX_REPOSITORY_DISPATCH_BODY_CHARACTERS,
  OPEN_GRAPH_IMAGE_VERSION,
  OPENINGS_ORIGIN,
  SOCIAL_CHANNELS,
  SOCIAL_VIDEO_DURATION_SECONDS,
  SOCIAL_VIDEO_FPS,
  SOCIAL_VIDEO_HEIGHT,
  SOCIAL_VIDEO_VERSION,
  SOCIAL_VIDEO_WIDTH,
  STARVATION_THRESHOLD_MS,
  STATE_SCHEMA_VERSION,
  TWITTER_POST_MAX_GRAPHEMES,
} from '../../config/constants.mjs';
import { readEnvironment } from '../../config/env.mjs';
import { escapeAttribute, escapeHtml } from '../../shared/escape.mjs';
import { sha256 } from '../../shared/hash.mjs';
import { fetchJson } from '../../shared/http.mjs';
import { assertValidJobId, buildCanonicalJobUrl, isValidJobId } from '../../shared/job-id.mjs';
import {
  listSnapshotCommits,
  readJsonAtCommit,
  resolveGitCommit,
} from '../data/git-json.mjs';
import { loadSnapshot } from '../data/load-snapshot.mjs';
import { collectBridgeJobs, collectDelta } from '../intake/collect-delta.mjs';
import { isEligibleNewJob } from '../intake/eligibility.mjs';
import {
  blueskyRecordKey,
  publishToBluesky,
} from '../networks/bluesky-client.mjs';
import {
  mastodonIdempotencyKey,
  publishToMastodon,
} from '../networks/mastodon-client.mjs';
import {
  publishCarouselToInstagram,
  publishStoryToInstagram,
  publishToInstagram,
} from '../networks/instagram-client.mjs';
import {
  publishToLinkedInViaBuffer,
  verifyBufferLinkedInChannel,
} from '../networks/buffer-linkedin-client.mjs';
import {
  publishToTwitterViaBuffer,
  verifyBufferTwitterChannel,
} from '../networks/buffer-twitter-client.mjs';
import { publishToLinkedIn } from '../networks/linkedin-client.mjs';
import { deleteThreadsPost, publishToThreads } from '../networks/threads-client.mjs';
import {
  buildEditorialDispatchRequest,
  buildRepositoryDispatchRequest,
  requestEditorialDeployment,
  requestIncrementalBridgeDeployment,
} from '../deploy/web-deploy-client.mjs';
import { verifyPublicEditorial } from '../deploy/editorial-verifier.mjs';
import { verifyPublicBridge } from '../deploy/public-verifier.mjs';
import { validateEditorialCatalog } from '../editorial/editorial-model.mjs';
import {
  createEmptyEditorialState,
  enqueueEditorialItem,
  transitionEditorialStage,
  validateEditorialState,
} from '../editorial/editorial-state.mjs';
import { selectEditorialItem, slotForDate } from '../editorial/editorial-scheduler.mjs';
import {
  countGraphemes,
  formatSalary,
  formatSocialPost,
} from '../render/format-job.mjs';
import { createBridgeHtml, opportunityDescription } from '../render/html-page.mjs';
import { createSocialCardSvg, renderSocialCardPng } from '../render/social-card.mjs';
import * as socialCardModule from '../render/social-card.mjs';
import { createCjkFontStyle, SOCIAL_CARD_FONT_STACK } from '../render/cjk-fonts.mjs';
import { resolveSocialTheme } from '../render/social-theme.mjs';
import {
  buildReelFfmpegArguments,
  createOriginalSoundtrackWav,
  createReelStageSvgs,
  renderReelVideo,
} from '../render/reel-video.mjs';
import {
  createEditorialSlideSvg,
  createEditorialStorySvg,
  renderEditorialAssets,
  resolveEditorialTheme,
} from '../render/editorial-card.mjs';
import { formatEditorialCaption } from '../render/editorial-caption.mjs';
import { createBridgePublisher } from '../publishing/bridge-publisher.mjs';
import {
  META_MIGRATION_REVISION,
  META_RECONCILIATION_MARKER,
  migrateMetaPublication,
  parseMetaMigrationRequest,
} from '../publishing/meta-migration.mjs';
import {
  processIntakeSnapshots,
  processOnePublication,
} from '../publishing/orchestrator.mjs';
import { decideScheduledWork } from '../publishing/scheduled-work.mjs';
import {
  enqueueScheduledEditorial,
  prepareEditorialStageIntent,
  processEditorialStage,
} from '../publishing/editorial-publisher.mjs';
import {
  enqueueBridgeWork,
  enqueueJob,
  markJobClosed,
  resetFailedStage,
  resetPublishedMetaStages,
  selectNextInstagramStory,
  selectNextQueueItem,
  transitionPendingBridgeStage,
  transitionQueueStage,
} from '../state/queue-operations.mjs';
import { loadStateFile } from '../state/load-state.mjs';
import { saveStateFile } from '../state/save-state.mjs';
import { migrateLinkedInState } from '../state/linkedin-state-migration.mjs';
import { migrateTwitterState } from '../state/twitter-state-migration.mjs';
import {
  assertNoSensitiveKeys,
  migrateIntakeState,
  migratePublicationsState,
  migrateQueueState,
  validateIntakeState,
  validatePublicationsState,
  validateQueueState,
} from '../state/state-model.mjs';

const validations = [];

function validation(name, run) {
  validations.push({ name, run });
}

validation('exports the approved immutable constants', () => {
  assert.equal(STATE_SCHEMA_VERSION, 3);
  assert.equal(OPENINGS_ORIGIN, 'https://openings.dev');
  assert.equal(MAX_CHANNEL_ATTEMPTS, 3);
  assert.equal(DEPLOY_POLL_ATTEMPTS, 300);
  assert.equal(STARVATION_THRESHOLD_MS, 24 * 60 * 60 * 1000);
  assert.deepEqual([IMAGE_WIDTH, IMAGE_HEIGHT], [1200, 630]);
  assert.deepEqual([SOCIAL_VIDEO_WIDTH, SOCIAL_VIDEO_HEIGHT], [1080, 1920]);
  assert.equal(SOCIAL_VIDEO_FPS, 30);
  assert.equal(SOCIAL_VIDEO_DURATION_SECONDS, 9);
  assert.equal(INSTAGRAM_CARD_VERSION, '4');
  assert.equal(OPEN_GRAPH_IMAGE_VERSION, '2');
  assert.equal(SOCIAL_VIDEO_VERSION, '4');
  assert.deepEqual(SOCIAL_CHANNELS, ['bluesky', 'mastodon', 'twitter', 'threads', 'instagram', 'linkedin']);
  assert.deepEqual(DEFAULT_SOCIAL_CHANNELS, ['bluesky', 'mastodon', 'twitter']);
  assert.equal(TWITTER_POST_MAX_GRAPHEMES, 280);
});

validation('installs Noto CJK before every Ubuntu social-card render', async () => {
  const [validationWorkflow, publicationWorkflow, packageSource] = await Promise.all([
    readFile(fileURLToPath(new URL('../../../.github/workflows/validate.yml', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../../../.github/workflows/publish-social.yml', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
  ]);
  for (const workflow of [validationWorkflow, publicationWorkflow]) {
    assert.match(workflow, /apt-get install --yes fonts-noto-cjk/u);
    assert.match(workflow, /apt-get install --yes[^\n]*ffmpeg/u);
    assert.ok(workflow.indexOf('fonts-noto-cjk') < workflow.indexOf('npm run'));
  }
  assert.doesNotMatch(packageSource, /@fontsource\/noto-sans-(?:jp|kr|sc)/u);
});

validation('escapes untrusted HTML and attribute values', () => {
  assert.equal(escapeHtml('<script>"jobs" & roles</script>'), '&lt;script&gt;&quot;jobs&quot; &amp; roles&lt;/script&gt;');
  assert.equal(escapeAttribute("' onload='publish()"), '&#39; onload=&#39;publish()');
});

validation('creates deterministic SHA-256 hashes', () => {
  assert.equal(sha256('openings'), 'add875e192edf555f22898d640b2e2acd69cd7b84008318423a8d13ee1202464');
});

validation('resolves one immutable social theme deterministically from a job ID', async () => {
  const { SOCIAL_THEMES, resolveSocialTheme } = await import('../render/social-theme.mjs');
  assert.deepEqual(SOCIAL_THEMES.map(({ id, accent, soft }) => [id, accent, soft]), [
    ['mint', '#b0ec9c', '#ddf7d4'],
    ['butter', '#f3dda6', '#fbf3d9'],
    ['powder_blue', '#cadcf4', '#e8f0fa'],
    ['soft_grape', '#d9c9ee', '#efe8f7'],
    ['apricot', '#f2c8ae', '#fae9de'],
    ['sage', '#cfe7dc', '#e9f4ef'],
  ]);
  assert.ok(Object.isFrozen(SOCIAL_THEMES));
  SOCIAL_THEMES.forEach((theme) => assert.ok(Object.isFrozen(theme)));

  const jobIds = [
    'gh_fb912858247d5261cc51e874',
    'gh_c734e6f23042238380854406',
    'gh_09b7c05c87697b82d8b34e7a',
    'gh_2d656e214b3b872d04339314',
    'gh_00f12f8090b3e56bccda0b4f',
    'gh_964d59a68b31e3bb24c601f7',
    'gh_42bf102c156fbdce471069b8',
  ];
  const firstPass = jobIds.map(resolveSocialTheme);
  const secondPass = jobIds.map(resolveSocialTheme);
  assert.deepEqual(secondPass, firstPass);
  assert.ok(new Set(firstPass.map(({ id }) => id)).size > 1);
  assert.throws(() => resolveSocialTheme('invalid'), /job ID/u);
});

validation('resolves safe Git refs and lists every immutable snapshot boundary', async () => {
  const previous = '1'.repeat(40);
  const manifestCommit = '2'.repeat(40);
  const current = '3'.repeat(40);
  const calls = [];
  const execFileImpl = async (_command, argumentsList) => {
    calls.push(argumentsList);
    if (argumentsList.includes('rev-parse')) return { stdout: `${current}\n` };
    if (argumentsList.includes('merge-base')) return { stdout: '' };
    if (argumentsList.includes('rev-list')) return { stdout: `${manifestCommit}\n` };
    throw new Error('Unexpected fake Git call');
  };
  assert.equal(await resolveGitCommit('/data', 'main', { execFileImpl }), current);
  assert.deepEqual(
    await listSnapshotCommits('/data', previous, current, { execFileImpl }),
    [previous, manifestCommit, current],
  );
  assert.equal(calls.some((call) => call.includes('--reverse')), true);
  await assert.rejects(resolveGitCommit('/data', '--upload-pack=evil', { execFileImpl }), /reference/i);
  await assert.rejects(listSnapshotCommits('/data', previous, current, {
    execFileImpl: async (_command, argumentsList) => {
      if (argumentsList.includes('merge-base')) throw new Error('not ancestor');
      return { stdout: '' };
    },
  }), /ancestor/i);
});

validation('accepts only canonical job identifiers', () => {
  const id = 'gh_0123456789abcdef01234567';
  assert.equal(isValidJobId(id), true);
  assert.equal(isValidJobId('gh_0123'), false);
  assert.equal(isValidJobId('../jobs'), false);
  assert.equal(assertValidJobId(id), id);
  assert.throws(() => assertValidJobId('gh_Z123456789abcdef01234567'), /Invalid job ID/);
  assert.equal(buildCanonicalJobUrl(id), `${OPENINGS_ORIGIN}/jobs/${id}`);
});

validation('keeps dry runs operational without secrets', () => {
  const config = readEnvironment({ env: {}, mode: 'dry-run' });
  assert.equal(config.publishEnabled, false);
  assert.equal(config.publicSiteOrigin, OPENINGS_ORIGIN);
});

validation('requires exact manual publication and reset gates', () => {
  const jobId = 'gh_0123456789abcdef01234567';
  assert.deepEqual(parsePublicationRequest({
    mode: 'controlled',
    jobId,
    confirmation: 'PUBLISH_ONE_JOB',
  }), { mode: 'controlled', jobId, stage: null });
  assert.throws(() => parsePublicationRequest({
    mode: 'controlled',
    jobId,
    confirmation: 'publish one job',
  }), /exact confirmation/i);
  assert.deepEqual(parsePublicationRequest({
    mode: 'retry-stage',
    jobId,
    stage: 'mastodon',
    confirmation: 'RESET_FAILED_STAGE',
  }), { mode: 'retry-stage', jobId, stage: 'mastodon' });
  assert.throws(() => parsePublicationRequest({
    mode: 'retry-stage',
    jobId,
    stage: 'all',
    confirmation: 'RESET_FAILED_STAGE',
  }), /retry stage/i);
  assert.deepEqual(parsePublicationRequest({
    mode: 'retry-stage',
    jobId,
    stage: 'linkedin',
    confirmation: 'RESET_FAILED_STAGE',
  }), { mode: 'retry-stage', jobId, stage: 'linkedin' });
  assert.deepEqual(parsePublicationRequest({
    mode: 'retry-stage',
    jobId,
    stage: 'intake-bridge',
    confirmation: 'RESET_FAILED_STAGE',
  }), { mode: 'retry-stage', jobId, stage: 'intake-bridge' });
});

validation('resets a failed snapshot-intake bridge without publishing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-intake-bridge-reset-'));
  const jobId = 'gh_53d53bb4cfce441a70f5e40a';
  const failedAt = '2026-09-04T11:25:35.979Z';
  try {
    await Promise.all([
      saveStateFile(join(directory, 'intake.json'), {
        schemaVersion: STATE_SCHEMA_VERSION,
        processedSnapshot: null,
        pendingBridges: [{
          jobId,
          contentHash: '1'.repeat(64),
          dataHash: '2'.repeat(64),
          dataCommit: '3'.repeat(40),
          reason: 'new',
          stage: {
            status: 'failed',
            attempts: MAX_CHANNEL_ATTEMPTS,
            updatedAt: failedAt,
            lastError: { code: 'deployment', at: failedAt },
            lastReset: null,
            result: null,
          },
        }],
        removedJobs: [],
      }, validateIntakeState),
      saveStateFile(join(directory, 'queue.json'), {
        schemaVersion: STATE_SCHEMA_VERSION,
        items: [],
      }, validateQueueState),
      saveStateFile(join(directory, 'publications.json'), {
        schemaVersion: STATE_SCHEMA_VERSION,
        jobs: {},
      }, validatePublicationsState),
    ]);
    const result = await runPublication({
      request: {
        mode: 'retry-stage',
        jobId,
        stage: 'intake-bridge',
        confirmation: 'RESET_FAILED_STAGE',
      },
      dataRepositoryPath: '/not-used',
      stateDirectory: directory,
      wordmarkPath: '/not-used',
      outputPath: '/not-used',
      log: () => {},
    });
    assert.deepEqual(result, { outcome: 'reset', jobId, stage: 'intake-bridge' });
    const intake = await loadStateFile(
      join(directory, 'intake.json'),
      validateIntakeState,
      migrateIntakeState,
    );
    assert.equal(intake.pendingBridges[0].stage.status, 'pending');
    assert.equal(intake.pendingBridges[0].stage.attempts, 0);
    assert.equal(intake.pendingBridges[0].stage.lastError, null);
    assert.equal(intake.pendingBridges[0].stage.result, null);
    assert.equal(intake.pendingBridges[0].stage.lastReset.reason, 'manual_reset');
    assert.equal(Number.isFinite(Date.parse(intake.pendingBridges[0].stage.updatedAt)), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('wires LinkedIn through the publication CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-linkedin-publish-'));
  const job = makeJob({ id: 'gh_777788889999aaaabbbbcccc' });
  const snapshot = makeLoadedSnapshot({
    commit: '7'.repeat(40),
    generatedAt: '2026-09-01T13:00:00.000Z',
    dataHash: '7'.repeat(64),
    jobs: [job],
  });
  let linkedinCalls = 0;
  try {
    await Promise.all([
      saveStateFile(join(directory, 'queue.json'), {
        schemaVersion: STATE_SCHEMA_VERSION,
        items: [],
      }, validateQueueState),
      saveStateFile(join(directory, 'publications.json'), {
        schemaVersion: STATE_SCHEMA_VERSION,
        jobs: {},
      }, validatePublicationsState),
    ]);
    const result = await runPublication({
      request: {
        mode: 'controlled',
        jobId: job.id,
        confirmation: 'PUBLISH_ONE_JOB',
      },
      dataRepositoryPath: '/fixture/data',
      stateDirectory: directory,
      wordmarkPath: '/fixture/wordmark.svg',
      outputPath: join(directory, 'output'),
      env: {
        WEB_DEPLOY_TOKEN: 'deploy-secret',
        BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
        BLUESKY_APP_PASSWORD: 'bluesky-secret',
        MASTODON_ACCESS_TOKEN: 'mastodon-secret',
        LINKEDIN_AUTO_PUBLISH: 'true',
        LINKEDIN_ACCESS_TOKEN: 'linkedin-secret',
        LINKEDIN_ORGANIZATION_ID: '108765432',
        LINKEDIN_API_VERSION: '202608',
        BUFFER_API_KEY: 'buffer-secret',
        BUFFER_ORGANIZATION_ID: '68b68d3ac159685850cf2b8d',
        BUFFER_TWITTER_CHANNEL_ID: '68b68e0fc159685850cf2c22',
      },
      log: () => {},
      dependencies: {
        resolveGitCommit: async () => snapshot.commit,
        loadCanonicalWordmark: async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        loadSnapshot: async () => snapshot,
        createBridgePublisher: () => async () => ({
          status: 'deployed',
          imageUrl: `https://openings.dev/jobs/${job.id}/opengraph-image.png`,
        }),
        publishBluesky: async () => ({ status: 'published' }),
        publishMastodon: async () => ({ status: 'published' }),
        publishTwitter: async () => ({
          status: 'published',
          id: 'buffer-tweet-9988776655',
          url: 'https://x.com/openingsdev/status/9988776655',
          provider: 'buffer',
        }),
        publishLinkedIn: async ({ post: selectedPost }) => {
          linkedinCalls += 1;
          assert.equal(selectedPost.canonicalUrl, `https://openings.dev/jobs/${job.id}`);
          return {
            status: 'published',
            id: 'urn:li:share:9988776655',
            url: 'https://www.linkedin.com/feed/update/urn:li:share:9988776655/',
          };
        },
      },
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(linkedinCalls, 1);
    assert.equal(JSON.parse(await readFile(join(directory, 'queue.json')))
      .items[0].linkedin.status, 'published');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('routes the LinkedIn queue stage through Buffer with the verified bridge image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-buffer-linkedin-publish-'));
  const job = makeJob({ id: 'gh_777788889999aaaabbbbcccd' });
  const snapshot = makeLoadedSnapshot({
    commit: '8'.repeat(40),
    generatedAt: '2026-09-01T13:30:00.000Z',
    dataHash: '8'.repeat(64),
    jobs: [job],
  });
  const imageUrl = `https://openings.dev/jobs/${job.id}/opengraph-image.png`;
  const calls = [];
  try {
    await Promise.all([
      saveStateFile(join(directory, 'queue.json'), {
        schemaVersion: STATE_SCHEMA_VERSION,
        items: [],
      }, validateQueueState),
      saveStateFile(join(directory, 'publications.json'), {
        schemaVersion: STATE_SCHEMA_VERSION,
        jobs: {},
      }, validatePublicationsState),
    ]);
    const result = await runPublication({
      request: {
        mode: 'controlled',
        jobId: job.id,
        confirmation: 'PUBLISH_ONE_JOB',
      },
      dataRepositoryPath: '/fixture/data',
      stateDirectory: directory,
      wordmarkPath: '/fixture/wordmark.svg',
      outputPath: join(directory, 'output'),
      env: {
        WEB_DEPLOY_TOKEN: 'deploy-secret',
        BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
        BLUESKY_APP_PASSWORD: 'bluesky-secret',
        MASTODON_ACCESS_TOKEN: 'mastodon-secret',
        LINKEDIN_AUTO_PUBLISH: 'true',
        LINKEDIN_PROVIDER: 'buffer',
        BUFFER_API_KEY: 'buffer-secret',
        BUFFER_ORGANIZATION_ID: '68b68d3ac159685850cf2b8d',
        BUFFER_LINKEDIN_CHANNEL_ID: '68b68e0fc159685850cf2c11',
        BUFFER_TWITTER_CHANNEL_ID: '68b68e0fc159685850cf2c22',
      },
      log: () => {},
      dependencies: {
        resolveGitCommit: async () => snapshot.commit,
        loadCanonicalWordmark: async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        loadSnapshot: async () => snapshot,
        createBridgePublisher: () => async () => ({ status: 'deployed', imageUrl }),
        publishBluesky: async () => ({ status: 'published' }),
        publishMastodon: async () => ({ status: 'published' }),
        publishTwitter: async () => ({
          status: 'published',
          id: 'buffer-tweet-cli-0',
          url: 'https://x.com/openingsdev/status/123456789',
          provider: 'buffer',
        }),
        publishLinkedInViaBuffer: async (input) => {
          calls.push(input);
          return {
            status: 'published',
            id: 'buffer-post-cli-1',
            url: 'https://www.linkedin.com/feed/update/urn:li:share:123456789/',
            provider: 'buffer',
          };
        },
      },
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].job.id, job.id);
    assert.equal(calls[0].post.canonicalUrl, `https://openings.dev/jobs/${job.id}`);
    assert.equal(calls[0].imageUrl, imageUrl);
    assert.equal(calls[0].publicSiteOrigin, 'https://openings.dev');
    assert.equal(calls[0].apiKey, 'buffer-secret');
    assert.equal(calls[0].organizationId, '68b68d3ac159685850cf2b8d');
    assert.equal(calls[0].channelId, '68b68e0fc159685850cf2c11');
    assert.equal(calls[0].apiOrigin, 'https://api.buffer.com');
    assert.equal(Object.hasOwn(calls[0], 'png'), false);
    assert.equal(Object.hasOwn(calls[0], 'accessToken'), false);
    assert.equal(result.queueState.items[0].linkedin.result.provider, 'buffer');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('routes the Twitter queue stage through Buffer with the verified bridge image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-buffer-twitter-publish-'));
  const job = makeJob({ id: 'gh_111122223333444455556666' });
  const snapshot = makeLoadedSnapshot({
    commit: '7'.repeat(40),
    generatedAt: '2026-09-03T13:30:00.000Z',
    dataHash: '7'.repeat(64),
    jobs: [job],
  });
  const imageUrl = `https://openings.dev/jobs/${job.id}/opengraph-image.png`;
  const calls = [];
  try {
    await Promise.all([
      saveStateFile(join(directory, 'queue.json'), {
        schemaVersion: STATE_SCHEMA_VERSION,
        items: [],
      }, validateQueueState),
      saveStateFile(join(directory, 'publications.json'), {
        schemaVersion: STATE_SCHEMA_VERSION,
        jobs: {},
      }, validatePublicationsState),
    ]);
    const result = await runPublication({
      request: {
        mode: 'controlled',
        jobId: job.id,
        confirmation: 'PUBLISH_ONE_JOB',
      },
      dataRepositoryPath: '/fixture/data',
      stateDirectory: directory,
      wordmarkPath: '/fixture/wordmark.svg',
      outputPath: join(directory, 'output'),
      env: {
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
        createBridgePublisher: () => async () => ({ status: 'deployed', imageUrl }),
        publishBluesky: async () => ({ status: 'published' }),
        publishMastodon: async () => ({ status: 'published' }),
        publishTwitterViaBuffer: async (input) => {
          calls.push(input);
          return {
            status: 'published',
            id: 'buffer-tweet-cli-1',
            url: 'https://x.com/openingsdev/status/998877',
            provider: 'buffer',
          };
        },
      },
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].job.id, job.id);
    assert.ok(calls[0].post.text.length <= 280);
    assert.equal(calls[0].imageUrl, imageUrl);
    assert.equal(calls[0].publicSiteOrigin, 'https://openings.dev');
    assert.equal(calls[0].apiKey, 'buffer-secret');
    assert.equal(calls[0].organizationId, '68b68d3ac159685850cf2b8d');
    assert.equal(calls[0].channelId, '68b68e0fc159685850cf2c22');
    assert.equal(calls[0].apiOrigin, 'https://api.buffer.com');
    assert.equal(result.queueState.items[0].twitter.result.provider, 'buffer');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('accepts bounded JSON responses and rejects unsafe response types', async () => {
  const response = await fetchJson('https://example.test/data.json', {
    fetchImpl: async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  });
  assert.deepEqual(response, { ok: true });
  await assert.rejects(
    fetchJson('https://example.test/page', {
      fetchImpl: async () => new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    }),
    /JSON content type/,
  );
});

validation('publishes an explicit LinkedIn article card with the canonical social image', async () => {
  const job = makeJob({ excerpt: 'Build reliable developer tools for public communities.' });
  const post = formatSocialPost(job);
  const png = Buffer.from('canonical-png');
  const requests = [];
  const responses = [
    new Response(JSON.stringify({ elements: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(JSON.stringify({
      value: {
        uploadUrl: 'https://www.linkedin.com/dms-uploads/fixture?token=signed',
        image: 'urn:li:image:fixture-image',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(null, { status: 201 }),
    new Response(JSON.stringify({
      id: 'urn:li:image:fixture-image',
      owner: 'urn:li:organization:108765432',
      status: 'AVAILABLE',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(null, {
      status: 201,
      headers: { 'x-restli-id': 'urn:li:share:123456789' },
    }),
  ];
  const result = await publishToLinkedIn({
    job,
    post,
    png,
    accessToken: 'linkedin-secret',
    organizationId: '108765432',
    apiVersion: '202608',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected LinkedIn request');
      return response;
    },
    sleep: async () => {},
  });

  assert.deepEqual(result, {
    status: 'published',
    id: 'urn:li:share:123456789',
    url: 'https://www.linkedin.com/feed/update/urn:li:share:123456789/',
  });
  assert.match(requests[0].url, /\/rest\/posts\?/u);
  assert.equal(JSON.parse(requests[1].options.body).initializeUploadRequest.owner,
    'urn:li:organization:108765432');
  assert.equal(requests[2].options.method, 'PUT');
  assert.equal(requests[2].options.headers['Content-Type'], 'image/png');
  assert.equal(requests[2].options.body, png);
  assert.deepEqual(JSON.parse(requests[4].options.body).content.article, {
    source: post.canonicalUrl,
    thumbnail: 'urn:li:image:fixture-image',
    title: job.title,
    description: opportunityDescription(job),
  });
  for (const request of requests.filter(({ url }) => url.startsWith('https://api.linkedin.com/'))) {
    assert.equal(request.options.headers['Linkedin-Version'], '202608');
    assert.equal(request.options.headers['X-Restli-Protocol-Version'], '2.0.0');
    assert.equal(request.options.headers.Authorization, 'Bearer linkedin-secret');
  }
  for (const request of requests) assert.equal(request.options.redirect, 'error');
  assert.equal(responses.length, 0);
});

validation('reconciles an existing LinkedIn article before uploading another image', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  let requests = 0;
  const result = await publishToLinkedIn({
    job,
    post,
    png: Buffer.from('canonical-png'),
    accessToken: 'linkedin-secret',
    organizationId: '108765432',
    apiVersion: '202608',
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({
        elements: [{
          id: 'urn:li:ugcPost:987654321',
          author: 'urn:li:organization:108765432',
          commentary: 'Existing publication',
          content: { article: { source: post.canonicalUrl } },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(result, {
    status: 'reconciled',
    id: 'urn:li:ugcPost:987654321',
    url: 'https://www.linkedin.com/feed/update/urn:li:ugcPost:987654321/',
  });
  assert.equal(requests, 1);
});

validation('does not reconcile a LinkedIn post whose URL only has the canonical prefix', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const responses = [
    new Response(JSON.stringify({
      elements: [{
        id: 'urn:li:share:9988776655',
        author: 'urn:li:organization:108765432',
        commentary: `Different job: ${post.canonicalUrl}/another`,
        content: {},
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({
      value: {
        uploadUrl: 'https://www.linkedin.com/dms-uploads/fixture?token=signed',
        image: 'urn:li:image:fixture-image',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(null, { status: 201 }),
    new Response(JSON.stringify({
      id: 'urn:li:image:fixture-image',
      owner: 'urn:li:organization:108765432',
      status: 'AVAILABLE',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(null, {
      status: 201,
      headers: { 'x-restli-id': 'urn:li:share:123456789' },
    }),
  ];
  const result = await publishToLinkedIn({
    job,
    post,
    png: Buffer.from('canonical-png'),
    accessToken: 'linkedin-secret',
    organizationId: '108765432',
    apiVersion: '202608',
    fetchImpl: async () => responses.shift(),
    sleep: async () => {},
  });
  assert.equal(result.status, 'published');
  assert.equal(result.id, 'urn:li:share:123456789');
  assert.equal(responses.length, 0);
});

validation('reconciles LinkedIn after an ambiguous post creation failure', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const responses = [
    new Response(JSON.stringify({ elements: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(JSON.stringify({
      value: {
        uploadUrl: 'https://www.linkedin.com/dms-uploads/fixture?token=signed',
        image: 'urn:li:image:fixture-image',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(null, { status: 201 }),
    new Response(JSON.stringify({
      id: 'urn:li:image:fixture-image',
      owner: 'urn:li:organization:108765432',
      status: 'AVAILABLE',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Error('socket closed after request body'),
    new Response(JSON.stringify({
      elements: [{
        id: 'urn:li:share:1122334455',
        author: 'urn:li:organization:108765432',
        commentary: post.text,
        content: {},
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  ];
  const result = await publishToLinkedIn({
    job,
    post,
    png: Buffer.from('canonical-png'),
    accessToken: 'linkedin-secret',
    organizationId: '108765432',
    apiVersion: '202608',
    fetchImpl: async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    sleep: async () => {},
  });
  assert.equal(result.status, 'reconciled');
  assert.equal(result.id, 'urn:li:share:1122334455');
  assert.equal(responses.length, 0);
});

validation('polls LinkedIn image processing immediately and waits only between checks', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const sleeps = [];
  const responses = [
    new Response(JSON.stringify({ elements: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(JSON.stringify({
      value: {
        uploadUrl: 'https://www.linkedin.com/dms-uploads/fixture?token=signed',
        image: 'urn:li:image:fixture-image',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(null, { status: 201 }),
    new Response(JSON.stringify({
      id: 'urn:li:image:fixture-image',
      owner: 'urn:li:organization:108765432',
      status: 'PROCESSING',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({
      id: 'urn:li:image:fixture-image',
      owner: 'urn:li:organization:108765432',
      status: 'AVAILABLE',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(null, {
      status: 201,
      headers: { 'x-restli-id': 'urn:li:share:123456789' },
    }),
  ];
  await publishToLinkedIn({
    job,
    post,
    png: Buffer.from('canonical-png'),
    accessToken: 'linkedin-secret',
    organizationId: '108765432',
    apiVersion: '202608',
    fetchImpl: async () => responses.shift(),
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    imagePollDelayMs: 25,
  });
  assert.deepEqual(sleeps, [25]);
  assert.equal(responses.length, 0);
});

validation('preserves a malformed successful LinkedIn create response after reconciliation', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const responses = [
    new Response(JSON.stringify({ elements: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(JSON.stringify({
      value: {
        uploadUrl: 'https://www.linkedin.com/dms-uploads/fixture?token=signed',
        image: 'urn:li:image:fixture-image',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(null, { status: 201 }),
    new Response(JSON.stringify({
      id: 'urn:li:image:fixture-image',
      owner: 'urn:li:organization:108765432',
      status: 'AVAILABLE',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(null, { status: 201 }),
    new Response(JSON.stringify({ elements: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ];
  await assert.rejects(publishToLinkedIn({
    job,
    post,
    png: Buffer.from('canonical-png'),
    accessToken: 'linkedin-secret',
    organizationId: '108765432',
    apiVersion: '202608',
    fetchImpl: async () => responses.shift(),
    sleep: async () => {},
  }), (error) => error.code === 'linkedin_response');
  assert.equal(responses.length, 0);
});

validation('requires LinkedIn post creation to return the documented 201 status', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const responses = [
    new Response(JSON.stringify({ elements: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(JSON.stringify({
      value: {
        uploadUrl: 'https://www.linkedin.com/dms-uploads/fixture?token=signed',
        image: 'urn:li:image:fixture-image',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(null, { status: 201 }),
    new Response(JSON.stringify({
      id: 'urn:li:image:fixture-image',
      owner: 'urn:li:organization:108765432',
      status: 'AVAILABLE',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(null, {
      status: 200,
      headers: { 'x-restli-id': 'urn:li:share:123456789' },
    }),
    new Response(JSON.stringify({ elements: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ];
  await assert.rejects(publishToLinkedIn({
    job,
    post,
    png: Buffer.from('canonical-png'),
    accessToken: 'linkedin-secret',
    organizationId: '108765432',
    apiVersion: '202608',
    fetchImpl: async () => responses.shift(),
    sleep: async () => {},
  }), (error) => error.code === 'linkedin_response');
  assert.equal(responses.length, 0);
});

validation('fails closed for unsafe LinkedIn uploads and failed image processing', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const configuration = {
    job,
    post,
    png: Buffer.from('canonical-png'),
    accessToken: 'linkedin-secret',
    organizationId: '108765432',
    apiVersion: '202608',
    sleep: async () => {},
  };
  await assert.rejects(publishToLinkedIn({
    ...configuration,
    fetchImpl: async (_url, _options) => new Response(JSON.stringify(
      _options?.method === 'POST'
        ? {
          value: {
            uploadUrl: 'https://uploads.example.test/steal',
            image: 'urn:li:image:fixture-image',
          },
        }
        : { elements: [] },
    ), { status: 200, headers: { 'content-type': 'application/json' } }),
  }), (error) => error.code === 'linkedin_image_initialization');

  const responses = [
    { elements: [] },
    {
      value: {
        uploadUrl: 'https://www.linkedin.com/dms-uploads/fixture?token=signed',
        image: 'urn:li:image:fixture-image',
      },
    },
    null,
    {
      id: 'urn:li:image:fixture-image',
      owner: 'urn:li:organization:108765432',
      status: 'PROCESSING_FAILED',
    },
  ];
  await assert.rejects(publishToLinkedIn({
    ...configuration,
    fetchImpl: async () => {
      const payload = responses.shift();
      return payload === null
        ? new Response(null, { status: 201 })
        : new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
    },
  }), (error) => error.code === 'linkedin_image_processing');
});

validation('rejects invalid LinkedIn configuration before making a request', async () => {
  let requests = 0;
  const job = makeJob();
  const base = {
    job,
    post: formatSocialPost(job),
    png: Buffer.from('canonical-png'),
    accessToken: 'linkedin-secret',
    organizationId: '108765432',
    apiVersion: '202608',
    fetchImpl: async () => { requests += 1; },
  };
  for (const [invalid, expectedCode] of [
    [{ accessToken: '' }, 'linkedin_authentication'],
    [{ organizationId: 'openings-dev' }, 'linkedin_configuration'],
    [{ apiVersion: 'v202608' }, 'linkedin_configuration'],
    [{ apiOrigin: 'http://api.linkedin.com' }, 'linkedin_configuration'],
  ]) {
    await assert.rejects(publishToLinkedIn({
      ...base,
      ...invalid,
    }), (error) => error.code === expectedCode
      && !error.message.includes('linkedin-secret'));
  }
  assert.equal(requests, 0);
});

validation('categorizes LinkedIn authentication and malformed provider responses', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const base = {
    job,
    post,
    png: Buffer.from('canonical-png'),
    accessToken: 'linkedin-secret',
    organizationId: '108765432',
    apiVersion: '202608',
    sleep: async () => {},
  };
  await assert.rejects(publishToLinkedIn({
    ...base,
    fetchImpl: async () => new Response(JSON.stringify({ message: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }),
  }), (error) => error.code === 'linkedin_authentication'
    && !error.message.includes('forbidden'));

  await assert.rejects(publishToLinkedIn({
    ...base,
    fetchImpl: async () => new Response('<html>not json</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  }), (error) => error.code === 'linkedin_response');

  await assert.rejects(publishToLinkedIn({
    ...base,
    fetchImpl: async () => new Response(JSON.stringify({
      elements: [{
        id: 'urn:li:share:not-numeric',
        author: 'urn:li:organization:108765432',
        commentary: post.text,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  }), (error) => error.code === 'linkedin_response');

  const invalidImageResponses = [
    { elements: [] },
    {
      value: {
        uploadUrl: 'https://www.linkedin.com/dms-uploads/fixture?token=signed',
        image: 'urn:li:image:invalid:value',
      },
    },
  ];
  await assert.rejects(publishToLinkedIn({
    ...base,
    fetchImpl: async () => new Response(JSON.stringify(invalidImageResponses.shift()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  }), (error) => error.code === 'linkedin_image_initialization');
});

validation('scopes Buffer channel verification to the configured organization', async () => {
  const requests = [];
  const channel = await verifyBufferLinkedInChannel({
    apiKey: 'buffer-secret',
    organizationId: '68b68d3ac159685850cf2b8d',
    channelId: '68b68e0fc159685850cf2c11',
    apiOrigin: 'https://api.buffer.com',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({
        data: {
          channels: [{
            id: '68b68e0fc159685850cf2c11',
            service: 'linkedin',
            isDisconnected: false,
            isLocked: false,
          }],
        },
      });
    },
  });
  assert.deepEqual(channel, {
    id: '68b68e0fc159685850cf2c11',
    service: 'linkedin',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.buffer.com');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.signal instanceof AbortSignal, true);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer buffer-secret');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
  const request = JSON.parse(requests[0].options.body);
  assert.match(request.query, /query GetChannels/u);
  assert.match(request.query, /channels\(input:\s*\{\s*organizationId:\s*\$organizationId/u);
  assert.deepEqual(request.variables, { organizationId: '68b68d3ac159685850cf2b8d' });
});

validation('rejects unsafe Buffer client configuration before requesting a channel', async () => {
  const base = {
    apiKey: 'buffer-secret',
    organizationId: '68b68d3ac159685850cf2b8d',
    channelId: '68b68e0fc159685850cf2c11',
    apiOrigin: 'https://api.buffer.com',
    fetchImpl: async () => { throw new Error('request must not run'); },
  };
  for (const override of [
    { apiKey: '' },
    { organizationId: '' },
    { channelId: ' ' },
    { apiOrigin: 'http://api.buffer.com' },
    { apiOrigin: 'https://user:secret@api.buffer.com' },
    { apiOrigin: 'https://api.buffer.com/graphql' },
  ]) {
    await assert.rejects(verifyBufferLinkedInChannel({ ...base, ...override }), (error) => (
      error.code === 'buffer_configuration'
      && !error.message.includes('buffer-secret')
    ));
  }
});

validation('fails closed for unsafe Buffer responses and unusable LinkedIn channels', async () => {
  const base = {
    apiKey: 'buffer-secret',
    organizationId: '68b68d3ac159685850cf2b8d',
    channelId: '68b68e0fc159685850cf2c11',
    apiOrigin: 'https://api.buffer.com',
  };
  const cases = [
    [new Response(null, { status: 401 }), 'buffer_authentication'],
    [new Response(null, { status: 403 }), 'buffer_authentication'],
    [new Response(null, { status: 429 }), 'buffer_rate_limit'],
    [new Response(null, { status: 302, headers: { location: 'https://redirect.test' } }), 'buffer_response'],
    [new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'buffer_response'],
    [new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }), 'buffer_response'],
    [jsonResponse({ errors: [{ message: 'secret provider detail' }] }), 'buffer_graphql'],
    [jsonResponse({ data: { channels: [] } }), 'buffer_configuration'],
    [jsonResponse({ data: { channels: [{
      id: base.channelId, service: 'facebook', isDisconnected: false, isLocked: false,
    }] } }), 'buffer_configuration'],
    [jsonResponse({ data: { channels: [{
      id: base.channelId, service: 'linkedin', isDisconnected: true, isLocked: false,
    }] } }), 'buffer_configuration'],
    [jsonResponse({ data: { channels: [{
      id: base.channelId, service: 'linkedin', isDisconnected: false, isLocked: true,
    }] } }), 'buffer_configuration'],
  ];
  for (const [response, code] of cases) {
    await assert.rejects(verifyBufferLinkedInChannel({
      ...base,
      fetchImpl: async () => response,
    }), (error) => (
      error.code === code
      && !`${error.message}${JSON.stringify(error.diagnostic ?? null)}`.includes('buffer-secret')
      && !`${error.message}${JSON.stringify(error.diagnostic ?? null)}`.includes('secret provider detail')
    ));
  }
});

function bufferChannelPayload() {
  return {
    data: {
      channels: [{
        id: '68b68e0fc159685850cf2c11',
        service: 'linkedin',
        isDisconnected: false,
        isLocked: false,
      }],
    },
  };
}

function bufferPublicationOptions(overrides = {}) {
  const job = makeJob();
  return {
    job,
    post: formatSocialPost(job),
    imageUrl: `https://openings.dev/jobs/${job.id}/opengraph-image.png`,
    publicSiteOrigin: 'https://openings.dev',
    apiKey: 'buffer-secret',
    organizationId: '68b68d3ac159685850cf2b8d',
    channelId: '68b68e0fc159685850cf2c11',
    apiOrigin: 'https://api.buffer.com',
    pollAttempts: 3,
    pollDelayMs: 25,
    sleep: async () => {},
    ...overrides,
  };
}

validation('publishes a LinkedIn image immediately through Buffer and waits for its public URL', async () => {
  const requests = [];
  const delays = [];
  const responses = [
    bufferChannelPayload(),
    { data: { posts: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
    { data: { createPost: {
      __typename: 'PostActionSuccess',
      post: { id: 'buffer-post-1', status: 'sending', externalLink: null },
    } } },
    { data: { post: { id: 'buffer-post-1', status: 'sending', externalLink: null } } },
    { data: { post: {
      id: 'buffer-post-1',
      status: 'sent',
      externalLink: 'https://www.linkedin.com/feed/update/urn:li:share:123456789/',
    } } },
  ];
  const options = bufferPublicationOptions({
    fetchImpl: async (url, requestOptions) => {
      requests.push({ url, options: requestOptions });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected Buffer request');
      return jsonResponse(response);
    },
    sleep: async (delay) => delays.push(delay),
  });
  const result = await publishToLinkedInViaBuffer(options);
  assert.deepEqual(result, {
    status: 'published',
    id: 'buffer-post-1',
    url: 'https://www.linkedin.com/feed/update/urn:li:share:123456789/',
    provider: 'buffer',
  });
  assert.deepEqual(requests.map(({ options: request }) => JSON.parse(request.body).operationName), [
    'GetChannels',
    'GetRecentPosts',
    'CreateLinkedInPost',
    'GetPost',
    'GetPost',
  ]);
  const creation = JSON.parse(requests[2].options.body);
  assert.match(creation.query, /schedulingType:\s*automatic/u);
  assert.match(creation.query, /mode:\s*shareNow/u);
  assert.match(creation.query, /image:\s*\{\s*url:\s*\$imageUrl/u);
  assert.match(creation.query, /altText:\s*\$altText/u);
  assert.doesNotMatch(creation.query, /addToQueue|customScheduled|dueAt|needsApproval|saveToDraft/u);
  assert.equal(creation.query.includes(options.post.text), false);
  assert.deepEqual(creation.variables, {
    text: options.post.text,
    channelId: options.channelId,
    imageUrl: options.imageUrl,
    altText: 'Senior TypeScript Engineer job opening on openings.dev',
  });
  assert.deepEqual(delays, [25]);
});

validation('rejects unsafe Buffer media before making a provider request', async () => {
  const values = [
    'http://openings.dev/jobs/example/opengraph-image.png',
    'https://user:secret@openings.dev/jobs/example/opengraph-image.png',
    'https://cdn.example.test/jobs/example/opengraph-image.png',
  ];
  for (const imageUrl of values) {
    let calls = 0;
    await assert.rejects(publishToLinkedInViaBuffer(bufferPublicationOptions({
      imageUrl,
      fetchImpl: async () => { calls += 1; return jsonResponse(bufferChannelPayload()); },
    })), (error) => error.code === 'buffer_media');
    assert.equal(calls, 0);
  }
});

validation('categorizes Buffer mutation errors without leaking provider details', async () => {
  for (const [typename, message, code] of [
    ['UnauthorizedError', 'private provider authorization detail', 'buffer_authentication'],
    ['LimitReachedError', 'private provider limit detail', 'buffer_rate_limit'],
    ['InvalidInputError', 'Failed to fetch image dimensions from private URL', 'buffer_media'],
    ['UnexpectedError', 'private provider publication detail', 'buffer_publication'],
  ]) {
    const responses = [
      bufferChannelPayload(),
      { data: { posts: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
      { data: { createPost: { __typename: typename, message } } },
    ];
    await assert.rejects(publishToLinkedInViaBuffer(bufferPublicationOptions({
      fetchImpl: async () => jsonResponse(responses.shift()),
    })), (error) => (
      error.code === code
      && !`${error.message}${JSON.stringify(error.diagnostic ?? null)}`.includes('private provider')
      && !`${error.message}${JSON.stringify(error.diagnostic ?? null)}`.includes('buffer-secret')
    ));
  }
});

validation('fails closed for terminal and timed-out Buffer post processing', async () => {
  for (const [post, attempts, code] of [
    [{ id: 'buffer-post-2', status: 'error', externalLink: null }, 2, 'buffer_publication'],
    [{ id: 'buffer-post-2', status: 'needs_approval', externalLink: null }, 2, 'buffer_processing'],
    [{ id: 'buffer-post-2', status: 'draft', externalLink: null }, 2, 'buffer_processing'],
    [{ id: 'buffer-post-2', status: 'sent', externalLink: 'https://example.test/not-linkedin' }, 2, 'buffer_response'],
    [{ id: 'buffer-post-2', status: 'sending', externalLink: null }, 1, 'buffer_processing'],
  ]) {
    const responses = [
      bufferChannelPayload(),
      { data: { posts: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
      { data: { createPost: {
        __typename: 'PostActionSuccess',
        post: { id: 'buffer-post-2', status: 'sending', externalLink: null },
      } } },
      { data: { post } },
    ];
    await assert.rejects(publishToLinkedInViaBuffer(bufferPublicationOptions({
      pollAttempts: attempts,
      fetchImpl: async () => jsonResponse(responses.shift()),
    })), (error) => error.code === code);
  }
});

function recentBufferPosts(nodes) {
  return {
    data: {
      posts: {
        edges: nodes.map((node) => ({ node })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
}

function bufferPost(overrides = {}) {
  return {
    id: 'buffer-existing-1',
    text: 'A previous post',
    status: 'sent',
    externalLink: 'https://www.linkedin.com/feed/update/urn:li:share:123456789/',
    channelId: '68b68e0fc159685850cf2c11',
    assets: [],
    ...overrides,
  };
}

validation('reconciles an exact Buffer canonical URL before creating another post', async () => {
  const operations = [];
  const options = bufferPublicationOptions();
  const responses = [
    bufferChannelPayload(),
    recentBufferPosts([bufferPost({ text: `Published earlier\n${options.post.canonicalUrl}\n#TechJobs` })]),
  ];
  const result = await publishToLinkedInViaBuffer({
    ...options,
    fetchImpl: async (_url, request) => {
      operations.push(JSON.parse(request.body).operationName);
      return jsonResponse(responses.shift());
    },
  });
  assert.deepEqual(result, {
    status: 'reconciled',
    id: 'buffer-existing-1',
    url: 'https://www.linkedin.com/feed/update/urn:li:share:123456789/',
    provider: 'buffer',
  });
  assert.deepEqual(operations, ['GetChannels', 'GetRecentPosts']);
});

validation('reconciles the exact Buffer image source but not canonical URL lookalikes', async () => {
  const exact = bufferPublicationOptions();
  const exactResponses = [
    bufferChannelPayload(),
    recentBufferPosts([bufferPost({
      text: 'Published without its original text marker',
      assets: [{ source: exact.imageUrl }],
    })]),
  ];
  const reconciled = await publishToLinkedInViaBuffer({
    ...exact,
    fetchImpl: async () => jsonResponse(exactResponses.shift()),
  });
  assert.equal(reconciled.status, 'reconciled');

  const prefixResponses = [
    bufferChannelPayload(),
    recentBufferPosts([bufferPost({
      text: `${exact.post.canonicalUrl}-different`,
      assets: [],
    })]),
    { data: { createPost: {
      __typename: 'PostActionSuccess',
      post: {
        id: 'buffer-created-2',
        status: 'sent',
        externalLink: 'https://www.linkedin.com/feed/update/urn:li:share:222222222/',
      },
    } } },
  ];
  const published = await publishToLinkedInViaBuffer({
    ...exact,
    fetchImpl: async () => jsonResponse(prefixResponses.shift()),
  });
  assert.equal(published.status, 'published');
  assert.equal(published.id, 'buffer-created-2');
});

validation('resumes a matching in-flight Buffer post instead of creating another', async () => {
  const operations = [];
  const options = bufferPublicationOptions();
  const responses = [
    bufferChannelPayload(),
    recentBufferPosts([bufferPost({
      text: options.post.text,
      status: 'sending',
      externalLink: null,
    })]),
    { data: { post: {
      id: 'buffer-existing-1',
      status: 'sent',
      externalLink: 'https://www.linkedin.com/feed/update/urn:li:share:123456789/',
    } } },
  ];
  const result = await publishToLinkedInViaBuffer({
    ...options,
    fetchImpl: async (_url, request) => {
      operations.push(JSON.parse(request.body).operationName);
      return jsonResponse(responses.shift());
    },
  });
  assert.equal(result.status, 'reconciled');
  assert.deepEqual(operations, ['GetChannels', 'GetRecentPosts', 'GetPost']);
});

validation('fails closed for matching errored or ambiguous Buffer posts', async () => {
  for (const status of ['error', 'needs_approval', 'draft']) {
    const options = bufferPublicationOptions();
    const responses = [
      bufferChannelPayload(),
      recentBufferPosts([bufferPost({
        text: options.post.text,
        status,
        externalLink: null,
      })]),
    ];
    await assert.rejects(publishToLinkedInViaBuffer({
      ...options,
      fetchImpl: async () => jsonResponse(responses.shift()),
    }), (error) => (
      error.code === (status === 'error' ? 'buffer_publication' : 'buffer_processing')
    ));
  }

  const multiple = bufferPublicationOptions();
  const multipleResponses = [
    bufferChannelPayload(),
    recentBufferPosts([
      bufferPost({ id: 'buffer-existing-1', text: multiple.post.text }),
      bufferPost({ id: 'buffer-existing-2', text: multiple.post.text }),
    ]),
  ];
  await assert.rejects(publishToLinkedInViaBuffer({
    ...multiple,
    fetchImpl: async () => jsonResponse(multipleResponses.shift()),
  }), (error) => error.code === 'buffer_reconciliation');
});

validation('reconciles once after an ambiguous Buffer create response', async () => {
  const operations = [];
  const options = bufferPublicationOptions();
  const responses = [
    bufferChannelPayload(),
    recentBufferPosts([]),
    new Error('connection reset after upload'),
    recentBufferPosts([bufferPost({ text: options.post.text })]),
  ];
  const result = await publishToLinkedInViaBuffer({
    ...options,
    fetchImpl: async (_url, request) => {
      operations.push(JSON.parse(request.body).operationName);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return jsonResponse(response);
    },
  });
  assert.equal(result.status, 'reconciled');
  assert.deepEqual(operations, [
    'GetChannels',
    'GetRecentPosts',
    'CreateLinkedInPost',
    'GetRecentPosts',
  ]);

  const missingResponses = [
    bufferChannelPayload(),
    recentBufferPosts([]),
    new Error('connection reset after upload'),
    recentBufferPosts([]),
  ];
  await assert.rejects(publishToLinkedInViaBuffer({
    ...options,
    fetchImpl: async () => {
      const response = missingResponses.shift();
      if (response instanceof Error) throw response;
      return jsonResponse(response);
    },
  }), (error) => error.code === 'buffer_response');
});

validation('rejects malformed Buffer reconciliation nodes instead of risking a duplicate', async () => {
  const options = bufferPublicationOptions();
  const responses = [
    bufferChannelPayload(),
    recentBufferPosts([{ id: 'buffer-existing-1', text: options.post.text }]),
  ];
  await assert.rejects(publishToLinkedInViaBuffer({
    ...options,
    fetchImpl: async () => jsonResponse(responses.shift()),
  }), (error) => error.code === 'buffer_reconciliation');
});

function twitterChannelPayload() {
  return {
    data: {
      channels: [{
        id: '68b68e0fc159685850cf2c22',
        service: 'twitter',
        isDisconnected: false,
        isLocked: false,
      }],
    },
  };
}

function twitterPublicationOptions(overrides = {}) {
  const job = makeJob();
  return {
    job,
    post: formatSocialPost(job, { maxGraphemes: TWITTER_POST_MAX_GRAPHEMES }),
    imageUrl: `https://openings.dev/jobs/${job.id}/opengraph-image.png`,
    publicSiteOrigin: 'https://openings.dev',
    apiKey: 'buffer-secret',
    organizationId: '68b68d3ac159685850cf2b8d',
    channelId: '68b68e0fc159685850cf2c22',
    apiOrigin: 'https://api.buffer.com',
    pollAttempts: 3,
    pollDelayMs: 25,
    sleep: async () => {},
    ...overrides,
  };
}

validation('scopes Buffer Twitter channel verification to the configured organization', async () => {
  const requests = [];
  const channel = await verifyBufferTwitterChannel({
    apiKey: 'buffer-secret',
    organizationId: '68b68d3ac159685850cf2b8d',
    channelId: '68b68e0fc159685850cf2c22',
    apiOrigin: 'https://api.buffer.com',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(twitterChannelPayload());
    },
  });
  assert.deepEqual(channel, {
    id: '68b68e0fc159685850cf2c22',
    service: 'twitter',
  });
  assert.equal(requests.length, 1);
  const request = JSON.parse(requests[0].options.body);
  assert.match(request.query, /query GetChannels/u);
  assert.deepEqual(request.variables, { organizationId: '68b68d3ac159685850cf2b8d' });
});

validation('fails closed for unsafe Buffer responses and unusable Twitter channels', async () => {
  const base = {
    apiKey: 'buffer-secret',
    organizationId: '68b68d3ac159685850cf2b8d',
    channelId: '68b68e0fc159685850cf2c22',
    apiOrigin: 'https://api.buffer.com',
  };
  const cases = [
    [new Response(null, { status: 401 }), 'buffer_authentication'],
    [new Response(null, { status: 429 }), 'buffer_rate_limit'],
    [jsonResponse({ data: { channels: [] } }), 'buffer_configuration'],
    [jsonResponse({ data: { channels: [{
      id: base.channelId, service: 'linkedin', isDisconnected: false, isLocked: false,
    }] } }), 'buffer_configuration'],
    [jsonResponse({ data: { channels: [{
      id: base.channelId, service: 'twitter', isDisconnected: true, isLocked: false,
    }] } }), 'buffer_configuration'],
  ];
  for (const [response, code] of cases) {
    await assert.rejects(verifyBufferTwitterChannel({
      ...base,
      fetchImpl: async () => response,
    }), (error) => error.code === code && !error.message.includes('buffer-secret'));
  }
});

validation('publishes a Twitter image immediately through Buffer and waits for its public URL', async () => {
  const requests = [];
  const delays = [];
  const responses = [
    twitterChannelPayload(),
    { data: { posts: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
    { data: { createPost: {
      __typename: 'PostActionSuccess',
      post: { id: 'buffer-tweet-1', status: 'sending', externalLink: null },
    } } },
    { data: { post: { id: 'buffer-tweet-1', status: 'sending', externalLink: null } } },
    { data: { post: {
      id: 'buffer-tweet-1',
      status: 'sent',
      externalLink: 'https://x.com/openingsdev/status/1234567890',
    } } },
  ];
  const options = twitterPublicationOptions({
    fetchImpl: async (url, requestOptions) => {
      requests.push({ url, options: requestOptions });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected Buffer request');
      return jsonResponse(response);
    },
    sleep: async (delay) => delays.push(delay),
  });
  const result = await publishToTwitterViaBuffer(options);
  assert.deepEqual(result, {
    status: 'published',
    id: 'buffer-tweet-1',
    url: 'https://x.com/openingsdev/status/1234567890',
    provider: 'buffer',
  });
  assert.deepEqual(requests.map(({ options: request }) => JSON.parse(request.body).operationName), [
    'GetChannels',
    'GetRecentPosts',
    'CreateTwitterPost',
    'GetPost',
    'GetPost',
  ]);
  const creation = JSON.parse(requests[2].options.body);
  assert.match(creation.query, /schedulingType:\s*automatic/u);
  assert.match(creation.query, /mode:\s*shareNow/u);
  assert.equal(creation.query.includes(options.post.text), false);
  assert.deepEqual(creation.variables, {
    text: options.post.text,
    channelId: options.channelId,
    imageUrl: options.imageUrl,
    altText: 'Senior TypeScript Engineer job opening on openings.dev',
  });
  assert.deepEqual(delays, [25]);
});

validation('reconciles an exact Buffer Twitter canonical URL before creating another post', async () => {
  const operations = [];
  const options = twitterPublicationOptions();
  const responses = [
    twitterChannelPayload(),
    {
      data: {
        posts: {
          edges: [{
            node: {
              id: 'buffer-existing-tweet',
              text: `Published earlier\n${options.post.canonicalUrl}\n#TechJobs`,
              status: 'sent',
              externalLink: 'https://x.com/openingsdev/status/1234567890',
              channelId: options.channelId,
              assets: [],
            },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  ];
  const result = await publishToTwitterViaBuffer({
    ...options,
    fetchImpl: async (_url, request) => {
      operations.push(JSON.parse(request.body).operationName);
      return jsonResponse(responses.shift());
    },
  });
  assert.deepEqual(result, {
    status: 'reconciled',
    id: 'buffer-existing-tweet',
    url: 'https://x.com/openingsdev/status/1234567890',
    provider: 'buffer',
  });
  assert.deepEqual(operations, ['GetChannels', 'GetRecentPosts']);
});

validation('rejects unsafe Buffer Twitter external links', async () => {
  const options = twitterPublicationOptions();
  const responses = [
    twitterChannelPayload(),
    { data: { posts: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
    { data: { createPost: {
      __typename: 'PostActionSuccess',
      post: { id: 'buffer-tweet-2', status: 'sending', externalLink: null },
    } } },
    { data: { post: {
      id: 'buffer-tweet-2',
      status: 'sent',
      externalLink: 'https://example.test/not-twitter',
    } } },
  ];
  await assert.rejects(publishToTwitterViaBuffer({
    ...options,
    fetchImpl: async () => jsonResponse(responses.shift()),
  }), (error) => error.code === 'buffer_response');
});

validation('enables scheduled publication only for exact true with every credential', () => {
  const env = {
    SOCIAL_AUTO_PUBLISH: 'true',
    WEB_DEPLOY_TOKEN: 'github-fine-grained-token',
    BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
    BLUESKY_APP_PASSWORD: 'app-secret',
    MASTODON_ACCESS_TOKEN: 'mastodon-secret',
    BUFFER_API_KEY: 'buffer-secret',
    BUFFER_ORGANIZATION_ID: '68b68d3ac159685850cf2b8d',
    BUFFER_TWITTER_CHANNEL_ID: '68b68e0fc159685850cf2c22',
  };
  assert.equal(readEnvironment({ env, mode: 'scheduled' }).publishEnabled, true);
  assert.equal(readEnvironment({ env: { ...env, SOCIAL_AUTO_PUBLISH: 'TRUE' }, mode: 'scheduled' }).publishEnabled, false);
  assert.throws(
    () => readEnvironment({ env: { ...env, WEB_DEPLOY_TOKEN: '' }, mode: 'controlled' }),
    (error) => error.message.includes('WEB_DEPLOY_TOKEN') && !error.message.includes('github-fine-grained-token'),
  );
});

validation('enables Meta channels independently and requires only their own credentials', () => {
  const base = {
    SOCIAL_AUTO_PUBLISH: 'true',
    WEB_DEPLOY_TOKEN: 'github-fine-grained-token',
    BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
    BLUESKY_APP_PASSWORD: 'app-secret',
    MASTODON_ACCESS_TOKEN: 'mastodon-secret',
    BUFFER_API_KEY: 'buffer-secret',
    BUFFER_ORGANIZATION_ID: '68b68d3ac159685850cf2b8d',
    BUFFER_TWITTER_CHANNEL_ID: '68b68e0fc159685850cf2c22',
  };
  const disabled = readEnvironment({ env: base, mode: 'scheduled' });
  assert.deepEqual(disabled.enabledChannels, ['bluesky', 'mastodon', 'twitter']);

  const threads = readEnvironment({
    env: { ...base, THREADS_AUTO_PUBLISH: 'true', THREADS_ACCESS_TOKEN: 'threads-secret' },
    mode: 'scheduled',
  });
  assert.deepEqual(threads.enabledChannels, ['bluesky', 'mastodon', 'twitter', 'threads']);
  assert.throws(
    () => readEnvironment({ env: { ...base, THREADS_AUTO_PUBLISH: 'true' }, mode: 'scheduled' }),
    /THREADS_ACCESS_TOKEN/u,
  );

  const instagram = readEnvironment({
    env: {
      ...base,
      INSTAGRAM_AUTO_PUBLISH: 'true',
      INSTAGRAM_ACCESS_TOKEN: 'instagram-secret',
      INSTAGRAM_USER_ID: '17841400000000000',
      META_GRAPH_VERSION: 'v23.0',
    },
    mode: 'scheduled',
  });
  assert.deepEqual(instagram.enabledChannels, ['bluesky', 'mastodon', 'twitter', 'instagram']);
  assert.equal(instagram.instagram.userId, '17841400000000000');
  assert.equal(instagram.instagram.apiVersion, 'v23.0');
});

validation('enables LinkedIn independently with bounded organization configuration', () => {
  const base = {
    SOCIAL_AUTO_PUBLISH: 'true',
    WEB_DEPLOY_TOKEN: 'github-fine-grained-token',
    BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
    BLUESKY_APP_PASSWORD: 'app-secret',
    MASTODON_ACCESS_TOKEN: 'mastodon-secret',
    BUFFER_API_KEY: 'buffer-secret',
    BUFFER_ORGANIZATION_ID: '68b68d3ac159685850cf2b8d',
    BUFFER_TWITTER_CHANNEL_ID: '68b68e0fc159685850cf2c22',
  };
  const disabled = readEnvironment({ env: base, mode: 'scheduled' });
  assert.equal(disabled.linkedin, null);
  assert.deepEqual(disabled.enabledChannels, ['bluesky', 'mastodon', 'twitter']);

  const enabled = readEnvironment({
    env: {
      ...base,
      LINKEDIN_AUTO_PUBLISH: 'true',
      LINKEDIN_ACCESS_TOKEN: 'linkedin-secret',
      LINKEDIN_ORGANIZATION_ID: '108765432',
      LINKEDIN_API_VERSION: '202608',
    },
    mode: 'scheduled',
  });
  assert.deepEqual(enabled.enabledChannels, ['bluesky', 'mastodon', 'twitter', 'linkedin']);
  assert.deepEqual(enabled.linkedin, {
    provider: 'direct',
    accessToken: 'linkedin-secret',
    organizationId: '108765432',
    organizationUrn: 'urn:li:organization:108765432',
    apiVersion: '202608',
    apiOrigin: 'https://api.linkedin.com',
  });

  for (const [key, value] of [
    ['LINKEDIN_ACCESS_TOKEN', ''],
    ['LINKEDIN_ORGANIZATION_ID', 'opening-dev'],
    ['LINKEDIN_API_VERSION', 'v202608'],
  ]) {
    assert.throws(() => readEnvironment({
      env: {
        ...base,
        LINKEDIN_AUTO_PUBLISH: 'true',
        LINKEDIN_ACCESS_TOKEN: 'linkedin-secret',
        LINKEDIN_ORGANIZATION_ID: '108765432',
        LINKEDIN_API_VERSION: '202608',
        [key]: value,
      },
      mode: 'scheduled',
    }), /LINKEDIN_/u);
  }
});

validation('selects Buffer for LinkedIn without requiring direct LinkedIn credentials', () => {
  const base = {
    SOCIAL_AUTO_PUBLISH: 'true',
    WEB_DEPLOY_TOKEN: 'github-fine-grained-token',
    BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
    BLUESKY_APP_PASSWORD: 'app-secret',
    MASTODON_ACCESS_TOKEN: 'mastodon-secret',
    LINKEDIN_AUTO_PUBLISH: 'true',
    LINKEDIN_PROVIDER: 'buffer',
    BUFFER_API_KEY: 'buffer-secret',
    BUFFER_ORGANIZATION_ID: '68b68d3ac159685850cf2b8d',
    BUFFER_LINKEDIN_CHANNEL_ID: '68b68e0fc159685850cf2c11',
    BUFFER_TWITTER_CHANNEL_ID: '68b68e0fc159685850cf2c22',
  };
  const enabled = readEnvironment({ env: base, mode: 'scheduled' });
  assert.deepEqual(enabled.enabledChannels, ['bluesky', 'mastodon', 'twitter', 'linkedin']);
  assert.deepEqual(enabled.linkedin, {
    provider: 'buffer',
    apiKey: 'buffer-secret',
    organizationId: '68b68d3ac159685850cf2b8d',
    channelId: '68b68e0fc159685850cf2c11',
    apiOrigin: BUFFER_API_ORIGIN,
  });

  for (const key of ['BUFFER_API_KEY', 'BUFFER_ORGANIZATION_ID', 'BUFFER_LINKEDIN_CHANNEL_ID']) {
    assert.throws(() => readEnvironment({
      env: { ...base, [key]: '' },
      mode: 'scheduled',
    }), (error) => error.message.includes(key) && !error.message.includes('buffer-secret'));
  }

  for (const value of [
    'http://api.buffer.com',
    'https://user:secret@api.buffer.com',
    'https://api.buffer.com/graphql',
  ]) {
    assert.throws(() => readEnvironment({
      env: { ...base, BUFFER_API_ORIGIN: value },
      mode: 'scheduled',
    }), /BUFFER_API_ORIGIN/u);
  }

  assert.throws(() => readEnvironment({
    env: { ...base, LINKEDIN_PROVIDER: 'queue' },
    mode: 'scheduled',
  }), /LINKEDIN_PROVIDER/u);

  const disabled = readEnvironment({
    env: { LINKEDIN_PROVIDER: 'buffer' },
    mode: 'dry-run',
  });
  assert.equal(disabled.linkedin, null);
});

validation('configures Twitter through Buffer using the shared organization credentials', () => {
  const base = {
    SOCIAL_AUTO_PUBLISH: 'true',
    WEB_DEPLOY_TOKEN: 'github-fine-grained-token',
    BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
    BLUESKY_APP_PASSWORD: 'app-secret',
    MASTODON_ACCESS_TOKEN: 'mastodon-secret',
    BUFFER_API_KEY: 'buffer-secret',
    BUFFER_ORGANIZATION_ID: '68b68d3ac159685850cf2b8d',
    BUFFER_TWITTER_CHANNEL_ID: '68b68e0fc159685850cf2c22',
  };
  const config = readEnvironment({ env: base, mode: 'scheduled' });
  assert.deepEqual(config.twitter, {
    apiKey: 'buffer-secret',
    organizationId: '68b68d3ac159685850cf2b8d',
    channelId: '68b68e0fc159685850cf2c22',
    apiOrigin: BUFFER_API_ORIGIN,
  });

  for (const key of ['BUFFER_API_KEY', 'BUFFER_ORGANIZATION_ID', 'BUFFER_TWITTER_CHANNEL_ID']) {
    assert.throws(() => readEnvironment({
      env: { ...base, [key]: '' },
      mode: 'scheduled',
    }), (error) => error.message.includes(key) && !error.message.includes('buffer-secret'));
  }

  assert.equal(readEnvironment({ env: {}, mode: 'dry-run' }).twitter, null);
});

validation('loads only deploy and Meta credentials for a controlled migration', () => {
  const config = readEnvironment({
    env: {
      WEB_DEPLOY_TOKEN: 'github-fine-grained-token',
      THREADS_ACCESS_TOKEN: 'threads-secret',
      INSTAGRAM_ACCESS_TOKEN: 'instagram-secret',
      INSTAGRAM_USER_ID: '17841400000000000',
      META_GRAPH_VERSION: 'v23.0',
    },
    mode: 'meta-migration',
  });
  assert.equal(config.publishEnabled, true);
  assert.equal(config.bluesky, null);
  assert.equal(config.mastodonAccessToken, null);
  assert.equal(config.threads.accessToken, 'threads-secret');
  assert.equal(config.instagram.userId, '17841400000000000');
  assert.throws(() => readEnvironment({
    env: {
      WEB_DEPLOY_TOKEN: 'github-fine-grained-token',
      THREADS_ACCESS_TOKEN: 'threads-secret',
      INSTAGRAM_ACCESS_TOKEN: 'instagram-secret',
      INSTAGRAM_USER_ID: '17841400000000000',
    },
    mode: 'meta-migration',
  }), /META_GRAPH_VERSION/u);
});

validation('isolates editorial deploy and Instagram credentials by stage', () => {
  const deploy = readEnvironment({
    env: { INSTAGRAM_EDITORIAL_AUTO_PUBLISH: 'true', WEB_DEPLOY_TOKEN: 'deploy-secret' },
    mode: 'editorial-assets',
  });
  assert.equal(deploy.instagramEditorialEnabled, true);
  assert.equal(deploy.webDeploy.token, 'deploy-secret');
  assert.equal(deploy.instagram, null);
  const instagram = readEnvironment({
    env: {
      INSTAGRAM_EDITORIAL_AUTO_PUBLISH: 'true',
      INSTAGRAM_ACCESS_TOKEN: 'instagram-secret',
      INSTAGRAM_USER_ID: '17841400000000000',
      META_GRAPH_VERSION: 'v26.0',
    },
    mode: 'editorial-feed',
  });
  assert.equal(instagram.webDeploy, null);
  assert.equal(instagram.instagram.accessToken, 'instagram-secret');
});

validation('enables Meta only for jobs enqueued after activation', () => {
  const snapshot = makeLoadedSnapshot({
    commit: '8'.repeat(40),
    generatedAt: '2026-08-25T19:00:00.000Z',
    dataHash: '8'.repeat(64),
    jobs: [],
  });
  const historical = makeJob({ id: 'gh_888888888888888888888881' });
  const future = makeJob({ id: 'gh_888888888888888888888882' });
  const initial = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job: historical,
    snapshot,
    discoveredAt: '2026-08-25T18:59:00.000Z',
  });
  const activated = enqueueJob(initial, {
    job: future,
    snapshot,
    discoveredAt: '2026-08-25T19:01:00.000Z',
    enabledChannels: ['bluesky', 'mastodon', 'threads', 'instagram'],
  });

  assert.equal(activated.items[0].threads.status, 'skipped_disabled');
  assert.equal(activated.items[0].instagram.status, 'skipped_disabled');
  assert.equal(activated.items[1].threads.status, 'pending');
  assert.equal(activated.items[1].instagram.status, 'pending');
});

validation('migrates version-two state without historical Story backfill', async () => {
  const snapshot = makeLoadedSnapshot({
    commit: '8'.repeat(40),
    generatedAt: '2026-08-25T19:00:00.000Z',
    dataHash: '8'.repeat(64),
    jobs: [],
  });
  const job = makeJob({ id: 'gh_888888888888888888888883' });
  const currentQueue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-25T19:01:00.000Z',
    enabledChannels: ['instagram'],
    instagramStoryEnabled: true,
  });
  const legacyItems = currentQueue.items.map(({ instagramStory: _ignored, ...item }) => item);
  const migratedQueue = migrateQueueState({ schemaVersion: 2, items: legacyItems });
  assert.equal(migratedQueue.schemaVersion, 3);
  assert.equal(migratedQueue.items[0].instagramStory.status, 'skipped_before_activation');
  assert.equal(migratedQueue.items[0].instagram.status, 'pending');

  const migratedIntake = migrateIntakeState({
    schemaVersion: 2,
    processedSnapshot: null,
    pendingBridges: [],
    removedJobs: [],
  });
  assert.equal(migratedIntake.schemaVersion, 3);

  const migratedPublications = migratePublicationsState({
    schemaVersion: 2,
    jobs: {
      [job.id]: { status: 'completed', instagram: { id: 'feed-1' } },
    },
  });
  assert.equal(migratedPublications.schemaVersion, 3);
  assert.equal(migratedPublications.jobs[job.id].instagramStory, null);

  const enabled = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-25T19:01:00.000Z',
    enabledChannels: ['instagram'],
    instagramStoryEnabled: true,
  });
  assert.equal(enabled.items[0].instagramStory.status, 'pending');
  const disabled = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-25T19:01:00.000Z',
    enabledChannels: ['instagram'],
    instagramStoryEnabled: false,
  });
  assert.equal(disabled.items[0].instagramStory.status, 'skipped_disabled');

  const directory = await mkdtemp(join(tmpdir(), 'openings-state-migration-'));
  const queuePath = join(directory, 'queue.json');
  try {
    await writeFile(queuePath, `${JSON.stringify({ schemaVersion: 2, items: legacyItems }, null, 2)}\n`);
    const loaded = await loadStateFile(queuePath, validateQueueState, migrateQueueState);
    assert.equal(loaded.schemaVersion, 3);
    assert.equal(loaded.items[0].instagramStory.status, 'skipped_before_activation');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('backfills Twitter when loading pre-activation version-three state', async () => {
  const snapshot = makeLoadedSnapshot({
    commit: '8'.repeat(40),
    generatedAt: '2026-09-03T11:00:00.000Z',
    dataHash: '8'.repeat(64),
    jobs: [],
  });
  const job = makeJob({ id: 'gh_888888888888888888888885' });
  const currentQueue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-09-03T11:01:00.000Z',
  });
  const legacyItems = currentQueue.items.map(({ twitter: _ignored, ...item }) => item);
  const legacyPublications = {
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: {
      [job.id]: { linkedin: null, instagramStory: null },
    },
  };
  const directory = await mkdtemp(join(tmpdir(), 'openings-twitter-shape-migration-'));
  try {
    await Promise.all([
      writeFile(join(directory, 'queue.json'), `${JSON.stringify({
        schemaVersion: STATE_SCHEMA_VERSION,
        items: legacyItems,
      }, null, 2)}\n`),
      writeFile(join(directory, 'publications.json'), `${JSON.stringify(legacyPublications, null, 2)}\n`),
    ]);
    const queue = await loadStateFile(
      join(directory, 'queue.json'),
      validateQueueState,
      migrateQueueState,
    );
    const publications = await loadStateFile(
      join(directory, 'publications.json'),
      validatePublicationsState,
      migratePublicationsState,
    );
    assert.deepEqual(queue.items[0].twitter, {
      status: 'skipped_before_activation',
      attempts: 0,
      updatedAt: null,
      lastError: null,
      lastReset: null,
      result: null,
    });
    assert.equal(publications.jobs[job.id].twitter, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('selects and publishes only a ready job Story', async () => {
  const job = makeJob({ id: 'gh_888888888888888888888884' });
  const snapshot = makeLoadedSnapshot({
    commit: '9'.repeat(40),
    generatedAt: '2026-08-25T20:00:00.000Z',
    dataHash: '9'.repeat(64),
    jobs: [job],
  });
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-25T20:01:00.000Z',
    enabledChannels: ['instagram'],
    instagramStoryEnabled: true,
  });
  assert.equal(selectNextInstagramStory(queue), null);
  queue = transitionQueueStage(queue, job.id, 'bridge', 'publishing', {
    at: '2026-08-25T20:02:00.000Z',
  });
  queue = transitionQueueStage(queue, job.id, 'bridge', 'published', {
    at: '2026-08-25T20:02:10.000Z',
    result: {
      socialVideoUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video.mp4`,
    },
  });
  queue = transitionQueueStage(queue, job.id, 'instagram', 'publishing', {
    at: '2026-08-25T20:03:00.000Z',
  });
  queue = transitionQueueStage(queue, job.id, 'instagram', 'published', {
    at: '2026-08-25T20:03:10.000Z',
    result: { status: 'published', id: 'feed-1', url: 'https://www.instagram.com/reel/feed-1/' },
  });
  assert.equal(selectNextInstagramStory(queue).jobId, job.id);
  const olderItem = {
    ...queue.items[0],
    jobId: 'gh_888888888888888888888883',
    createdAt: '2026-08-25T19:00:00.000Z',
    discoveredAt: '2026-08-25T19:01:00.000Z',
    instagram: { ...queue.items[0].instagram, updatedAt: '2026-08-25T19:03:10.000Z' },
  };
  const controlledQueue = validateQueueState({ ...queue, items: [olderItem, queue.items[0]] });
  assert.equal(selectNextInstagramStory(controlledQueue, job.id).jobId, job.id);

  const directory = await mkdtemp(join(tmpdir(), 'openings-job-story-'));
  const queuePath = join(directory, 'queue.json');
  const publicationsPath = join(directory, 'publications.json');
  const publications = {
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: {
      [job.id]: {
        status: 'completed',
        instagram: queue.items[0].instagram.result,
        linkedin: null,
        twitter: null,
        instagramStory: null,
      },
    },
  };
  try {
    await saveStateFile(queuePath, queue, validateQueueState);
    await saveStateFile(publicationsPath, publications, validatePublicationsState);
    let storyCalls = 0;
    const prepared = await runJobStoryPublication({
      stateDirectory: directory,
      mode: 'intent',
      jobId: job.id,
      operationKey: 'test-run-1',
      env: { INSTAGRAM_STORY_AUTO_PUBLISH: 'true' },
      now: '2026-08-25T20:03:50.000Z',
      log: () => {},
    });
    assert.equal(prepared.outcome, 'prepared');
    assert.equal(prepared.queueState.items[0].instagramStory.result.operationKey, 'test-run-1');
    const interruptedDirectory = await mkdtemp(join(tmpdir(), 'openings-job-story-interrupted-'));
    try {
      await saveStateFile(join(interruptedDirectory, 'queue.json'), prepared.queueState, validateQueueState);
      await saveStateFile(join(interruptedDirectory, 'publications.json'), publications, validatePublicationsState);
      const interrupted = await runJobStoryPublication({
        stateDirectory: interruptedDirectory,
        mode: 'intent',
        jobId: job.id,
        operationKey: 'test-restarted-run',
        env: { INSTAGRAM_STORY_AUTO_PUBLISH: 'true' },
        now: '2026-08-25T20:03:55.000Z',
        log: () => {},
      });
      assert.equal(interrupted.outcome, 'failed_manual_review');
      assert.equal(interrupted.queueState.items[0].instagramStory.lastError.code, 'instagram_story_interrupted');
    } finally {
      await rm(interruptedDirectory, { recursive: true, force: true });
    }
    const result = await runJobStoryPublication({
      stateDirectory: directory,
      mode: 'publish',
      jobId: job.id,
      operationKey: 'test-run-1',
      env: {
        INSTAGRAM_STORY_AUTO_PUBLISH: 'true',
        INSTAGRAM_ACCESS_TOKEN: 'instagram-secret',
        INSTAGRAM_USER_ID: '17841400000000000',
        META_GRAPH_VERSION: 'v26.0',
      },
      now: '2026-08-25T20:04:00.000Z',
      dependencies: {
        publishStory: async ({ mediaUrl, mediaKind }) => {
          storyCalls += 1;
          assert.equal(mediaUrl, `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video.mp4`);
          assert.equal(mediaKind, 'video');
          return { status: 'published', id: 'story-1', url: null };
        },
      },
      log: () => {},
    });
    assert.equal(storyCalls, 1);
    assert.equal(result.queueState.items[0].instagramStory.status, 'published');
    assert.equal(result.queueState.items[0].instagram.result.id, 'feed-1');
    assert.equal(result.publicationsState.jobs[job.id].instagramStory.id, 'story-1');

    const partialCases = [
      {
        label: 'queue-authoritative',
        queueState: result.queueState,
        publicationsState: publications,
      },
      {
        label: 'publication-authoritative',
        queueState: prepared.queueState,
        publicationsState: result.publicationsState,
      },
    ];
    for (const partial of partialCases) {
      const repairDirectory = await mkdtemp(join(tmpdir(), `openings-job-story-${partial.label}-`));
      try {
        await saveStateFile(join(repairDirectory, 'queue.json'), partial.queueState, validateQueueState);
        await saveStateFile(join(repairDirectory, 'publications.json'), partial.publicationsState, validatePublicationsState);
        const repaired = await runJobStoryPublication({
          stateDirectory: repairDirectory,
          mode: 'intent',
          operationKey: 'repair-state-only',
          env: { INSTAGRAM_STORY_AUTO_PUBLISH: 'true' },
          now: '2026-08-25T20:05:00.000Z',
          log: () => {},
        });
        assert.equal(repaired.outcome, 'idle');
        assert.equal(repaired.queueState.items[0].instagramStory.status, 'published');
        assert.equal(repaired.queueState.items[0].instagramStory.result.id, 'story-1');
        assert.equal(repaired.publicationsState.jobs[job.id].instagramStory.id, 'story-1');
      } finally {
        await rm(repairDirectory, { recursive: true, force: true });
      }
    }

    const idle = await runJobStoryPublication({
      stateDirectory: directory,
      mode: 'publish',
      operationKey: 'test-run-2',
      env: {
        INSTAGRAM_STORY_AUTO_PUBLISH: 'true',
        INSTAGRAM_ACCESS_TOKEN: 'instagram-secret',
        INSTAGRAM_USER_ID: '17841400000000000',
        META_GRAPH_VERSION: 'v26.0',
      },
      dependencies: {
        publishStory: async () => { throw new Error('must not republish'); },
      },
      log: () => {},
    });
    assert.equal(idle.outcome, 'idle');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('publishes a Story before the job\'s other channels have completed', async () => {
  const job = makeJob({ id: 'gh_888888888888888888888885' });
  const snapshot = makeLoadedSnapshot({
    commit: '9'.repeat(40),
    generatedAt: '2026-08-25T20:00:00.000Z',
    dataHash: '9'.repeat(64),
    jobs: [job],
  });
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-25T20:01:00.000Z',
    enabledChannels: ['instagram', 'linkedin'],
    instagramStoryEnabled: true,
  });
  queue = transitionQueueStage(queue, job.id, 'bridge', 'publishing', { at: '2026-08-25T20:02:00.000Z' });
  queue = transitionQueueStage(queue, job.id, 'bridge', 'published', {
    at: '2026-08-25T20:02:10.000Z',
    result: { socialVideoUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video.mp4` },
  });
  queue = transitionQueueStage(queue, job.id, 'instagram', 'publishing', { at: '2026-08-25T20:03:00.000Z' });
  queue = transitionQueueStage(queue, job.id, 'instagram', 'published', {
    at: '2026-08-25T20:03:10.000Z',
    result: { status: 'published', id: 'feed-2', url: 'https://www.instagram.com/reel/feed-2/' },
  });
  // LinkedIn (or any other channel) is still retryable, so the orchestrator
  // has not called completePublication yet: publications.json has no entry
  // for this job at all, unlike the "interrupted" test above where one
  // already exists.
  queue = transitionQueueStage(queue, job.id, 'linkedin', 'publishing', { at: '2026-08-25T20:03:20.000Z' });
  queue = transitionQueueStage(queue, job.id, 'linkedin', 'retryable', {
    at: '2026-08-25T20:03:30.000Z',
    errorCode: 'buffer_media',
  });

  const directory = await mkdtemp(join(tmpdir(), 'openings-job-story-early-'));
  try {
    await saveStateFile(join(directory, 'queue.json'), queue, validateQueueState);
    await saveStateFile(
      join(directory, 'publications.json'),
      { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
      validatePublicationsState,
    );
    const prepared = await runJobStoryPublication({
      stateDirectory: directory,
      mode: 'intent',
      jobId: job.id,
      operationKey: 'test-early-run',
      env: { INSTAGRAM_STORY_AUTO_PUBLISH: 'true' },
      now: '2026-08-25T20:03:50.000Z',
      log: () => {},
    });
    assert.equal(prepared.outcome, 'prepared');
    const result = await runJobStoryPublication({
      stateDirectory: directory,
      mode: 'publish',
      jobId: job.id,
      operationKey: 'test-early-run',
      env: {
        INSTAGRAM_STORY_AUTO_PUBLISH: 'true',
        INSTAGRAM_ACCESS_TOKEN: 'instagram-secret',
        INSTAGRAM_USER_ID: '17841400000000000',
        META_GRAPH_VERSION: 'v26.0',
      },
      now: '2026-08-25T20:04:00.000Z',
      dependencies: {
        publishStory: async () => ({ status: 'published', id: 'story-2', url: null }),
      },
      log: () => {},
    });
    assert.equal(result.outcome, 'published');
    assert.equal(result.queueState.items[0].instagramStory.status, 'published');
    assert.equal(result.publicationsState.jobs[job.id].instagramStory.id, 'story-2');
    assert.equal(result.publicationsState.jobs[job.id].linkedin, null);
    assert.equal(result.publicationsState.jobs[job.id].status, undefined);

    const persistedQueue = await loadStateFile(join(directory, 'queue.json'), validateQueueState, migrateQueueState);
    assert.equal(persistedQueue.items[0].instagramStory.status, 'published');
    const persistedPublications = await loadStateFile(
      join(directory, 'publications.json'),
      validatePublicationsState,
      migratePublicationsState,
    );
    assert.equal(persistedPublications.jobs[job.id].instagramStory.id, 'story-2');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('skips disabled and up-to-date schedules before expensive setup', () => {
  const dataHash = 'a'.repeat(64);
  const intakeState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    processedSnapshot: {
      commit: '1'.repeat(40),
      generatedAt: '2026-08-23T12:00:00.000Z',
      dataHash,
    },
    pendingBridges: [],
    removedJobs: [],
  };
  const queueState = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };

  assert.deepEqual(decideScheduledWork({
    publishEnabled: false,
    intakeState,
    queueState,
    currentDataHash: 'b'.repeat(64),
  }), { shouldRun: false, reason: 'disabled', queueDepth: 0 });
  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    intakeState,
    queueState,
    currentDataHash: dataHash,
  }), { shouldRun: false, reason: 'up_to_date', queueDepth: 0 });
  assert.deepEqual(decideScheduledWork({
    publishEnabled: false,
    storyPublishEnabled: true,
    intakeState,
    queueState,
    currentDataHash: dataHash,
  }), { shouldRun: false, reason: 'story_up_to_date', queueDepth: 0 });
  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    intakeState,
    queueState,
    currentDataHash: 'b'.repeat(64),
  }), { shouldRun: true, reason: 'snapshot_changed', queueDepth: 0 });
});

validation('runs schedules while social or bridge work is ready', () => {
  const dataHash = 'a'.repeat(64);
  const intakeState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    processedSnapshot: {
      commit: '1'.repeat(40),
      generatedAt: '2026-08-23T12:00:00.000Z',
      dataHash,
    },
    pendingBridges: [],
    removedJobs: [],
  };
  const job = makeJob();
  const snapshot = makeLoadedSnapshot({
    commit: '1'.repeat(40),
    generatedAt: '2026-08-23T12:00:00.000Z',
    dataHash,
    jobs: [job],
  });
  const queueState = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-23T12:01:00.000Z',
  });

  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    intakeState,
    queueState,
    currentDataHash: dataHash,
  }), { shouldRun: true, reason: 'queued', queueDepth: 1 });

  let interruptedStory = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-23T12:01:00.000Z',
    enabledChannels: ['instagram'],
    instagramStoryEnabled: true,
  });
  interruptedStory = transitionQueueStage(interruptedStory, job.id, 'bridge', 'publishing', { at: '2026-08-23T12:02:00.000Z' });
  interruptedStory = transitionQueueStage(interruptedStory, job.id, 'bridge', 'published', {
    at: '2026-08-23T12:02:10.000Z', result: { socialVideoUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video.mp4` },
  });
  interruptedStory = transitionQueueStage(interruptedStory, job.id, 'instagram', 'publishing', { at: '2026-08-23T12:03:00.000Z' });
  interruptedStory = transitionQueueStage(interruptedStory, job.id, 'instagram', 'published', {
    at: '2026-08-23T12:03:10.000Z', result: { id: 'feed-interrupted', url: 'https://instagram.com/p/feed-interrupted' },
  });
  interruptedStory = transitionQueueStage(interruptedStory, job.id, 'instagramStory', 'publishing', {
    at: '2026-08-23T12:04:00.000Z', intent: { operationKey: 'previous-workflow-run' },
  });
  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    storyPublishEnabled: true,
    intakeState,
    queueState: interruptedStory,
    currentDataHash: dataHash,
  }), { shouldRun: true, reason: 'queued', queueDepth: 1 });
  assert.deepEqual(decideScheduledWork({
    publishEnabled: false,
    storyPublishEnabled: true,
    intakeState,
    queueState: interruptedStory,
    currentDataHash: dataHash,
  }), { shouldRun: true, reason: 'queued', queueDepth: 1 });

  const bridgeState = enqueueBridgeWork(intakeState, { job, snapshot, reason: 'changed' });
  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    intakeState: bridgeState,
    queueState: { schemaVersion: STATE_SCHEMA_VERSION, items: [] },
    currentDataHash: dataHash,
  }), { shouldRun: true, reason: 'bridge_queued', queueDepth: 0 });
});

validation('preflight avoids remote reads for queued work and fails open on manifest errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-social-preflight-'));
  const job = makeJob();
  const snapshot = makeLoadedSnapshot({
    commit: '1'.repeat(40),
    generatedAt: '2026-08-23T12:00:00.000Z',
    dataHash: 'a'.repeat(64),
    jobs: [job],
  });
  const intakeState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    processedSnapshot: {
      commit: snapshot.commit,
      generatedAt: snapshot.generatedAt,
      dataHash: snapshot.dataHash,
    },
    pendingBridges: [],
    removedJobs: [],
  };
  const queueState = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-23T12:01:00.000Z',
  });
  try {
    await saveStateFile(join(directory, 'intake.json'), intakeState, validateIntakeState);
    await saveStateFile(join(directory, 'queue.json'), queueState, validateQueueState);
    let fetchCalls = 0;
    const queued = await runPreflight({
      eventName: 'schedule',
      publishEnabled: true,
      stateDirectory: directory,
      fetchManifest: async () => { fetchCalls += 1; return { dataHash: snapshot.dataHash }; },
      log: () => {},
    });
    assert.deepEqual(queued, { shouldRun: true, reason: 'queued', queueDepth: 1 });
    assert.equal(fetchCalls, 0);

    await saveStateFile(join(directory, 'queue.json'), { schemaVersion: STATE_SCHEMA_VERSION, items: [] }, validateQueueState);
    const unavailable = await runPreflight({
      eventName: 'schedule',
      publishEnabled: true,
      stateDirectory: directory,
      fetchManifest: async () => { throw new Error('temporary network error'); },
      log: () => {},
    });
    assert.deepEqual(unavailable, { shouldRun: true, reason: 'preflight_unavailable', queueDepth: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('validates the tracked state schemas', async () => {
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const intake = await loadStateFile(join(repositoryRoot, 'state/intake.json'), validateIntakeState);
  const queue = await loadStateFile(join(repositoryRoot, 'state/queue.json'), validateQueueState);
  const publications = await loadStateFile(join(repositoryRoot, 'state/publications.json'), validatePublicationsState);
  assert.equal(intake.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(queue.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(Array.isArray(queue.items), true);
  assert.equal(publications.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(typeof publications.jobs, 'object');
});

validation('rejects unknown state versions, duplicates, and sensitive keys', () => {
  assert.throws(() => validateIntakeState({ schemaVersion: 99, processedSnapshot: null, pendingBridges: [], removedJobs: [] }), /schemaVersion/);
  assert.throws(
    () => validateQueueState({ schemaVersion: STATE_SCHEMA_VERSION, items: [{ jobId: 'gh_0123456789abcdef01234567' }, { jobId: 'gh_0123456789abcdef01234567' }] }),
    /duplicate/i,
  );
  assert.throws(() => validatePublicationsState({
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: {
      gh_0123456789abcdef01234567: { status: 'completed' },
    },
  }), /linkedin/u);
  assert.throws(() => validatePublicationsState({
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: {
      gh_0123456789abcdef01234567: { status: 'completed', linkedin: 'invalid' },
    },
  }), /linkedin/u);
  assert.throws(() => assertNoSensitiveKeys({ nested: { accessToken: 'never-track-this' } }), /sensitive/i);
});

validation('requires the twitter field on every publication record', () => {
  const jobId = 'gh_0123456789abcdef01234567';
  assert.throws(() => validatePublicationsState({
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: { [jobId]: { linkedin: null, instagramStory: null } },
  }), /\.twitter is required/u);
  assert.doesNotThrow(() => validatePublicationsState({
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: { [jobId]: { linkedin: null, instagramStory: null, twitter: null } },
  }));
  assert.doesNotThrow(() => validatePublicationsState({
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: { [jobId]: {
      linkedin: null,
      instagramStory: null,
      twitter: { status: 'published', id: 'buffer-tweet-1', url: 'https://x.com/openingsdev/status/1', provider: 'buffer' },
    } },
  }));
});

validation('writes state atomically with stable formatting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-social-publisher-state-'));
  const file = join(directory, 'queue.json');
  const value = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };
  try {
    await saveStateFile(file, value, validateQueueState);
    assert.equal(await readFile(file, 'utf8'), `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function makeJob(overrides = {}) {
  return {
    id: 'gh_0123456789abcdef01234567',
    sourceId: 'openings-fixtures/jobs#42',
    title: 'Senior TypeScript Engineer',
    description: 'Build reliable developer tools.',
    issueState: 'open',
    contentHash: '55b48a8e62f73da8021d3f8bdc70ec9cfb9ee89d5b5243d4b2b5b6b24f9fca95',
    repository: 'openings-fixtures/jobs',
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    url: 'https://github.com/openings-fixtures/jobs/issues/42',
    sourceType: 'github-issue',
    ...overrides,
  };
}

function makeVersionTwoQueueFixture(job) {
  const stage = (status, result = null) => ({
    status,
    attempts: status === 'published' ? 1 : 0,
    updatedAt: status === 'published' ? '2026-08-20T14:00:00.000Z' : null,
    lastError: null,
    lastReset: null,
    result,
  });
  return {
    schemaVersion: 2,
    items: [{
      jobId: job.id,
      sourceId: job.sourceId,
      dataCommit: 'f'.repeat(40),
      dataHash: 'a'.repeat(64),
      contentHash: job.contentHash,
      discoveredAt: '2026-08-20T13:01:00.000Z',
      createdAt: job.createdAt,
      publicationCreatedAt: '2026-08-20T13:01:00.000Z',
      bridge: stage('published', { status: 'deployed' }),
      bluesky: stage('published', { status: 'published' }),
      mastodon: stage('published', { status: 'published' }),
      threads: stage('skipped_disabled'),
      instagram: stage('skipped_disabled'),
    }],
  };
}

validation('migrates LinkedIn state without reopening historical jobs', () => {
  const job = makeJob();
  const migrated = migrateLinkedInState({
    intakeState: {
      schemaVersion: 2,
      processedSnapshot: null,
      pendingBridges: [],
      removedJobs: [],
    },
    queueState: makeVersionTwoQueueFixture(job),
    publicationsState: {
      schemaVersion: 2,
      jobs: {
        [job.id]: {
          status: 'completed',
          completedAt: '2026-08-20T14:00:00.000Z',
        },
      },
    },
    at: '2026-09-01T12:00:00.000Z',
  });
  assert.equal(migrated.intakeState.schemaVersion, 3);
  assert.equal(migrated.queueState.schemaVersion, 3);
  assert.deepEqual(migrated.queueState.items[0].linkedin, {
    status: 'skipped_before_activation',
    attempts: 0,
    updatedAt: '2026-09-01T12:00:00.000Z',
    lastError: null,
    lastReset: null,
    result: null,
  });
  assert.equal(migrated.publicationsState.schemaVersion, 3);
  assert.equal(migrated.publicationsState.jobs[job.id].linkedin, null);
  validateIntakeState(migrated.intakeState);
  validateQueueState(migrated.queueState);
  validatePublicationsState(migrated.publicationsState);
});

validation('applies the guarded LinkedIn migration to tracked state files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-linkedin-state-'));
  const job = makeJob();
  try {
    await Promise.all([
      writeFile(join(directory, 'intake.json'), JSON.stringify({
        schemaVersion: 2,
        processedSnapshot: null,
        pendingBridges: [],
        removedJobs: [],
      })),
      writeFile(join(directory, 'queue.json'), JSON.stringify(makeVersionTwoQueueFixture(job))),
      writeFile(join(directory, 'publications.json'), JSON.stringify({
        schemaVersion: 2,
        jobs: { [job.id]: { status: 'completed' } },
      })),
    ]);
    await assert.rejects(runLinkedInStateMigration({
      stateDirectory: directory,
      at: '2026-09-01T12:00:00.000Z',
      confirmation: 'migrate',
    }), /exact confirmation/u);
    const result = await runLinkedInStateMigration({
      stateDirectory: directory,
      at: '2026-09-01T12:00:00.000Z',
      confirmation: 'MIGRATE_LINKEDIN_STATE',
    });
    assert.deepEqual(result, { queueItems: 1, publications: 1, schemaVersion: 3 });
    assert.equal(JSON.parse(await readFile(join(directory, 'queue.json'))).items[0]
      .linkedin.status, 'skipped_before_activation');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('backfills a skipped-before-activation twitter stage onto existing queue items', () => {
  const at = '2026-09-03T12:00:00.000Z';
  const queueState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    items: [{
      jobId: 'gh_0123456789abcdef01234567',
      sourceId: 'src-1',
      dataCommit: '1'.repeat(40),
      dataHash: '1'.repeat(64),
      contentHash: '2'.repeat(64),
      discoveredAt: at,
      createdAt: at,
      publicationCreatedAt: at,
      bridge: { status: 'published', attempts: 1, updatedAt: at, lastError: null, lastReset: null, result: {} },
      bluesky: { status: 'published', attempts: 1, updatedAt: at, lastError: null, lastReset: null, result: {} },
      mastodon: { status: 'published', attempts: 1, updatedAt: at, lastError: null, lastReset: null, result: {} },
      threads: { status: 'skipped_disabled', attempts: 0, updatedAt: null, lastError: null, lastReset: null, result: null },
      instagram: { status: 'skipped_disabled', attempts: 0, updatedAt: null, lastError: null, lastReset: null, result: null },
      linkedin: { status: 'skipped_disabled', attempts: 0, updatedAt: null, lastError: null, lastReset: null, result: null },
      instagramStory: { status: 'skipped_disabled', attempts: 0, updatedAt: null, lastError: null, lastReset: null, result: null },
    }],
  };
  const publicationsState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: {
      gh_0123456789abcdef01234567: { linkedin: null, instagramStory: null },
    },
  };
  const migrated = migrateTwitterState({ queueState, publicationsState, at });
  assert.equal(migrated.queueState.items[0].twitter.status, 'skipped_before_activation');
  assert.equal(migrated.queueState.items[0].twitter.updatedAt, at);
  assert.equal(migrated.publicationsState.jobs.gh_0123456789abcdef01234567.twitter, null);
  assert.doesNotThrow(() => validateQueueState(migrated.queueState));
  assert.doesNotThrow(() => validatePublicationsState(migrated.publicationsState));

  assert.throws(() => migrateTwitterState({ queueState, publicationsState, at: 'not-a-date' }),
    /ISO date/u);
});

validation('runs the twitter state migration only with the exact confirmation phrase', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-twitter-migration-'));
  const at = '2026-09-03T12:00:00.000Z';
  try {
    await Promise.all([
      saveStateFile(join(directory, 'queue.json'), {
        schemaVersion: STATE_SCHEMA_VERSION,
        items: [],
      }, validateQueueState),
      saveStateFile(join(directory, 'publications.json'), {
        schemaVersion: STATE_SCHEMA_VERSION,
        jobs: {},
      }, validatePublicationsState),
    ]);
    await assert.rejects(runTwitterStateMigration({
      stateDirectory: directory,
      at,
      confirmation: 'wrong phrase',
    }), /exact confirmation/i);
    const result = await runTwitterStateMigration({
      stateDirectory: directory,
      at,
      confirmation: 'MIGRATE_TWITTER_STATE',
    });
    assert.deepEqual(result, { queueItems: 0, publications: 0, schemaVersion: STATE_SCHEMA_VERSION });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function makeSocialVideoBuffer() {
  const value = Buffer.alloc(24);
  value.writeUInt32BE(24, 0);
  value.write('ftyp', 4, 'ascii');
  return value;
}

async function makeSocialVideoCover() {
  return sharp({
    create: {
      width: SOCIAL_VIDEO_WIDTH,
      height: SOCIAL_VIDEO_HEIGHT,
      channels: 3,
      background: '#f5f3ef',
    },
  }).jpeg().toBuffer();
}

function makeSnapshotFiles(jobs, overrides = {}) {
  const generatedAt = overrides.generatedAt ?? '2026-08-20T13:00:00.000Z';
  const manifest = {
    generatedAt,
    schemaVersion: 4,
    pageSize: 20,
    dataHash: 'a'.repeat(64),
    totals: {
      openOpportunities: jobs.length,
      pages: 1,
    },
    files: { jobIds: 'api/job-ids.json' },
    facets: {},
    pages: [{ page: 1, file: 'api/pages/page-0001.json', count: jobs.length }],
    ...overrides.manifest,
  };
  return {
    'snapshots/opportunities/api/manifest.json': manifest,
    'snapshots/opportunities/api/job-ids.json': { generatedAt, ids: jobs.map((job) => job.id) },
    'snapshots/opportunities/api/pages/page-0001.json': {
      generatedAt,
      page: 1,
      pageSize: 20,
      nextPage: null,
      ids: jobs.map((job) => job.id),
      items: jobs,
    },
  };
}

validation('reads JSON from a fixed Git commit without shell interpolation', async () => {
  const calls = [];
  const result = await readJsonAtCommit('/safe/repository', 'a'.repeat(40), 'snapshots/data.json', {
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      return { stdout: '{"ok":true}' };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{
    command: 'git',
    args: ['-C', '/safe/repository', 'show', `${'a'.repeat(40)}:snapshots/data.json`],
  }]);
  await assert.rejects(readJsonAtCommit('/safe/repository', 'a'.repeat(40), '../secrets.json'), /repository-relative/);
});

validation('loads one complete immutable data snapshot', async () => {
  const jobs = [makeJob()];
  const files = makeSnapshotFiles(jobs);
  const snapshot = await loadSnapshot('/data', 'b'.repeat(40), {
    readJson: async (_repository, _commit, path) => structuredClone(files[path]),
  });
  assert.equal(snapshot.commit, 'b'.repeat(40));
  assert.equal(snapshot.generatedAt, '2026-08-20T13:00:00.000Z');
  assert.deepEqual([...snapshot.jobsById.keys()], [jobs[0].id]);
});

validation('loads every reviewed data snapshot schema', async () => {
  const jobs = [makeJob()];
  for (const schemaVersion of [4, 5, 6]) {
    const files = makeSnapshotFiles(jobs, { manifest: { schemaVersion } });
    const snapshot = await loadSnapshot('/data', 'b'.repeat(40), {
      readJson: async (_repository, _commit, path) => structuredClone(files[path]),
    });
    assert.equal(snapshot.schemaVersion, schemaVersion);
  }
});

validation('rejects an unreviewed data snapshot schema', async () => {
  const files = makeSnapshotFiles([makeJob()], { manifest: { schemaVersion: 7 } });
  await assert.rejects(
    loadSnapshot('/data', 'b'.repeat(40), {
      readJson: async (_repository, _commit, path) => structuredClone(files[path]),
    }),
    /Unsupported data schemaVersion: 7/u,
  );
});

validation('loads incrementally written artifacts from one immutable commit', async () => {
  const files = makeSnapshotFiles([makeJob()]);
  files['snapshots/opportunities/api/pages/page-0001.json'].generatedAt = '2026-08-20T13:05:00.000Z';
  const snapshot = await loadSnapshot('/data', 'c'.repeat(40), {
    readJson: async (_repository, _commit, path) => structuredClone(files[path]),
  });

  assert.equal(snapshot.jobsById.size, 1);
});

validation('rejects duplicate and inconsistent snapshot artifacts', async () => {
  const duplicate = makeJob();
  const files = makeSnapshotFiles([duplicate, duplicate]);
  await assert.rejects(
    loadSnapshot('/data', 'c'.repeat(40), { readJson: async (_repository, _commit, path) => structuredClone(files[path]) }),
    /duplicate/i,
  );

  const badCount = makeSnapshotFiles([makeJob()]);
  badCount['snapshots/opportunities/api/manifest.json'].pages[0].count = 2;
  await assert.rejects(
    loadSnapshot('/data', 'e'.repeat(40), { readJson: async (_repository, _commit, path) => structuredClone(badCount[path]) }),
    /count/i,
  );
});

validation('classifies new, changed, removed, and bridge-only work', () => {
  const unchanged = makeJob();
  const changedBefore = makeJob({
    id: 'gh_111111111111111111111111',
    contentHash: '1'.repeat(64),
  });
  const removed = makeJob({
    id: 'gh_222222222222222222222222',
    contentHash: '2'.repeat(64),
  });
  const changedAfter = { ...changedBefore, contentHash: '3'.repeat(64) };
  const added = makeJob({
    id: 'gh_333333333333333333333333',
    contentHash: '4'.repeat(64),
  });
  const previous = { jobsById: new Map([[unchanged.id, unchanged], [changedBefore.id, changedBefore], [removed.id, removed]]) };
  const current = { jobsById: new Map([[unchanged.id, unchanged], [changedAfter.id, changedAfter], [added.id, added]]) };
  const delta = collectDelta(previous, current);
  assert.deepEqual(delta.new.map((job) => job.id), [added.id]);
  assert.deepEqual(delta.changed.map((job) => job.id), [changedAfter.id]);
  assert.deepEqual(delta.removed.map((job) => job.id), [removed.id]);
  assert.deepEqual(collectBridgeJobs(delta).map((job) => job.id), [added.id, changedAfter.id]);
});

validation('enqueues only genuinely new open GitHub issues', () => {
  const previousGeneratedAt = '2026-08-20T10:00:00.000Z';
  const eligible = makeJob({ createdAt: '2026-08-20T10:00:01.000Z' });
  assert.equal(isEligibleNewJob(eligible, previousGeneratedAt, { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} }), true);
  assert.equal(isEligibleNewJob({ ...eligible, createdAt: previousGeneratedAt }, previousGeneratedAt, { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} }), false);
  assert.equal(isEligibleNewJob({ ...eligible, issueState: 'closed' }, previousGeneratedAt, { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} }), false);
  assert.equal(isEligibleNewJob({ ...eligible, sourceType: 'github-discussion' }, previousGeneratedAt, { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} }), false);
  assert.equal(isEligibleNewJob(eligible, previousGeneratedAt, {
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: { [eligible.id]: { completedAt: '2026-08-20T11:00:00.000Z' } },
  }), false);
});

function snapshotReference(overrides = {}) {
  return {
    commit: 'f'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: 'a'.repeat(64),
    ...overrides,
  };
}

validation('enqueues jobs and bridge refreshes idempotently', () => {
  const job = makeJob();
  const snapshot = snapshotReference();
  const initialQueue = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };
  const first = enqueueJob(initialQueue, { job, snapshot, discoveredAt: '2026-08-20T13:01:00.000Z' });
  const second = enqueueJob(first, { job, snapshot, discoveredAt: '2026-08-20T13:05:00.000Z' });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].discoveredAt, '2026-08-20T13:01:00.000Z');
  assert.equal(second.items[0].bluesky.status, 'pending');
  assert.equal(second.items[0].mastodon.status, 'pending');
  assert.equal(second.items[0].threads.status, 'skipped_disabled');
  assert.equal(second.items[0].instagram.status, 'skipped_disabled');

  const withMeta = enqueueJob(initialQueue, {
    job,
    snapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
    enabledChannels: ['bluesky', 'mastodon', 'threads', 'instagram'],
  });
  assert.equal(withMeta.items[0].threads.status, 'pending');
  assert.equal(withMeta.items[0].instagram.status, 'pending');

  const intake = { schemaVersion: STATE_SCHEMA_VERSION, processedSnapshot: null, pendingBridges: [], removedJobs: [] };
  const withBridge = enqueueBridgeWork(intake, { job, snapshot, reason: 'new' });
  const refreshed = enqueueBridgeWork(withBridge, {
    job: { ...job, contentHash: 'b'.repeat(64) },
    snapshot: { ...snapshot, dataHash: 'c'.repeat(64) },
    reason: 'changed',
  });
  assert.equal(refreshed.pendingBridges.length, 1);
  assert.equal(refreshed.pendingBridges[0].reason, 'changed');
  assert.equal(refreshed.pendingBridges[0].contentHash, 'b'.repeat(64));
});

validation('transitions durable pending bridge stages safely', () => {
  const job = makeJob();
  const snapshot = snapshotReference();
  let intake = enqueueBridgeWork({
    schemaVersion: STATE_SCHEMA_VERSION,
    processedSnapshot: null,
    pendingBridges: [],
    removedJobs: [],
  }, { job, snapshot, reason: 'new' });

  intake = transitionPendingBridgeStage(intake, job.id, 'publishing', {
    at: '2026-09-01T18:01:00.000Z',
  });
  intake = transitionPendingBridgeStage(intake, job.id, 'retryable', {
    at: '2026-09-01T18:02:00.000Z',
    errorCode: 'deployment',
  });
  assert.equal(intake.pendingBridges[0].stage.status, 'retryable');
  assert.deepEqual(intake.pendingBridges[0].stage.lastError, {
    code: 'deployment',
    at: '2026-09-01T18:02:00.000Z',
  });

  intake = transitionPendingBridgeStage(intake, job.id, 'publishing', {
    at: '2026-09-01T18:03:00.000Z',
  });
  intake = transitionPendingBridgeStage(intake, job.id, 'published', {
    at: '2026-09-01T18:04:00.000Z',
    result: { status: 'deployed' },
  });
  assert.equal(intake.pendingBridges[0].stage.attempts, 2);
  assert.deepEqual(intake.pendingBridges[0].stage.result, { status: 'deployed' });
  assert.throws(
    () => transitionPendingBridgeStage(intake, 'gh_ffffffffffffffffffffffff', 'publishing'),
    /not found/u,
  );
  assert.throws(
    () => transitionPendingBridgeStage(intake, job.id, 'pending'),
    /transition/u,
  );
});

validation('keeps network transitions independent and caps attempts', () => {
  const job = makeJob();
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot: snapshotReference(),
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  queue = transitionQueueStage(queue, job.id, 'bluesky', 'publishing', { at: '2026-08-20T13:02:00.000Z' });
  queue = transitionQueueStage(queue, job.id, 'bluesky', 'published', {
    at: '2026-08-20T13:02:10.000Z',
    result: { uri: 'at://did:plc:fixture/app.bsky.feed.post/opening-fixture' },
  });
  assert.equal(queue.items[0].bluesky.status, 'published');
  assert.equal(queue.items[0].mastodon.status, 'pending');
  assert.throws(() => transitionQueueStage(queue, job.id, 'bluesky', 'pending'), /transition/i);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    queue = transitionQueueStage(queue, job.id, 'mastodon', 'publishing', { at: `2026-08-20T13:0${attempt + 3}:00.000Z` });
    queue = transitionQueueStage(queue, job.id, 'mastodon', 'retryable', {
      at: `2026-08-20T13:0${attempt + 3}:10.000Z`,
      errorCode: 'provider_timeout',
    });
  }
  assert.equal(queue.items[0].mastodon.status, 'failed');
  assert.equal(queue.items[0].mastodon.attempts, 3);
  assert.deepEqual(Object.keys(queue.items[0].mastodon.lastError).sort(), ['at', 'code']);
  queue = resetFailedStage(queue, job.id, 'mastodon', {
    at: '2026-08-20T14:00:00.000Z',
    reason: 'credential_rotated',
  });
  assert.equal(queue.items[0].mastodon.status, 'pending');
  assert.equal(queue.items[0].mastodon.attempts, 0);
});

validation('resets only published Meta stages for a controlled visual migration', () => {
  const job = makeJob();
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot: snapshotReference(),
    discoveredAt: '2026-08-20T13:01:00.000Z',
    enabledChannels: ['bluesky', 'mastodon', 'threads', 'instagram'],
  });
  for (const channel of ['bluesky', 'mastodon', 'threads', 'instagram']) {
    queue = transitionQueueStage(queue, job.id, channel, 'publishing', {
      at: '2026-08-20T13:02:00.000Z',
    });
    queue = transitionQueueStage(queue, job.id, channel, 'published', {
      at: '2026-08-20T13:02:10.000Z',
      result: {
        id: `${channel}-old`,
        url: `https://example.test/${channel}-old`,
      },
    });
  }
  const previousBluesky = structuredClone(queue.items[0].bluesky);
  const previousMastodon = structuredClone(queue.items[0].mastodon);
  const previousBridge = structuredClone(queue.items[0].bridge);
  const migrated = resetPublishedMetaStages(queue, job.id, {
    at: '2026-08-28T14:00:00.000Z',
    reason: 'meta_publication_migration',
  });

  assert.deepEqual(migrated.items[0].bluesky, previousBluesky);
  assert.deepEqual(migrated.items[0].mastodon, previousMastodon);
  assert.deepEqual(migrated.items[0].bridge, previousBridge);
  for (const channel of ['threads', 'instagram']) {
    assert.equal(migrated.items[0][channel].status, 'pending');
    assert.equal(migrated.items[0][channel].attempts, 0);
    assert.equal(migrated.items[0][channel].result, null);
    assert.deepEqual(migrated.items[0][channel].lastReset, {
      at: '2026-08-28T14:00:00.000Z',
      reason: 'meta_publication_migration',
    });
  }
  assert.throws(() => resetPublishedMetaStages(migrated, job.id, {
    at: '2026-08-28T14:00:00.000Z',
    reason: 'meta_publication_migration',
  }), /published Meta stages/u);
});

validation('requires an explicit bounded request for a Meta publication migration', () => {
  assert.equal(META_MIGRATION_REVISION, 'white_band_poster_v4_social_video_v4');
  assert.equal(META_RECONCILIATION_MARKER, '#OpeningsJobs');
  assert.deepEqual(parseMetaMigrationRequest({
    jobIds: ['gh_111111111111111111111111', 'gh_222222222222222222222222'],
    confirmation: 'MIGRATE_META_POSTS',
  }), {
    jobIds: ['gh_111111111111111111111111', 'gh_222222222222222222222222'],
  });
  assert.throws(() => parseMetaMigrationRequest({
    jobIds: ['gh_111111111111111111111111'],
    confirmation: 'yes',
  }), /exact confirmation phrase/u);
  assert.throws(() => parseMetaMigrationRequest({
    jobIds: ['not-a-job'],
    confirmation: 'MIGRATE_META_POSTS',
  }), /job ID/u);
});

validation('replaces only Meta publications and records recoverable cleanup state', async () => {
  const job = makeJob();
  const snapshot = makeLoadedSnapshot({
    commit: 'f'.repeat(40),
    generatedAt: '2026-08-28T13:00:00.000Z',
    dataHash: 'a'.repeat(64),
    jobs: [job],
  });
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
    enabledChannels: ['bluesky', 'mastodon', 'threads', 'instagram'],
  });
  for (const stage of ['bridge', 'bluesky', 'mastodon', 'threads', 'instagram']) {
    queue = transitionQueueStage(queue, job.id, stage, 'publishing', {
      at: '2026-08-20T13:02:00.000Z',
    });
    queue = transitionQueueStage(queue, job.id, stage, 'published', {
      at: '2026-08-20T13:02:10.000Z',
      result: stage === 'bridge'
        ? {
          instagramCardVersion: '1',
          socialVideoVersion: '1',
          socialVideoUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video.mp4?v=1`,
          socialVideoCoverUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video-cover.jpg?v=1`,
        }
        : { id: `${stage}-old`, url: `https://example.test/${stage}-old` },
    });
  }
  const priorMigration = {
    revision: 'poster_v3_social_video_v2',
    marker: '#OpeningsPosterV3',
    completedAt: '2026-08-27T13:03:00.000Z',
    threads: {
      previous: { id: 'threads-legacy', url: 'https://example.test/threads-legacy' },
      replacement: queue.items[0].threads.result,
      cleanup: 'manual_required',
    },
    instagram: {
      previous: { id: 'instagram-legacy', url: 'https://example.test/instagram-legacy' },
      replacement: queue.items[0].instagram.result,
      cleanup: 'manual_required',
    },
  };
  const publicationsState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: {
      [job.id]: {
        status: 'completed',
        contentHash: job.contentHash,
        dataCommit: snapshot.commit,
        dataHash: snapshot.dataHash,
        completedAt: '2026-08-20T13:03:00.000Z',
        bluesky: queue.items[0].bluesky.result,
        mastodon: queue.items[0].mastodon.result,
        threads: queue.items[0].threads.result,
        instagram: queue.items[0].instagram.result,
        linkedin: null,
        twitter: null,
        metaMigration: priorMigration,
      },
    },
  };
  const previousBluesky = structuredClone(publicationsState.jobs[job.id].bluesky);
  const previousMastodon = structuredClone(publicationsState.jobs[job.id].mastodon);
  const deleted = [];
  const result = await migrateMetaPublication({
    queueState: queue,
    publicationsState,
    currentSnapshot: snapshot,
    jobId: job.id,
    now: '2026-08-28T14:00:00.000Z',
    publishBridge: async () => ({
      instagramCardVersion: INSTAGRAM_CARD_VERSION,
      socialVideoVersion: SOCIAL_VIDEO_VERSION,
      socialVideoUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video.mp4?v=3`,
      socialVideoCoverUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video-cover.jpg?v=3`,
    }),
    publishThreads: async () => ({
      status: 'published',
      id: 'threads-new',
      url: 'https://example.test/threads-new',
    }),
    publishInstagram: async ({ queueItem }) => {
      assert.match(queueItem.bridge.result.socialVideoUrl, /v=3$/u);
      return {
        status: 'published',
        id: 'instagram-new',
        url: 'https://example.test/instagram-new',
      };
    },
    deleteThreads: async ({ id }) => {
      deleted.push(id);
      return { id, status: 'deleted' };
    },
  });

  assert.equal(result.outcome, 'migrated');
  assert.equal(result.queueState.items[0].bluesky.result.id, 'bluesky-old');
  assert.equal(result.queueState.items[0].mastodon.result.id, 'mastodon-old');
  assert.equal(result.queueState.items[0].threads.result.id, 'threads-new');
  assert.equal(result.queueState.items[0].instagram.result.id, 'instagram-new');
  assert.deepEqual(deleted, ['threads-old']);
  assert.equal(result.publicationsState.jobs[job.id].metaMigration.revision, META_MIGRATION_REVISION);
  assert.equal(result.publicationsState.jobs[job.id].metaMigration.marker, META_RECONCILIATION_MARKER);
  assert.equal(result.publicationsState.jobs[job.id].metaMigration.threads.cleanup, 'deleted');
  assert.equal(result.publicationsState.jobs[job.id].metaMigration.instagram.cleanup, 'manual_required');
  assert.equal(result.publicationsState.jobs[job.id].metaMigration.instagram.previous.id, 'instagram-old');
  assert.equal(result.publicationsState.jobs[job.id].metaMigration.instagram.replacement.id, 'instagram-new');
  assert.deepEqual(result.publicationsState.jobs[job.id].bluesky, previousBluesky);
  assert.deepEqual(result.publicationsState.jobs[job.id].mastodon, previousMastodon);
  assert.equal(result.publicationsState.jobs[job.id].metaMigration.history.length, 1);
  assert.deepEqual(result.publicationsState.jobs[job.id].metaMigration.history[0], priorMigration);
  assert.equal('history' in result.publicationsState.jobs[job.id].metaMigration.history[0], false);

  const repeated = await migrateMetaPublication({
    ...result,
    currentSnapshot: snapshot,
    jobId: job.id,
    now: '2026-08-28T14:10:00.000Z',
    publishBridge: async () => { throw new Error('must not republish bridge'); },
    publishThreads: async () => { throw new Error('must not republish Threads'); },
    publishInstagram: async () => { throw new Error('must not republish Instagram'); },
    deleteThreads: async () => { throw new Error('must not delete twice'); },
  });
  assert.equal(repeated.outcome, 'already_migrated');

  const manualCleanup = await migrateMetaPublication({
    queueState: queue,
    publicationsState,
    currentSnapshot: snapshot,
    jobId: job.id,
    now: '2026-08-28T14:20:00.000Z',
    publishBridge: async () => ({
      instagramCardVersion: INSTAGRAM_CARD_VERSION,
      socialVideoVersion: SOCIAL_VIDEO_VERSION,
      socialVideoUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video.mp4?v=3`,
      socialVideoCoverUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video-cover.jpg?v=3`,
    }),
    publishThreads: async () => ({
      status: 'published',
      id: 'threads-new',
      url: 'https://example.test/threads-new',
    }),
    publishInstagram: async () => ({
      status: 'published',
      id: 'instagram-new',
      url: 'https://example.test/instagram-new',
    }),
  });
  assert.equal(manualCleanup.outcome, 'migrated');
  assert.equal(manualCleanup.publicationsState.jobs[job.id].metaMigration.threads.cleanup, 'manual_required');
});

validation('selects newest work unless an older item is starving', () => {
  const oldJob = makeJob({ id: 'gh_111111111111111111111111', createdAt: '2026-08-18T10:00:00.000Z' });
  const newJob = makeJob({ id: 'gh_222222222222222222222222', createdAt: '2026-08-20T12:00:00.000Z' });
  let queue = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };
  queue = enqueueJob(queue, { job: oldJob, snapshot: snapshotReference(), discoveredAt: '2026-08-20T10:00:00.000Z' });
  queue = enqueueJob(queue, { job: newJob, snapshot: snapshotReference(), discoveredAt: '2026-08-20T12:30:00.000Z' });
  assert.equal(selectNextQueueItem(queue, '2026-08-20T14:00:00.000Z').jobId, newJob.id);
  assert.equal(selectNextQueueItem(queue, '2026-08-21T11:00:00.000Z').jobId, oldJob.id);
  const restarted = structuredClone(queue);
  assert.equal(selectNextQueueItem(restarted, '2026-08-21T11:00:00.000Z').jobId, oldJob.id);
});

validation('prioritizes cross-channel work over a starving legacy-channel item', () => {
  const legacyJob = makeJob({ id: 'gh_333333333333333333333333', createdAt: '2026-08-18T10:00:00.000Z' });
  const crossChannelJob = makeJob({ id: 'gh_444444444444444444444444', createdAt: '2026-08-20T12:00:00.000Z' });
  let queue = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };
  queue = enqueueJob(queue, {
    job: legacyJob,
    snapshot: snapshotReference(),
    discoveredAt: '2026-08-20T10:00:00.000Z',
  });
  queue = enqueueJob(queue, {
    job: crossChannelJob,
    snapshot: snapshotReference(),
    discoveredAt: '2026-08-20T12:30:00.000Z',
    enabledChannels: ['bluesky', 'mastodon', 'threads', 'instagram'],
  });

  assert.equal(
    selectNextQueueItem(queue, '2026-08-21T11:00:00.000Z').jobId,
    crossChannelJob.id,
  );
});

validation('skips social work blocked by a terminal bridge failure', () => {
  const blockedJob = makeJob({
    id: 'gh_555555555555555555555555',
    createdAt: '2026-08-18T10:00:00.000Z',
  });
  const healthyJob = makeJob({
    id: 'gh_666666666666666666666666',
    createdAt: '2026-08-20T12:00:00.000Z',
  });
  let queue = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };
  queue = enqueueJob(queue, {
    job: blockedJob,
    snapshot: snapshotReference(),
    discoveredAt: '2026-08-18T10:01:00.000Z',
  });
  queue = enqueueJob(queue, {
    job: healthyJob,
    snapshot: snapshotReference(),
    discoveredAt: '2026-08-20T12:01:00.000Z',
  });
  queue.items[0].bridge = {
    status: 'failed',
    attempts: MAX_CHANNEL_ATTEMPTS,
    updatedAt: '2026-08-20T13:00:00.000Z',
    lastError: { code: 'deployment', at: '2026-08-20T13:00:00.000Z' },
    lastReset: null,
    result: null,
  };

  assert.equal(
    selectNextQueueItem(queue, '2026-08-21T11:00:00.000Z').jobId,
    healthyJob.id,
  );
  assert.deepEqual(decideScheduledWork({
    publishEnabled: true,
    intakeState: {
      schemaVersion: STATE_SCHEMA_VERSION,
      processedSnapshot: snapshotReference(),
      pendingBridges: [],
      removedJobs: [],
    },
    queueState: queue,
    currentDataHash: snapshotReference().dataHash,
  }), { shouldRun: true, reason: 'queued', queueDepth: 1 });

  const manuallyReset = resetFailedStage(queue, blockedJob.id, 'bridge', {
    at: '2026-08-21T11:01:00.000Z',
    reason: 'manual_reset',
  });
  assert.equal(
    selectNextQueueItem(manuallyReset, '2026-08-21T11:02:00.000Z').jobId,
    blockedJob.id,
  );
});

validation('marks a closed queued job without publishing either channel', () => {
  const job = makeJob();
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot: snapshotReference(),
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  queue = markJobClosed(queue, job.id, '2026-08-20T13:30:00.000Z');
  assert.equal(queue.items[0].bridge.status, 'skipped_closed');
  assert.equal(queue.items[0].bluesky.status, 'skipped_closed');
  assert.equal(queue.items[0].mastodon.status, 'skipped_closed');
  assert.equal(queue.items[0].threads.status, 'skipped_disabled');
  assert.equal(queue.items[0].instagram.status, 'skipped_disabled');
  assert.equal(selectNextQueueItem(queue, '2026-08-20T14:00:00.000Z'), null);
});

validation('formats salary bounds without turning a maximum into an exact salary', () => {
  assert.equal(formatSalary({ currency: 'USD', min: 9000, period: 'month' }), 'From $9,000/month');
  assert.equal(formatSalary({ currency: 'USD', max: 12000, period: 'month' }), 'Up to $12,000/month');
  assert.equal(formatSalary({ currency: 'USD', min: 9000, max: 12000, period: 'month' }), '$9,000–$12,000/month');
  assert.equal(formatSalary({ currency: 'USD', min: 12000, max: 9000, period: 'month' }), null);
  assert.equal(formatSalary(null), null);
});

validation('writes concise English framing while preserving the original title', () => {
  const post = formatSocialPost(makeJob({
    title: 'Desenvolvedor(a) TypeScript Sênior',
    community: { name: 'Openings Fixtures' },
    country: 'Brazil',
    region: 'South America',
    tags: ['remote', 'senior', 'typescript'],
    salary: { currency: 'BRL', min: 12000, max: 18000, period: 'month' },
  }));
  assert.equal(post.title, 'Desenvolvedor(a) TypeScript Sênior');
  assert.match(post.text, /^New job on openings\.dev\n\nDesenvolvedor\(a\) TypeScript Sênior/);
  assert.match(post.text, /Openings Fixtures · Brazil · South America/);
  assert.match(post.text, /R\$12,000–R\$18,000\/month/);
  assert.match(post.text, /View the listing:\nhttps:\/\/openings\.dev\/jobs\/gh_0123456789abcdef01234567/);
  assert.match(post.text, /#TechJobs #TypeScript$/);
});

validation('omits unknown metadata and unsafe stack hashtags', () => {
  const post = formatSocialPost(makeJob({
    community: null,
    country: 'Unknown',
    region: '',
    tags: ['remote', 'senior', 'c++'],
    salary: null,
  }));
  assert.equal(post.metadataLine, null);
  assert.equal(post.salaryLine, null);
  assert.equal(post.hashtags, '#TechJobs');
  assert.doesNotMatch(post.text, /Unknown|undefined|null|#C/);
});

validation('formats an Instagram caption for discovery and conversation', async () => {
  const { formatInstagramCaption } = await import('../render/instagram-caption.mjs');
  const remoteJob = makeJob({
    title: 'Senior TypeScript Engineer',
    community: { name: 'Openings Fixtures' },
    country: 'Remote',
    region: 'Worldwide',
    tags: ['typescript', 'remote', 'senior'],
  });
  const remotePost = formatSocialPost(remoteJob);
  const remoteCaption = formatInstagramCaption(remoteJob, remotePost);

  assert.match(remoteCaption, /Senior TypeScript Engineer/u);
  assert.match(remoteCaption, new RegExp(remotePost.canonicalUrl));
  assert.match(remoteCaption, /Know someone who fits\? Tag them below\./u);
  assert.match(remoteCaption, /Follow @openingshq for more jobs from public communities\./u);
  assert.match(remoteCaption, /#TechJobs #TypeScript #OpeningsJobs #Hiring #RemoteJobs$/u);
  assert.doesNotMatch(remoteCaption, /#OpeningsPosterV\d+/u);
  assert.equal((remoteCaption.match(/https:\/\/openings\.dev\/jobs\//gu) ?? []).length, 1);

  const onsiteJob = makeJob({
    title: 'Frontend Engineer in Tokyo',
    country: 'Japan',
    region: 'Tokyo',
    tags: ['typescript', 'frontend'],
  });
  const onsiteCaption = formatInstagramCaption(onsiteJob, formatSocialPost(onsiteJob));
  const hashtags = onsiteCaption.match(/#[\p{L}\p{N}]+/gu) ?? [];
  assert.doesNotMatch(onsiteCaption, /#RemoteJobs/u);
  assert.equal(new Set(hashtags).size, hashtags.length);
  assert.ok(hashtags.length <= 5);

  const onsiteCjkJob = makeJob({
    title: '[广州 / 线下] Bitcoin 开发工程师',
    country: 'Global',
    region: 'Worldwide',
    tags: ['engineering'],
  });
  const onsiteCjkCaption = formatInstagramCaption(onsiteCjkJob, formatSocialPost(onsiteCjkJob));
  assert.doesNotMatch(onsiteCjkCaption, /#RemoteJobs/u);
});

validation('keeps long Unicode posts within the Bluesky grapheme limit', () => {
  const title = `${'高性能ソフトウェアエンジニア🚀'.repeat(24)} final`;
  const post = formatSocialPost(makeJob({
    title,
    community: { name: 'A very long international community name that may be omitted' },
    country: 'Worldwide',
    region: 'Global',
    tags: ['typescript'],
  }));
  assert.ok(countGraphemes(post.text) <= 300);
  assert.ok(post.title.endsWith('…'));
  assert.equal((post.text.match(/https:\/\/openings\.dev\/jobs\//g) ?? []).length, 1);
  assert.match(post.text, /View the listing:/);
  assert.match(post.text, /#TechJobs #TypeScript$/);
});

validation('formats a tighter Twitter post within its own 280-grapheme limit', () => {
  const job = makeJob({
    title: 'Staff Platform Engineer for Distributed Systems and Developer Experience Tooling',
    excerpt: 'A very long excerpt that has no bearing on the post body but exercises the formatter.',
  });
  const defaultPost = formatSocialPost(job);
  const twitterPost = formatSocialPost(job, { maxGraphemes: TWITTER_POST_MAX_GRAPHEMES });
  assert.ok(countGraphemes(defaultPost.text) <= 300);
  assert.ok(countGraphemes(twitterPost.text) <= 280);
  assert.ok(countGraphemes(twitterPost.text) <= countGraphemes(defaultPost.text));
  assert.equal(twitterPost.canonicalUrl, defaultPost.canonicalUrl);
  assert.equal(twitterPost.hashtags, defaultPost.hashtags);
});

validation('renders a complete escaped canonical job bridge', () => {
  const job = makeJob({
    title: '<script>publish()</script> Senior Engineer',
    excerpt: 'Build tools & keep users safe. <img src=x onerror=publish()>',
    community: { name: 'Openings & Friends' },
  });
  const imageHash = 'b'.repeat(64);
  const html = createBridgeHtml(job, { imageHash });
  const canonicalUrl = `https://openings.dev/jobs/${job.id}`;
  assert.match(html, /<!doctype html>/i);
  assert.match(html, new RegExp(`<link rel="canonical" href="${canonicalUrl}"`));
  assert.match(html, new RegExp(`<meta property="og:url" content="${canonicalUrl}"`));
  assert.match(html, new RegExp(`<meta property="og:image" content="${canonicalUrl}/opengraph-image.png\\?v=2\\.${imageHash.slice(0, 16)}"`));
  assert.match(html, new RegExp(`<meta name="twitter:image" content="${canonicalUrl}/opengraph-image.png\\?v=2\\.${imageHash.slice(0, 16)}"`));
  assert.match(html, /<meta property="og:image:width" content="1200">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, new RegExp(`<meta name="openings:data-hash" content="${job.contentHash}"`));
  assert.match(html, /<meta name="openings:instagram-card-version" content="4">/u);
  assert.match(html, /<meta name="openings:social-video-version" content="4">/u);
  assert.match(html, /&lt;script&gt;publish\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img src=x|onerror=/);
  assert.match(html, new RegExp(`location\\.replace\\("https://openings\\.dev/\\?job=${job.id}"\\)`));
  assert.throws(() => createBridgeHtml(job), /image hash/i);
});

validation('renders the production social-card system to a bounded PNG', async () => {
  const job = makeJob({
    title: 'Senior TypeScript Engineer building reliable community tools',
    excerpt: 'Build reliable developer tools with a distributed open source team.',
    community: { name: 'Openings Fixtures' },
    country: 'Remote',
    region: 'Worldwide',
    tags: ['typescript', 'remote', 'senior'],
    salary: { currency: 'USD', min: 9000, max: 12000, period: 'month' },
  });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302e"/></svg>';
  const svg = createSocialCardSvg(job, { wordmarkSvg });
  const theme = resolveSocialTheme(job.id);
  assert.match(svg, /width="1200" height="630"/);
  for (const color of ['#f5f3ef', '#fffefa', '#21302e', '#5e6663', '#d8d8d1', '#f0f1ed', theme.accent, theme.soft]) {
    assert.match(svg, new RegExp(color));
  }
  assert.match(svg, new RegExp(`data-theme="${theme.id}"`));
  assert.match(svg, /data:image\/svg\+xml;base64,/);
  assert.match(svg, /Senior TypeScript Engineer/);
  assert.match(svg, /View job/);

  const png = await renderSocialCardPng(job, { wordmarkSvg });
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 630);
  assert.ok(png.byteLength < 2 * 1024 * 1024);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const dispatch = buildRepositoryDispatchRequest({
    jobId: job.id,
    contentHash: job.contentHash,
    html: Buffer.from(createBridgeHtml(job, { imageHash: sha256(png) })),
    image: png,
    instagramSvg: Buffer.from(socialCardModule.createInstagramCardSvg(job, { wordmarkSvg })),
    repository: 'openings-dev/web-deploy',
  });
  assert.ok(dispatch.body.length <= MAX_REPOSITORY_DISPATCH_BODY_CHARACTERS);
});

validation('keeps a long salary period intact in the social-card sidebar', () => {
  const job = makeJob({
    salary: { currency: 'BRL', min: 7000, max: 12000, period: 'month' },
  });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const svg = createSocialCardSvg(job, { wordmarkSvg });

  assert.match(svg, />R\$7,000–R\$12,000<\/text>/u);
  assert.match(svg, />\/month<\/text>/u);
  assert.doesNotMatch(svg, />mon<\/text>.*>th<\/text>/su);
});

validation('bounds long Unicode card titles to three lines', () => {
  const job = makeJob({ title: '高性能ソフトウェアエンジニア🚀'.repeat(20) });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const svg = createSocialCardSvg(job, { wordmarkSvg });
  const titleLines = svg.match(/data-title-line="true"/g) ?? [];
  assert.ok(titleLines.length >= 1 && titleLines.length <= 3);
  assert.match(svg, /…/);
});

validation('renders multilingual CJK social cards with the system font contract', async () => {
  const job = makeJob({
    title: '全球远程 ソフトウェアエンジニア 소프트웨어 엔지니어',
    community: { name: '国際開発コミュニティ' },
  });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const svg = createSocialCardSvg(job, { wordmarkSvg });

  assert.doesNotMatch(svg, /data:font\/woff2;base64,/u);
  assert.match(svg, /Noto Sans CJK SC/u);
  assert.match(svg, /Noto Sans CJK JP/u);
  assert.match(svg, /Noto Sans CJK KR/u);

  const png = await renderSocialCardPng(job, { wordmarkSvg });
  const metadata = await sharp(png).metadata();
  assert.deepEqual([metadata.width, metadata.height], [1200, 630]);
});

validation('uses installed Noto CJK fonts instead of ignored embedded web fonts', () => {
  assert.equal(createCjkFontStyle('全球远程 ソフトウェア 엔지니어'), '');
  assert.equal(
    SOCIAL_CARD_FONT_STACK,
    'Noto Sans CJK SC, Noto Sans CJK JP, Noto Sans CJK KR, Arial, sans-serif',
  );
});

validation('builds a compact immutable full-canvas poster model', async () => {
  const posterModule = await import('../render/social-poster-model.mjs');
  const { resolveSocialTheme } = await import('../render/social-theme.mjs');
  assert.equal(posterModule.SOCIAL_POSTER_MODEL_VERSION, 3);
  assert.equal(posterModule.SOCIAL_SAFE_INSET_X, 180);
  assert.equal(posterModule.SOCIAL_SAFE_INSET_Y, 320);
  assert.deepEqual(posterModule.INSTAGRAM_POSTER_GEOMETRY.safeArea, {
    x: 30,
    y: 60,
    width: 1020,
    height: 1230,
  });
  assert.deepEqual(posterModule.REEL_POSTER_GEOMETRY.safeArea, {
    x: 180,
    y: 320,
    width: 720,
    height: 1440,
  });
  assert.deepEqual(posterModule.REEL_POSTER_GEOMETRY.header, {
    x: 180, y: 320, width: 720, height: 120,
  });
  assert.deepEqual(posterModule.REEL_POSTER_GEOMETRY.role, {
    x: 180, y: 440, width: 720, height: 570,
  });
  assert.deepEqual(posterModule.REEL_POSTER_GEOMETRY.facts, {
    x: 180, y: 1030, width: 720, height: 420,
  });
  assert.deepEqual(posterModule.REEL_POSTER_GEOMETRY.attribution, {
    x: 180, y: 1490, width: 720, height: 260,
  });

  const salaryJob = makeJob({
    salary: { currency: 'USD', min: 9000, max: 12000, period: 'month' },
    tags: ['remote', 'typescript'],
    country: 'Brazil',
    region: 'Latin America',
    community: { name: 'Awesome Jobs' },
  });
  const salary = posterModule.createSocialPosterModel(salaryJob);
  assert.equal(salary.dominantFact.label, 'SALARY');
  assert.equal(salary.dominantFact.value, '$9,000–$12,000/month');
  assert.deepEqual(salary.theme, resolveSocialTheme(salaryJob.id));
  assert.deepEqual(salary.supportingFacts.map(({ label }) => label), ['WORK MODE', 'LOCATION']);
  assert.equal(Object.isFrozen(salary), true);
  assert.equal(Object.isFrozen(salary.theme), true);
  assert.equal(Object.isFrozen(salary.layouts.instagram), true);

  const remote = posterModule.createSocialPosterModel(makeJob({
    tags: ['typescript', 'remote'],
    country: 'Worldwide',
    community: { name: 'Remote Makers' },
  }));
  assert.deepEqual(remote.dominantFact, { label: 'WORK MODE', value: 'REMOTE' });

  const hybrid = posterModule.createSocialPosterModel(makeJob({ tags: ['hybrid'] }));
  assert.deepEqual(hybrid.dominantFact, { label: 'WORK MODE', value: 'HYBRID' });

  const onsite = posterModule.createSocialPosterModel(makeJob({ tags: ['on-site'] }));
  assert.deepEqual(onsite.dominantFact, { label: 'WORK MODE', value: 'ON-SITE' });

  const location = posterModule.createSocialPosterModel(makeJob({
    country: 'Japan',
    region: 'Asia',
    tags: ['rust'],
  }));
  assert.deepEqual(location.dominantFact, { label: 'LOCATION', value: 'Japan · Asia' });

  const fallback = posterModule.createSocialPosterModel(makeJob({
    repository: 'fallback-owner/jobs',
  }));
  assert.deepEqual(fallback.dominantFact, { label: 'STATUS', value: 'OPEN ROLE' });
  assert.equal(fallback.community, 'fallback-owner');
  assert.equal(fallback.supportingFacts.some(({ value }) => value === 'Location not specified'), true);

  const encoded = posterModule.encodeSocialPosterModel(salary);
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/u);
  assert.ok(encoded.length < 8_192);
  assert.deepEqual(posterModule.decodeSocialPosterModel(encoded), salary);
  const unsupportedTheme = structuredClone(salary);
  unsupportedTheme.theme.accent = '#ffffff';
  assert.throws(() => posterModule.validateSocialPosterModel(unsupportedTheme), /theme/u);
});

validation('fits Latin, CJK, and emoji-led poster titles deterministically', async () => {
  const { createSocialPosterModel } = await import('../render/social-poster-model.mjs');
  const fixtures = [
    'Senior Product Engineer',
    'Principal Platform Engineer building reliable distributed developer infrastructure across public communities',
    '東京勤務 シニアソフトウェアエンジニア プラットフォーム信頼性と開発者体験',
    '全球远程 高级软件工程师 开发者平台与基础设施',
    '🚀 Senior TypeScript Engineer for community infrastructure',
  ];
  for (const title of fixtures) {
    const first = createSocialPosterModel(makeJob({ title }));
    const second = createSocialPosterModel(makeJob({ title }));
    assert.deepEqual(first.layouts, second.layouts);
    for (const layout of [first.layouts.instagram, first.layouts.reel]) {
      assert.ok(layout.titleLines.length >= 1 && layout.titleLines.length <= 5);
      assert.ok(layout.titleLines.every((line) => !line.includes('\uFFFD')));
      assert.ok(layout.titleFontSize >= 68);
    }
  }

  const overflowing = createSocialPosterModel(makeJob({
    title: '超高性能分散システムソフトウェアエンジニア'.repeat(18),
  }));
  assert.equal(overflowing.layouts.instagram.titleLines.at(-1).endsWith('…'), true);
  assert.equal(overflowing.layouts.reel.titleLines.at(-1).endsWith('…'), true);
});

validation('defines a white-led editorial-band Instagram poster', () => {
  assert.equal(typeof socialCardModule.createInstagramCardSvg, 'function');
  const job = makeJob({
    title: '[广州 / 线下] 招聘Bitcoin创新开发工程师 | 国内BTC底层开发团队',
    community: { name: 'rebase-network' },
    country: 'Global',
    tags: ['on-site'],
  });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const svg = socialCardModule.createInstagramCardSvg(job, { wordmarkSvg });
  const theme = resolveSocialTheme(job.id);

  assert.match(svg, /width="1080" height="1350" viewBox="0 0 1080 1350"/u);
  assert.match(svg, /data-instagram-card="true"/u);
  assert.match(svg, new RegExp(`data-theme="${theme.id}"`));
  assert.match(svg, /data-social-poster-version="3"/u);
  assert.match(svg, /data-poster-model="[A-Za-z0-9+/]+={0,2}"/u);
  assert.match(svg, /data-safe-area="true"[^>]*x="30"[^>]*y="60"[^>]*width="1020"[^>]*height="1230"/u);
  assert.match(svg, /data-poster-role-region="true"[^>]*x="30"[^>]*y="152"[^>]*width="1020"[^>]*height="590"/u);
  assert.match(svg, /data-poster-facts-region="true"[^>]*x="30"[^>]*y="742"[^>]*width="1020"[^>]*height="341"/u);
  assert.match(svg, /data-poster-attribution-region="true"[^>]*x="30"[^>]*y="1107"[^>]*width="1020"[^>]*height="183"/u);
  assert.match(svg, new RegExp(`data-editorial-band="true"[^>]*y="1107"[^>]*height="243"[^>]*fill="${theme.accent}"`));
  assert.match(svg, /data-instagram-title-line="true"/u);
  assert.match(svg, /工程师—国内/u);
  assert.doesNotMatch(svg, />\|<\/text>/u);
  assert.match(svg, /data-instagram-wordmark="true"[^>]*width="250"/u);
  assert.match(svg, />@openingshq<\/text>/u);
  assert.match(svg, /data-instagram-facts="true"[^>]*x="30"[^>]*y="742"[^>]*height="341"[^>]*rx="28"[^>]*fill="#f0f1ed"/u);
  assert.match(svg, /data-instagram-dominant-fact="true"/u);
  assert.match(svg, />WORK MODE<\/text>/u);
  assert.match(svg, />ON-SITE<\/text>/u);
  assert.match(svg, /data-instagram-cta="true"[^>]*x="700"[^>]*y="1152"[^>]*width="350"[^>]*height="88"/u);
  assert.match(svg, /Find this opening on openings\.dev/u);
  assert.doesNotMatch(svg, /data:font\/woff2;base64,/u);
  assert.doesNotMatch(svg, /x="40" y="40" width="1000" height="1270"/u);
  assert.doesNotMatch(svg, /data-instagram-facts="true"[^>]*y="830"/u);

  const importantBounds = [...svg.matchAll(
    /data-important-content="true" data-x="(?<x>\d+)" data-y="(?<y>\d+)" data-width="(?<width>\d+)" data-height="(?<height>\d+)"/gu,
  )];
  assert.ok(importantBounds.length >= 4);
  for (const match of importantBounds) {
    const bounds = Object.fromEntries(
      Object.entries(match.groups).map(([key, value]) => [key, Number(value)]),
    );
    assert.ok(bounds.x >= 30 && bounds.y >= 60);
    assert.ok(bounds.x + bounds.width <= 1050);
    assert.ok(bounds.y + bounds.height <= 1290);
  }

  const shortSvg = socialCardModule.createInstagramCardSvg(
    makeJob({ title: 'Senior Product Engineer', tags: ['typescript'] }),
    { wordmarkSvg },
  );
  assert.match(shortSvg, /font-size="112"[^>]*data-instagram-title-line="true"/u);
  assert.match(shortSvg, />SHARED THROUGH<\/text>/u);

  const longSalarySvg = socialCardModule.createInstagramCardSvg(makeJob({
    salary: { currency: 'JPY', min: 9000000, max: 14000000, period: 'year' },
  }), { wordmarkSvg });
  assert.match(longSalarySvg, />SALARY<\/text>/u);
  assert.match(longSalarySvg, />¥9,000,000–¥14,000,000\/year<\/text>/u);
  const monthlySalarySvg = socialCardModule.createInstagramCardSvg(makeJob({
    salary: { currency: 'USD', min: 9000, max: 12000, period: 'month' },
  }), { wordmarkSvg });
  assert.match(monthlySalarySvg, />\$9,000–\$12,000\/month<\/text>/u);
});

validation('renders a bounded 1080 by 1350 Instagram JPEG preview', async () => {
  assert.equal(typeof socialCardModule.renderInstagramCardJpeg, 'function');
  const job = makeJob({ title: 'Senior ソフトウェア Engineer' });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const jpeg = await socialCardModule.renderInstagramCardJpeg(job, { wordmarkSvg });
  const metadata = await sharp(jpeg).metadata();

  assert.deepEqual([metadata.format, metadata.width, metadata.height], ['jpeg', 1080, 1350]);
  assert.ok(jpeg.byteLength < 2 * 1024 * 1024);
});

validation('builds four white-led native 9:16 Reel stages from the canonical model', () => {
  const reelJob = makeJob({
    title: 'Senior ソフトウェア Engineer',
    country: 'Remote',
    region: 'Worldwide',
    tags: ['remote'],
    salary: { currency: 'USD', min: 9000, max: 12000, period: 'month' },
  });
  const instagramSvg = socialCardModule.createInstagramCardSvg(reelJob, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const stages = createReelStageSvgs(instagramSvg);
  const theme = resolveSocialTheme(reelJob.id);

  assert.equal(stages.length, 4);
  assert.deepEqual(
    stages.map((stage) => /data-reel-stage="(?<stage>[1-4])"/u.exec(stage)?.groups?.stage),
    ['1', '2', '3', '4'],
  );
  for (const stage of stages) {
    assert.match(stage, /width="1080" height="1920" viewBox="0 0 1080 1920"/u);
    assert.match(stage, new RegExp(`data-theme="${theme.id}"`));
    assert.match(stage, /<rect width="1080" height="1920" fill="#fffefa"/u);
    assert.match(stage, /data-safe-area="true"[^>]*x="180"[^>]*y="320"[^>]*width="720"[^>]*height="1440"/u);
    const importantBounds = [...stage.matchAll(
      /data-important-content="true" data-x="(?<x>\d+)" data-y="(?<y>\d+)" data-width="(?<width>\d+)" data-height="(?<height>\d+)"/gu,
    )];
    assert.equal(importantBounds.length, 4);
    for (const match of importantBounds) {
      const bounds = Object.fromEntries(
        Object.entries(match.groups).map(([key, value]) => [key, Number(value)]),
      );
      assert.ok(bounds.x >= 180 && bounds.y >= 320);
      assert.ok(bounds.x + bounds.width <= 900);
      assert.ok(bounds.y + bounds.height <= 1760);
    }
    assert.match(stage, /<image x="210" y="338" width="220" height="40"/u);
    assert.match(stage, /<text x="210"[^>]*data-reel-title-line="true"/u);
    assert.match(stage, /<text x="210"[^>]*data-reel-dominant-fact="true"/u);
    assert.match(stage, /<text x="870" y="350" text-anchor="end"/u);
    assert.match(stage, /<text x="210" y="1550"/u);
    assert.match(stage, /<rect x="510" y="1540" width="360" height="104"/u);
    assert.match(stage, /data:image\/svg\+xml;base64,/u);
    assert.match(stage, /@openingshq/u);
    assert.match(stage, /Senior/u);
    assert.match(stage, /ソフトウェア/u);
    assert.doesNotMatch(stage, /<image[^>]*x="60"[^>]*y="210"[^>]*width="960"[^>]*height="1200"/u);
    assert.doesNotMatch(stage, /data-reel-reveal="true"/u);
  }
  assert.match(stages[0], /data-reel-brand="true"[^>]*opacity="1"/u);
  assert.match(stages[0], /data-reel-title="true"[^>]*opacity="0"/u);
  assert.match(stages[1], /data-reel-title="true"[^>]*opacity="1"/u);
  assert.match(stages[1], /data-reel-facts="true"[^>]*opacity="0"/u);
  assert.match(stages[2], /data-reel-facts="true"[^>]*opacity="1"/u);
  assert.match(stages[2], /data-reel-facts-surface="true"[^>]*fill="#f0f1ed"[^>]*opacity="1"/u);
  assert.match(stages[2], /data-editorial-band="true"[^>]*x="0"[^>]*y="1490"[^>]*width="1080"[^>]*height="430"[^>]*opacity="0"/u);
  assert.match(stages[2], /data-reel-attribution="true"[^>]*opacity="0"/u);
  assert.match(stages[3], /data-reel-attribution="true"[^>]*opacity="1"/u);
  assert.match(stages[3], new RegExp(`data-editorial-band="true"[^>]*x="0"[^>]*y="1490"[^>]*width="1080"[^>]*height="430"[^>]*fill="${theme.accent}"[^>]*opacity="1"`));
  assert.match(stages[2], />\$9,000–\$12,000\/month<\/text>/u);
  assert.match(stages[2], />Remote · Worldwide<\/text>/u);
  assert.doesNotMatch(stages[2], />World<\/text>.*>wide<\/text>/su);
});

validation('creates an original deterministic 48 kHz stereo soundtrack', () => {
  const first = createOriginalSoundtrackWav();
  const second = createOriginalSoundtrackWav();

  assert.deepEqual(first, second);
  assert.equal(first.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(first.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(first.readUInt16LE(22), 2);
  assert.equal(first.readUInt32LE(24), 48_000);
  assert.equal(first.readUInt16LE(34), 16);
  assert.equal(first.byteLength, 44 + (9 * 48_000 * 2 * 2));
});

validation('builds an Instagram and Shorts compatible FFmpeg delivery contract', () => {
  const argumentsList = buildReelFfmpegArguments({
    stagePaths: ['/tmp/1.png', '/tmp/2.png', '/tmp/3.png', '/tmp/4.png'],
    audioPath: '/tmp/soundtrack.wav',
    outputPath: '/tmp/social-video.mp4',
  });
  const joined = argumentsList.join(' ');

  assert.match(joined, /xfade=transition=fade/u);
  assert.match(joined, /-c:v libx264/u);
  assert.match(joined, /-pix_fmt yuv420p/u);
  assert.match(joined, /-r 30/u);
  assert.match(joined, /-c:a aac/u);
  assert.match(joined, /-ar 48000/u);
  assert.match(joined, /-b:a 128k/u);
  assert.match(joined, /-movflags \+faststart/u);
  assert.match(joined, /-t 9/u);
  assert.equal(argumentsList.at(-1), '/tmp/social-video.mp4');
});

validation('renders the public Reel video and final-frame cover into one job directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-reel-render-'));
  const instagramSvg = socialCardModule.createInstagramCardSvg(makeJob({
    title: '[東京] シニアソフトウェアエンジニア',
  }), {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const calls = [];
  try {
    const result = await renderReelVideo({
      instagramSvg,
      outputDirectory: directory,
      execFileImpl: async (command, argumentsList) => {
        calls.push({ command, argumentsList });
        const output = Buffer.alloc(24);
        output.writeUInt32BE(24, 0);
        output.write('ftyp', 4, 'ascii');
        await writeFile(argumentsList.at(-1), output);
        return { stdout: '', stderr: '' };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'ffmpeg');
    assert.equal(result.videoPath, join(directory, 'social-video.mp4'));
    assert.equal(result.coverPath, join(directory, 'social-video-cover.jpg'));
    assert.equal(
      result.coverSourceHash,
      sha256(Buffer.from(createReelStageSvgs(instagramSvg).at(-1), 'utf8')),
    );
    assert.equal((await readFile(result.videoPath)).subarray(4, 8).toString('ascii'), 'ftyp');
    const cover = await sharp(await readFile(result.coverPath)).metadata();
    assert.deepEqual([cover.format, cover.width, cover.height], ['jpeg', 1080, 1920]);
    const residue = (await readdir(directory)).filter((name) => name.startsWith('.reel-render-'));
    assert.deepEqual(residue, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('dry run emits the canonical bridge and both platform image previews', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-social-publisher-dry-run-'));
  const fixturePath = join(directory, 'job.json');
  const wordmarkPath = join(directory, 'wordmark.svg');
  const outputPath = join(directory, 'output');
  const beforeState = await readFile(fileURLToPath(new URL('../../../state/queue.json', import.meta.url)), 'utf8');
  try {
    await writeFile(fixturePath, `${JSON.stringify(makeJob({ community: { name: 'Openings Fixtures' } }), null, 2)}\n`);
    await writeFile(wordmarkPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302e"/></svg>');
    const result = await runDryRun({ fixturePath, wordmarkPath, outputPath, log: () => {} });
    const files = (await readdir(outputPath, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath ?? entry.path, entry.name).slice(outputPath.length + 1))
      .sort();
    assert.deepEqual(files, [
      `jobs/${result.jobId}/index.html`,
      `jobs/${result.jobId}/instagram-image.jpg`,
      `jobs/${result.jobId}/opengraph-image.png`,
      `jobs/${result.jobId}/social-video-cover.jpg`,
      `jobs/${result.jobId}/social-video.mp4`,
    ]);
    assert.equal(await readFile(fileURLToPath(new URL('../../../state/queue.json', import.meta.url)), 'utf8'), beforeState);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('publishes rendered bridge artifacts through web-deploy without FTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-social-publisher-bridge-'));
  const job = makeJob();
  const calls = [];
  try {
    const publishBridge = createBridgePublisher({
      config: {
        publicSiteOrigin: OPENINGS_ORIGIN,
        webDeploy: {
          repository: 'openings-dev/web-deploy',
          token: 'github-secret',
        },
      },
      wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
      outputRoot: directory,
      requestDeployment: async (input) => {
        calls.push(input);
        return {
          status: 'deployed',
          verification: {
            canonicalUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}`,
            imageUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/opengraph-image.png`,
            instagramImageUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/instagram-image.jpg`,
            socialVideoUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video.mp4`,
            socialVideoCoverUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video-cover.jpg`,
          },
        };
      },
    });
    const result = await publishBridge({ job, reason: 'instagram_card_upgrade' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].repository, 'openings-dev/web-deploy');
    assert.equal(calls[0].token, 'github-secret');
    assert.match(calls[0].html.toString('utf8'), new RegExp(job.id));
    assert.equal(sha256(calls[0].image), calls[0].expectedPngHash);
    assert.match(calls[0].instagramSvg.toString('utf8'), /data-instagram-card="true"/u);
    assert.equal(sha256(calls[0].instagramSvg), calls[0].expectedInstagramSvgHash);
    assert.equal(calls[0].expectedInstagramCardVersion, '4');
    assert.equal(calls[0].expectedSocialVideoVersion, '4');
    assert.equal(calls[0].forceDeployment, true);
    assert.equal(result.status, 'deployed');
    assert.equal(result.canonicalUrl, `${OPENINGS_ORIGIN}/jobs/${job.id}`);
    assert.equal(result.instagramImageUrl, `${OPENINGS_ORIGIN}/jobs/${job.id}/instagram-image.jpg`);
    assert.equal(result.socialVideoUrl, `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video.mp4`);
    assert.equal(result.socialVideoCoverUrl, `${OPENINGS_ORIGIN}/jobs/${job.id}/social-video-cover.jpg`);
    assert.equal(result.instagramCardVersion, '4');
    assert.equal(result.socialVideoVersion, '4');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('builds a bounded repository dispatch without credentials in its body', () => {
  const html = Buffer.from('<!doctype html><html></html>');
  const image = Buffer.from('fixture-image');
  const instagramSvg = Buffer.from('<svg width="1080" height="1350"></svg>');
  const request = buildRepositoryDispatchRequest({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    html,
    image,
    instagramSvg,
    repository: 'openings-dev/web-deploy',
  });
  assert.equal(request.url, 'https://api.github.com/repos/openings-dev/web-deploy/dispatches');
  assert.ok(request.body.length < 60_000);
  const body = JSON.parse(request.body);
  assert.equal(body.event_type, 'publish_job_bridge');
  assert.deepEqual(Object.keys(body.client_payload).sort(), [
    'content_hash',
    'html_base64',
    'html_sha256',
    'image_base64',
    'image_sha256',
    'instagram_svg_base64',
    'instagram_svg_sha256',
    'job_id',
  ]);
  assert.equal(body.client_payload.html_sha256, sha256(html));
  assert.equal(body.client_payload.image_sha256, sha256(image));
  assert.equal(body.client_payload.instagram_svg_sha256, sha256(instagramSvg));
  assert.doesNotMatch(request.body, /token|password|ftp/iu);
  assert.throws(() => buildRepositoryDispatchRequest({
    jobId: '../escape',
    contentHash: 'a'.repeat(64),
    html,
    image,
    instagramSvg,
    repository: 'openings-dev/web-deploy',
  }), /Invalid job ID/);
  assert.throws(() => buildRepositoryDispatchRequest({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    html,
    image: Buffer.alloc(60_000),
    instagramSvg,
    repository: 'openings-dev/web-deploy',
  }), (error) => error.code === 'bridge_payload' && /payload.*large/i.test(error.message));
});

validation('accepts a valid repository dispatch between 60 KB and GitHub\'s 64 KB limit', () => {
  const request = buildRepositoryDispatchRequest({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    html: Buffer.from('<!doctype html><html></html>'),
    image: Buffer.alloc(45_000),
    instagramSvg: Buffer.from('<svg width="1080" height="1350"></svg>'),
    repository: 'openings-dev/web-deploy',
  });

  assert.ok(Buffer.byteLength(request.body, 'utf8') > 60_000);
  assert.ok(Buffer.byteLength(request.body, 'utf8') < 64 * 1024);
});

validation('keeps the largest multilingual poster inside the incremental dispatch limit', async () => {
  const job = makeJob({
    title: '全球远程 シニアソフトウェアエンジニア 개발자 플랫폼 '.repeat(8).trim(),
    description: 'International public-community opportunity. '.repeat(28),
    community: { name: 'International Open Source Infrastructure Community' },
    country: 'Worldwide',
    region: 'Global',
    tags: ['remote', 'kubernetes', 'typescript'],
    salary: { currency: 'JPY', min: 9000000, max: 14000000, period: 'year' },
  });
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302e"/></svg>';
  const image = await renderSocialCardPng(job, { wordmarkSvg });
  const instagramSvg = Buffer.from(socialCardModule.createInstagramCardSvg(job, { wordmarkSvg }));
  const request = buildRepositoryDispatchRequest({
    jobId: job.id,
    contentHash: job.contentHash,
    html: Buffer.from(createBridgeHtml(job, { imageHash: sha256(image) })),
    image,
    instagramSvg,
    repository: 'openings-dev/web-deploy',
  });
  const payload = JSON.parse(request.body).client_payload;
  assert.ok(request.body.length <= MAX_REPOSITORY_DISPATCH_BODY_CHARACTERS);
  assert.equal('reel_svg_base64' in payload, false);
  assert.equal('poster_model_base64' in payload, false);
  assert.match(
    Buffer.from(payload.instagram_svg_base64, 'base64').toString('utf8'),
    /data-poster-model="[A-Za-z0-9+/]+={0,2}"/u,
  );
});

validation('verifies public HTML, exact PNG bytes, and the Instagram JPEG derivative', async () => {
  const job = makeJob();
  const instagramSvgHash = 'c'.repeat(64);
  const png = await renderSocialCardPng(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const pngHash = sha256(png);
  const html = createBridgeHtml(job, { imageHash: pngHash });
  const canonicalUrl = `https://openings.dev/jobs/${job.id}`;
  const imageUrl = `${canonicalUrl}/opengraph-image.png?v=2.${pngHash.slice(0, 16)}`;
  const instagramImageUrl = `${canonicalUrl}/instagram-image.jpg?v=4.${instagramSvgHash.slice(0, 16)}`;
  const socialVideoUrl = `${canonicalUrl}/social-video.mp4?v=4.${instagramSvgHash.slice(0, 16)}`;
  const socialVideoCoverUrl = `${canonicalUrl}/social-video-cover.jpg?v=4.${instagramSvgHash.slice(0, 16)}`;
  const instagramImage = await socialCardModule.renderInstagramCardJpeg(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const socialVideo = makeSocialVideoBuffer();
  const socialVideoCover = await makeSocialVideoCover();
  const fetchImpl = async (url) => {
    if (url === canonicalUrl) {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url === imageUrl) {
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url === instagramImageUrl) {
      return new Response(instagramImage, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (url === socialVideoCoverUrl) {
      return new Response(socialVideoCover, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (url === socialVideoUrl) {
      return new Response(socialVideo, { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    return new Response('missing', { status: 404 });
  };
  const result = await verifyPublicBridge({
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: pngHash,
    expectedInstagramSvgHash: instagramSvgHash,
    fetchImpl,
  });
  assert.equal(result.matches, true);
  assert.equal(result.canonicalUrl, canonicalUrl);
  assert.equal(result.instagramImageUrl, instagramImageUrl);
  assert.equal(result.instagramCardVersion, '4');
  assert.equal(result.socialVideoUrl, socialVideoUrl);
  assert.equal(result.socialVideoCoverUrl, socialVideoCoverUrl);
  assert.equal(result.socialVideoVersion, '4');

  const staleHtml = html.replace(
    'name="openings:instagram-card-version" content="4"',
    'name="openings:instagram-card-version" content="3"',
  );
  const staleVersion = await verifyPublicBridge({
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: sha256(png),
    expectedInstagramSvgHash: instagramSvgHash,
    fetchImpl: async (url) => {
      if (url === canonicalUrl) {
        return new Response(staleHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return fetchImpl(url);
    },
    allowMismatch: true,
  });
  assert.equal(staleVersion.matches, false);
  assert.equal(staleVersion.reason, 'instagram_card_version_mismatch');

  const staleSocialVideoHtml = html.replace(
    'name="openings:social-video-version" content="4"',
    'name="openings:social-video-version" content="3"',
  );
  const staleSocialVideo = await verifyPublicBridge({
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: sha256(png),
    expectedInstagramSvgHash: instagramSvgHash,
    fetchImpl: async (url) => {
      if (url === canonicalUrl) {
        return new Response(staleSocialVideoHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return fetchImpl(url);
    },
    allowMismatch: true,
  });
  assert.equal(staleSocialVideo.matches, false);
  assert.equal(staleSocialVideo.reason, 'social_video_version_mismatch');

  const mismatch = await verifyPublicBridge({
    jobId: job.id,
    contentHash: 'b'.repeat(64),
    expectedPngHash: sha256(png),
    expectedInstagramSvgHash: instagramSvgHash,
    fetchImpl,
    allowMismatch: true,
  });
  assert.equal(mismatch.matches, false);
  assert.equal(mismatch.reason, 'content_hash_mismatch');
});

validation('accepts the canonical Hostinger trailing-slash redirect only', async () => {
  const job = makeJob();
  const instagramSvgHash = 'd'.repeat(64);
  const png = await renderSocialCardPng(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const pngHash = sha256(png);
  const html = createBridgeHtml(job, { imageHash: pngHash });
  const canonicalUrl = `https://openings.dev/jobs/${job.id}`;
  const redirectedUrl = `${canonicalUrl}/`;
  const imageUrl = `${canonicalUrl}/opengraph-image.png?v=2.${pngHash.slice(0, 16)}`;
  const instagramImageUrl = `${canonicalUrl}/instagram-image.jpg?v=4.${instagramSvgHash.slice(0, 16)}`;
  const socialVideoUrl = `${canonicalUrl}/social-video.mp4?v=4.${instagramSvgHash.slice(0, 16)}`;
  const socialVideoCoverUrl = `${canonicalUrl}/social-video-cover.jpg?v=4.${instagramSvgHash.slice(0, 16)}`;
  const instagramImage = await socialCardModule.renderInstagramCardJpeg(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const socialVideo = makeSocialVideoBuffer();
  const socialVideoCover = await makeSocialVideoCover();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === canonicalUrl) {
      return new Response(null, { status: 301, headers: { location: redirectedUrl } });
    }
    if (url === redirectedUrl) {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url === imageUrl) {
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url === instagramImageUrl) {
      return new Response(instagramImage, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (url === socialVideoCoverUrl) {
      return new Response(socialVideoCover, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (url === socialVideoUrl) {
      return new Response(socialVideo, { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    return new Response('missing', { status: 404 });
  };

  const result = await verifyPublicBridge({
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: pngHash,
    expectedInstagramSvgHash: instagramSvgHash,
    fetchImpl,
  });

  assert.equal(result.matches, true);
  assert.deepEqual(calls, [
    canonicalUrl,
    redirectedUrl,
    imageUrl,
    instagramImageUrl,
    socialVideoCoverUrl,
    socialVideoUrl,
  ]);
});

validation('verifies exact public assets when Cloudflare blocks Node HTML requests', async () => {
  const job = makeJob();
  const instagramSvgHash = 'e'.repeat(64);
  const png = await renderSocialCardPng(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const pngHash = sha256(png);
  const canonicalUrl = `https://openings.dev/jobs/${job.id}`;
  const redirectedUrl = `${canonicalUrl}/`;
  const imageUrl = `${canonicalUrl}/opengraph-image.png?v=2.${pngHash.slice(0, 16)}`;
  const instagramImageUrl = `${canonicalUrl}/instagram-image.jpg?v=4.${instagramSvgHash.slice(0, 16)}`;
  const socialVideoUrl = `${canonicalUrl}/social-video.mp4?v=4.${instagramSvgHash.slice(0, 16)}`;
  const socialVideoCoverUrl = `${canonicalUrl}/social-video-cover.jpg?v=4.${instagramSvgHash.slice(0, 16)}`;
  const instagramImage = await socialCardModule.renderInstagramCardJpeg(job, {
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
  });
  const socialVideo = makeSocialVideoBuffer();
  const socialVideoCover = await makeSocialVideoCover();
  const fetchImpl = async (url) => {
    if (url === canonicalUrl) {
      return new Response(null, { status: 301, headers: { location: redirectedUrl } });
    }
    if (url === redirectedUrl) {
      return new Response('Bot Verification', {
        status: 403,
        headers: { 'content-type': 'text/html', server: 'cloudflare' },
      });
    }
    if (url === imageUrl) {
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url === instagramImageUrl) {
      return new Response(instagramImage, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (url === socialVideoCoverUrl) {
      return new Response(socialVideoCover, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (url === socialVideoUrl) {
      return new Response(socialVideo, { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    return new Response('missing', { status: 404 });
  };

  const result = await verifyPublicBridge({
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: pngHash,
    expectedInstagramSvgHash: instagramSvgHash,
    fetchImpl,
  });

  assert.equal(result.matches, true);
  assert.equal(result.htmlVerification, 'edge_blocked_assets_verified');
});

validation('rejects public bridge redirects outside the canonical job directory', async () => {
  const job = makeJob();
  const mismatch = await verifyPublicBridge({
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: 'a'.repeat(64),
    fetchImpl: async () => new Response(null, {
      status: 301,
      headers: { location: 'https://example.test/untrusted' },
    }),
    allowMismatch: true,
  });

  assert.equal(mismatch.matches, false);
  assert.equal(mismatch.reason, 'html_redirect_mismatch');
});

validation('skips current bridges and dispatches stale bridges exactly once', async () => {
  const calls = [];
  const verificationInputs = [];
  const html = Buffer.from('<!doctype html><html></html>');
  const image = Buffer.from('fixture-image');
  const instagramSvg = Buffer.from('<svg width="1080" height="1350"></svg>');
  const currentVerification = {
    matches: true,
    canonicalUrl: 'https://openings.dev/jobs/gh_0123456789abcdef01234567',
    imageUrl: 'https://openings.dev/jobs/gh_0123456789abcdef01234567/opengraph-image.png',
  };
  const matching = await requestIncrementalBridgeDeployment({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    expectedPngHash: sha256(image),
    expectedInstagramSvgHash: sha256(instagramSvg),
    html,
    image,
    instagramSvg,
    repository: 'openings-dev/web-deploy',
    token: 'github-secret',
    expectedInstagramCardVersion: '2',
    verifyPublic: async (input) => {
      verificationInputs.push(input);
      return currentVerification;
    },
    fetchImpl: async () => { calls.push('dispatch'); return new Response(null, { status: 204 }); },
  });
  assert.equal(matching.status, 'already_current');
  assert.deepEqual(calls, []);
  assert.equal(verificationInputs[0].expectedInstagramCardVersion, '2');

  const forcedCalls = [];
  const forced = await requestIncrementalBridgeDeployment({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    expectedPngHash: sha256(image),
    expectedInstagramSvgHash: sha256(instagramSvg),
    expectedInstagramCardVersion: '2',
    forceDeployment: true,
    html,
    image,
    instagramSvg,
    repository: 'openings-dev/web-deploy',
    token: 'github-secret',
    verifyPublic: async () => currentVerification,
    fetchImpl: async (url, options) => {
      forcedCalls.push({ url, options });
      return new Response(null, { status: 204 });
    },
    sleep: async () => {},
  });
  assert.equal(forced.status, 'deployed');
  assert.equal(forcedCalls.length, 1);

  let verification = 0;
  const deployed = await requestIncrementalBridgeDeployment({
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    expectedPngHash: sha256(image),
    expectedInstagramSvgHash: sha256(instagramSvg),
    html,
    image,
    instagramSvg,
    repository: 'openings-dev/web-deploy',
    token: 'github-secret',
    verifyPublic: async () => {
      verification += 1;
      return verification === 1 ? { matches: false, reason: 'not_found' } : currentVerification;
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: 204 });
    },
    sleep: async () => {},
  });
  assert.equal(deployed.status, 'deployed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer github-secret');
  assert.equal(calls[0].options.headers['x-github-api-version'], '2026-03-10');
  assert.doesNotMatch(calls[0].options.body, /github-secret/u);

  await assert.rejects(
    requestIncrementalBridgeDeployment({
      jobId: 'gh_0123456789abcdef01234567',
      contentHash: 'a'.repeat(64),
      expectedPngHash: sha256(image),
      expectedInstagramSvgHash: sha256(instagramSvg),
      html,
      image,
      instagramSvg,
      repository: 'openings-dev/web-deploy',
      token: 'github-secret',
      verifyPublic: async () => ({ matches: false, reason: 'not_found' }),
      fetchImpl: async () => new Response('forbidden', { status: 403 }),
      sleep: async () => {},
      pollAttempts: 2,
    }),
    (error) => /dispatch failed/i.test(error.message) && !error.message.includes('github-secret'),
  );
});

function transientBridgeDispatchInput({ fetchImpl, sleep, ...overrides }) {
  const image = Buffer.from('fixture-image');
  const instagramSvg = Buffer.from('<svg width="1080" height="1350"></svg>');
  let verification = 0;
  return {
    jobId: 'gh_0123456789abcdef01234567',
    contentHash: 'a'.repeat(64),
    expectedPngHash: sha256(image),
    expectedInstagramSvgHash: sha256(instagramSvg),
    html: Buffer.from('<!doctype html><html></html>'),
    image,
    instagramSvg,
    repository: 'openings-dev/web-deploy',
    token: 'github-secret',
    verifyPublic: async () => {
      verification += 1;
      return verification === 1
        ? { matches: false, reason: 'not_found' }
        : {
            matches: true,
            canonicalUrl: 'https://openings.dev/jobs/gh_0123456789abcdef01234567',
            imageUrl: 'https://openings.dev/jobs/gh_0123456789abcdef01234567/opengraph-image.png',
          };
    },
    fetchImpl,
    sleep,
    pollAttempts: 1,
    pollDelayMs: 0,
    ...overrides,
  };
}

validation('retries a transient bridge dispatch transport failure', async () => {
  const delays = [];
  let dispatches = 0;
  const result = await requestIncrementalBridgeDeployment(transientBridgeDispatchInput({
    fetchImpl: async () => {
      dispatches += 1;
      if (dispatches === 1) throw new TypeError('socket reset');
      return new Response(null, { status: 204 });
    },
    sleep: async (delay) => delays.push(delay),
    dispatchAttempts: 2,
    dispatchRetryDelayMs: 25,
  }));

  assert.equal(result.status, 'deployed');
  assert.equal(dispatches, 2);
  assert.deepEqual(delays, [25, 0]);
});

validation('retries a transient bridge dispatch HTTP response', async () => {
  const delays = [];
  let dispatches = 0;
  const result = await requestIncrementalBridgeDeployment(transientBridgeDispatchInput({
    fetchImpl: async () => {
      dispatches += 1;
      return new Response(null, { status: dispatches === 1 ? 503 : 204 });
    },
    sleep: async (delay) => delays.push(delay),
    dispatchAttempts: 2,
    dispatchRetryDelayMs: 30,
  }));

  assert.equal(result.status, 'deployed');
  assert.equal(dispatches, 2);
  assert.deepEqual(delays, [30, 0]);
});

validation('honors Retry-After for a rate-limited bridge dispatch', async () => {
  const delays = [];
  let dispatches = 0;
  const result = await requestIncrementalBridgeDeployment(transientBridgeDispatchInput({
    fetchImpl: async () => {
      dispatches += 1;
      return dispatches === 1
        ? new Response(null, { status: 429, headers: { 'retry-after': '2' } })
        : new Response(null, { status: 204 });
    },
    sleep: async (delay) => delays.push(delay),
    dispatchAttempts: 2,
    dispatchRetryDelayMs: 30,
  }));

  assert.equal(result.status, 'deployed');
  assert.equal(dispatches, 2);
  assert.deepEqual(delays, [2_000, 0]);
});

validation('retries a bridge dispatch rejected as endpoint spam', async () => {
  const delays = [];
  let dispatches = 0;
  const result = await requestIncrementalBridgeDeployment(transientBridgeDispatchInput({
    fetchImpl: async () => {
      dispatches += 1;
      return dispatches === 1
        ? Response.json({ message: 'Validation failed, or the endpoint has been spammed.' }, { status: 422 })
        : new Response(null, { status: 204 });
    },
    sleep: async (delay) => delays.push(delay),
    dispatchAttempts: 2,
    dispatchRetryDelayMs: 40,
  }));

  assert.equal(result.status, 'deployed');
  assert.equal(dispatches, 2);
  assert.deepEqual(delays, [40, 0]);
});

validation('does not retry a bridge dispatch validation failure', async () => {
  const delays = [];
  let dispatches = 0;
  await assert.rejects(
    requestIncrementalBridgeDeployment(transientBridgeDispatchInput({
      fetchImpl: async () => {
        dispatches += 1;
        return Response.json({ message: 'Validation Failed' }, { status: 422 });
      },
      sleep: async (delay) => delays.push(delay),
      dispatchAttempts: 3,
      dispatchRetryDelayMs: 40,
    })),
    (error) => error.code === 'bridge_dispatch' && /HTTP 422/u.test(error.message),
  );

  assert.equal(dispatches, 1);
  assert.deepEqual(delays, []);
});

validation('does not retry a permanent bridge dispatch HTTP response', async () => {
  const delays = [];
  let dispatches = 0;
  await assert.rejects(
    requestIncrementalBridgeDeployment(transientBridgeDispatchInput({
      fetchImpl: async () => {
        dispatches += 1;
        return new Response('forbidden', { status: 403 });
      },
      sleep: async (delay) => delays.push(delay),
      dispatchAttempts: 3,
      dispatchRetryDelayMs: 20,
    })),
    (error) => error.code === 'bridge_dispatch'
      && /HTTP 403/u.test(error.message)
      && !error.message.includes('github-secret'),
  );

  assert.equal(dispatches, 1);
  assert.deepEqual(delays, []);
});

validation('reports exhausted transient bridge dispatch attempts safely', async () => {
  const delays = [];
  let dispatches = 0;
  await assert.rejects(
    requestIncrementalBridgeDeployment(transientBridgeDispatchInput({
      fetchImpl: async () => {
        dispatches += 1;
        return new Response(null, { status: 503 });
      },
      sleep: async (delay) => delays.push(delay),
      dispatchAttempts: 3,
      dispatchRetryDelayMs: 15,
    })),
    (error) => error.code === 'bridge_dispatch'
      && /HTTP 503/u.test(error.message)
      && !error.message.includes('github-secret'),
  );

  assert.equal(dispatches, 3);
  assert.deepEqual(delays, [15, 15]);
});

function createFakeBlueskyAgent({ existing = null, uploadError = null, putError = null } = {}) {
  const calls = { login: [], get: [], upload: [], put: [] };
  const agent = {
    session: null,
    async login(credentials) {
      calls.login.push(credentials);
      this.session = { did: 'did:plc:openingsfixture', handle: 'openingshq.bsky.social' };
    },
    async uploadBlob(bytes, options) {
      calls.upload.push({ bytes, options });
      if (uploadError) throw uploadError;
      return { data: { blob: { $type: 'blob', ref: { $link: 'bafkfixture' }, mimeType: 'image/png', size: bytes.byteLength } } };
    },
    com: {
      atproto: {
        repo: {
          async getRecord(input) {
            calls.get.push(input);
            if (!existing) {
              const error = new Error('not found');
              error.error = 'RecordNotFound';
              throw error;
            }
            return { data: existing };
          },
          async putRecord(input) {
            calls.put.push(input);
            if (putError) throw putError;
            return {
              data: {
                uri: `at://did:plc:openingsfixture/app.bsky.feed.post/${input.rkey}`,
                cid: 'bafyreipublished',
              },
            };
          },
        },
      },
    },
  };
  return { agent, calls };
}

validation('publishes one deterministic Bluesky external-card record', async () => {
  const job = makeJob({ community: { name: 'Openings Fixtures' }, tags: ['typescript'] });
  const post = formatSocialPost(job);
  const png = Buffer.from([137, 80, 78, 71]);
  const { agent, calls } = createFakeBlueskyAgent();
  const result = await publishToBluesky({
    job,
    post,
    png,
    publicationCreatedAt: '2026-08-20T13:01:00.000Z',
    credentials: { identifier: 'openingshq.bsky.social', appPassword: 'fixture-secret' },
    agentFactory: () => agent,
  });
  const rkey = blueskyRecordKey(job.id, '2026-08-20T13:01:00.000Z');
  assert.equal(result.status, 'published');
  assert.equal(result.url, `https://bsky.app/profile/openingshq.bsky.social/post/${rkey}`);
  assert.equal(calls.put.length, 1);
  assert.equal(calls.put[0].rkey, rkey);
  assert.equal(calls.put[0].record.createdAt, '2026-08-20T13:01:00.000Z');
  assert.equal(calls.put[0].record.embed.external.uri, post.canonicalUrl);
  assert.equal(calls.put[0].record.embed.external.thumb.mimeType, 'image/png');
  assert.ok(calls.put[0].record.facets.some((facet) => facet.features.some((feature) => feature.$type === 'app.bsky.richtext.facet#link')));
  assert.ok(calls.put[0].record.facets.some((facet) => facet.features.some((feature) => feature.$type === 'app.bsky.richtext.facet#tag')));
});

validation('reconciles an existing matching Bluesky record without uploading', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const rkey = blueskyRecordKey(job.id, '2026-08-20T13:01:00.000Z');
  const { agent, calls } = createFakeBlueskyAgent({
    existing: {
      uri: `at://did:plc:openingsfixture/app.bsky.feed.post/${rkey}`,
      cid: 'bafyreiexisting',
      value: { embed: { external: { uri: post.canonicalUrl } } },
    },
  });
  const result = await publishToBluesky({
    job,
    post,
    png: Buffer.from([1]),
    publicationCreatedAt: '2026-08-20T13:01:00.000Z',
    credentials: { identifier: 'openingshq.bsky.social', appPassword: 'fixture-secret' },
    agentFactory: () => agent,
  });
  assert.equal(result.status, 'reconciled');
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.put.length, 0);
});

validation('derives deterministic Bluesky TIDs from the job and publication time', () => {
  const time = '2026-08-20T13:01:00.000Z';
  const first = blueskyRecordKey('gh_0123456789abcdef01234567', time);
  const same = blueskyRecordKey('gh_0123456789abcdef01234567', time);
  const otherJob = blueskyRecordKey('gh_1123456789abcdef01234567', time);
  const otherTime = blueskyRecordKey('gh_0123456789abcdef01234567', '2026-08-20T13:01:01.000Z');

  assert.equal(TID.is(first), true);
  assert.equal(first.length, 13);
  assert.equal(first, same);
  assert.notEqual(first, otherJob);
  assert.notEqual(first, otherTime);
});

validation('rejects conflicting or failed Bluesky writes without leaking credentials', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const conflict = createFakeBlueskyAgent({
    existing: {
      uri: 'at://did:plc:openingsfixture/app.bsky.feed.post/conflict',
      cid: 'conflict',
      value: { embed: { external: { uri: 'https://openings.dev/jobs/gh_ffffffffffffffffffffffff' } } },
    },
  });
  await assert.rejects(publishToBluesky({
    job,
    post,
    png: Buffer.from([1]),
    publicationCreatedAt: '2026-08-20T13:01:00.000Z',
    credentials: { identifier: 'openingshq.bsky.social', appPassword: 'fixture-secret' },
    agentFactory: () => conflict.agent,
  }), /conflicting deterministic record/i);

  const failed = createFakeBlueskyAgent({ uploadError: new Error('fixture-secret provider detail') });
  await assert.rejects(
    publishToBluesky({
      job,
      post,
      png: Buffer.from([1]),
      publicationCreatedAt: '2026-08-20T13:01:00.000Z',
      credentials: { identifier: 'openingshq.bsky.social', appPassword: 'fixture-secret' },
      agentFactory: () => failed.agent,
    }),
    (error) => error.code === 'bluesky_thumbnail_upload'
      && /thumbnail upload failed/i.test(error.message)
      && !error.message.includes('fixture-secret'),
  );

  const putError = new Error('Invalid record from fixture-secret for openingshq.bsky.social');
  putError.error = 'InvalidRequest';
  putError.status = 400;
  const putFailed = createFakeBlueskyAgent({ putError });
  await assert.rejects(
    publishToBluesky({
      job,
      post,
      png: Buffer.from([1]),
      publicationCreatedAt: '2026-08-20T13:01:00.000Z',
      credentials: { identifier: 'openingshq.bsky.social', appPassword: 'fixture-secret' },
      agentFactory: () => putFailed.agent,
    }),
    (error) => error.code === 'bluesky_publication'
      && /record publication failed/i.test(error.message)
      && error.diagnostic?.status === 400
      && error.diagnostic?.providerCode === 'InvalidRequest'
      && /\[redacted\]/u.test(error.diagnostic?.message ?? '')
      && !JSON.stringify(error.diagnostic).includes('fixture-secret')
      && !JSON.stringify(error.diagnostic).includes('openingshq.bsky.social'),
  );
});

validation('persists safe provider stage codes without provider details', async () => {
  const job = makeJob();
  const snapshot = makeLoadedSnapshot({
    commit: 'f'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: 'f'.repeat(64),
    jobs: [job],
  });
  const queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  const providerError = new Error('Bluesky thumbnail upload failed');
  providerError.code = 'bluesky_thumbnail_upload';
  const result = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async () => ({ status: 'deployed' }),
    publishBluesky: async () => { throw providerError; },
    publishMastodon: async () => ({ status: 'published' }),
    now: '2026-08-20T13:02:00.000Z',
  });

  assert.equal(result.queueState.items[0].bluesky.lastError.code, 'bluesky_thumbnail_upload');
  assert.doesNotMatch(JSON.stringify(result.queueState), /provider detail|fixture-secret/u);
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function createFakeMastodonFetch({ statuses = [], postError = null, cards = [] } = {}) {
  const calls = [];
  let cardIndex = 0;
  const created = {
    id: '109876543210',
    url: 'https://mastodon.social/@openingshq/109876543210',
    content: '<p>New job</p>',
    card: null,
  };
  return {
    calls,
    async fetch(url, options = {}) {
      calls.push({ url: String(url), options });
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v1/accounts/verify_credentials') {
        return jsonResponse({ id: '12345', username: 'openingshq' });
      }
      if (parsed.pathname === '/api/v1/accounts/12345/statuses') {
        return jsonResponse(statuses);
      }
      if (parsed.pathname === '/api/v1/statuses' && options.method === 'POST') {
        if (postError) throw postError;
        return jsonResponse(created);
      }
      if (parsed.pathname === `/api/v1/statuses/${created.id}`) {
        const card = cards[Math.min(cardIndex, Math.max(0, cards.length - 1))] ?? null;
        cardIndex += 1;
        return jsonResponse({ ...created, card });
      }
      return jsonResponse({ error: 'missing' }, 404);
    },
  };
}

validation('publishes a link-only Mastodon status with deterministic idempotency', async () => {
  const job = makeJob({ community: { name: 'Openings Fixtures' } });
  const post = formatSocialPost(job);
  const fake = createFakeMastodonFetch({
    cards: [null, { url: post.canonicalUrl, title: job.title }],
  });
  const result = await publishToMastodon({
    job,
    post,
    accessToken: 'fixture-token',
    fetchImpl: fake.fetch,
    sleep: async () => {},
    cardPollAttempts: 2,
  });
  assert.equal(result.status, 'published');
  assert.equal(result.cardStatus, 'resolved');
  const publication = fake.calls.find((call) => new URL(call.url).pathname === '/api/v1/statuses' && call.options.method === 'POST');
  assert.equal(publication.options.headers['Idempotency-Key'], mastodonIdempotencyKey(job.id));
  assert.equal(publication.options.headers.Authorization, 'Bearer fixture-token');
  const body = new URLSearchParams(publication.options.body);
  assert.equal(body.get('status'), post.text);
  assert.equal(body.get('visibility'), 'public');
  assert.equal(body.has('media_ids[]'), false);
});

validation('reconciles a recent Mastodon status by exact canonical URL', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const fake = createFakeMastodonFetch({
    statuses: [{
      id: 'existing',
      url: 'https://mastodon.social/@openingshq/existing',
      content: `<p>View: <a href="${post.canonicalUrl}">${post.canonicalUrl}</a></p>`,
      card: { url: post.canonicalUrl },
    }],
  });
  const result = await publishToMastodon({
    job,
    post,
    accessToken: 'fixture-token',
    fetchImpl: fake.fetch,
    sleep: async () => {},
  });
  assert.equal(result.status, 'reconciled');
  assert.equal(result.id, 'existing');
  assert.equal(result.cardStatus, 'resolved');
  assert.equal(fake.calls.some((call) => call.options.method === 'POST'), false);
});

validation('does not duplicate Mastodon posts after an ambiguous response', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const failed = createFakeMastodonFetch({ postError: new Error('fixture-token connection reset') });
  await assert.rejects(
    publishToMastodon({
      job,
      post,
      accessToken: 'fixture-token',
      fetchImpl: failed.fetch,
      sleep: async () => {},
    }),
    (error) => /publication failed/i.test(error.message) && !error.message.includes('fixture-token'),
  );

  const retry = createFakeMastodonFetch({
    statuses: [{
      id: 'created-during-timeout',
      url: 'https://mastodon.social/@openingshq/created-during-timeout',
      content: `<p><a href="${post.canonicalUrl}">${post.canonicalUrl}</a></p>`,
      card: null,
    }],
  });
  const result = await publishToMastodon({
    job,
    post,
    accessToken: 'fixture-token',
    fetchImpl: retry.fetch,
    sleep: async () => {},
  });
  assert.equal(result.status, 'reconciled');
  assert.equal(result.cardStatus, 'pending');
  assert.equal(retry.calls.some((call) => call.options.method === 'POST'), false);
});

validation('records a delayed Mastodon PreviewCard without retrying the status', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const fake = createFakeMastodonFetch({ cards: [null, null] });
  const result = await publishToMastodon({
    job,
    post,
    accessToken: 'fixture-token',
    fetchImpl: fake.fetch,
    sleep: async () => {},
    cardPollAttempts: 2,
  });
  assert.equal(result.status, 'published');
  assert.equal(result.cardStatus, 'pending');
  assert.equal(fake.calls.filter((call) => call.options.method === 'POST').length, 1);

  const unrelated = createFakeMastodonFetch({ cards: [{ url: 'https://example.test/not-the-job' }] });
  const unrelatedResult = await publishToMastodon({
    job,
    post,
    accessToken: 'fixture-token',
    fetchImpl: unrelated.fetch,
    sleep: async () => {},
    cardPollAttempts: 1,
  });
  assert.equal(unrelatedResult.cardStatus, 'pending');
});

validation('publishes and reconciles a link-preview Threads post', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const calls = [];
  let published = false;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(url);
    if (parsed.pathname === '/v1.0/me/threads' && options.method !== 'POST') {
      return jsonResponse({
        data: published ? [{ id: 'thread-1', text: `${post.text}\n\n#OpeningsJobs`, permalink: 'https://www.threads.net/@openingshq/post/thread-1' }] : [],
      });
    }
    if (parsed.pathname === '/v1.0/me/threads' && options.method === 'POST') {
      published = true;
      return jsonResponse({ id: 'thread-1' });
    }
    if (parsed.pathname === '/v1.0/thread-1') {
      return jsonResponse({
        id: 'thread-1',
        permalink: 'https://www.threads.net/@openingshq/post/thread-1',
      });
    }
    return jsonResponse({ error: 'missing' }, 404);
  };

  const result = await publishToThreads({
    job,
    post,
    accessToken: 'threads-secret',
    reconciliationMarker: '#OpeningsJobs',
    fetchImpl,
  });
  assert.equal(result.status, 'published');
  assert.equal(result.id, 'thread-1');
  assert.equal(result.url, 'https://www.threads.net/@openingshq/post/thread-1');
  const publication = calls.find((call) => call.options.method === 'POST');
  const body = new URLSearchParams(publication.options.body);
  assert.equal(body.get('media_type'), 'TEXT');
  assert.equal(body.get('text'), `${post.text}\n\n#OpeningsJobs`);
  assert.equal(body.get('link_attachment'), post.canonicalUrl);
  assert.equal(body.get('auto_publish_text'), 'true');
  assert.equal(body.get('reply_control'), 'everyone');
  assert.equal(publication.options.headers.Authorization, 'Bearer threads-secret');

  const reconciled = await publishToThreads({
    job,
    post,
    accessToken: 'threads-secret',
    reconciliationMarker: '#OpeningsJobs',
    fetchImpl,
  });
  assert.equal(reconciled.status, 'reconciled');
  assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);

  const deleted = await deleteThreadsPost({
    id: 'thread-1',
    accessToken: 'threads-secret',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ success: true });
    },
  });
  assert.deepEqual(deleted, { id: 'thread-1', status: 'deleted' });
  const deletion = calls.at(-1);
  assert.equal(new URL(deletion.url).pathname, '/v1.0/thread-1');
  assert.equal(deletion.options.method, 'DELETE');

  const alreadyDeleted = await deleteThreadsPost({
    id: 'thread-1',
    accessToken: 'threads-secret',
    fetchImpl: async () => jsonResponse({
      error: {
        code: 100,
        error_subcode: 33,
        message: 'Unsupported get request. Object does not exist.',
      },
    }, 400),
  });
  assert.deepEqual(alreadyDeleted, { id: 'thread-1', status: 'already_deleted' });
});

validation('publishes and reconciles one Instagram Reel by canonical job URL', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const videoUrl = `${post.canonicalUrl}/social-video.mp4`;
  const coverUrl = `${post.canonicalUrl}/social-video-cover.jpg`;
  const calls = [];
  let published = false;
  let containerChecks = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(url);
    if (parsed.pathname === '/v23.0/17841400000000000/media' && options.method !== 'POST') {
      return jsonResponse({
        data: published ? [{ id: 'media-1', caption: `New opening\n${post.canonicalUrl}\n#OpeningsJobs`, permalink: 'https://www.instagram.com/p/media-1/' }] : [],
      });
    }
    if (parsed.pathname === '/v23.0/17841400000000000/media' && options.method === 'POST') {
      return jsonResponse({ id: 'container-1' });
    }
    if (parsed.pathname === '/v23.0/container-1') {
      containerChecks += 1;
      return jsonResponse({
        id: 'container-1',
        status_code: containerChecks < 12 ? 'IN_PROGRESS' : 'FINISHED',
      });
    }
    if (parsed.pathname === '/v23.0/17841400000000000/media_publish') {
      published = true;
      return jsonResponse({ id: 'media-1' });
    }
    if (parsed.pathname === '/v23.0/media-1') {
      return jsonResponse({
        id: 'media-1',
        permalink: 'https://www.instagram.com/p/media-1/',
      });
    }
    return jsonResponse({ error: 'missing' }, 404);
  };

  const result = await publishToInstagram({
    job,
    post,
    videoUrl,
    coverUrl,
    accessToken: 'instagram-secret',
    userId: '17841400000000000',
    apiVersion: 'v23.0',
    reconciliationMarker: '#OpeningsJobs',
    fetchImpl,
    sleep: async () => {},
    containerPollAttempts: 12,
  });
  assert.equal(result.status, 'published');
  assert.equal(result.id, 'media-1');
  assert.equal(result.url, 'https://www.instagram.com/p/media-1/');
  assert.equal(containerChecks, 12);
  const container = calls.find((call) => new URL(call.url).pathname.endsWith('/media') && call.options.method === 'POST');
  const body = new URLSearchParams(container.options.body);
  assert.equal(body.get('media_type'), 'REELS');
  assert.equal(body.get('video_url'), videoUrl);
  assert.equal(body.get('cover_url'), coverUrl);
  assert.equal(body.get('share_to_feed'), 'true');
  assert.equal(body.has('image_url'), false);
  assert.match(body.get('caption'), new RegExp(post.canonicalUrl));
  assert.match(body.get('caption'), /Follow @openingshq for more jobs from public communities\./u);
  assert.match(body.get('caption'), /Know someone who fits\? Tag them below\./u);
  assert.equal((body.get('caption').match(/#OpeningsJobs/gu) ?? []).length, 1);
  assert.doesNotMatch(body.get('caption'), /#OpeningsPosterV\d+/u);
  assert.equal(container.options.headers.Authorization, 'Bearer instagram-secret');

  const reconciled = await publishToInstagram({
    job,
    post,
    videoUrl,
    coverUrl,
    accessToken: 'instagram-secret',
    userId: '17841400000000000',
    apiVersion: 'v23.0',
    reconciliationMarker: '#OpeningsJobs',
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(reconciled.status, 'reconciled');
  assert.equal(calls.filter((call) => new URL(call.url).pathname.endsWith('/media_publish')).length, 1);

  await assert.rejects(publishToInstagram({
    job,
    post,
    videoUrl: 'http://openings.dev/video.mp4',
    coverUrl,
    accessToken: 'instagram-secret',
    userId: '17841400000000000',
    apiVersion: 'v23.0',
    fetchImpl,
  }), /public HTTPS MP4/u);
});

validation('publishes an ordered seven-image Instagram carousel', async () => {
  const imageUrls = Array.from(
    { length: 7 },
    (_, index) => `https://openings.dev/social/editorial/linkedin-headline-clara/1/slide-${String(index + 1).padStart(2, '0')}.jpg`,
  );
  const calls = [];
  let childIndex = 0;
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? new URLSearchParams(options.body) : null;
    calls.push({ url: String(url), options, body });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/media') && options.method !== 'POST') {
      return jsonResponse({ data: [] });
    }
    if (pathname.endsWith('/media') && options.method === 'POST') {
      if (body.get('is_carousel_item') === 'true') {
        childIndex += 1;
        return jsonResponse({ id: `child-${childIndex}` });
      }
      return jsonResponse({ id: 'carousel-container' });
    }
    if (/\/child-\d+$/u.test(pathname) || pathname.endsWith('/carousel-container')) {
      return jsonResponse({ status_code: 'FINISHED' });
    }
    if (pathname.endsWith('/media_publish')) {
      return jsonResponse({ id: 'carousel-media' });
    }
    if (pathname.endsWith('/carousel-media')) {
      return jsonResponse({ id: 'carousel-media', permalink: 'https://www.instagram.com/p/carousel-media/' });
    }
    return jsonResponse({ error: 'missing' }, 404);
  };

  const result = await publishCarouselToInstagram({
    imageUrls,
    caption: 'Headline claro ajuda recrutadores.\n\n#OpeningsGuideL01',
    reconciliationMarker: '#OpeningsGuideL01',
    accessToken: 'instagram-secret',
    userId: '17841400000000000',
    apiVersion: 'v26.0',
    fetchImpl,
    sleep: async () => {},
  });

  assert.deepEqual(result, {
    status: 'published',
    id: 'carousel-media',
    url: 'https://www.instagram.com/p/carousel-media/',
  });
  const children = calls.filter(({ body }) => body?.get('is_carousel_item') === 'true');
  assert.deepEqual(children.map(({ body }) => body.get('image_url')), imageUrls);
  const parent = calls.find(({ body }) => body?.get('media_type') === 'CAROUSEL');
  assert.equal(parent.body.get('children'), 'child-1,child-2,child-3,child-4,child-5,child-6,child-7');
  assert.equal(parent.body.get('caption'), 'Headline claro ajuda recrutadores.\n\n#OpeningsGuideL01');

  let unsafePostAttempted = false;
  await assert.rejects(
    publishCarouselToInstagram({
      imageUrls,
      caption: 'Headline claro ajuda recrutadores.\n\n#OpeningsGuideL01',
      reconciliationMarker: '#OpeningsGuideL01',
      accessToken: 'instagram-secret',
      userId: '17841400000000000',
      apiVersion: 'v26.0',
      fetchImpl: async (_url, options = {}) => {
        if (options.method === 'POST') unsafePostAttempted = true;
        throw new Error('lookup unavailable');
      },
    }),
    (error) => error?.code === 'instagram_carousel_reconciliation',
  );
  assert.equal(unsafePostAttempted, false);

  await assert.rejects(
    publishCarouselToInstagram({
      imageUrls: imageUrls.slice(0, 1),
      caption: 'Invalid carousel',
      accessToken: 'instagram-secret',
      userId: '17841400000000000',
      apiVersion: 'v26.0',
      fetchImpl,
    }),
    /between 2 and 10/u,
  );
});

validation('publishes image and video Stories without republishing ambiguous results', async () => {
  const storyUrl = 'https://openings.dev/social/editorial/linkedin-headline-clara/1/story.jpg';
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? new URLSearchParams(options.body) : null;
    calls.push({ url: String(url), options, body });
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/media') && options.method === 'POST') {
      return jsonResponse({ id: 'story-container' });
    }
    if (pathname.endsWith('/story-container')) {
      return jsonResponse({ status_code: 'FINISHED' });
    }
    if (pathname.endsWith('/media_publish')) {
      return jsonResponse({ id: 'story-media' });
    }
    if (pathname.endsWith('/story-media')) {
      return jsonResponse({ id: 'story-media', permalink: null });
    }
    return jsonResponse({ error: 'missing' }, 404);
  };

  const result = await publishStoryToInstagram({
    mediaUrl: storyUrl,
    mediaKind: 'image',
    accessToken: 'instagram-secret',
    userId: '17841400000000000',
    apiVersion: 'v26.0',
    fetchImpl,
    sleep: async () => {},
  });
  assert.deepEqual(result, { status: 'published', id: 'story-media', url: null });
  const storyContainer = calls.find(({ body }) => body?.get('media_type') === 'STORIES');
  assert.equal(storyContainer.body.get('image_url'), storyUrl);
  assert.equal(storyContainer.body.has('video_url'), false);

  let publishAttempts = 0;
  const ambiguousFetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/media') && options.method === 'POST') {
      return jsonResponse({ id: 'ambiguous-container' });
    }
    if (pathname.endsWith('/ambiguous-container')) {
      return jsonResponse({ status_code: 'FINISHED' });
    }
    if (pathname.endsWith('/media_publish')) {
      publishAttempts += 1;
      throw new Error('connection closed');
    }
    if (pathname.endsWith('/media')) {
      return jsonResponse({ data: [] });
    }
    return jsonResponse({ error: 'missing' }, 404);
  };
  await assert.rejects(
    publishStoryToInstagram({
      mediaUrl: storyUrl,
      mediaKind: 'image',
      accessToken: 'instagram-secret',
      userId: '17841400000000000',
      apiVersion: 'v26.0',
      fetchImpl: ambiguousFetch,
      sleep: async () => {},
    }),
    (error) => error?.code === 'instagram_story_ambiguous',
  );
  assert.equal(publishAttempts, 1);

  await assert.rejects(
    publishStoryToInstagram({
      mediaUrl: 'http://openings.dev/story.jpg',
      mediaKind: 'image',
      accessToken: 'instagram-secret',
      userId: '17841400000000000',
      apiVersion: 'v26.0',
      fetchImpl,
    }),
    /public HTTPS JPEG/u,
  );
  await assert.rejects(
    publishStoryToInstagram({
      mediaUrl: storyUrl,
      mediaKind: 'animation',
      accessToken: 'instagram-secret',
      userId: '17841400000000000',
      apiVersion: 'v26.0',
      fetchImpl,
    }),
    /media kind/u,
  );
});

function makeLoadedSnapshot({ commit, generatedAt, dataHash, jobs }) {
  return {
    commit,
    generatedAt,
    dataHash,
    schemaVersion: 4,
    jobsById: new Map(jobs.map((job) => [job.id, job])),
  };
}

validation('baselines the current snapshot without bridge work or social backfill', async () => {
  const current = makeLoadedSnapshot({
    commit: '1'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '1'.repeat(64),
    jobs: [makeJob()],
  });
  const bridgeCalls = [];
  const result = await processIntakeSnapshots({
    intakeState: { schemaVersion: STATE_SCHEMA_VERSION, processedSnapshot: null, pendingBridges: [], removedJobs: [] },
    queueState: { schemaVersion: STATE_SCHEMA_VERSION, items: [] },
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    snapshots: [current],
    publishBridge: async (input) => bridgeCalls.push(input),
    now: '2026-08-20T13:01:00.000Z',
  });
  assert.equal(result.summary.baseline, true);
  assert.equal(result.intakeState.processedSnapshot.commit, current.commit);
  assert.deepEqual(result.queueState.items, []);
  assert.deepEqual(bridgeCalls, []);
});

validation('deploys every new or changed bridge but queues only genuinely new issues', async () => {
  const unchanged = makeJob();
  const changedBefore = makeJob({ id: 'gh_111111111111111111111111', contentHash: '1'.repeat(64) });
  const changedAfter = { ...changedBefore, contentHash: '2'.repeat(64), updatedAt: '2026-08-20T11:30:00.000Z' };
  const eligible = makeJob({
    id: 'gh_222222222222222222222222',
    contentHash: '3'.repeat(64),
    createdAt: '2026-08-20T10:00:01.000Z',
  });
  const historical = makeJob({
    id: 'gh_333333333333333333333333',
    contentHash: '4'.repeat(64),
    createdAt: '2026-08-19T10:00:00.000Z',
  });
  const removed = makeJob({ id: 'gh_444444444444444444444444', contentHash: '5'.repeat(64) });
  const previous = makeLoadedSnapshot({
    commit: '1'.repeat(40),
    generatedAt: '2026-08-20T10:00:00.000Z',
    dataHash: '1'.repeat(64),
    jobs: [unchanged, changedBefore, removed],
  });
  const current = makeLoadedSnapshot({
    commit: '2'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '2'.repeat(64),
    jobs: [unchanged, changedAfter, eligible, historical],
  });
  const bridgeCalls = [];
  const result = await processIntakeSnapshots({
    intakeState: {
      schemaVersion: STATE_SCHEMA_VERSION,
      processedSnapshot: snapshotReference({ commit: previous.commit, generatedAt: previous.generatedAt, dataHash: previous.dataHash }),
      pendingBridges: [],
      removedJobs: [],
    },
    queueState: { schemaVersion: STATE_SCHEMA_VERSION, items: [] },
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    snapshots: [previous, current],
    publishBridge: async ({ job, reason }) => {
      bridgeCalls.push(`${job.id}:${reason}`);
      return { status: 'deployed', canonicalUrl: `https://openings.dev/jobs/${job.id}` };
    },
    now: '2026-08-20T13:01:00.000Z',
  });
  assert.deepEqual(bridgeCalls, [
    `${eligible.id}:new`,
    `${historical.id}:new`,
    `${changedAfter.id}:changed`,
  ]);
  assert.deepEqual(result.queueState.items.map((item) => item.jobId), [eligible.id]);
  assert.equal(result.queueState.items[0].bridge.status, 'published');
  assert.deepEqual(result.intakeState.pendingBridges, []);
  assert.deepEqual(result.intakeState.removedJobs, [removed.id]);
  assert.equal(result.intakeState.processedSnapshot.commit, current.commit);
});

validation('checkpoints one bridge attempt and resumes without duplicate deployment', async () => {
  const jobs = [
    makeJob({
      id: 'gh_111111111111111111111111',
      contentHash: '1'.repeat(64),
      createdAt: '2026-09-01T18:00:01.000Z',
    }),
    makeJob({
      id: 'gh_222222222222222222222222',
      contentHash: '2'.repeat(64),
      createdAt: '2026-09-01T18:00:02.000Z',
    }),
    makeJob({
      id: 'gh_333333333333333333333333',
      contentHash: '3'.repeat(64),
      createdAt: '2026-09-01T18:00:03.000Z',
    }),
  ];
  const previous = makeLoadedSnapshot({
    commit: 'a'.repeat(40),
    generatedAt: '2026-09-01T18:00:00.000Z',
    dataHash: 'a'.repeat(64),
    jobs: [],
  });
  const current = makeLoadedSnapshot({
    commit: 'b'.repeat(40),
    generatedAt: '2026-09-01T18:05:00.000Z',
    dataHash: 'b'.repeat(64),
    jobs,
  });
  const bridgeCalls = [];
  const publishBridge = async ({ job }) => {
    bridgeCalls.push(job.id);
    return { status: 'deployed', canonicalUrl: `https://openings.dev/jobs/${job.id}` };
  };
  const initialIntake = {
    schemaVersion: STATE_SCHEMA_VERSION,
    processedSnapshot: snapshotReference({
      commit: previous.commit,
      generatedAt: previous.generatedAt,
      dataHash: previous.dataHash,
    }),
    pendingBridges: [],
    removedJobs: [],
  };
  const emptyQueue = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };
  const publications = { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} };

  const first = await processIntakeSnapshots({
    intakeState: initialIntake,
    queueState: emptyQueue,
    publicationsState: publications,
    snapshots: [previous, current],
    publishBridge,
    maxBridgeAttempts: 1,
    now: '2026-09-01T18:06:00.000Z',
  });
  assert.equal(first.summary.complete, false);
  assert.equal(first.summary.error, null);
  assert.equal(first.summary.bridges, 1);
  assert.equal(first.intakeState.processedSnapshot.commit, previous.commit);
  assert.equal(first.intakeState.pendingBridges.length, 1);
  assert.equal(first.intakeState.pendingBridges[0].stage.status, 'published');
  assert.deepEqual(first.queueState.items.map(({ jobId }) => jobId), [jobs[0].id]);
  assert.deepEqual(bridgeCalls, [jobs[0].id]);

  const second = await processIntakeSnapshots({
    intakeState: first.intakeState,
    queueState: first.queueState,
    publicationsState: publications,
    snapshots: [previous, current],
    publishBridge,
    maxBridgeAttempts: 1,
    now: '2026-09-01T18:07:00.000Z',
  });
  assert.equal(second.summary.complete, false);
  assert.equal(second.summary.bridges, 1);
  assert.equal(second.intakeState.processedSnapshot.commit, previous.commit);
  assert.deepEqual(second.queueState.items.map(({ jobId }) => jobId), [jobs[0].id, jobs[1].id]);
  assert.deepEqual(bridgeCalls, [jobs[0].id, jobs[1].id]);

  const completed = await processIntakeSnapshots({
    intakeState: second.intakeState,
    queueState: second.queueState,
    publicationsState: publications,
    snapshots: [previous, current],
    publishBridge,
    now: '2026-09-01T18:08:00.000Z',
  });
  assert.equal(completed.summary.complete, true);
  assert.equal(completed.summary.bridges, 1);
  assert.equal(completed.intakeState.processedSnapshot.commit, current.commit);
  assert.deepEqual(completed.intakeState.pendingBridges, []);
  assert.deepEqual(completed.queueState.items.map(({ jobId }) => jobId), jobs.map(({ id }) => id));
  assert.deepEqual(bridgeCalls, jobs.map(({ id }) => id));
});

validation('persists a retryable intake bridge instead of discarding the failure', async () => {
  const job = makeJob({
    id: 'gh_444444444444444444444444',
    contentHash: '4'.repeat(64),
    createdAt: '2026-09-01T18:00:01.000Z',
  });
  const previous = makeLoadedSnapshot({
    commit: 'c'.repeat(40),
    generatedAt: '2026-09-01T18:00:00.000Z',
    dataHash: 'c'.repeat(64),
    jobs: [],
  });
  const current = makeLoadedSnapshot({
    commit: 'd'.repeat(40),
    generatedAt: '2026-09-01T18:05:00.000Z',
    dataHash: 'd'.repeat(64),
    jobs: [job],
  });
  const failure = new Error('secret FTP diagnostic');
  failure.code = 'bridge_deployment';
  const result = await processIntakeSnapshots({
    intakeState: {
      schemaVersion: STATE_SCHEMA_VERSION,
      processedSnapshot: snapshotReference({
        commit: previous.commit,
        generatedAt: previous.generatedAt,
        dataHash: previous.dataHash,
      }),
      pendingBridges: [],
      removedJobs: [],
    },
    queueState: { schemaVersion: STATE_SCHEMA_VERSION, items: [] },
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    snapshots: [previous, current],
    publishBridge: async () => { throw failure; },
    maxBridgeAttempts: 1,
    now: '2026-09-01T18:06:00.000Z',
  });
  assert.equal(result.summary.complete, false);
  assert.equal(result.summary.error, 'bridge_deployment');
  assert.equal(result.intakeState.processedSnapshot.commit, previous.commit);
  assert.equal(result.intakeState.pendingBridges[0].stage.status, 'retryable');
  assert.equal(result.intakeState.pendingBridges[0].stage.attempts, 1);
  assert.equal(result.intakeState.pendingBridges[0].stage.lastError.code, 'bridge_deployment');
  assert.deepEqual(result.queueState.items, []);
  assert.equal(JSON.stringify(result).includes('secret FTP diagnostic'), false);
});

validation('replaces a stale intake checkpoint before deploying changed content', async () => {
  const before = makeJob({
    id: 'gh_555555555555555555555555',
    contentHash: '5'.repeat(64),
  });
  const after = { ...before, contentHash: '6'.repeat(64), updatedAt: '2026-09-01T18:05:00.000Z' };
  const previous = makeLoadedSnapshot({
    commit: 'e'.repeat(40),
    generatedAt: '2026-09-01T18:00:00.000Z',
    dataHash: 'e'.repeat(64),
    jobs: [before],
  });
  const current = makeLoadedSnapshot({
    commit: 'f'.repeat(40),
    generatedAt: '2026-09-01T18:05:00.000Z',
    dataHash: 'f'.repeat(64),
    jobs: [after],
  });
  const staleSnapshot = snapshotReference({
    commit: previous.commit,
    generatedAt: previous.generatedAt,
    dataHash: previous.dataHash,
  });
  let intake = {
    schemaVersion: STATE_SCHEMA_VERSION,
    processedSnapshot: staleSnapshot,
    pendingBridges: [],
    removedJobs: [],
  };
  intake = enqueueBridgeWork(intake, { job: before, snapshot: previous, reason: 'changed' });
  let deployedHash = null;
  const result = await processIntakeSnapshots({
    intakeState: intake,
    queueState: { schemaVersion: STATE_SCHEMA_VERSION, items: [] },
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    snapshots: [previous, current],
    publishBridge: async ({ job }) => {
      deployedHash = job.contentHash;
      return { status: 'deployed' };
    },
    maxBridgeAttempts: 1,
    now: '2026-09-01T18:06:00.000Z',
  });
  assert.equal(deployedHash, after.contentHash);
  assert.equal(result.summary.complete, true);
  assert.equal(result.intakeState.processedSnapshot.commit, current.commit);
  assert.deepEqual(result.intakeState.pendingBridges, []);
  assert.deepEqual(result.queueState.items, []);
});

validation('persists one bounded intake attempt through the CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-bounded-intake-'));
  const jobs = [
    makeJob({
      id: 'gh_666666666666666666666661',
      contentHash: '6'.repeat(64),
      createdAt: '2026-09-01T18:00:01.000Z',
    }),
    makeJob({
      id: 'gh_666666666666666666666662',
      contentHash: '7'.repeat(64),
      createdAt: '2026-09-01T18:00:02.000Z',
    }),
  ];
  const previous = makeLoadedSnapshot({
    commit: '6'.repeat(40),
    generatedAt: '2026-09-01T18:00:00.000Z',
    dataHash: '6'.repeat(64),
    jobs: [],
  });
  const current = makeLoadedSnapshot({
    commit: '7'.repeat(40),
    generatedAt: '2026-09-01T18:05:00.000Z',
    dataHash: '7'.repeat(64),
    jobs,
  });
  const logs = [];
  let bridgeCalls = 0;
  try {
    await saveStateFile(join(directory, 'intake.json'), {
      schemaVersion: STATE_SCHEMA_VERSION,
      processedSnapshot: snapshotReference({
        commit: previous.commit,
        generatedAt: previous.generatedAt,
        dataHash: previous.dataHash,
      }),
      pendingBridges: [],
      removedJobs: [],
    }, validateIntakeState);
    await saveStateFile(join(directory, 'queue.json'), {
      schemaVersion: STATE_SCHEMA_VERSION,
      items: [],
    }, validateQueueState);
    await saveStateFile(join(directory, 'publications.json'), {
      schemaVersion: STATE_SCHEMA_VERSION,
      jobs: {},
    }, validatePublicationsState);

    await runIntake({
      dataRepositoryPath: '/fixture/data',
      stateDirectory: directory,
      wordmarkPath: '/fixture/wordmark.svg',
      outputPath: join(directory, 'output'),
      env: { WEB_DEPLOY_TOKEN: 'deploy-secret' },
      maxBridgeAttempts: 1,
      log: (message) => logs.push(message),
      dependencies: {
        resolveGitCommit: async () => current.commit,
        listSnapshotCommits: async () => [previous.commit, current.commit],
        loadSnapshot: async (_repository, commit) => (
          commit === previous.commit ? previous : current
        ),
        loadCanonicalWordmark: async () => '<svg></svg>',
        createBridgePublisher: () => async ({ job }) => {
          bridgeCalls += 1;
          return { status: 'deployed', canonicalUrl: `https://openings.dev/jobs/${job.id}` };
        },
      },
    });

    const [intake, queue] = await Promise.all([
      loadStateFile(join(directory, 'intake.json'), validateIntakeState),
      loadStateFile(join(directory, 'queue.json'), validateQueueState),
    ]);
    const summary = JSON.parse(logs.at(-1));
    assert.equal(bridgeCalls, 1);
    assert.equal(intake.processedSnapshot.commit, previous.commit);
    assert.equal(intake.pendingBridges.length, 1);
    assert.equal(intake.pendingBridges[0].stage.status, 'published');
    assert.deepEqual(queue.items.map(({ jobId }) => jobId), [jobs[0].id]);
    assert.equal(summary.complete, false);
    assert.equal(summary.error, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('persists a failed CLI intake attempt without logging its diagnostic', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-failed-intake-'));
  const job = makeJob({
    id: 'gh_777777777777777777777777',
    contentHash: '8'.repeat(64),
    createdAt: '2026-09-01T18:00:01.000Z',
  });
  const previous = makeLoadedSnapshot({
    commit: '8'.repeat(40),
    generatedAt: '2026-09-01T18:00:00.000Z',
    dataHash: '8'.repeat(64),
    jobs: [],
  });
  const current = makeLoadedSnapshot({
    commit: '9'.repeat(40),
    generatedAt: '2026-09-01T18:05:00.000Z',
    dataHash: '9'.repeat(64),
    jobs: [job],
  });
  const logs = [];
  try {
    await saveStateFile(join(directory, 'intake.json'), {
      schemaVersion: STATE_SCHEMA_VERSION,
      processedSnapshot: snapshotReference({
        commit: previous.commit,
        generatedAt: previous.generatedAt,
        dataHash: previous.dataHash,
      }),
      pendingBridges: [],
      removedJobs: [],
    }, validateIntakeState);
    await saveStateFile(join(directory, 'queue.json'), {
      schemaVersion: STATE_SCHEMA_VERSION,
      items: [],
    }, validateQueueState);
    await saveStateFile(join(directory, 'publications.json'), {
      schemaVersion: STATE_SCHEMA_VERSION,
      jobs: {},
    }, validatePublicationsState);

    await runIntake({
      dataRepositoryPath: '/fixture/data',
      stateDirectory: directory,
      wordmarkPath: '/fixture/wordmark.svg',
      outputPath: join(directory, 'output'),
      env: { WEB_DEPLOY_TOKEN: 'deploy-secret' },
      maxBridgeAttempts: 1,
      log: (message) => logs.push(message),
      dependencies: {
        resolveGitCommit: async () => current.commit,
        listSnapshotCommits: async () => [previous.commit, current.commit],
        loadSnapshot: async (_repository, commit) => (
          commit === previous.commit ? previous : current
        ),
        loadCanonicalWordmark: async () => '<svg></svg>',
        createBridgePublisher: () => async () => {
          const error = new Error('secret FTP diagnostic');
          error.code = 'bridge_deployment';
          throw error;
        },
      },
    });

    const intake = await loadStateFile(join(directory, 'intake.json'), validateIntakeState);
    const summary = JSON.parse(logs.at(-1));
    assert.equal(intake.pendingBridges[0].stage.status, 'retryable');
    assert.equal(summary.error, 'bridge_deployment');
    assert.equal(logs.join('\n').includes('secret FTP diagnostic'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('deploys before providers and preserves partial success for a retry', async () => {
  const job = makeJob({ community: { name: 'Openings Fixtures' }, tags: ['typescript'] });
  const snapshot = makeLoadedSnapshot({
    commit: '3'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '3'.repeat(64),
    jobs: [job],
  });
  const queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  const order = [];
  const first = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async () => { order.push('bridge'); return { status: 'deployed' }; },
    publishBluesky: async ({ post }) => { order.push('bluesky'); return { status: 'published', uri: 'at://fixture', cid: 'cid', url: post.canonicalUrl }; },
    publishMastodon: async () => { order.push('mastodon'); throw new Error('Mastodon publication failed'); },
    publishTwitter: async () => ({ status: 'published', id: 'buffer-tweet', url: 'https://x.com/openingsdev/status/1', provider: 'buffer' }),
    now: '2026-08-20T13:02:00.000Z',
  });
  assert.deepEqual(order, ['bridge', 'bluesky', 'mastodon']);
  assert.equal(first.queueState.items[0].bridge.status, 'published');
  assert.equal(first.queueState.items[0].bluesky.status, 'published');
  assert.equal(first.queueState.items[0].mastodon.status, 'retryable');
  assert.deepEqual(first.publicationsState.jobs, {});

  order.length = 0;
  const second = await processOnePublication({
    queueState: first.queueState,
    publicationsState: first.publicationsState,
    currentSnapshot: snapshot,
    publishBridge: async () => { order.push('bridge'); return { status: 'deployed' }; },
    publishBluesky: async () => { order.push('bluesky'); return { status: 'published' }; },
    publishMastodon: async ({ post }) => { order.push('mastodon'); return { status: 'reconciled', id: 'status', url: post.canonicalUrl, cardStatus: 'resolved' }; },
    now: '2026-08-20T15:02:00.000Z',
  });
  assert.deepEqual(order, ['mastodon']);
  assert.equal(second.queueState.items[0].mastodon.status, 'published');
  assert.equal(second.publicationsState.jobs[job.id].status, 'completed');
});

validation('retires closed queue items and publishes the next open job in one run', async () => {
  const closedJob = makeJob({
    id: 'gh_777777777777777777777777',
    createdAt: '2026-08-18T10:00:00.000Z',
  });
  const openJob = makeJob({
    id: 'gh_888888888888888888888888',
    createdAt: '2026-08-20T12:00:00.000Z',
  });
  const snapshot = makeLoadedSnapshot({
    commit: '8'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '8'.repeat(64),
    jobs: [openJob],
  });
  let queue = { schemaVersion: STATE_SCHEMA_VERSION, items: [] };
  for (const [job, discoveredAt] of [
    [closedJob, '2026-08-18T10:01:00.000Z'],
    [openJob, '2026-08-20T12:01:00.000Z'],
  ]) {
    queue = enqueueJob(queue, { job, snapshot, discoveredAt });
    queue = transitionQueueStage(queue, job.id, 'bridge', 'publishing', {
      at: discoveredAt,
    });
    queue = transitionQueueStage(queue, job.id, 'bridge', 'published', {
      at: discoveredAt,
      result: { status: 'deployed' },
    });
  }

  const providerJobs = [];
  const result = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async () => { throw new Error('Published bridges must not redeploy'); },
    publishBluesky: async ({ job }) => {
      providerJobs.push(job.id);
      return { status: 'published', uri: 'at://fixture', cid: 'fixture-cid' };
    },
    publishMastodon: async ({ job, post }) => {
      providerJobs.push(job.id);
      return { status: 'published', id: 'status', url: post.canonicalUrl };
    },
    publishTwitter: async ({ job }) => {
      providerJobs.push(job.id);
      return { status: 'published', id: 'buffer-tweet', url: 'https://x.com/openingsdev/status/1', provider: 'buffer' };
    },
    now: '2026-08-21T11:00:00.000Z',
  });

  assert.equal(result.outcome, 'completed');
  assert.equal(result.selectedJobId, openJob.id);
  assert.equal(result.queueState.items[0].bridge.status, 'published');
  assert.equal(result.queueState.items[0].bluesky.status, 'skipped_closed');
  assert.equal(result.queueState.items[0].mastodon.status, 'skipped_closed');
  assert.deepEqual(providerJobs, [openJob.id, openJob.id, openJob.id]);
});

validation('refreshes a stale queued Instagram card before publication', async () => {
  const job = makeJob();
  const snapshot = makeLoadedSnapshot({
    commit: '9'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '9'.repeat(64),
    jobs: [job],
  });
  const makePublishedBridgeQueue = (
    instagramCardVersion,
    socialVideoVersion = SOCIAL_VIDEO_VERSION,
  ) => {
    let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
      job,
      snapshot,
      discoveredAt: '2026-08-20T13:01:00.000Z',
      enabledChannels: ['instagram'],
    });
    queue = transitionQueueStage(queue, job.id, 'bridge', 'publishing', {
      at: '2026-08-20T13:01:10.000Z',
    });
    return transitionQueueStage(queue, job.id, 'bridge', 'published', {
      at: '2026-08-20T13:01:20.000Z',
      result: { status: 'deployed', instagramCardVersion, socialVideoVersion },
    });
  };

  const staleOrder = [];
  const stale = await processOnePublication({
    queueState: makePublishedBridgeQueue('1'),
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async ({ reason }) => {
      assert.equal(reason, 'instagram_card_upgrade');
      staleOrder.push('bridge');
      return {
        status: 'deployed',
        instagramCardVersion: INSTAGRAM_CARD_VERSION,
        socialVideoVersion: SOCIAL_VIDEO_VERSION,
      };
    },
    publishBluesky: async () => { throw new Error('Bluesky is disabled'); },
    publishMastodon: async () => { throw new Error('Mastodon is disabled'); },
    publishInstagram: async () => {
      staleOrder.push('instagram');
      return { status: 'published', id: 'media-stale', url: 'https://www.instagram.com/p/media-stale/' };
    },
    enabledChannels: ['instagram'],
    now: '2026-08-20T13:02:00.000Z',
  });
  assert.deepEqual(staleOrder, ['bridge', 'instagram']);
  assert.equal(stale.queueState.items[0].bridge.result.instagramCardVersion, INSTAGRAM_CARD_VERSION);
  assert.equal(stale.queueState.items[0].bridge.result.socialVideoVersion, SOCIAL_VIDEO_VERSION);

  const currentOrder = [];
  await processOnePublication({
    queueState: makePublishedBridgeQueue(INSTAGRAM_CARD_VERSION),
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async () => { currentOrder.push('bridge'); return { status: 'deployed' }; },
    publishBluesky: async () => { throw new Error('Bluesky is disabled'); },
    publishMastodon: async () => { throw new Error('Mastodon is disabled'); },
    publishInstagram: async () => {
      currentOrder.push('instagram');
      return { status: 'published', id: 'media-current', url: 'https://www.instagram.com/p/media-current/' };
    },
    enabledChannels: ['instagram'],
    now: '2026-08-20T13:02:00.000Z',
  });
  assert.deepEqual(currentOrder, ['instagram']);
});

validation('controlled publication can enqueue one explicit current job', async () => {
  const job = makeJob({
    id: 'gh_cccccccccccccccccccccccc',
    createdAt: '2026-08-20T12:47:52.000Z',
  });
  const snapshot = makeLoadedSnapshot({
    commit: 'c'.repeat(40),
    generatedAt: '2026-08-20T15:27:19.163Z',
    dataHash: 'c'.repeat(64),
    jobs: [job],
  });
  const calls = [];
  const result = await processOnePublication({
    queueState: { schemaVersion: STATE_SCHEMA_VERSION, items: [] },
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async () => { calls.push('bridge'); return { status: 'deployed' }; },
    publishBluesky: async () => { calls.push('bluesky'); return { status: 'published' }; },
    publishMastodon: async () => { calls.push('mastodon'); return { status: 'published' }; },
    publishTwitter: async () => ({ status: 'published', id: 'buffer-tweet', url: 'https://x.com/openingsdev/status/1', provider: 'buffer' }),
    now: '2026-08-20T15:30:00.000Z',
    jobId: job.id,
  });

  assert.equal(result.outcome, 'completed');
  assert.equal(result.selectedJobId, job.id);
  assert.deepEqual(calls, ['bridge', 'bluesky', 'mastodon']);
  assert.equal(result.queueState.items[0].jobId, job.id);
});

validation('controlled publication never republishes a completed job', async () => {
  const job = makeJob({ id: 'gh_dddddddddddddddddddddddd' });
  const snapshot = makeLoadedSnapshot({
    commit: 'd'.repeat(40),
    generatedAt: '2026-08-20T15:27:19.163Z',
    dataHash: 'd'.repeat(64),
    jobs: [job],
  });
  const publications = {
    schemaVersion: STATE_SCHEMA_VERSION,
    jobs: {
      [job.id]: {
        status: 'completed',
        contentHash: job.contentHash,
        dataCommit: snapshot.commit,
        dataHash: snapshot.dataHash,
        completedAt: '2026-08-20T15:00:00.000Z',
        bluesky: { status: 'published' },
        mastodon: { status: 'published' },
        linkedin: null,
        twitter: null,
      },
    },
  };
  const calls = [];
  const result = await processOnePublication({
    queueState: { schemaVersion: STATE_SCHEMA_VERSION, items: [] },
    publicationsState: publications,
    currentSnapshot: snapshot,
    publishBridge: async () => { calls.push('bridge'); },
    publishBluesky: async () => { calls.push('bluesky'); },
    publishMastodon: async () => { calls.push('mastodon'); },
    now: '2026-08-20T15:30:00.000Z',
    jobId: job.id,
  });

  assert.equal(result.outcome, 'already_published');
  assert.equal(result.selectedJobId, job.id);
  assert.deepEqual(result.queueState.items, []);
  assert.deepEqual(calls, []);
});

validation('rerenders changed queued work and skips jobs no longer open', async () => {
  const before = makeJob({ contentHash: '1'.repeat(64) });
  const after = { ...before, contentHash: '2'.repeat(64), title: 'Updated title' };
  const previousSnapshot = makeLoadedSnapshot({
    commit: '4'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '4'.repeat(64),
    jobs: [before],
  });
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job: before,
    snapshot: previousSnapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  const currentSnapshot = makeLoadedSnapshot({
    commit: '5'.repeat(40),
    generatedAt: '2026-08-20T14:00:00.000Z',
    dataHash: '5'.repeat(64),
    jobs: [after],
  });
  const rendered = [];
  const changed = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot,
    publishBridge: async ({ job }) => { rendered.push(job.contentHash); return { status: 'deployed' }; },
    publishBluesky: async () => ({ status: 'published', uri: 'at://fixture', cid: 'cid', url: 'https://bsky.app/post' }),
    publishMastodon: async () => ({ status: 'published', id: 'status', url: 'https://mastodon.social/status', cardStatus: 'pending' }),
    now: '2026-08-20T14:01:00.000Z',
  });
  assert.deepEqual(rendered, [after.contentHash]);
  assert.equal(changed.queueState.items[0].contentHash, after.contentHash);

  queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job: before,
    snapshot: previousSnapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  const closed = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: { ...currentSnapshot, jobsById: new Map() },
    publishBridge: async () => { throw new Error('must not deploy'); },
    publishBluesky: async () => { throw new Error('must not post'); },
    publishMastodon: async () => { throw new Error('must not post'); },
    now: '2026-08-20T14:01:00.000Z',
  });
  assert.equal(closed.outcome, 'skipped_closed');
  assert.equal(closed.queueState.items[0].bluesky.status, 'skipped_closed');
});

validation('publishes at most one job and never bypasses a failed bridge', async () => {
  const firstJob = makeJob({
    id: 'gh_aaaaaaaaaaaaaaaaaaaaaaaa',
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-20T12:00:00.000Z',
  });
  const secondJob = makeJob({
    id: 'gh_bbbbbbbbbbbbbbbbbbbbbbbb',
    contentHash: 'b'.repeat(64),
    createdAt: '2026-08-20T11:00:00.000Z',
  });
  const snapshot = makeLoadedSnapshot({
    commit: '6'.repeat(40),
    generatedAt: '2026-08-20T13:00:00.000Z',
    dataHash: '6'.repeat(64),
    jobs: [firstJob, secondJob],
  });
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job: firstJob,
    snapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  queue = enqueueJob(queue, {
    job: secondJob,
    snapshot,
    discoveredAt: '2026-08-20T13:01:00.000Z',
  });
  const providerJobs = [];
  const result = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async ({ job }) => {
      if (job.id === firstJob.id) throw new Error('FTP deployment failed');
      return { status: 'deployed' };
    },
    publishBluesky: async ({ job }) => { providerJobs.push(job.id); return { status: 'published' }; },
    publishMastodon: async ({ job }) => { providerJobs.push(job.id); return { status: 'published' }; },
    now: '2026-08-20T13:02:00.000Z',
  });
  assert.equal(result.outcome, 'bridge_retryable');
  assert.deepEqual(providerJobs, []);
  assert.equal(result.queueState.items[1].bridge.status, 'pending');
});

validation('publishes and persists a LinkedIn-only queue stage', async () => {
  const job = makeJob({ id: 'gh_111122223333444455556666' });
  const snapshot = makeLoadedSnapshot({
    commit: '9'.repeat(40),
    generatedAt: '2026-09-01T12:30:00.000Z',
    dataHash: '9'.repeat(64),
    jobs: [job],
  });
  const queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-09-01T12:31:00.000Z',
    enabledChannels: ['linkedin'],
  });
  const result = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async () => ({ status: 'deployed' }),
    publishBluesky: async () => { throw new Error('Bluesky must stay skipped'); },
    publishMastodon: async () => { throw new Error('Mastodon must stay skipped'); },
    publishLinkedIn: async ({ job: selectedJob, post: selectedPost }) => {
      assert.equal(selectedJob.id, job.id);
      assert.equal(selectedPost.canonicalUrl, `https://openings.dev/jobs/${job.id}`);
      return {
        status: 'published',
        id: 'urn:li:share:123456789',
        url: 'https://www.linkedin.com/feed/update/urn:li:share:123456789/',
      };
    },
    enabledChannels: ['linkedin'],
    now: '2026-09-01T13:00:00.000Z',
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.queueState.items[0].linkedin.status, 'published');
  assert.equal(result.publicationsState.jobs[job.id].linkedin.id, 'urn:li:share:123456789');
});

validation('publishes to Twitter through the queue stage machinery', async () => {
  const job = makeJob({ id: 'gh_aaaabbbbccccddddeeeeffff' });
  const snapshot = makeLoadedSnapshot({
    commit: '9'.repeat(40),
    generatedAt: '2026-09-03T10:00:00.000Z',
    dataHash: '9'.repeat(64),
    jobs: [job],
  });
  let queueState = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-09-03T10:00:00.000Z',
    enabledChannels: ['bluesky', 'mastodon', 'twitter'],
  });
  queueState = transitionQueueStage(queueState, job.id, 'bridge', 'publishing', { at: '2026-09-03T10:00:01.000Z' });
  queueState = transitionQueueStage(queueState, job.id, 'bridge', 'published', {
    at: '2026-09-03T10:00:01.000Z',
    result: { canonicalUrl: `https://openings.dev/jobs/${job.id}` },
  });
  let twitterCalls = 0;
  const twitterResult = await processOnePublication({
    queueState,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    publishBridge: async () => { throw new Error('bridge must not run again'); },
    publishBluesky: async () => ({ status: 'published' }),
    publishMastodon: async () => ({ status: 'published' }),
    publishTwitter: async ({ post: selectedPost }) => {
      twitterCalls += 1;
      assert.equal(selectedPost.canonicalUrl, `https://openings.dev/jobs/${job.id}`);
      assert.ok(selectedPost.text.length <= 280);
      return {
        status: 'published',
        id: 'buffer-tweet-3',
        url: 'https://x.com/openingsdev/status/998877',
        provider: 'buffer',
      };
    },
    enabledChannels: ['bluesky', 'mastodon', 'twitter'],
  });
  assert.equal(twitterResult.outcome, 'completed');
  assert.equal(twitterCalls, 1);
  assert.equal(twitterResult.queueState.items[0].twitter.status, 'published');
  assert.equal(twitterResult.publicationsState.jobs[job.id].twitter.id, 'buffer-tweet-3');
});

validation('retries LinkedIn without republishing a completed provider', async () => {
  const job = makeJob({ id: 'gh_111122223333444455557777' });
  const snapshot = makeLoadedSnapshot({
    commit: '8'.repeat(40),
    generatedAt: '2026-09-01T12:30:00.000Z',
    dataHash: '8'.repeat(64),
    jobs: [job],
  });
  let queue = enqueueJob({ schemaVersion: STATE_SCHEMA_VERSION, items: [] }, {
    job,
    snapshot,
    discoveredAt: '2026-09-01T12:31:00.000Z',
    enabledChannels: ['bluesky', 'linkedin'],
  });
  queue = transitionQueueStage(queue, job.id, 'bridge', 'publishing', {
    at: '2026-09-01T12:32:00.000Z',
  });
  queue = transitionQueueStage(queue, job.id, 'bridge', 'published', {
    at: '2026-09-01T12:33:00.000Z',
    result: { status: 'deployed' },
  });
  queue = transitionQueueStage(queue, job.id, 'bluesky', 'publishing', {
    at: '2026-09-01T12:34:00.000Z',
  });
  queue = transitionQueueStage(queue, job.id, 'bluesky', 'published', {
    at: '2026-09-01T12:35:00.000Z',
    result: { status: 'published', uri: 'at://fixture', cid: 'fixture-cid' },
  });
  let linkedinCalls = 0;
  const publishers = {
    publishBridge: async () => { throw new Error('Bridge must stay published'); },
    publishBluesky: async () => { throw new Error('Bluesky must not be republished'); },
    publishMastodon: async () => { throw new Error('Mastodon must stay skipped'); },
    publishLinkedIn: async () => {
      linkedinCalls += 1;
      if (linkedinCalls === 1) {
        const error = new Error('Temporary Buffer failure');
        error.code = 'buffer_rate_limit';
        throw error;
      }
      return {
        status: 'reconciled',
        id: 'urn:li:share:2233445566',
        url: 'https://www.linkedin.com/feed/update/urn:li:share:2233445566/',
      };
    },
  };
  const first = await processOnePublication({
    queueState: queue,
    publicationsState: { schemaVersion: STATE_SCHEMA_VERSION, jobs: {} },
    currentSnapshot: snapshot,
    ...publishers,
    enabledChannels: ['bluesky', 'linkedin'],
    now: '2026-09-01T13:00:00.000Z',
  });
  assert.equal(first.outcome, 'partial');
  assert.equal(first.queueState.items[0].bluesky.status, 'published');
  assert.equal(first.queueState.items[0].linkedin.status, 'retryable');
  assert.equal(first.queueState.items[0].linkedin.lastError.code, 'buffer_rate_limit');

  const second = await processOnePublication({
    queueState: first.queueState,
    publicationsState: first.publicationsState,
    currentSnapshot: snapshot,
    ...publishers,
    enabledChannels: ['bluesky', 'linkedin'],
    now: '2026-09-01T15:00:00.000Z',
  });
  assert.equal(linkedinCalls, 2);
  assert.equal(second.outcome, 'completed');
  assert.equal(second.queueState.items[0].bluesky.attempts, 1);
  assert.equal(second.queueState.items[0].linkedin.status, 'published');
});

validation('keeps validation read-only and production publishing explicitly gated', async () => {
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const [validationWorkflow, productionWorkflow, readme] = await Promise.all([
    readFile(join(repositoryRoot, '.github/workflows/validate.yml'), 'utf8'),
    readFile(join(repositoryRoot, '.github/workflows/publish-social.yml'), 'utf8'),
    readFile(join(repositoryRoot, 'README.md'), 'utf8'),
  ]);
  assert.match(validationWorkflow, /pull_request:/u);
  assert.match(validationWorkflow, /push:/u);
  assert.match(validationWorkflow, /contents:\s*read/u);
  assert.match(validationWorkflow, /npm ci/u);
  assert.match(validationWorkflow, /npm run validate/u);
  assert.match(validationWorkflow, /npm run dry-run/u);
  assert.doesNotMatch(validationWorkflow, /secrets\./u);
  assert.doesNotMatch(validationWorkflow, /npm run (?:intake|publish)/u);
  assert.match(productionWorkflow, /cron:\s*['"]17 \*\/2 \* \* \*['"]/u);
  assert.match(productionWorkflow, /workflow_dispatch:/u);
  assert.doesNotMatch(productionWorkflow, /^\s{2}(?:push|pull_request):/mu);
  assert.match(productionWorkflow, /contents:\s*write/u);
  assert.match(productionWorkflow, /cancel-in-progress:\s*false/u);
  assert.match(
    productionWorkflow,
    /^defaults:\n  run:\n    shell: bash$/mu,
  );
  assert.match(productionWorkflow, /PUBLISH_ONE_JOB/u);
  assert.match(productionWorkflow, /RESET_FAILED_STAGE/u);
  assert.match(productionWorkflow, /chore\(state\): checkpoint social intake/u);
  assert.match(productionWorkflow, /chore\(state\): record social publication/u);
  assert.match(productionWorkflow, /WEB_DEPLOY_TOKEN/u);
  assert.match(productionWorkflow, /THREADS_AUTO_PUBLISH/u);
  assert.match(productionWorkflow, /INSTAGRAM_AUTO_PUBLISH/u);
  assert.match(productionWorkflow, /INSTAGRAM_STORY_AUTO_PUBLISH/u);
  assert.match(productionWorkflow, /THREADS_ACCESS_TOKEN/u);
  assert.match(productionWorkflow, /INSTAGRAM_ACCESS_TOKEN/u);
  assert.match(productionWorkflow, /META_GRAPH_VERSION/u);
  for (const pattern of [
    /publish_linkedin:/u,
    /LINKEDIN_AUTO_PUBLISH/u,
    /LINKEDIN_PROVIDER/u,
    /LINKEDIN_API_VERSION/u,
    /LINKEDIN_ORGANIZATION_ID/u,
    /LINKEDIN_ACCESS_TOKEN/u,
    /BUFFER_API_ORIGIN/u,
    /BUFFER_ORGANIZATION_ID/u,
    /BUFFER_LINKEDIN_CHANNEL_ID/u,
    /BUFFER_API_KEY/u,
    /- linkedin/u,
  ]) {
    assert.match(productionWorkflow, pattern);
  }
  assert.equal([...productionWorkflow.matchAll(/secrets\.LINKEDIN_ACCESS_TOKEN/gu)].length, 1);
  assert.equal([...productionWorkflow.matchAll(/secrets\.BUFFER_API_KEY/gu)].length, 1);
  assert.match(
    productionWorkflow,
    /inputs\.publish_linkedin\) && 'true' \|\| vars\.LINKEDIN_AUTO_PUBLISH \|\| 'false'/u,
  );
  for (const value of [
    'LinkedIn Page',
    'w_organization_social',
    'r_organization_social',
    'LINKEDIN_AUTO_PUBLISH',
    'LINKEDIN_ACCESS_TOKEN',
    'LINKEDIN_ORGANIZATION_ID',
    'LINKEDIN_API_VERSION',
    'LINKEDIN_API_ORIGIN',
    'LINKEDIN_PROVIDER',
    'BUFFER_API_ORIGIN',
    'BUFFER_ORGANIZATION_ID',
    'BUFFER_LINKEDIN_CHANNEL_ID',
    'BUFFER_API_KEY',
    'shareNow',
    'Buffer Free plan',
    'direct provider fallback',
    'publish_linkedin',
    'skipped_before_activation',
  ]) {
    assert.match(readme, new RegExp(value, 'u'));
  }
  assert.doesNotMatch(readme, /BUFFER_API_KEY\s*=\s*[A-Za-z0-9_-]{12,}/u);
  assert.doesNotMatch(productionWorkflow, /BUFFER_API_KEY:\s*(?!\$\{\{ secrets\.BUFFER_API_KEY \}\})\S+/u);
  assert.match(productionWorkflow, /id:\s*preflight/u);
  assert.match(productionWorkflow, /src\/cli\/preflight\.mjs/u);
  assert.match(productionWorkflow, /steps\.preflight\.outputs\.should_run == 'true'/u);
  const publicationIndex = productionWorkflow.indexOf('Publish at most one queued job');
  const publicationCommitIndex = productionWorkflow.indexOf('Commit and push publication or reset state');
  const intakeIndex = productionWorkflow.indexOf('Process and checkpoint bounded snapshot intake');
  assert.ok(publicationIndex >= 0);
  assert.ok(publicationIndex < publicationCommitIndex);
  assert.ok(publicationCommitIndex < intakeIndex);
  const publicationStep = productionWorkflow.match(
    /- name: Publish at most one queued job(?<block>[\s\S]*?)(?=\n\s+- name:)/u,
  )?.groups?.block ?? '';
  assert.match(publicationStep, /id:\s*publication/u);
  assert.match(publicationStep, /mkdir -p \.tmp/u);
  assert.ok(publicationStep.indexOf('mkdir -p .tmp') < publicationStep.indexOf('tee .tmp/publication-summary.txt'));
  assert.match(publicationStep, /JSON\.parse/u);
  assert.match(publicationStep, /outcome=.*GITHUB_OUTPUT/u);
  assert.match(productionWorkflow, /npm run publish:story/u);
  assert.match(productionWorkflow, /chore\(state\): record Instagram story/u);
  assert.ok(
    productionWorkflow.indexOf('Commit and push publication or reset state')
      < productionWorkflow.indexOf('Prepare Instagram Story publication intent'),
  );
  assert.ok(
    productionWorkflow.indexOf('Prepare Instagram Story publication intent')
      < productionWorkflow.indexOf('Commit and push Instagram Story intent'),
  );
  assert.ok(
    productionWorkflow.indexOf('Commit and push Instagram Story intent')
      < productionWorkflow.indexOf('Publish Instagram Story for a completed feed post'),
  );
  assert.ok(
    productionWorkflow.indexOf('Publish Instagram Story for a completed feed post')
      < productionWorkflow.indexOf('Commit and push Instagram Story state'),
  );
  const storyPublication = productionWorkflow.match(
    /- name: Publish Instagram Story for a completed feed post(?<block>[\s\S]*?)(?=\n\s+- name:)/u,
  )?.groups?.block ?? '';
  assert.match(storyPublication, /--mode publish/u);
  assert.match(storyPublication, /--operation "\$STORY_OPERATION_KEY"/u);
  assert.match(storyPublication, /--job "\$REQUEST_JOB_ID"/u);
  assert.doesNotMatch(storyPublication, /INSTAGRAM_AUTO_PUBLISH/u);
  const storyResultCommit = productionWorkflow.match(
    /- name: Commit and push Instagram Story state(?<block>[\s\S]*?)$/u,
  )?.groups?.block ?? '';
  assert.match(storyResultCommit, /if: always\(\)/u);
  const stateCheckout = productionWorkflow.match(
    /- name: Check out social-publisher state and source(?<block>[\s\S]*?)(?=\n\s+- name:)/u,
  )?.groups?.block ?? '';
  assert.match(stateCheckout, /ref:\s*\$\{\{ github\.ref_name \}\}/u);
  const intakeStep = productionWorkflow.match(
    /- name: Process and checkpoint bounded snapshot intake(?<block>[\s\S]*?)(?=\n\s+- name:)/u,
  )?.groups?.block ?? '';
  assert.match(intakeStep, /id:\s*intake/u);
  assert.match(intakeStep, /env\.RUN_MODE == 'scheduled'/u);
  assert.match(intakeStep, /steps\.publication\.outputs\.outcome != 'bridge_retryable'/u);
  assert.doesNotMatch(intakeStep, /env\.RUN_MODE == 'controlled'/u);
  assert.match(intakeStep, /for iteration in \{1\.\.8\}/u);
  assert.match(intakeStep, /npm run intake/u);
  assert.match(intakeStep, /git add -- state\/intake\.json state\/queue\.json/u);
  assert.match(intakeStep, /chore\(state\): checkpoint social intake \[skip ci\]/u);
  assert.match(intakeStep, /git fetch origin/u);
  assert.match(intakeStep, /git rebase/u);
  assert.match(intakeStep, /npm run validate/u);
  assert.match(intakeStep, /JSON\.parse/u);
  assert.match(intakeStep, /GITHUB_OUTPUT/u);
  const intakeGuard = productionWorkflow.match(
    /- name: Fail after preserving an intake error(?<block>[\s\S]*?)(?=\n\s+- name:|$)/u,
  )?.groups?.block ?? '';
  assert.match(intakeGuard, /steps\.intake\.outputs\.error != ''/u);
  assert.match(intakeGuard, /exit 1/u);
  assert.doesNotMatch(productionWorkflow, /FTP_(?:SERVER|USERNAME|PASSWORD|JOB_ROOT)|Install LFTP/u);
  const actionUses = [...`${validationWorkflow}\n${productionWorkflow}`.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/gu)];
  assert.ok(actionUses.length >= 5);
  assert.equal(actionUses.every((match) => /^[0-9a-f]{40}$/u.test(match[1])), true);
});

validation('exposes the Twitter Buffer channel and retry-stage option in the production workflow', async () => {
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const productionWorkflow = await readFile(
    join(repositoryRoot, '.github/workflows/publish-social.yml'),
    'utf8',
  );
  assert.match(productionWorkflow, /BUFFER_TWITTER_CHANNEL_ID/u);
  assert.match(productionWorkflow, /- twitter/u);
  assert.equal([...productionWorkflow.matchAll(/secrets\.BUFFER_API_KEY/gu)].length, 1);
});

validation('exposes guarded intake-bridge recovery in the production workflow', async () => {
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const productionWorkflow = await readFile(
    join(repositoryRoot, '.github/workflows/publish-social.yml'),
    'utf8',
  );
  assert.match(productionWorkflow, /- intake-bridge/u);
  const resetCommit = productionWorkflow.match(
    /- name: Commit and push publication or reset state(?<block>[\s\S]*?)(?=\n\s+- name:)/u,
  )?.groups?.block ?? '';
  assert.match(
    resetCommit,
    /git add -- state\/intake\.json state\/queue\.json state\/publications\.json/u,
  );
});

validation('documents the Twitter Buffer configuration and rollout sequence', async () => {
  const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const readme = await readFile(join(repositoryRoot, 'README.md'), 'utf8');
  for (const value of [
    'BUFFER_TWITTER_CHANNEL_ID',
    'For Twitter/X through Buffer',
  ]) {
    assert.match(readme, new RegExp(value, 'u'));
  }
});

validation('ships a complete, source-grounded 12-week Instagram editorial catalog', () => {
  validateEditorialCatalog(EDITORIAL_CATALOG);
  assert.equal(EDITORIAL_CATALOG.length, 36);
  assert.deepEqual(
    Object.fromEntries(['linkedin', 'resume', 'search', 'application', 'interview'].map((pillar) => [
      pillar,
      EDITORIAL_CATALOG.filter((item) => item.pillar === pillar).length,
    ])),
    { linkedin: 12, resume: 8, search: 6, application: 4, interview: 6 },
  );
  assert.equal(new Set(EDITORIAL_CATALOG.map(({ id }) => id)).size, 36);
  for (const item of EDITORIAL_CATALOG) {
    assert.equal(item.version, EDITORIAL_CONTENT_VERSION);
    assertEditorialCopyPolicy(item);
    assert.equal(item.slides.length, 7);
    assert.deepEqual(item.slides.map(({ kind }) => kind), [
      'cover', 'context', 'action', 'example', 'action', 'checklist', 'cta',
    ]);
    assert.deepEqual(item.slides.slice(1).map(({ title }) => title), [
      'Why it matters', 'Try this', 'Before and after',
      'A useful adjustment', 'Quick checklist', 'Do it today',
    ]);
    assert.equal(item.slides[5].items.length, 4);
    assert.ok(item.sources.length > 0);
    assert.ok(item.sources.every(({ url }) => url.startsWith('https://')));
    assert.ok(item.minRepeatDays >= 84);
    assert.equal(JSON.stringify(item).includes('<'), false);
  }
  for (const item of EDITORIAL_CATALOG.filter(({ pillar }) => pillar === 'linkedin')) {
    assert.ok(item.sources.every(({ author, url }) => (
      author === 'LinkedIn Help'
        && new URL(url).hostname === 'www.linkedin.com'
        && new URL(url).pathname.startsWith('/help/linkedin/')
    )));
  }
});

validation('rejects editorial copy that breaks the English publishing policy', () => {
  const fixture = structuredClone(EDITORIAL_CATALOG[0]);
  fixture.version = EDITORIAL_CONTENT_VERSION;
  fixture.sources = [{
    title: 'How do I create a good LinkedIn profile?',
    author: 'LinkedIn Help',
    url: 'https://www.linkedin.com/help/linkedin/answer/a554351/how-do-i-create-a-good-linkedin-profile-?lang=en',
  }];

  for (const [field, value, expected] of [
    ['title', 'Clear profile — better search', /dash characters/u],
    ['title', 'Why it matters: currículo', /Portuguese editorial copy/u],
    ['title', 'Seu perfil needs one clear role.', /Portuguese editorial copy/u],
    ['promise', 'Leverage your profile for more views.', /banned editorial term/u],
  ]) {
    const candidate = structuredClone(fixture);
    candidate[field] = value;
    assert.throws(() => assertEditorialCopyPolicy(candidate), expected);
  }

  const personalSource = structuredClone(fixture);
  personalSource.sources = [{
    title: 'Profile advice',
    author: 'Personal author',
    url: 'https://www.linkedin.com/pulse/profile-advice',
  }];
  assert.throws(() => assertEditorialCopyPolicy(personalSource), /official LinkedIn Help sources/u);
});

validation('schedules the right editorial pillar and never duplicates a pending slot', () => {
  assert.deepEqual(slotForDate('2026-09-07T15:17:00.000Z'), {
    key: '2026-09-07',
    pillars: ['linkedin'],
  });
  assert.deepEqual(slotForDate('2026-09-09T15:17:00.000Z'), {
    key: '2026-09-09',
    pillars: ['resume', 'application'],
  });
  assert.deepEqual(slotForDate('2026-09-11T15:17:00.000Z'), {
    key: '2026-09-11',
    pillars: ['search', 'interview'],
  });
  assert.equal(slotForDate('2026-09-08T15:17:00.000Z'), null);

  const now = '2026-09-07T15:17:00.000Z';
  const empty = createEmptyEditorialState();
  const selected = selectEditorialItem({ catalog: EDITORIAL_CATALOG, state: empty, now });
  assert.equal(selected.content.id, 'linkedin-atividade-estrategica');
  assert.equal(selected.scheduledDate, '2026-09-07');
  const queued = enqueueEditorialItem(empty, selected, { at: now });
  validateEditorialState(queued, EDITORIAL_CATALOG);
  assert.equal(queued.catalogVersion, '2');
  assert.equal(queued.pending[0].contentVersion, EDITORIAL_CONTENT_VERSION);
  assert.equal(selectEditorialItem({ catalog: EDITORIAL_CATALOG, state: queued, now }), null);

  const completed = validateEditorialState({
    ...empty,
    history: {
      [selected.content.id]: {
        lastPublishedAt: '2026-09-07T15:20:00.000Z',
        cycles: 1,
        lastPublication: {
          scheduledDate: '2026-09-07',
          contentVersion: '1',
          assets: { status: 'deployed' },
          feed: { id: 'same-day-feed' },
          story: { id: 'same-day-story' },
        },
      },
    },
  }, EDITORIAL_CATALOG);
  assert.equal(selectEditorialItem({
    catalog: EDITORIAL_CATALOG,
    state: completed,
    now: '2026-09-07T18:00:00.000Z',
  }), null);
  assert.equal(enqueueScheduledEditorial({
    state: completed,
    catalog: EDITORIAL_CATALOG,
    now: '2026-09-07T18:00:00.000Z',
    contentId: EDITORIAL_CATALOG.find(({ id }) => id !== selected.content.id).id,
  }), completed);
});

validation('keeps editorial feed and Story stages independently durable', () => {
  const now = '2026-09-07T15:17:00.000Z';
  const selected = selectEditorialItem({
    catalog: EDITORIAL_CATALOG,
    state: createEmptyEditorialState(),
    now,
  });
  let state = enqueueEditorialItem(createEmptyEditorialState(), selected, { at: now });
  state = transitionEditorialStage(state, selected.content.id, 'assets', 'publishing', { at: now });
  state = transitionEditorialStage(state, selected.content.id, 'assets', 'published', {
    at: now,
    result: { manifestPath: 'editorial/linkedin-atividade-estrategica/manifest.json' },
  });
  state = transitionEditorialStage(state, selected.content.id, 'feed', 'publishing', { at: now });
  state = transitionEditorialStage(state, selected.content.id, 'feed', 'published', {
    at: now,
    result: { id: 'feed-1' },
  });
  assert.equal(state.pending[0].story.status, 'pending');
  assert.equal(state.history[selected.content.id], undefined);
  state = transitionEditorialStage(state, selected.content.id, 'story', 'publishing', { at: now });
  state = transitionEditorialStage(state, selected.content.id, 'story', 'published', {
    at: now,
    result: { id: 'story-1' },
  });
  assert.equal(state.pending.length, 0);
  assert.equal(state.history[selected.content.id].lastPublishedAt, now);
  assert.equal(state.history[selected.content.id].cycles, 1);
  assert.equal(state.history[selected.content.id].lastPublication.feed.id, 'feed-1');
  assert.equal(state.history[selected.content.id].lastPublication.story.id, 'story-1');
  validateEditorialState(state, EDITORIAL_CATALOG);
});

validation('renders deterministic editorial carousels and a dedicated Story', async () => {
  const content = EDITORIAL_CATALOG[0];
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302e"/></svg>';
  assert.deepEqual(resolveEditorialTheme(content.id), resolveEditorialTheme(content.id));
  assert.notDeepEqual(resolveEditorialTheme(content.id), resolveEditorialTheme(EDITORIAL_CATALOG[1].id));
  const coverSvg = createEditorialSlideSvg(content, 0, { wordmarkSvg });
  const storySvg = createEditorialStorySvg(content, { wordmarkSvg });
  const allSlideSvgs = content.slides.map((_, index) => createEditorialSlideSvg(content, index, { wordmarkSvg }));
  const editorialSvgCopy = `${allSlideSvgs.join('\n')}\n${storySvg}`;
  assert.match(coverSvg, /width="1080" height="1350"/u);
  assert.match(coverSvg, /data-editorial-slide="1"/u);
  assert.match(storySvg, /width="1080" height="1920"/u);
  assert.match(storySvg, /data-editorial-story="true"/u);
  assert.match(editorialSvgCopy, /PRACTICAL GUIDE/u);
  assert.match(editorialSvgCopy, /BEFORE/u);
  assert.match(editorialSvgCopy, /AFTER/u);
  assert.match(editorialSvgCopy, /NEW GUIDE/u);
  assert.match(editorialSvgCopy, /View the carousel in the feed/u);
  assert.doesNotMatch(editorialSvgCopy, /GUIA|ANTES|DEPOIS|NOVO|PASSO A PASSO|Veja|SALVE|CURRÍCULO|CANDIDATURA|ENTREVISTA/u);
  const rendered = await renderEditorialAssets(content, { wordmarkSvg });
  assert.equal(rendered.slides.length, 7);
  for (const jpeg of [...rendered.slides, rendered.story]) {
    const metadata = await sharp(jpeg).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 1080);
  }
  assert.equal((await sharp(rendered.slides[0]).metadata()).height, 1350);
  assert.equal((await sharp(rendered.story).metadata()).height, 1920);
});

validation('formats and writes a complete editorial dry run', async () => {
  const content = EDITORIAL_CATALOG[0];
  const caption = formatEditorialCaption(content);
  assert.ok(caption.length < 2_200);
  assert.match(caption, /Source:/u);
  assert.doesNotMatch(caption, /Sources:/u);
  assert.doesNotMatch(caption, /[\u2013\u2014]/u);
  assert.match(caption, /#OpeningsDev/u);
  const multiSourceContent = EDITORIAL_CATALOG.find(({ sources }) => sources.length > 1);
  assert.match(formatEditorialCaption(multiSourceContent), /Sources:/u);
  const directory = await mkdtemp(join(tmpdir(), 'openings-editorial-'));
  const wordmarkPath = join(directory, 'wordmark.svg');
  await writeFile(wordmarkPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>');
  try {
    const result = await renderEditorialDryRun({
      content,
      wordmarkPath,
      outputPath: directory,
      log: () => {},
    });
    assert.equal(result.files.length, 10);
    const names = await readdir(join(directory, 'editorial', content.id));
    assert.deepEqual(names.sort(), [
      'caption.txt', 'manifest.json', 'slide-01.jpg', 'slide-02.jpg', 'slide-03.jpg',
      'slide-04.jpg', 'slide-05.jpg', 'slide-06.jpg', 'slide-07.jpg', 'story.jpg',
    ]);
    const manifest = JSON.parse(await readFile(join(directory, 'editorial', content.id, 'manifest.json'), 'utf8'));
    assert.equal(manifest.contentId, content.id);
    assert.equal(manifest.slides.length, 7);
    assert.equal(typeof manifest.story.sha256, 'string');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

validation('builds a bounded editorial deployment request with eight canonical SVG assets', () => {
  const content = EDITORIAL_CATALOG[0];
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const carouselSvgs = content.slides.map((_, index) => createEditorialSlideSvg(content, index, { wordmarkSvg }));
  const storySvg = createEditorialStorySvg(content, { wordmarkSvg });
  const request = buildEditorialDispatchRequest({
    contentId: content.id,
    version: content.version,
    carouselSvgs,
    storySvg,
    repository: 'openings-dev/web-deploy',
  });
  const body = JSON.parse(request.body);
  assert.equal(body.event_type, 'publish_instagram_editorial');
  assert.equal(body.client_payload.assets.length, 8);
  assert.deepEqual(body.client_payload.assets.map(({ name }) => name), [
    'slide-01', 'slide-02', 'slide-03', 'slide-04', 'slide-05', 'slide-06', 'slide-07', 'story',
  ]);
  for (const [index, asset] of body.client_payload.assets.entries()) {
    const source = index < 7 ? carouselSvgs[index] : storySvg;
    assert.equal(asset.sha256, sha256(source));
    assert.equal(gunzipSync(Buffer.from(asset.svg_gzip_base64, 'base64')).toString('utf8'), source);
  }
  for (const catalogContent of EDITORIAL_CATALOG) {
    const catalogSlides = catalogContent.slides.map((_, index) => createEditorialSlideSvg(catalogContent, index, { wordmarkSvg }));
    const catalogStory = createEditorialStorySvg(catalogContent, { wordmarkSvg });
    const catalogRequest = buildEditorialDispatchRequest({
      contentId: catalogContent.id,
      version: catalogContent.version,
      carouselSvgs: catalogSlides,
      storySvg: catalogStory,
      repository: 'openings-dev/web-deploy',
    });
    assert.ok(catalogRequest.body.length <= MAX_REPOSITORY_DISPATCH_BODY_CHARACTERS);
  }
  assert.throws(() => buildEditorialDispatchRequest({
    contentId: '../escape', version: '1', carouselSvgs, storySvg, repository: 'openings-dev/web-deploy',
  }), /content ID/i);
  for (const unsafe of [
    '<image href="file:///etc/passwd"/>',
    '<image href="//example.com/tracker.svg"/>',
    '<rect style="fill:url(ftp://example.com/pixel.svg)"/>',
  ]) {
    const unsafeSlides = [...carouselSvgs];
    unsafeSlides[0] = unsafeSlides[0].replace('</svg>', `${unsafe}</svg>`);
    assert.throws(() => buildEditorialDispatchRequest({
      contentId: content.id,
      version: content.version,
      carouselSvgs: unsafeSlides,
      storySvg,
      repository: 'openings-dev/web-deploy',
    }), /unsupported SVG/u);
  }
});

validation('verifies every public editorial JPEG against its canonical manifest', async () => {
  const content = EDITORIAL_CATALOG[0];
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const rendered = await renderEditorialAssets(content, { wordmarkSvg });
  const sourceSvgs = content.slides.map((_, index) => createEditorialSlideSvg(content, index, { wordmarkSvg }));
  sourceSvgs.push(createEditorialStorySvg(content, { wordmarkSvg }));
  const names = [...content.slides.map((_, index) => `slide-${String(index + 1).padStart(2, '0')}`), 'story'];
  const buffers = [...rendered.slides, rendered.story];
  const manifest = {
    schemaVersion: 1,
    contentId: content.id,
    contentVersion: content.version,
    assets: names.map((name, index) => ({
      name,
      path: `${name}.jpg`,
      sourceSha256: sha256(sourceSvgs[index]),
      sha256: sha256(buffers[index]),
      width: 1080,
      height: name === 'story' ? 1920 : 1350,
    })),
  };
  const base = `https://openings.dev/social/editorial/${content.id}/${content.version}`;
  const result = await verifyPublicEditorial({
    contentId: content.id,
    version: content.version,
    expectedSourceHashes: Object.fromEntries(manifest.assets.map(({ name, sourceSha256 }) => [name, sourceSha256])),
    fetchImpl: async (url) => {
      if (url === `${base}/manifest.json`) return new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } });
      const index = manifest.assets.findIndex(({ path }) => url === `${base}/${path}`);
      return index >= 0
        ? new Response(buffers[index], { headers: { 'content-type': 'image/jpeg' } })
        : new Response('missing', { status: 404 });
    },
  });
  assert.equal(result.matches, true);
  assert.equal(result.carouselUrls.length, 7);
  assert.equal(result.storyUrl, `${base}/story.jpg`);
});

validation('orchestrates editorial assets, feed, and Story as durable independent stages', async () => {
  const monday = '2026-09-07T15:17:00.000Z';
  let state = enqueueScheduledEditorial({
    state: createEmptyEditorialState(), catalog: EDITORIAL_CATALOG, now: monday,
  });
  const contentId = state.pending[0].contentId;
  const calls = [];
  state = (await processEditorialStage({
    state, catalog: EDITORIAL_CATALOG, stage: 'assets', now: monday,
    wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
    deployAssets: async ({ carouselSvgs, storySvg }) => {
      calls.push('assets');
      assert.equal(carouselSvgs.length, 7);
      assert.match(storySvg, /height="1920"/u);
      return { status: 'deployed', verification: {
        manifestUrl: 'https://openings.dev/social/editorial/manifest.json',
        carouselUrls: Array.from({ length: 7 }, (_, index) => `https://openings.dev/social/editorial/slide-0${index + 1}.jpg`),
        storyUrl: 'https://openings.dev/social/editorial/story.jpg',
      } };
    },
  })).state;
  assert.equal(state.pending[0].assets.status, 'published');
  assert.equal(state.pending[0].feed.status, 'pending');
  state = (await processEditorialStage({
    state, catalog: EDITORIAL_CATALOG, stage: 'feed', now: monday,
    publishCarousel: async ({ imageUrls, caption, reconciliationMarker }) => {
      calls.push('feed');
      assert.equal(imageUrls.length, 7);
      assert.ok(caption.includes(reconciliationMarker));
      return { status: 'published', id: 'carousel-media', url: 'https://instagram.com/p/carousel' };
    },
  })).state;
  assert.equal(state.pending[0].feed.result.id, 'carousel-media');
  assert.equal(state.pending[0].story.status, 'pending');
  const preparedStory = prepareEditorialStageIntent({
    state, catalog: EDITORIAL_CATALOG, stage: 'story', operationKey: 'editorial-test-1', now: monday,
  });
  assert.equal(preparedStory.outcome, 'prepared');
  state = preparedStory.state;
  state = (await processEditorialStage({
    state, catalog: EDITORIAL_CATALOG, stage: 'story', now: monday,
    operationKey: 'editorial-test-1',
    publishStory: async ({ mediaUrl, mediaKind }) => {
      calls.push('story');
      assert.equal(mediaUrl, 'https://openings.dev/social/editorial/story.jpg');
      assert.equal(mediaKind, 'image');
      return { status: 'published', id: 'story-media', url: null };
    },
  })).state;
  assert.deepEqual(calls, ['assets', 'feed', 'story']);
  assert.equal(state.pending.length, 0);
  assert.equal(state.history[contentId].cycles, 1);
  assert.equal(state.history[contentId].lastPublication.feed.id, 'carousel-media');
  assert.equal(state.history[contentId].lastPublication.story.id, 'story-media');
});

validation('fails closed when an editorial Story is ambiguous and enforces the manual gate', async () => {
  assert.deepEqual(parseEditorialRequest({
    mode: 'controlled', contentId: 'linkedin-headline-clara', confirmation: 'PUBLISH_ONE_EDITORIAL_POST',
  }), { mode: 'controlled', contentId: 'linkedin-headline-clara', stage: null });
  assert.throws(() => parseEditorialRequest({
    mode: 'controlled', contentId: 'linkedin-headline-clara', confirmation: 'publish',
  }), /exact confirmation/i);

  const now = '2026-09-07T15:17:00.000Z';
  const selection = selectEditorialItem({ catalog: EDITORIAL_CATALOG, state: createEmptyEditorialState(), now });
  let state = enqueueEditorialItem(createEmptyEditorialState(), selection, { at: now });
  assert.throws(() => enqueueScheduledEditorial({
    state,
    catalog: EDITORIAL_CATALOG,
    now,
    contentId: 'linkedin-headline-clara' === selection.content.id
      ? 'linkedin-idioma-do-perfil'
      : 'linkedin-headline-clara',
  }), /already pending/i);
  let called = false;
  const blocked = await processEditorialStage({
    state, catalog: EDITORIAL_CATALOG, stage: 'story', now,
    publishStory: async () => { called = true; },
  });
  assert.equal(blocked.outcome, 'blocked');
  assert.equal(called, false);
  state = transitionEditorialStage(state, selection.content.id, 'assets', 'publishing', { at: now });
  state = transitionEditorialStage(state, selection.content.id, 'assets', 'published', {
    at: now, result: { carouselUrls: Array(7).fill('https://openings.dev/slide.jpg'), storyUrl: 'https://openings.dev/story.jpg' },
  });
  state = transitionEditorialStage(state, selection.content.id, 'feed', 'publishing', { at: now });
  state = transitionEditorialStage(state, selection.content.id, 'feed', 'published', { at: now, result: { id: 'feed' } });
  const prepared = prepareEditorialStageIntent({
    state,
    catalog: EDITORIAL_CATALOG,
    stage: 'story',
    operationKey: 'editorial-test-2',
    now,
  });
  state = prepared.state;
  const error = new Error('ambiguous');
  error.code = 'instagram_story_ambiguous';
  const failed = await processEditorialStage({
    state, catalog: EDITORIAL_CATALOG, stage: 'story', now,
    operationKey: 'editorial-test-2',
    publishStory: async () => { throw error; },
  });
  assert.equal(failed.outcome, 'failed_manual_review');
  assert.equal(failed.state.pending[0].story.status, 'failed');
  assert.equal(failed.state.pending[0].feed.status, 'published');

  const interrupted = prepareEditorialStageIntent({
    state: prepared.state,
    catalog: EDITORIAL_CATALOG,
    stage: 'story',
    operationKey: 'editorial-restarted-run',
    now: '2026-09-07T15:18:00.000Z',
  });
  assert.equal(interrupted.outcome, 'failed_manual_review');
  assert.equal(interrupted.state.pending[0].story.lastError.code, 'instagram_story_interrupted');
});

validation('checkpoints the automated editorial workflow in dependency order', async () => {
  const workflow = await readFile(fileURLToPath(new URL('../../../.github/workflows/publish-editorial.yml', import.meta.url)), 'utf8');
  assert.match(workflow, /cron:\s*['"]17 15 \* \* 1,3,5['"]/u);
  assert.match(workflow, /INSTAGRAM_EDITORIAL_AUTO_PUBLISH/u);
  assert.match(workflow, /PUBLISH_ONE_EDITORIAL_POST/u);
  assert.match(workflow, /social-publisher-publication/u);
  assert.match(workflow, /fonts-noto-cjk/u);
  assert.match(workflow, /librsvg2-bin/u);
  assert.match(workflow, /npm ci/u);
  const order = [
    'Enqueue one editorial guide',
    'Commit editorial intent',
    'Deploy editorial assets',
    'Commit editorial asset result',
    'Publish editorial carousel',
    'Commit editorial feed result',
    'Prepare editorial Story intent',
    'Commit editorial Story intent',
    'Publish editorial Story',
    'Commit editorial Story result',
  ];
  order.reduce((previous, label) => {
    const index = workflow.indexOf(label);
    assert.ok(index > previous, `${label} must follow its durable prerequisite`);
    return index;
  }, -1);
  assert.doesNotMatch(workflow, /^\s{2}(?:push|pull_request):/mu);
});

let passed = 0;

for (const { name, run } of validations) {
  try {
    await run();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

console.log(`Validated ${passed} deterministic contracts.`);
