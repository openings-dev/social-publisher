# One Daily Push Without Weekly Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver at most one new-opening notification per São Paulo day without a weekly manual secret that stops the publisher.

**Architecture:** Keep the existing durable queue and OneSignal delivery flow. Remove only the custom Free-plan assertion from configuration and workflow wiring, then lower the hard runtime cap from two to one while retaining the existing São Paulo day calculation.

**Tech Stack:** Node.js ES modules, Node test runner, GitHub Actions YAML, OneSignal REST delivery.

---

### Task 1: Remove the weekly runtime gate

**Files:**
- Modify: `test/push-config.test.mjs`
- Modify: `test/push-version-announcement.test.mjs`
- Modify: `src/modules/push/push-config.mjs`

- [ ] **Step 1: Write the failing configuration test**

Replace the attestation test and remove `ONESIGNAL_FREE_ATTESTATION_JSON` from the base fixture:

```js
test('does not require a weekly Free-plan assertion to send', () => {
  const config = readPushConfig(base);
  assert.equal(Object.hasOwn(config, 'attestation'), false);
  assert.doesNotThrow(() => readPushConfig({
    ...base,
    ONESIGNAL_FREE_ATTESTATION_JSON: JSON.stringify({
      checkedAt: '2026-09-01T12:00:00.000Z',
      mobileMau: 900,
      plan: 'free',
      scope: 'organization',
      overLimitBehavior: 'pause',
    }),
  }));
});
```

- [ ] **Step 2: Run the test and verify the production failure is reproduced**

Run: `node --test test/push-config.test.mjs`

Expected: FAIL because the current implementation still requires and validates the weekly assertion.

- [ ] **Step 3: Remove the assertion parser and returned property**

Delete `MAX_SAFE_FREE_MAU`, `validateAttestation`, and this returned field from `readPushConfig`:

```js
attestation: validateAttestation(env.ONESIGNAL_FREE_ATTESTATION_JSON ?? '', now),
```

Keep the app ID, API key, audience version, test subscription IDs, and audience validation unchanged.
Remove the obsolete `ONESIGNAL_FREE_ATTESTATION_JSON` fixture from
`test/push-version-announcement.test.mjs` as well.

- [ ] **Step 4: Run the focused configuration tests**

Run: `node --test test/push-config.test.mjs test/push-version-announcement.test.mjs`

Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit the runtime gate removal**

```bash
git add src/modules/push/push-config.mjs test/push-config.test.mjs test/push-version-announcement.test.mjs
git commit -m "fix(push): remove weekly delivery gate"
```

### Task 2: Enforce one notification per São Paulo day

**Files:**
- Modify: `test/push-orchestrator.test.mjs`
- Modify: `src/modules/push/push-orchestrator.mjs`

- [ ] **Step 1: Change the regression test to require a one-per-day ceiling**

Rename the ceiling test to `limits broadcasts to one per Sao Paulo day even when the stored cap is higher`. Give the state one accepted intent updated on the same São Paulo day as `now`, then assert:

```js
const deferred = preparePushSubmission(state, current, { now: '2026-09-17T02:30:00.000Z' });
assert.equal(deferred.intent, null);
assert.equal(deferred.reason, 'daily_cap');
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/push-orchestrator.test.mjs`

Expected: FAIL because one accepted notification is still below the current hard ceiling of two.

- [ ] **Step 3: Lower the hard ceiling**

In `src/modules/push/push-orchestrator.mjs`, change:

```js
const MAX_DAILY_PUSHES = 2;
```

to:

```js
const MAX_DAILY_PUSHES = 1;
```

- [ ] **Step 4: Run the orchestrator tests**

Run: `node --test test/push-orchestrator.test.mjs`

Expected: all tests pass, including the São Paulo midnight reset.

- [ ] **Step 5: Commit the daily ceiling**

```bash
git add src/modules/push/push-orchestrator.mjs test/push-orchestrator.test.mjs
git commit -m "fix(push): limit broadcasts to one per day"
```

### Task 3: Remove obsolete workflow wiring and update operations documentation

**Files:**
- Modify: `.github/workflows/publish-push.yml`
- Modify: `test/push-workflow-resume.test.mjs`
- Modify: `docs/operations/new-job-push-readiness.md`

- [ ] **Step 1: Add workflow assertions before changing YAML**

Extend `test/push-workflow-resume.test.mjs` with:

```js
test('does not depend on a weekly Free-plan assertion secret', () => {
  assert.doesNotMatch(workflow, /ONESIGNAL_FREE_ATTESTATION_JSON/u);
});
```

- [ ] **Step 2: Run the workflow test and verify it fails**

Run: `node --test test/push-workflow-resume.test.mjs`

Expected: FAIL because the workflow still maps `ONESIGNAL_FREE_ATTESTATION_JSON`.

- [ ] **Step 3: Remove the obsolete workflow secret**

Delete this job environment mapping from `.github/workflows/publish-push.yml`:

```yaml
ONESIGNAL_FREE_ATTESTATION_JSON: ${{ secrets.ONESIGNAL_FREE_ATTESTATION_JSON }}
```

- [ ] **Step 4: Correct the readiness policy**

Update `docs/operations/new-job-push-readiness.md` to state that the local policy is one new-job notification per São Paulo day, that OneSignal pauses Free-plan mobile sending above 1,000 organization-wide MAU, and that no weekly repository assertion is required.

- [ ] **Step 5: Run workflow and configuration tests**

Run: `node --test test/push-workflow-resume.test.mjs test/push-config.test.mjs test/push-orchestrator.test.mjs`

Expected: all tests pass with zero failures.

- [ ] **Step 6: Commit workflow and documentation changes**

```bash
git add .github/workflows/publish-push.yml test/push-workflow-resume.test.mjs docs/operations/new-job-push-readiness.md
git commit -m "chore(push): retire weekly Free-plan assertion"
```

### Task 4: Validate, publish, and verify recovery

**Files:**
- Verify all changed files and the existing pending push state.

- [ ] **Step 1: Run the complete local validation**

Run: `PATH=/opt/homebrew/bin:$PATH npm run validate`

Expected: every test and deterministic contract passes with zero failures.

- [ ] **Step 2: Inspect the final change set**

Run: `git diff origin/main...HEAD --check` and `git status --short`

Expected: no whitespace errors and only the planned committed changes.

- [ ] **Step 3: Rebase onto the latest main and validate again**

Run: `git fetch origin main`, `git rebase origin/main`, and `PATH=/opt/homebrew/bin:$PATH npm run validate`.

Expected: the rebase succeeds and the complete validation passes again.

- [ ] **Step 4: Publish without rewriting history**

Run: `git push origin HEAD:main`

Expected: `main` advances to the implementation commit.

- [ ] **Step 5: Observe the next automatic scheduled run**

Run:

```bash
gh run list --repo openings-dev/social-publisher --workflow publish-push.yml --event schedule --limit 1 --json databaseId,headSha,status,conclusion,url
```

Wait for the first scheduled run whose `headSha` is the new `main` commit. The
durable pending intent must be resumed; no new duplicate intent may be created.

- [ ] **Step 6: Verify the live result**

Run `gh run watch` with the `databaseId` returned in Step 5 and
`--repo openings-dev/social-publisher --exit-status`, then fetch and inspect the
completed `push-state` branch.

Expected: `Publish new-job push` completes successfully, the pending intent becomes `accepted` or a non-error provider outcome, and no second notification is attempted on the same São Paulo day.
