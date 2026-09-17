# OneSignal FCM Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Securely connect the production Openings OneSignal application to the `openingshq` Firebase project through FCM v1 without enabling or sending push notifications.

**Architecture:** A focused module validates the dedicated Firebase service-account identity before network access, Base64-encodes it in memory, updates the one fixed OneSignal app with a short-lived Organization API key, and verifies the returned app metadata. A manual-only GitHub Actions workflow exposes the credentials to one process for one guarded operation; the temporary secrets, local JSON, and Organization API key are removed after production verification.

**Tech Stack:** Node.js 20 ESM, native `fetch`, native `node:test`, GitHub Actions, OneSignal Update App REST API.

---

## Fixed production identities

- OneSignal App ID: `c49d82df-9d48-4283-b746-4afe280cda5e`
- Firebase project ID: `openingshq`
- Firebase service account: `onesignal-fcm-sender@openingshq.iam.gserviceaccount.com`
- Manual confirmation: `CONFIGURE_OPENINGS_FCM_V1`
- Temporary GitHub secrets: `ONESIGNAL_ORGANIZATION_API_KEY` and `ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON`
- Permanent existing secret used only as the app selector: `ONESIGNAL_APP_ID`

The existing `ONESIGNAL_API_KEY` is app-scoped and must not be used here. OneSignal's Update App endpoint requires an Organization API key and expects `fcm_v1_service_account_json` to contain the Base64 representation of the service-account JSON.

### Task 1: Validate the exact Firebase credential before network access

**Files:**
- Create: `src/modules/push/onesignal-fcm-configurator.mjs`
- Create: `test/push-onesignal-fcm-configurator.test.mjs`

- [ ] **Step 1: Write failing credential-validation tests**

Create `test/push-onesignal-fcm-configurator.test.mjs` with:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { validateFirebaseServiceAccount } from '../src/modules/push/onesignal-fcm-configurator.mjs';

const validCredential = Object.freeze({
  type: 'service_account',
  project_id: 'openingshq',
  private_key_id: 'key-id',
  private_key: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n',
  client_email: 'onesignal-fcm-sender@openingshq.iam.gserviceaccount.com',
  client_id: '1234567890',
  token_uri: 'https://oauth2.googleapis.com/token',
});

test('accepts only the dedicated openingshq service account', () => {
  const result = validateFirebaseServiceAccount(JSON.stringify(validCredential));
  assert.deepEqual(result, validCredential);
});

test('rejects malformed JSON without exposing its contents', () => {
  assert.throws(() => validateFirebaseServiceAccount('{private-key'), {
    message: 'Firebase service account must be valid JSON',
  });
});

test('rejects every protected identity mismatch', () => {
  for (const [field, value] of [
    ['type', 'authorized_user'],
    ['project_id', 'other-project'],
    ['client_email', 'other@openingshq.iam.gserviceaccount.com'],
  ]) {
    assert.throws(
      () => validateFirebaseServiceAccount(JSON.stringify({ ...validCredential, [field]: value })),
      /Firebase service account identity is invalid/u,
    );
  }
});

test('rejects absent or malformed private-key material', () => {
  for (const privateKey of [undefined, '', 'secret', '-----BEGIN PRIVATE KEY-----\nsecret']) {
    assert.throws(
      () => validateFirebaseServiceAccount(JSON.stringify({ ...validCredential, private_key: privateKey })),
      /Firebase service account private key is invalid/u,
    );
  }
});
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run: `node --test test/push-onesignal-fcm-configurator.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `onesignal-fcm-configurator.mjs`.

- [ ] **Step 3: Implement the minimal identity validator**

Create `src/modules/push/onesignal-fcm-configurator.mjs` with:

```js
const EXPECTED_APP_ID = 'c49d82df-9d48-4283-b746-4afe280cda5e';
const EXPECTED_PROJECT_ID = 'openingshq';
const EXPECTED_CLIENT_EMAIL = 'onesignal-fcm-sender@openingshq.iam.gserviceaccount.com';

export function validateFirebaseServiceAccount(rawJson) {
  let credential;
  try {
    credential = JSON.parse(rawJson);
  } catch {
    throw new Error('Firebase service account must be valid JSON');
  }
  if (credential?.type !== 'service_account'
    || credential.project_id !== EXPECTED_PROJECT_ID
    || credential.client_email !== EXPECTED_CLIENT_EMAIL) {
    throw new Error('Firebase service account identity is invalid');
  }
  if (typeof credential.private_key !== 'string'
    || !/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n?$/u.test(credential.private_key)) {
    throw new Error('Firebase service account private key is invalid');
  }
  return credential;
}

export const OPENINGS_ONESIGNAL_APP_ID = EXPECTED_APP_ID;
```

- [ ] **Step 4: Run the focused test and confirm green**

Run: `node --test test/push-onesignal-fcm-configurator.test.mjs`

Expected: 4 tests pass, 0 fail.

- [ ] **Step 5: Commit the validator**

```bash
git add src/modules/push/onesignal-fcm-configurator.mjs test/push-onesignal-fcm-configurator.test.mjs
git commit -m "feat: validate OneSignal FCM credential"
```

### Task 2: Configure and verify FCM v1 through OneSignal

**Files:**
- Modify: `src/modules/push/onesignal-fcm-configurator.mjs`
- Modify: `test/push-onesignal-fcm-configurator.test.mjs`

- [ ] **Step 1: Append failing request and response tests**

Append to `test/push-onesignal-fcm-configurator.test.mjs`:

```js
import { configureOneSignalFcm, OPENINGS_ONESIGNAL_APP_ID } from '../src/modules/push/onesignal-fcm-configurator.mjs';

test('updates the fixed app with Base64 FCM v1 JSON and verifies read-back', async () => {
  const requests = [];
  const result = await configureOneSignalFcm({
    appId: OPENINGS_ONESIGNAL_APP_ID,
    organizationApiKey: 'organization-secret',
    serviceAccountJson: JSON.stringify(validCredential),
  }, { fetchImpl: async (url, request = {}) => {
    requests.push({ url, request });
    if (request.method === 'PUT') {
      return new Response(JSON.stringify({ id: OPENINGS_ONESIGNAL_APP_ID }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id: OPENINGS_ONESIGNAL_APP_ID,
      fcm_v1_service_account_json: 'configured',
    }), { status: 200 });
  } });

  assert.deepEqual(result, { appId: OPENINGS_ONESIGNAL_APP_ID, fcmV1Configured: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `https://api.onesignal.com/apps/${OPENINGS_ONESIGNAL_APP_ID}`);
  assert.equal(requests[0].request.method, 'PUT');
  assert.equal(requests[0].request.headers.authorization, 'Key organization-secret');
  assert.equal(requests[1].request.method, 'GET');
  const body = JSON.parse(requests[0].request.body);
  assert.deepEqual(JSON.parse(Buffer.from(body.fcm_v1_service_account_json, 'base64').toString('utf8')), validCredential);
});

test('rejects wrong app identity and absent secrets before network access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('{}'); };
  for (const change of [
    { appId: 'wrong-app' },
    { organizationApiKey: '' },
    { serviceAccountJson: '' },
  ]) {
    await assert.rejects(() => configureOneSignalFcm({
      appId: OPENINGS_ONESIGNAL_APP_ID,
      organizationApiKey: 'organization-secret',
      serviceAccountJson: JSON.stringify(validCredential),
      ...change,
    }, { fetchImpl }), /invalid|required/u);
  }
  assert.equal(calls, 0);
});

test('reports sanitized provider failures without response or credential contents', async () => {
  const inputs = {
    appId: OPENINGS_ONESIGNAL_APP_ID,
    organizationApiKey: 'organization-secret',
    serviceAccountJson: JSON.stringify(validCredential),
  };
  await assert.rejects(() => configureOneSignalFcm(inputs, {
    fetchImpl: async () => new Response('private provider detail', { status: 403 }),
  }), { message: 'OneSignal FCM update failed with status 403' });
  await assert.rejects(() => configureOneSignalFcm(inputs, {
    fetchImpl: async (_url, request = {}) => request.method === 'PUT'
      ? new Response(JSON.stringify({ id: OPENINGS_ONESIGNAL_APP_ID }), { status: 200 })
      : new Response(JSON.stringify({ id: OPENINGS_ONESIGNAL_APP_ID }), { status: 200 }),
  }), { message: 'OneSignal FCM read-back did not confirm FCM v1' });
});
```

Move the original import to one combined import so the file contains only one import from the configurator module.

- [ ] **Step 2: Run the focused test and confirm the new tests fail**

Run: `node --test test/push-onesignal-fcm-configurator.test.mjs`

Expected: FAIL because `configureOneSignalFcm` is not exported.

- [ ] **Step 3: Add the guarded API operation**

Append to `src/modules/push/onesignal-fcm-configurator.mjs`:

```js
function requireNonEmpty(value, message) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message);
}

export async function configureOneSignalFcm({ appId, organizationApiKey, serviceAccountJson }, {
  fetchImpl = fetch,
  timeoutMs = 60_000,
} = {}) {
  if (appId !== EXPECTED_APP_ID) throw new Error('OneSignal App ID is invalid');
  requireNonEmpty(organizationApiKey, 'OneSignal Organization API key is required');
  requireNonEmpty(serviceAccountJson, 'Firebase service account JSON is required');
  const credential = validateFirebaseServiceAccount(serviceAccountJson);
  const endpoint = `https://api.onesignal.com/apps/${EXPECTED_APP_ID}`;
  const headers = {
    accept: 'application/json',
    authorization: `Key ${organizationApiKey}`,
    'content-type': 'application/json',
  };
  const update = await fetchImpl(endpoint, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      fcm_v1_service_account_json: Buffer.from(JSON.stringify(credential), 'utf8').toString('base64'),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!update.ok) throw new Error(`OneSignal FCM update failed with status ${update.status}`);
  const readBack = await fetchImpl(endpoint, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Key ${organizationApiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!readBack.ok) throw new Error(`OneSignal FCM read-back failed with status ${readBack.status}`);
  const app = await readBack.json();
  if (app?.id !== EXPECTED_APP_ID
    || typeof app.fcm_v1_service_account_json !== 'string'
    || app.fcm_v1_service_account_json.trim() === '') {
    throw new Error('OneSignal FCM read-back did not confirm FCM v1');
  }
  return Object.freeze({ appId: EXPECTED_APP_ID, fcmV1Configured: true });
}
```

- [ ] **Step 4: Run focused and push test suites**

Run: `node --test test/push-onesignal-fcm-configurator.test.mjs && npm run test:platform`

Expected: configurator tests pass; the complete platform suite passes with no failures.

- [ ] **Step 5: Commit the API operation**

```bash
git add src/modules/push/onesignal-fcm-configurator.mjs test/push-onesignal-fcm-configurator.test.mjs
git commit -m "feat: configure OneSignal FCM v1"
```

### Task 3: Add a fail-closed CLI boundary

**Files:**
- Create: `src/cli/configure-onesignal-fcm.mjs`
- Create: `test/push-onesignal-fcm-cli.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing CLI boundary tests**

Create `test/push-onesignal-fcm-cli.test.mjs` with:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { runOneSignalFcmBootstrap } from '../src/cli/configure-onesignal-fcm.mjs';

const env = Object.freeze({
  REQUEST_CONFIRMATION: 'CONFIGURE_OPENINGS_FCM_V1',
  ONESIGNAL_APP_ID: 'c49d82df-9d48-4283-b746-4afe280cda5e',
  ONESIGNAL_ORGANIZATION_API_KEY: 'organization-secret',
  ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON: '{"credential":true}',
});

test('passes only the guarded environment to the configurator and logs a safe result', async () => {
  const logs = [];
  let received;
  const result = await runOneSignalFcmBootstrap({ env, log: (value) => logs.push(value), configure: async (value) => {
    received = value;
    return { appId: env.ONESIGNAL_APP_ID, fcmV1Configured: true };
  } });
  assert.deepEqual(received, {
    appId: env.ONESIGNAL_APP_ID,
    organizationApiKey: env.ONESIGNAL_ORGANIZATION_API_KEY,
    serviceAccountJson: env.ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON,
  });
  assert.deepEqual(result, { appId: env.ONESIGNAL_APP_ID, fcmV1Configured: true });
  assert.deepEqual(logs, ['OneSignal FCM v1 configured for c49d82df-9d48-4283-b746-4afe280cda5e']);
  assert.doesNotMatch(logs.join(''), /organization-secret|credential/u);
});

test('rejects an inexact confirmation before calling the configurator', async () => {
  let called = false;
  await assert.rejects(() => runOneSignalFcmBootstrap({
    env: { ...env, REQUEST_CONFIRMATION: 'configure' },
    configure: async () => { called = true; },
  }), /exact confirmation phrase/u);
  assert.equal(called, false);
});
```

- [ ] **Step 2: Run the CLI test and confirm the red state**

Run: `node --test test/push-onesignal-fcm-cli.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the CLI boundary**

Create `src/cli/configure-onesignal-fcm.mjs` with:

```js
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { configureOneSignalFcm } from '../modules/push/onesignal-fcm-configurator.mjs';

export async function runOneSignalFcmBootstrap({
  env = process.env,
  log = console.log,
  configure = configureOneSignalFcm,
} = {}) {
  if (env.REQUEST_CONFIRMATION !== 'CONFIGURE_OPENINGS_FCM_V1') {
    throw new Error('OneSignal FCM bootstrap requires the exact confirmation phrase');
  }
  const result = await configure({
    appId: env.ONESIGNAL_APP_ID,
    organizationApiKey: env.ONESIGNAL_ORGANIZATION_API_KEY,
    serviceAccountJson: env.ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON,
  });
  log(`OneSignal FCM v1 configured for ${result.appId}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOneSignalFcmBootstrap().catch((error) => {
    console.error(error instanceof Error ? error.message : 'OneSignal FCM bootstrap failed');
    process.exitCode = 1;
  });
}
```

Add this script to `package.json` immediately after `"push"`:

```json
"push:configure-fcm": "node src/cli/configure-onesignal-fcm.mjs",
```

- [ ] **Step 4: Run the CLI and platform tests**

Run: `node --test test/push-onesignal-fcm-cli.test.mjs && npm run test:platform`

Expected: CLI tests pass and the platform suite passes with no failures.

- [ ] **Step 5: Commit the CLI boundary**

```bash
git add src/cli/configure-onesignal-fcm.mjs test/push-onesignal-fcm-cli.test.mjs package.json
git commit -m "feat: add guarded FCM bootstrap CLI"
```

### Task 4: Add the manual-only least-privilege workflow

**Files:**
- Create: `.github/workflows/configure-onesignal-fcm.yml`
- Create: `test/push-fcm-workflow.test.mjs`

- [ ] **Step 1: Write the failing workflow contract test**

Create `test/push-fcm-workflow.test.mjs` with:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/configure-onesignal-fcm.yml', import.meta.url), 'utf8');

test('keeps FCM bootstrap manual, main-only, and read-only', () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /schedule:|repository_dispatch:|push:/u);
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.match(workflow, /^    if: github\.ref == 'refs\/heads\/main'$/mu);
  assert.match(workflow, /timeout-minutes: 5/u);
});

test('scopes exact temporary secrets to the configuration step', () => {
  for (const name of ['ONESIGNAL_ORGANIZATION_API_KEY', 'ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON']) {
    assert.equal([...workflow.matchAll(new RegExp(`${name}:`, 'gu'))].length, 1);
    assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`, 'u'));
  }
  assert.match(workflow, /ONESIGNAL_APP_ID: \$\{\{ secrets\.ONESIGNAL_APP_ID \}\}/u);
  assert.match(workflow, /REQUEST_CONFIRMATION: \$\{\{ inputs\.confirmation \}\}/u);
});

test('cannot activate or deliver push notifications', () => {
  assert.match(workflow, /npm run push:configure-fcm/u);
  assert.doesNotMatch(workflow, /npm run push --|OPENINGS_PUSH_AUTO_PUBLISH|SEND_TEST_PUSH|ENABLE_NEW_JOB_PUSH/u);
  assert.doesNotMatch(workflow, /upload-artifact|artifacts?/iu);
});
```

- [ ] **Step 2: Run the workflow test and confirm the red state**

Run: `node --test test/push-fcm-workflow.test.mjs`

Expected: FAIL with `ENOENT` for `.github/workflows/configure-onesignal-fcm.yml`.

- [ ] **Step 3: Implement the workflow**

Create `.github/workflows/configure-onesignal-fcm.yml` with:

```yaml
name: Configure OneSignal FCM v1

on:
  workflow_dispatch:
    inputs:
      confirmation:
        description: Enter CONFIGURE_OPENINGS_FCM_V1 exactly
        required: true
        type: string

permissions:
  contents: read

jobs:
  configure:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Check out the trusted bootstrap code
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5

      - name: Use Node.js 20
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 20
          cache: npm

      - name: Install exact dependencies
        run: npm ci

      - name: Configure and verify OneSignal FCM v1
        env:
          REQUEST_CONFIRMATION: ${{ inputs.confirmation }}
          ONESIGNAL_APP_ID: ${{ secrets.ONESIGNAL_APP_ID }}
          ONESIGNAL_ORGANIZATION_API_KEY: ${{ secrets.ONESIGNAL_ORGANIZATION_API_KEY }}
          ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON: ${{ secrets.ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON }}
        run: npm run push:configure-fcm
```

- [ ] **Step 4: Run workflow and complete repository verification**

Run: `node --test test/push-fcm-workflow.test.mjs && npm run validate`

Expected: workflow tests pass; platform, artwork, and deterministic validation suites all finish with 0 failures.

- [ ] **Step 5: Commit the workflow**

```bash
git add .github/workflows/configure-onesignal-fcm.yml test/push-fcm-workflow.test.mjs
git commit -m "ci: add secure OneSignal FCM bootstrap"
```

### Task 5: Review, merge, and run the production bootstrap

**Files:**
- Verify only; no source edits expected.

- [ ] **Step 1: Review the complete branch without exposing secrets**

Run:

```bash
git status --short
git diff --check origin/main...HEAD
git log --oneline origin/main..HEAD
npm run validate
```

Expected: clean status, empty `git diff --check`, the design/implementation commits listed, and all validation passing.

- [ ] **Step 2: Push the branch, open a PR, wait for required checks, and merge**

Run:

```bash
git push -u origin codex/onesignal-fcm-setup
gh pr create --repo openings-dev/social-publisher --base main --head codex/onesignal-fcm-setup --title "Configure OneSignal FCM v1 securely" --body "Adds a manual-only, identity-locked bootstrap for the Openings Android FCM v1 credential. It does not enable or send push notifications."
gh pr checks --repo openings-dev/social-publisher --watch
```

Expected: branch pushed, PR created, and every required check succeeds. Merge only after reviewing the PR diff and confirming it contains no credential material.

- [ ] **Step 3: Create and stage the two temporary credentials**

In OneSignal, create a new Organization API key dedicated to this one bootstrap. Store it directly without printing it:

```bash
gh secret set ONESIGNAL_ORGANIZATION_API_KEY --repo openings-dev/social-publisher
gh secret set ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON --repo openings-dev/social-publisher < /Users/guilherme/Downloads/openingshq-7235f8ae7060.json
```

Expected: both commands succeed without displaying either secret. Confirm names only:

```bash
gh secret list --repo openings-dev/social-publisher | rg '^(ONESIGNAL_ORGANIZATION_API_KEY|ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON)\b'
```

Expected: exactly the two temporary names appear.

- [ ] **Step 4: Dispatch the bootstrap once and verify the safe log**

Run:

```bash
gh workflow run configure-onesignal-fcm.yml --repo openings-dev/social-publisher --ref main -f confirmation=CONFIGURE_OPENINGS_FCM_V1
gh run list --repo openings-dev/social-publisher --workflow configure-onesignal-fcm.yml --limit 1 --json databaseId,status,conclusion
```

Copy the returned `databaseId` and run `gh run watch RUN_ID --repo openings-dev/social-publisher --exit-status`, replacing `RUN_ID` with that numeric value.

Expected: the run succeeds and its configuration step reports only `OneSignal FCM v1 configured for c49d82df-9d48-4283-b746-4afe280cda5e`. It must not run the push publication workflow or create a notification.

- [ ] **Step 5: Independently verify FCM v1 in OneSignal**

Open the production app's Google Android settings and confirm Firebase Cloud Messaging API v1 is active for the `openingshq` sender:

`https://dashboard.onesignal.com/apps/c49d82df-9d48-4283-b746-4afe280cda5e/settings/configure/google-android`

Expected: Google Android is configured with FCM v1. Do not continue to SDK activation, audience configuration, or notification delivery.

- [ ] **Step 6: Revoke and remove all bootstrap credentials**

First revoke the dedicated Organization API key in OneSignal. Then run:

```bash
gh secret delete ONESIGNAL_ORGANIZATION_API_KEY --repo openings-dev/social-publisher
gh secret delete ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON --repo openings-dev/social-publisher
```

Move `/Users/guilherme/Downloads/openingshq-7235f8ae7060.json` to the macOS Trash so it remains recoverable during the immediate verification window, then empty Trash only after confirming OneSignal remains configured.

Confirm GitHub contains neither temporary secret:

```bash
gh secret list --repo openings-dev/social-publisher | rg '^(ONESIGNAL_ORGANIZATION_API_KEY|ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON)\b'
```

Expected: no matches. The permanent `ONESIGNAL_APP_ID` and app-scoped `ONESIGNAL_API_KEY` remain; push auto-publication remains disabled.

- [ ] **Step 7: Record the verified boundary**

Append this subsection under `## Rollout` in `README.md`:

```markdown
### Android push readiness

On 2026-09-16, FCM v1 was configured and independently verified for the production OneSignal app. The short-lived OneSignal Organization API key was revoked, both bootstrap-only GitHub secrets were deleted, and the local Firebase credential was removed. No notification was sent during bootstrap; audience setup, physical-device canary, mobile release, and automatic publication remain separate rollout gates.
```

Do not record secret values, the local credential path, or key fingerprints.

Run `npm run validate`, then commit that documentation update with:

```bash
git add README.md
git commit -m "docs: record verified FCM bootstrap"
```

Expected: full validation passes and the final commit contains documentation only.
