# LinkedIn Organization Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish genuinely new openings.dev jobs as duplicate-safe organic article posts on the official openings.dev LinkedIn Page.

**Architecture:** Add LinkedIn as an opt-in queue channel, backed by a focused REST client that reconciles recent organization posts, uploads the existing Open Graph PNG, waits for the image, and creates an article post. Reuse the generic stage orchestration and migrate tracked state so historical jobs are permanently skipped while new jobs can be enabled through an independent flag.

**Tech Stack:** Node.js 20 ESM, native `fetch`, Sharp through the existing social-card renderer, GitHub Actions, JSON tracked state, deterministic validation in `src/modules/validation/run-validation.mjs`.

---

## File map

- Create `src/modules/networks/linkedin-client.mjs`: validate LinkedIn configuration, reconcile posts, upload and poll images, create article posts, normalize durable results.
- Create `src/modules/state/linkedin-state-migration.mjs`: pure version-2-to-version-3 state migration.
- Create `src/cli/migrate-linkedin-state.mjs`: apply the state migration atomically to tracked files after an exact confirmation.
- Modify `src/config/constants.mjs`: register the channel, API origin, and schema version.
- Modify `src/config/env.mjs`: independently gate and validate LinkedIn credentials.
- Modify `src/modules/publishing/orchestrator.mjs`: publish and persist the LinkedIn stage.
- Modify `src/cli/publish.mjs`: construct the client, render its PNG, expose summary and retry support.
- Modify `src/modules/validation/run-validation.mjs`: add test-first contracts for configuration, migration, HTTP behavior, orchestration, workflow, and documentation.
- Modify `.github/workflows/publish-social.yml`: expose independent controlled and scheduled LinkedIn configuration.
- Modify `README.md`: document behavior, variables, secrets, permissions, and rollout.
- Modify `package.json`: expose the guarded state migration command.
- Modify `state/intake.json`, `state/queue.json`, and `state/publications.json`: move to the new schema with no historical LinkedIn backfill.

### Task 1: Add the channel contract, configuration, and state migration

**Files:**

- Create: `src/modules/state/linkedin-state-migration.mjs`
- Create: `src/cli/migrate-linkedin-state.mjs`
- Modify: `src/config/constants.mjs`
- Modify: `src/config/env.mjs`
- Modify: `src/modules/validation/run-validation.mjs`
- Modify: `package.json`
- Modify: `state/intake.json`
- Modify: `state/queue.json`
- Modify: `state/publications.json`

- [ ] **Step 1: Write failing configuration and migration validations**

Add `SOCIAL_CHANNELS` and `LINKEDIN_API_ORIGIN` to the constants import, import `migrateLinkedInState`, update the immutable schema assertion to `3`, and add these validations to `run-validation.mjs`:

```js
validation('enables LinkedIn independently with bounded organization configuration', () => {
  const base = {
    SOCIAL_AUTO_PUBLISH: 'true',
    WEB_DEPLOY_TOKEN: 'github-fine-grained-token',
    BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
    BLUESKY_APP_PASSWORD: 'app-secret',
    MASTODON_ACCESS_TOKEN: 'mastodon-secret',
  };
  const disabled = readEnvironment({ env: base, mode: 'scheduled' });
  assert.equal(disabled.linkedin, null);
  assert.deepEqual(disabled.enabledChannels, ['bluesky', 'mastodon']);

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
  assert.deepEqual(enabled.enabledChannels, ['bluesky', 'mastodon', 'linkedin']);
  assert.deepEqual(enabled.linkedin, {
    accessToken: 'linkedin-secret',
    organizationId: '108765432',
    organizationUrn: 'urn:li:organization:108765432',
    apiVersion: '202608',
    apiOrigin: LINKEDIN_API_ORIGIN,
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

validation('migrates LinkedIn state without reopening historical jobs', () => {
  const job = makeJob();
  const migrated = migrateLinkedInState({
    intakeState: { schemaVersion: 2, processedSnapshot: null, pendingBridges: [], removedJobs: [] },
    queueState: makeVersionTwoQueueFixture(job),
    publicationsState: {
      schemaVersion: 2,
      jobs: { [job.id]: { status: 'completed', completedAt: '2026-08-20T14:00:00.000Z' } },
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
```

Define `makeVersionTwoQueueFixture` beside `makeJob` as one complete version-2 queue item with bridge, Bluesky, Mastodon, Threads, and Instagram stages but no LinkedIn stage. Do not use production `enqueueJob`, because it will create version-3 state.

- [ ] **Step 2: Run validation and verify the expected red state**

Run `npm run validate`.

Expected: failure because `migrateLinkedInState`, `LINKEDIN_API_ORIGIN`, and the version-3 channel/configuration do not exist.

- [ ] **Step 3: Implement constants, environment validation, and the pure migration**

Change the relevant constants to:

```js
export const STATE_SCHEMA_VERSION = 3;
export const LINKEDIN_API_ORIGIN = 'https://api.linkedin.com';
export const SOCIAL_CHANNELS = Object.freeze(['bluesky', 'mastodon', 'threads', 'instagram', 'linkedin']);
export const DEFAULT_SOCIAL_CHANNELS = Object.freeze(['bluesky', 'mastodon']);
```

In `env.mjs`, add LinkedIn to `enabledChannels` only for exact `true`, require the three LinkedIn values only when the channel is enabled for a social-capable mode, validate organization ID with `/^[1-9][0-9]{0,19}$/u`, validate the API version with `/^20[0-9]{4}$/u`, and return:

```js
linkedin: requiresSocial && linkedinEnabled ? Object.freeze({
  accessToken: env.LINKEDIN_ACCESS_TOKEN,
  organizationId: env.LINKEDIN_ORGANIZATION_ID,
  organizationUrn: `urn:li:organization:${env.LINKEDIN_ORGANIZATION_ID}`,
  apiVersion: env.LINKEDIN_API_VERSION,
  apiOrigin: normalizeOrigin(
    env.LINKEDIN_API_ORIGIN,
    LINKEDIN_API_ORIGIN,
    'LINKEDIN_API_ORIGIN',
  ),
}) : null,
```

Create `linkedin-state-migration.mjs` as:

```js
import { STATE_SCHEMA_VERSION } from '../../config/constants.mjs';

function historicalStage(at) {
  return {
    status: 'skipped_before_activation',
    attempts: 0,
    updatedAt: at,
    lastError: null,
    lastReset: null,
    result: null,
  };
}

function assertVersionTwo(value, label) {
  if (!value || value.schemaVersion !== 2) {
    throw new Error(`${label} must use schemaVersion 2`);
  }
}

export function migrateLinkedInState({ intakeState, queueState, publicationsState, at }) {
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
    throw new Error('LinkedIn activation timestamp must be an ISO date');
  }
  assertVersionTwo(intakeState, 'intake state');
  assertVersionTwo(queueState, 'queue state');
  assertVersionTwo(publicationsState, 'publications state');
  if (!Array.isArray(queueState.items) || !publicationsState.jobs
    || typeof publicationsState.jobs !== 'object' || Array.isArray(publicationsState.jobs)) {
    throw new Error('LinkedIn state migration input is invalid');
  }
  return {
    intakeState: { ...intakeState, schemaVersion: STATE_SCHEMA_VERSION },
    queueState: {
      ...queueState,
      schemaVersion: STATE_SCHEMA_VERSION,
      items: queueState.items.map((item) => ({ ...item, linkedin: historicalStage(at) })),
    },
    publicationsState: {
      ...publicationsState,
      schemaVersion: STATE_SCHEMA_VERSION,
      jobs: Object.fromEntries(Object.entries(publicationsState.jobs)
        .map(([jobId, publication]) => [jobId, { ...publication, linkedin: publication.linkedin ?? null }])),
    },
  };
}
```

Create a guarded migration CLI that accepts `--state`, `--at`, and exact `--confirmation MIGRATE_LINKEDIN_STATE`, reads the three raw JSON files, calls `migrateLinkedInState`, validates the outputs, and saves them with `saveStateFile`. Export `runLinkedInStateMigration` for validation. Add `"migrate:linkedin-state": "node src/cli/migrate-linkedin-state.mjs"` to the package scripts.

- [ ] **Step 4: Apply the tracked-state migration**

Run:

```sh
npm run migrate:linkedin-state -- --state state --at 2026-09-01T12:00:00.000Z --confirmation MIGRATE_LINKEDIN_STATE
```

Expected: all state files use version 3, every existing queue item has `skipped_before_activation`, and every completed publication has `linkedin: null`.

- [ ] **Step 5: Run validation and make state/configuration green**

Run `npm run validate` and update existing exact channel-array assertions to include `linkedin` only where it is enabled. Expected: all contracts pass.

- [ ] **Step 6: Commit the channel contract and migration**

```sh
git add package.json src/config/constants.mjs src/config/env.mjs \
  src/modules/state/linkedin-state-migration.mjs src/cli/migrate-linkedin-state.mjs \
  src/modules/validation/run-validation.mjs state/intake.json state/queue.json state/publications.json
git commit -m "feat: add LinkedIn channel state"
```

### Task 2: Implement the duplicate-safe LinkedIn REST client

**Files:**

- Create: `src/modules/networks/linkedin-client.mjs`
- Modify: `src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing client validations**

Import `publishToLinkedIn` and add focused tests with an injected `fetchImpl`. The primary test records every request and returns, in order: no recent posts, image initialization, binary upload, image `AVAILABLE`, and a `201` post response with `x-restli-id`.

Assert:

```js
assert.equal(result.status, 'published');
assert.equal(result.id, 'urn:li:share:123456789');
assert.equal(result.url, 'https://www.linkedin.com/feed/update/urn:li:share:123456789/');
assert.equal(JSON.parse(requests[1].options.body).initializeUploadRequest.owner,
  'urn:li:organization:108765432');
assert.equal(requests[2].options.method, 'PUT');
assert.equal(requests[2].options.headers['Content-Type'], 'image/png');
assert.deepEqual(JSON.parse(requests[4].options.body).content.article, {
  source: post.canonicalUrl,
  thumbnail: 'urn:li:image:fixture-image',
  title: job.title,
  description: opportunityDescription(job),
});
for (const request of requests.filter(({ url }) => url.startsWith('https://api.linkedin.com/'))) {
  assert.equal(request.options.headers['Linkedin-Version'], '202608');
  assert.equal(request.options.headers['X-Restli-Protocol-Version'], '2.0.0');
}
```

Add separate validations for immediate reconciliation, reconciliation after an ambiguous create error, `PROCESSING` before `AVAILABLE`, `PROCESSING_FAILED`, 401/403 categorization, and rejection of unsafe upload hosts, redirects, invalid content types, malformed URNs, missing `x-restli-id`, empty token, invalid organization ID, and invalid API version.

- [ ] **Step 2: Run validation and verify it fails because the client is absent**

Run `npm run validate`.

Expected: module import or export failure for `publishToLinkedIn`.

- [ ] **Step 3: Implement the minimal client**

Create `linkedin-client.mjs` with:

```js
export async function publishToLinkedIn({
  job,
  post,
  png,
  accessToken,
  organizationId,
  apiVersion,
  apiOrigin = LINKEDIN_API_ORIGIN,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  imagePollAttempts = 6,
  imagePollDelayMs = 2_000,
})
```

Implement focused helpers: configuration validation; required headers; bounded JSON requests; recent-post finder using `/rest/posts?author=<encoded>&q=author&count=100&sortBy=CREATED`; image initialization; safe HTTPS LinkedIn upload; Image API polling; article creation; and normalized Post URN/public URL output.

Use this exact article body:

```js
{
  author: organizationUrn,
  commentary: post.text,
  visibility: 'PUBLIC',
  distribution: {
    feedDistribution: 'MAIN_FEED',
    targetEntities: [],
    thirdPartyDistributionChannels: [],
  },
  content: {
    article: {
      source: post.canonicalUrl,
      thumbnail: imageUrn,
      title: job.title.trim(),
      description: opportunityDescription(job),
    },
  },
  lifecycleState: 'PUBLISHED',
  isReshareDisabledByAuthor: false,
}
```

On a create failure, call the recent-post finder exactly once more. Return only a proven exact canonical-URL match; otherwise throw `LinkedInPublicationError` with one bounded error code. Never expose response bodies, upload URLs, or access tokens.

- [ ] **Step 4: Run the complete client validation set**

Run `npm run validate`.

Expected: all LinkedIn and existing provider contracts pass without network access.

- [ ] **Step 5: Commit the client**

```sh
git add src/modules/networks/linkedin-client.mjs src/modules/validation/run-validation.mjs
git commit -m "feat: publish LinkedIn article posts"
```

### Task 3: Connect LinkedIn to orchestration and summaries

**Files:**

- Modify: `src/modules/publishing/orchestrator.mjs`
- Modify: `src/cli/publish.mjs`
- Modify: `src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing orchestration validations**

Add a LinkedIn-only queue validation:

```js
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
```

Add a second validation where Bluesky is already published, LinkedIn fails, and a later retry proves Bluesky is never invoked again. Extend manual request validation so `stage: 'linkedin'` is accepted.

- [ ] **Step 2: Run validation and verify the orchestration test fails**

Run `npm run validate`.

Expected: LinkedIn remains unavailable or is not persisted.

- [ ] **Step 3: Wire the orchestrator and CLI**

Add `linkedin: item.linkedin.result` to `completePublication`, add `publishLinkedIn` to `processOnePublication`, and extend the publisher map:

```js
const publishers = {
  bluesky: publishBluesky,
  mastodon: publishMastodon,
  threads: publishThreads,
  instagram: publishInstagram,
  linkedin: publishLinkedIn,
};
```

In `publish.mjs`, import `publishToLinkedIn`, construct the default publisher from `config.linkedin`, render the canonical PNG with `renderSocialCardPng(job, { wordmarkSvg })`, and pass the normalized configuration. Add:

```js
linkedin: selectedItem?.linkedin.status ?? null,
linkedinError: selectedItem?.linkedin.lastError?.code ?? null,
```

to the sanitized summary.

- [ ] **Step 4: Run validation and make orchestration green**

Run `npm run validate`.

Expected: LinkedIn-only completion, durable state, retry isolation, and all existing channels pass.

- [ ] **Step 5: Commit orchestration**

```sh
git add src/modules/publishing/orchestrator.mjs src/cli/publish.mjs \
  src/modules/validation/run-validation.mjs
git commit -m "feat: orchestrate LinkedIn publishing"
```

### Task 4: Add safe GitHub Actions rollout and documentation

**Files:**

- Modify: `.github/workflows/publish-social.yml`
- Modify: `README.md`
- Modify: `src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing workflow and README contracts**

Extend workflow validation to require:

```js
for (const pattern of [
  /publish_linkedin:/u,
  /LINKEDIN_AUTO_PUBLISH/u,
  /LINKEDIN_API_VERSION/u,
  /LINKEDIN_ORGANIZATION_ID/u,
  /LINKEDIN_ACCESS_TOKEN/u,
  /- linkedin/u,
]) {
  assert.match(productionWorkflow, pattern);
}
```

Read `README.md` in the same validation and require the Page, `w_organization_social`, `r_organization_social`, `LINKEDIN_AUTO_PUBLISH`, `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_ORGANIZATION_ID`, `LINKEDIN_API_VERSION`, `LINKEDIN_API_ORIGIN`, controlled rollout, token renewal, and no-backfill behavior.

- [ ] **Step 2: Run validation and verify the contracts fail**

Run `npm run validate`.

Expected: missing LinkedIn workflow and README assertions.

- [ ] **Step 3: Update the workflow**

Add boolean input `publish_linkedin`, add `linkedin` to retry-stage choices, and set:

```yaml
LINKEDIN_API_ORIGIN: ${{ vars.LINKEDIN_API_ORIGIN || 'https://api.linkedin.com' }}
LINKEDIN_API_VERSION: ${{ vars.LINKEDIN_API_VERSION }}
LINKEDIN_ORGANIZATION_ID: ${{ vars.LINKEDIN_ORGANIZATION_ID }}
LINKEDIN_AUTO_PUBLISH: ${{ (github.event_name == 'workflow_dispatch' && inputs.mode == 'controlled' && inputs.publish_linkedin) && 'true' || vars.LINKEDIN_AUTO_PUBLISH || 'false' }}
```

Expose `LINKEDIN_ACCESS_TOKEN: ${{ secrets.LINKEDIN_ACCESS_TOKEN }}` only in the provider publication step, never in validation, intake, dry-run, or pull-request contexts.

- [ ] **Step 4: Update README**

Document LinkedIn in the channel list and flow, explain the explicit article card, add variables/secrets/scopes, state that activation affects only future jobs, and describe controlled rollout plus manual token renewal.

- [ ] **Step 5: Run validation and inspect the workflow diff**

```sh
npm run validate
git diff --check
git diff -- .github/workflows/publish-social.yml README.md
```

Expected: validation passes, no whitespace errors, and the token appears only in the provider step.

- [ ] **Step 6: Commit workflow and docs**

```sh
git add .github/workflows/publish-social.yml README.md src/modules/validation/run-validation.mjs
git commit -m "docs: add LinkedIn rollout configuration"
```

### Task 5: Verify and review the complete feature

**Files:** Verify all modified files.

- [ ] **Step 1: Run deterministic validation**

Run `npm run validate`.

Expected: every contract passes without credentials or network access.

- [ ] **Step 2: Render the unchanged visual artifact**

```sh
npm run dry-run -- --fixture assets/fixtures/job.json --output .tmp/linkedin-dry-run
```

Expected: copy, bridge, 1200×630 PNG, Instagram assets, and video render; LinkedIn needs no new visual asset.

- [ ] **Step 3: Inspect state and secret safety**

```sh
rg -n 'LINKEDIN_ACCESS_TOKEN|linkedin-secret|Authorization' state .tmp/linkedin-dry-run || true
node --input-type=module -e "import { readFile } from 'node:fs/promises'; import { validateIntakeState, validateQueueState, validatePublicationsState } from './src/modules/state/state-model.mjs'; validateIntakeState(JSON.parse(await readFile('state/intake.json'))); validateQueueState(JSON.parse(await readFile('state/queue.json'))); validatePublicationsState(JSON.parse(await readFile('state/publications.json'))); console.log('state ok');"
```

Expected: no secrets found and `state ok` printed.

- [ ] **Step 4: Inspect commits and diff quality**

```sh
git status --short
git log --oneline -6
git diff --check HEAD~4..HEAD
```

Expected: only intentional plan/spec artifacts remain, feature commits are present, and no whitespace errors exist.

- [ ] **Step 5: Request code review and address findings with TDD**

Invoke `superpowers:requesting-code-review`. For each actionable finding, add or strengthen a failing validation, observe the failure, implement the smallest fix, and rerun `npm run validate`.

- [ ] **Step 6: Run final verification**

Invoke `superpowers:verification-before-completion`, rerun validation and dry-run, and report the exact passing contract count plus the remaining external setup: Community Management approval, organization ID, API version, and access token.
