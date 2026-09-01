# Buffer-backed LinkedIn Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish newly queued openings.dev jobs immediately to the official LinkedIn Page through Buffer's Free plan without duplicate posts or secret leakage.

**Architecture:** Keep the existing `linkedin` queue stage and direct LinkedIn client. Add a provider-aware environment contract and a focused Buffer GraphQL client. The CLI dispatches LinkedIn publication to Buffer or the direct client, passing Buffer the bridge's verified public image URL. The workflow stays opt-in until one controlled publication and reconciliation check pass.

**Tech Stack:** Node.js 20 ESM, native `fetch`, Buffer GraphQL API, GitHub Actions, deterministic contracts in `src/modules/validation/run-validation.mjs`.

---

## File map

- Create `src/modules/networks/buffer-linkedin-client.mjs`: Buffer GraphQL validation, channel verification, reconciliation, immediate creation, polling, and normalized results.
- Modify `src/config/constants.mjs`: add the canonical Buffer API origin.
- Modify `src/config/env.mjs`: select and validate the `direct` or `buffer` LinkedIn provider.
- Modify `src/cli/publish.mjs`: dispatch the LinkedIn stage to the selected provider and pass the verified bridge image URL to Buffer.
- Modify `src/modules/validation/run-validation.mjs`: add test-first contracts for configuration, client behavior, CLI wiring, workflow, and documentation.
- Modify `.github/workflows/publish-social.yml`: pass Buffer variables and its repository secret without enabling LinkedIn automatically.
- Modify `README.md`: document Buffer behavior, Free-plan setup, credentials, provider fallback, and controlled rollout.

No tracked state file or schema migration changes.

### Task 1: Add provider-aware configuration

**Files:**

- Modify: `src/config/constants.mjs`
- Modify: `src/config/env.mjs`
- Modify: `src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing configuration contracts**

Extend `enables LinkedIn independently with bounded organization configuration` or split it into focused validations that prove:

- `LINKEDIN_PROVIDER` defaults to `direct` for backward compatibility;
- `LINKEDIN_PROVIDER=buffer` requires only `BUFFER_API_KEY`, `BUFFER_ORGANIZATION_ID`, and `BUFFER_LINKEDIN_CHANNEL_ID` when LinkedIn is enabled;
- the Buffer configuration exposes `provider`, `apiKey`, `organizationId`, `channelId`, and normalized `apiOrigin`;
- direct credentials are not required for the Buffer provider;
- Buffer credentials are not required for the direct provider;
- unknown provider names, blank Buffer IDs, and an HTTP or credential-bearing Buffer origin fail before publication;
- dry-run and disabled LinkedIn modes require neither provider's credentials.

- [ ] **Step 2: Run the focused validation and prove it fails**

Run:

```sh
npm run validate
```

Expected: the new Buffer provider assertions fail because the configuration does not exist.

- [ ] **Step 3: Implement the minimal configuration**

Add:

```js
export const BUFFER_API_ORIGIN = 'https://api.buffer.com';
```

When LinkedIn is enabled, normalize `LINKEDIN_PROVIDER` to `direct` when absent and accept only `direct` or `buffer`. Return a frozen provider-specific object:

```js
{
  provider: 'buffer',
  apiKey: env.BUFFER_API_KEY,
  organizationId: env.BUFFER_ORGANIZATION_ID,
  channelId: env.BUFFER_LINKEDIN_CHANNEL_ID,
  apiOrigin: normalizeOrigin(env.BUFFER_API_ORIGIN, BUFFER_API_ORIGIN, 'BUFFER_API_ORIGIN'),
}
```

Preserve the existing direct fields and add `provider: 'direct'` to that object. Error messages name missing environment keys but never include their values.

- [ ] **Step 4: Run the complete validation**

Run `npm run validate` and confirm all existing direct LinkedIn contracts still pass.

- [ ] **Step 5: Commit**

```sh
git add src/config/constants.mjs src/config/env.mjs src/modules/validation/run-validation.mjs
git commit -m "feat: configure Buffer as a LinkedIn provider"
```

### Task 2: Implement safe Buffer GraphQL transport and channel verification

**Files:**

- Create: `src/modules/networks/buffer-linkedin-client.mjs`
- Modify: `src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing transport and channel contracts**

Import `publishToLinkedInViaBuffer` and use an injected `fetchImpl` that records calls. Add tests for:

- one JSON `POST` to the exact configured API origin;
- `Authorization: Bearer <key>` and `Content-Type: application/json`;
- a `channels(input: { organizationId })` query that selects the configured channel;
- acceptance only when the selected channel reports service `linkedin` and is not disconnected or locked;
- rejection of missing key or IDs, HTTP API origins, credentials or paths in the API origin, redirects, non-JSON responses, malformed JSON, HTTP 401/403, HTTP 429, GraphQL top-level errors, and an absent or mismatched channel;
- rejection messages and diagnostics that never contain the API key.

Keep fixture responses minimal and deterministic. Do not call the real Buffer API.

- [ ] **Step 2: Run validation and verify the expected red state**

Run `npm run validate`.

Expected: module import or Buffer assertions fail.

- [ ] **Step 3: Implement configuration guards and GraphQL request handling**

Create a client with:

- a small `publicationError(code, message, diagnostic?)` helper;
- strict HTTPS origin normalization;
- `fetch(..., { method: 'POST', redirect: 'error', headers, body })`;
- JSON content-type and bounded response parsing;
- classification for authentication, rate-limit, GraphQL, response, and configuration failures;
- a `GetChannels` query scoped to `organizationId`, then an exact `channelId` match and service/connection checks.

Do not log or attach raw GraphQL bodies, variables, authorization headers, or response bodies to errors.

- [ ] **Step 4: Run validation and commit**

Run `npm run validate`, then:

```sh
git add src/modules/networks/buffer-linkedin-client.mjs src/modules/validation/run-validation.mjs
git commit -m "feat: add safe Buffer GraphQL transport"
```

### Task 3: Add immediate image publication and durable completion

**Files:**

- Modify: `src/modules/networks/buffer-linkedin-client.mjs`
- Modify: `src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write a failing happy-path publication contract**

Model these provider responses in order: valid channels, no recent matching posts, successful `createPost`, and status polling from `sending` to `sent`.

Assert that the mutation sends:

```graphql
createPost(input: {
  text: $text
  channelId: $channelId
  schedulingType: automatic
  mode: shareNow
  assets: [{ image: { url: $imageUrl, metadata: { altText: $altText } } }]
})
```

Use GraphQL variables rather than interpolating content into query text. Assert the variables contain the existing formatted post text, exact channel ID, bridge image URL, and bounded alt text. Assert no `dueAt`, approval, draft, or queue mode is present.

The result must be:

```js
{
  status: 'published',
  id: 'buffer-post-id',
  url: 'https://www.linkedin.com/...',
  provider: 'buffer',
}
```

- [ ] **Step 2: Add failing media, mutation, and polling contracts**

Cover:

- media must be HTTPS, credential-free, and hosted on the configured `publicSiteOrigin`;
- Buffer `MutationError` unions become sanitized media, publication, limit, or authentication errors;
- a successful mutation requires a bounded Buffer post ID and known status;
- the single-post query polls immediately, waits only between non-terminal checks, and stops at a bounded attempt count;
- `sent` requires an HTTPS LinkedIn `externalLink`;
- `error`, `needs_approval`, `draft`, unexpected statuses, and timeout fail closed;
- injected `sleep` records bounded delays so validation remains fast.

- [ ] **Step 3: Implement immediate creation and polling**

Add `CreateLinkedInPost` and `GetPost` operations. Always include both `PostActionSuccess` and `MutationError` selections. Use `schedulingType: automatic`, `mode: shareNow`, and one public image asset. Poll through injectable timing functions and return only after the provider reports `sent` with a valid LinkedIn URL.

- [ ] **Step 4: Run validation and commit**

Run `npm run validate`, then:

```sh
git add src/modules/networks/buffer-linkedin-client.mjs src/modules/validation/run-validation.mjs
git commit -m "feat: publish LinkedIn posts immediately through Buffer"
```

### Task 4: Add duplicate reconciliation and ambiguous-response safety

**Files:**

- Modify: `src/modules/networks/buffer-linkedin-client.mjs`
- Modify: `src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing reconciliation contracts**

Use `posts(first: 20, input: { organizationId, filter: { channelIds }, sort })` fixtures and prove:

- exact canonical URL matching in post text returns a sent post without mutation;
- exact matching in an image asset source also reconciles;
- canonical-prefix lookalikes, other channels, malformed post nodes, and unrelated URLs do not reconcile;
- a matching `sending` or `scheduled` post resumes polling without mutation;
- a matching `error`, `needs_approval`, or `draft` post fails closed without mutation;
- an ambiguous network error after `createPost` triggers one new recent-post query;
- a unique post found after the ambiguous error is resumed or reconciled;
- no proven post produces a retryable sanitized error;
- multiple matching active posts fail closed instead of guessing.

The recent-post query is bounded, newest first, and does not paginate indefinitely.

- [ ] **Step 2: Run validation and prove the new contracts fail**

Run `npm run validate`.

- [ ] **Step 3: Implement preflight and post-failure reconciliation**

Add exact canonical URL extraction using parsed URLs rather than loose substring matching. Normalize provider nodes before comparison. Reuse the same lookup before creation and once after an ambiguous create transport failure. Never automatically create a replacement for an errored matching Buffer post.

- [ ] **Step 4: Run validation and commit**

Run `npm run validate`, then:

```sh
git add src/modules/networks/buffer-linkedin-client.mjs src/modules/validation/run-validation.mjs
git commit -m "feat: reconcile Buffer LinkedIn publications"
```

### Task 5: Wire Buffer into the existing LinkedIn queue stage

**Files:**

- Modify: `src/cli/publish.mjs`
- Modify: `src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing CLI wiring contracts**

Add a controlled-publication fixture with `LINKEDIN_PROVIDER=buffer`. Let the injected bridge publisher return a realistic `imageUrl`, inject a Buffer publisher dependency, and assert it receives:

- the selected job and formatted post;
- `queueItem.bridge.result.imageUrl`;
- Buffer configuration and `publicSiteOrigin`;
- no rendered PNG and no direct LinkedIn configuration.

Keep the existing direct LinkedIn CLI contract and prove it still renders/passes the PNG through the direct dependency path. Confirm a Buffer LinkedIn failure leaves already completed providers untouched and records only a sanitized LinkedIn-stage error.

- [ ] **Step 2: Run validation and verify the expected failure**

Run `npm run validate`.

- [ ] **Step 3: Implement provider dispatch**

Import the Buffer client. Add an injectable `publishLinkedInViaBuffer` dependency. In the LinkedIn callback:

- if `config.linkedin.provider === 'buffer'`, pass the verified bridge image URL and Buffer configuration;
- otherwise keep the current direct render/upload flow;
- log `provider: 'buffer'` or `provider: 'linkedin'` with only the sanitized code.

Do not modify the orchestrator or state schema.

- [ ] **Step 4: Run validation and commit**

Run `npm run validate`, then:

```sh
git add src/cli/publish.mjs src/modules/validation/run-validation.mjs
git commit -m "feat: route LinkedIn publishing through Buffer"
```

### Task 6: Wire GitHub Actions and operator documentation

**Files:**

- Modify: `.github/workflows/publish-social.yml`
- Modify: `README.md`
- Modify: `src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing workflow and documentation contracts**

Require the workflow and README to contain:

- `LINKEDIN_PROVIDER`;
- `BUFFER_API_ORIGIN`;
- `BUFFER_ORGANIZATION_ID`;
- `BUFFER_LINKEDIN_CHANNEL_ID`;
- exactly one `secrets.BUFFER_API_KEY` reference;
- `shareNow`, Buffer Free plan, immediate publishing, controlled rollout, and direct-provider fallback;
- no API key value, no claim that Buffer stores the bridge asset, and no instruction to enable automation before verification.

Preserve existing workflow gates and direct LinkedIn configuration contracts.

- [ ] **Step 2: Run validation and prove it fails**

Run `npm run validate`.

- [ ] **Step 3: Update workflow and README**

Add provider variables to the job environment and `BUFFER_API_KEY: ${{ secrets.BUFFER_API_KEY }}` only at the provider step/job boundary that needs it. Keep `LINKEDIN_AUTO_PUBLISH` false in repository configuration until rollout completes. Document both providers and explain that Buffer downloads the stable bridge image from openings.dev.

- [ ] **Step 4: Run validation and commit**

Run `npm run validate`, then:

```sh
git add .github/workflows/publish-social.yml README.md src/modules/validation/run-validation.mjs
git commit -m "docs: configure Buffer LinkedIn rollout"
```

### Task 7: Complete local verification and review

**Files:**

- Review all changed files from Tasks 1-6.

- [ ] **Step 1: Run deterministic verification**

Run:

```sh
npm run validate
npm run dry-run
git diff --check origin/main...HEAD
```

Expected: all validations pass, dry-run succeeds without credentials or network access, and the diff has no whitespace errors.

- [ ] **Step 2: Review security and behavior**

Confirm manually:

- no Buffer key in tracked files, logs, tests, Git history, or command arguments;
- all provider writes use exact IDs and reject redirects;
- no state schema or historical queue status changed;
- every create path reconciles first;
- only `shareNow` is used;
- automatic LinkedIn publishing remains disabled.

- [ ] **Step 3: Run an independent code review**

Use the existing review workflow or a review tool without creating a subagent. Fix any high-confidence finding test-first and record each independent fix as its own micro-commit.

### Task 8: Configure Buffer and perform the controlled rollout

**External actions:** Buffer in the external Brave `Openings.dev` profile and GitHub repository settings.

- [ ] **Step 1: Obtain action-time confirmation and connect the channel**

Immediately before the click, ask for confirmation to connect the Openings.dev LinkedIn Page to Buffer. Select only the official Page and verify the resulting channel is connected, unlocked, and reports service `linkedin`.

- [ ] **Step 2: Obtain action-time confirmation and create the API key**

Immediately before creation, ask for confirmation. Create one personal key with a descriptive name. Transfer it directly to the `BUFFER_API_KEY` GitHub secret using browser clipboard paste without reading or displaying the value.

- [ ] **Step 3: Discover IDs without exposing the key**

Use the authenticated Buffer API or settings UI to identify the `Openings HQ` organization ID and the exact LinkedIn channel ID. Store:

- `LINKEDIN_PROVIDER=buffer`;
- `BUFFER_API_ORIGIN=https://api.buffer.com`;
- `BUFFER_ORGANIZATION_ID=<discovered ID>`;
- `BUFFER_LINKEDIN_CHANNEL_ID=<discovered ID>`;
- `LINKEDIN_AUTO_PUBLISH=false`.

- [ ] **Step 4: Push the verified micro-commits**

Fetch and confirm `main` has not diverged. Push only the completed, validated commits to `origin/main`.

- [ ] **Step 5: Obtain action-time confirmation and publish one controlled job**

Immediately before dispatching the workflow, identify the exact open job and show its title and canonical URL. After confirmation, run controlled mode with `publish_linkedin=true` and `PUBLISH_ONE_JOB` while other optional channels remain off as appropriate.

- [ ] **Step 6: Verify publication and duplicate safety**

Confirm the Buffer post status is sent, the LinkedIn URL is public, text/link/image are correct, and durable state contains the normalized Buffer result. Exercise reconciliation against the same canonical URL without creating a second post.

- [ ] **Step 7: Activate automatic LinkedIn publication**

Only after controlled verification, set `LINKEDIN_AUTO_PUBLISH=true`. Confirm the next newly enqueued job is eligible while historical jobs remain skipped. Report the exact commits, workflow run, LinkedIn URL, and final repository status.
