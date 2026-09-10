import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildRuntimeMetadata } from '../src/cli/mask-workflow-runtime.mjs';

const repositoryRoot = new URL('../', import.meta.url);
const socialWorkflow = readFileSync(new URL('.github/workflows/publish-social.yml', repositoryRoot), 'utf8');
const editorialWorkflow = readFileSync(new URL('.github/workflows/publish-editorial.yml', repositoryRoot), 'utf8');
const readme = readFileSync(new URL('README.md', repositoryRoot), 'utf8');

function jobEnvironment(workflow) {
  return workflow.match(/^    env:\n(?<block>[\s\S]*?)(?=^    steps:)/mu)?.groups?.block ?? '';
}

function step(workflow, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return workflow.match(new RegExp(`^      - name: ${escaped}(?<block>[\\s\\S]*?)(?=^      - name:|(?![\\s\\S]))`, 'mu'))?.groups?.block ?? '';
}

test('moves workflow configuration to individually masked secrets without public defaults', () => {
  const socialEnv = jobEnvironment(socialWorkflow);
  const editorialEnv = jobEnvironment(editorialWorkflow);
  const socialNames = [
    'DATA_PATH', 'WEB_PATH', 'PUBLIC_SITE_ORIGIN', 'WEB_DEPLOY_REPOSITORY',
    'BLUESKY_SERVICE_URL', 'MASTODON_BASE_URL', 'THREADS_API_URL',
    'INSTAGRAM_API_ORIGIN', 'META_GRAPH_VERSION', 'INSTAGRAM_USER_ID',
    'LINKEDIN_API_ORIGIN', 'LINKEDIN_API_VERSION', 'LINKEDIN_ORGANIZATION_ID',
    'LINKEDIN_PROVIDER', 'BUFFER_API_ORIGIN', 'BUFFER_ORGANIZATION_ID',
    'BUFFER_LINKEDIN_CHANNEL_ID', 'BUFFER_TWITTER_CHANNEL_ID', 'SOCIAL_AUTO_PUBLISH',
    'PUBLISHING_SOCIAL_SHADOW_ENABLED', 'PUBLISHING_MASTODON_ENABLED',
    'PUBLISHING_ENDPOINT', 'PUBLISHING_CLIENT_ID',
  ];
  for (const name of socialNames) {
    assert.match(socialEnv, new RegExp(`^      ${name}: \\$\\{\\{ secrets\\.${name} \\}\\}$`, 'mu'));
  }
  for (const name of ['WEB_PATH', 'OPENINGS_R2_ENABLED', 'OPENINGS_R2_ACCOUNT_ID', 'OPENINGS_R2_BUCKET',
    'OPENINGS_R2_BUCKET_PURPOSE', 'OPENINGS_R2_PUBLIC_ORIGIN',
    'INSTAGRAM_API_ORIGIN', 'META_GRAPH_VERSION', 'INSTAGRAM_USER_ID']) {
    assert.match(editorialEnv, new RegExp(`^      ${name}: \\$\\{\\{ secrets\\.${name} \\}\\}$`, 'mu'));
  }
  assert.match(step(socialWorkflow, 'Decide whether scheduled work exists'), /DATA_MANIFEST_URL: \$\{\{ secrets\.DATA_MANIFEST_URL \}\}/u);
  assert.doesNotMatch(socialWorkflow, /vars\./u);
  assert.doesNotMatch(editorialWorkflow.replace("if: github.event_name == 'workflow_dispatch' || vars.INSTAGRAM_EDITORIAL_AUTO_PUBLISH == 'true'", ''), /vars\./u);
  assert.doesNotMatch(`${socialEnv}\n${editorialEnv}`, /https?:\/\//u);
  assert.doesNotMatch(`${socialEnv}\n${editorialEnv}`, /\|\| '(?:false|direct)'/u);
});

test('scopes editorial R2 writes to the asset step and retires web deployment', () => {
  const editorialEnv = jobEnvironment(editorialWorkflow);
  const assets = step(editorialWorkflow, 'Publish editorial assets to R2');
  for (const name of ['OPENINGS_R2_ACCESS_KEY_ID', 'OPENINGS_R2_SECRET_ACCESS_KEY']) {
    assert.equal([...editorialWorkflow.matchAll(new RegExp(`${name}:`, 'gu'))].length, 1);
    assert.match(assets, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`, 'u'));
    assert.doesNotMatch(editorialEnv, new RegExp(name, 'u'));
  }
  assert.doesNotMatch(editorialWorkflow, /WEB_DEPLOY_TOKEN|WEB_DEPLOY_REPOSITORY/u);
  assert.doesNotMatch(editorialWorkflow, /OPENINGS_R2_CAPACITY_JSON/u);
  assert.doesNotMatch(step(editorialWorkflow, 'Publish editorial carousel'), /OPENINGS_R2_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/u);
  assert.doesNotMatch(step(editorialWorkflow, 'Publish editorial Story'), /OPENINGS_R2_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/u);
});

test('preserves manual overrides, triggers, concurrency, and the editorial job gate', () => {
  for (const name of ['THREADS_AUTO_PUBLISH', 'INSTAGRAM_AUTO_PUBLISH', 'INSTAGRAM_STORY_AUTO_PUBLISH']) {
    assert.match(socialWorkflow, new RegExp(`github\\.event_name == 'workflow_dispatch' && inputs\\.mode == 'controlled' && inputs\\.publish_meta\\) && 'true' \\|\\| secrets\\.${name}`, 'u'));
  }
  assert.match(socialWorkflow, /github\.event_name == 'workflow_dispatch' && inputs\.mode == 'controlled' && inputs\.publish_linkedin\) && 'true' \|\| secrets\.LINKEDIN_AUTO_PUBLISH/u);
  assert.match(editorialWorkflow, /^    if: github\.event_name == 'workflow_dispatch' \|\| vars\.INSTAGRAM_EDITORIAL_AUTO_PUBLISH == 'true'$/mu);
  assert.match(editorialWorkflow, /cron: '0 15 \* \* 2,4'/u);
  assert.match(editorialWorkflow, /inputs\.mode == 'controlled'\) && 'true' \|\| secrets\.INSTAGRAM_EDITORIAL_AUTO_PUBLISH/u);
  for (const workflow of [socialWorkflow, editorialWorkflow]) {
    assert.match(workflow, /schedule:/u);
    assert.match(workflow, /workflow_dispatch:/u);
    assert.match(workflow, /group: social-publisher-publication/u);
    assert.match(workflow, /cancel-in-progress: false/u);
  }
  assert.match(socialWorkflow, /repository_dispatch:\s*\n\s*types:\s*\[openings_source_committed_v1\]/u);
  assert.match(step(socialWorkflow, 'Check out immutable data history'), /ref: \$\{\{ env\.SOURCE_EVENT_COMMIT \|\| 'main' \}\}/u);
});

test('documents fixed workflow configuration as individually named repository secrets', () => {
  const configuration = readme.match(/^## Configuration\n(?<block>[\s\S]*?)(?=^## Rollout)/mu)?.groups?.block ?? '';
  assert.match(configuration, /individual repository secrets/u);
  assert.doesNotMatch(configuration, /Repository variables:/u);
  for (const name of ['DATA_PATH', 'WEB_PATH', 'DATA_MANIFEST_URL', 'PUBLIC_SITE_ORIGIN', 'PUBLISHING_CLIENT_ID']) {
    assert.match(configuration, new RegExp(`\\b${name}\\b`, 'u'));
  }
  assert.match(configuration, /INSTAGRAM_EDITORIAL_AUTO_PUBLISH[\s\S]{0,120}job-level gate[\s\S]{0,120}mirrors[\s\S]{0,120}secret/iu);
  assert.doesNotMatch(configuration, /(?:PUBLIC_SITE_ORIGIN|DATA_PATH|WEB_PATH|DATA_MANIFEST_URL|PUBLISHING_CLIENT_ID)\s*=\s*\S+/u);
});

test('bootstraps masked runtime metadata after checkout and before conditional work', () => {
  for (const [workflow, kind, nextStep] of [
    [socialWorkflow, 'social', 'Decide whether scheduled work exists'],
    [editorialWorkflow, 'editorial', 'Check out the canonical openings.dev wordmark'],
  ]) {
    const checkout = workflow.indexOf('Check out social-publisher state and source');
    const bootstrap = workflow.indexOf(`node src/cli/mask-workflow-runtime.mjs --kind ${kind}`);
    assert.ok(checkout >= 0 && checkout < bootstrap);
    assert.ok(bootstrap < workflow.indexOf(nextStep));
    assert.doesNotMatch(jobEnvironment(workflow), /(?:RUN_MODE|STORY_OPERATION_KEY|EDITORIAL_OPERATION_KEY):/u);
  }
});

test('installs locked dependencies before the preflight imports state validators', () => {
  const setup = socialWorkflow.indexOf('Use Node.js 20');
  const install = socialWorkflow.indexOf('Install exact dependencies');
  const preflight = socialWorkflow.indexOf('Decide whether scheduled work exists');
  assert.ok(setup >= 0 && setup < install && install < preflight);
  assert.doesNotMatch(step(socialWorkflow, 'Use Node.js 20'), /if: steps\.preflight/u);
  assert.doesNotMatch(step(socialWorkflow, 'Install exact dependencies'), /if: steps\.preflight/u);
});

test('scopes the platform client secret only to platform web transport steps', () => {
  const permitted = [
    'Publish at most one queued job',
    'Replace legacy Instagram and Threads publications',
    'Process and checkpoint bounded snapshot intake',
  ];
  assert.equal([...socialWorkflow.matchAll(/PUBLISHING_CLIENT_SECRET:/gu)].length, permitted.length);
  for (const name of permitted) {
    assert.match(step(socialWorkflow, name), /PUBLISHING_CLIENT_SECRET: \$\{\{ secrets\.PUBLISHING_CLIENT_SECRET \}\}/u);
  }
  assert.doesNotMatch(jobEnvironment(socialWorkflow), /PUBLISHING_CLIENT_SECRET/u);
  assert.doesNotMatch(step(socialWorkflow, 'Render a review artifact without external writes'), /PUBLISHING_CLIENT_SECRET/u);
});

test('scopes direct R2 credentials to publication while intake transfers ownership only', () => {
  const socialEnv = jobEnvironment(socialWorkflow);
  for (const name of ['OPENINGS_R2_ENABLED', 'OPENINGS_R2_ACCOUNT_ID', 'OPENINGS_R2_BUCKET',
    'OPENINGS_R2_BUCKET_PURPOSE', 'OPENINGS_R2_PUBLIC_ORIGIN', 'OPENINGS_R2_CAPACITY_JSON']) {
    assert.match(socialEnv, new RegExp(`^      ${name}: \\$\\{\\{ secrets\\.${name} \\}\\}$`, 'mu'));
  }
  const publisher = step(socialWorkflow, 'Publish at most one queued job');
  const intake = step(socialWorkflow, 'Process and checkpoint bounded snapshot intake');
  for (const name of ['OPENINGS_R2_ACCESS_KEY_ID', 'OPENINGS_R2_SECRET_ACCESS_KEY']) {
    assert.equal([...socialWorkflow.matchAll(new RegExp(`${name}:`, 'gu'))].length, 1);
    assert.match(publisher, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`, 'u'));
    assert.doesNotMatch(socialEnv, new RegExp(name, 'u'));
    assert.doesNotMatch(intake, new RegExp(name, 'u'));
  }
  assert.match(intake, /--strategy selected-media-owner/u);
  assert.match(intake, /--max-queue-additions 25/u);
  assert.doesNotMatch(step(socialWorkflow, 'Preserve deferred platform handoff and source media'),
    /instagram-image\.jpg|social-video\.mp4|openings\/jobs/u);
});

test('builds exact runtime metadata for every supported event and mode', () => {
  const cases = [
    ['social', 'schedule', {}, 'scheduled', 'STORY_OPERATION_KEY', 'job-story-41-2'],
    ['social', 'repository_dispatch', { action: 'openings_source_committed_v1', client_payload: {
      schema_version: 1,
      source_repository: 'openings-dev/data-pipeline',
      source_commit: 'a'.repeat(40),
      previous_commit: 'b'.repeat(40),
      data_hash: 'c'.repeat(64),
      event_id: `openings:data:${'a'.repeat(40)}`,
    } }, 'scheduled', 'STORY_OPERATION_KEY', 'job-story-41-2'],
    ['social', 'workflow_dispatch', { inputs: { mode: 'dry-run' } }, 'dry-run', 'STORY_OPERATION_KEY', 'job-story-41-2'],
    ['social', 'workflow_dispatch', { inputs: { mode: 'controlled' } }, 'controlled', 'STORY_OPERATION_KEY', 'job-story-41-2'],
    ['social', 'workflow_dispatch', { inputs: { mode: 'migrate-meta' } }, 'migrate-meta', 'STORY_OPERATION_KEY', 'job-story-41-2'],
    ['social', 'workflow_dispatch', { inputs: { mode: 'retry-stage' } }, 'retry-stage', 'STORY_OPERATION_KEY', 'job-story-41-2'],
    ['social', 'workflow_dispatch', { inputs: { mode: 'scheduled' } }, 'scheduled', 'STORY_OPERATION_KEY', 'job-story-41-2'],
    ['editorial', 'schedule', {}, 'scheduled', 'EDITORIAL_OPERATION_KEY', 'editorial-41-2'],
    ['editorial', 'workflow_dispatch', { inputs: { mode: 'dry-run' } }, 'dry-run', 'EDITORIAL_OPERATION_KEY', 'editorial-41-2'],
    ['editorial', 'workflow_dispatch', { inputs: { mode: 'controlled' } }, 'controlled', 'EDITORIAL_OPERATION_KEY', 'editorial-41-2'],
  ];
  for (const [kind, eventName, event, mode, operationName, operationValue] of cases) {
    const expected = {
      RUN_MODE: mode,
      [operationName]: operationValue,
    };
    if (eventName === 'repository_dispatch') {
      expected.SOURCE_EVENT_COMMIT = 'a'.repeat(40);
      expected.SOURCE_EVENT_DATA_HASH = 'c'.repeat(64);
    }
    assert.deepEqual(buildRuntimeMetadata({ kind, eventName, event, runId: '41', runAttempt: '2' }), expected);
  }
});

test('rejects malformed or forged source repository dispatch events', () => {
  const payload = {
    schema_version: 1,
    source_repository: 'openings-dev/data-pipeline',
    source_commit: 'a'.repeat(40),
    previous_commit: 'b'.repeat(40),
    data_hash: 'c'.repeat(64),
    event_id: `openings:data:${'a'.repeat(40)}`,
  };
  const valid = { kind: 'social', eventName: 'repository_dispatch', event: {
    action: 'openings_source_committed_v1', client_payload: payload,
  }, runId: '41', runAttempt: '2' };
  for (const event of [
    {},
    { action: 'wrong', client_payload: payload },
    { action: 'openings_source_committed_v1', client_payload: { ...payload, extra: true } },
    { action: 'openings_source_committed_v1', client_payload: { ...payload, source_repository: 'attacker/repo' } },
    { action: 'openings_source_committed_v1', client_payload: { ...payload, source_commit: 'not-a-sha' } },
    { action: 'openings_source_committed_v1', client_payload: { ...payload, event_id: 'openings:data:wrong' } },
  ]) {
    assert.throws(() => buildRuntimeMetadata({ ...valid, event }), /invalid workflow runtime metadata/u);
  }
  assert.throws(() => buildRuntimeMetadata({ ...valid, kind: 'editorial' }), /invalid workflow runtime metadata/u);
});

test('rejects missing, unsupported, multiline, and shell-shaped runtime input', () => {
  const valid = { kind: 'social', eventName: 'workflow_dispatch', event: { inputs: { mode: 'dry-run' } }, runId: '41', runAttempt: '2' };
  for (const change of [
    { kind: undefined }, { kind: 'other' }, { eventName: undefined }, { eventName: 'push' },
    { event: {} }, { event: { inputs: { mode: 'dry-run\nINJECTED=value' } } },
    { event: { inputs: { mode: '$(touch bad)' } } }, { runId: '' }, { runId: '0' },
    { runId: '41\nEVIL=1' }, { runAttempt: '0' }, { runAttempt: '2; echo bad' },
    { kind: 'editorial', event: { inputs: { mode: 'scheduled' } } },
  ]) {
    assert.throws(() => buildRuntimeMetadata({ ...valid, ...change }), /invalid workflow runtime metadata/u);
  }
});

test('CLI masks both values before appending exact exports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-runtime-'));
  try {
    const eventPath = join(directory, 'event.json');
    const envPath = join(directory, 'github-env');
    writeFileSync(eventPath, JSON.stringify({ inputs: { mode: 'controlled' } }));
    writeFileSync(envPath, 'EXISTING=value\n');
    const result = spawnSync(process.execPath, ['src/cli/mask-workflow-runtime.mjs', '--kind', 'social'], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: eventPath, GITHUB_RUN_ID: '41', GITHUB_RUN_ATTEMPT: '2', GITHUB_ENV: envPath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '::add-mask::controlled\n::add-mask::job-story-41-2\n');
    assert.equal(readFileSync(envPath, 'utf8'), 'EXISTING=value\nRUN_MODE=controlled\nSTORY_OPERATION_KEY=job-story-41-2\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid CLI input emits no workflow commands and does not write the environment file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-runtime-invalid-'));
  try {
    const eventPath = join(directory, 'event.json');
    const envPath = join(directory, 'github-env');
    writeFileSync(eventPath, JSON.stringify({ inputs: { mode: '$(echo bad)' } }));
    writeFileSync(envPath, 'UNCHANGED=yes\n');
    const result = spawnSync(process.execPath, ['src/cli/mask-workflow-runtime.mjs', '--kind', 'social'], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: eventPath, GITHUB_RUN_ID: '41', GITHUB_RUN_ATTEMPT: '2', GITHUB_ENV: envPath },
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(readFileSync(envPath, 'utf8'), 'UNCHANGED=yes\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the normal platform suite explicitly discovers this regression test', () => {
  const packageJson = JSON.parse(readFileSync(new URL('package.json', repositoryRoot), 'utf8'));
  assert.match(packageJson.scripts['test:platform'], /test\/workflow-secrets\.test\.mjs/u);
});
