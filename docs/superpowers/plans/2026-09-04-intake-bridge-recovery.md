# Intake Bridge Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guarded operator action that reopens one failed snapshot-intake bridge without publishing or disabling the three-attempt limit.

**Architecture:** Extend the existing `retry-stage` command with a distinct `intake-bridge` stage. The state layer owns the failed-to-pending transition, the CLI selects and persists the intake state file, and the workflow exposes and commits the guarded operation.

**Tech Stack:** Node.js 20 ESM, JSON state files, GitHub Actions YAML, deterministic contract runner.

---

### Task 1: Reproduce the missing intake recovery path

**Files:**
- Modify: `src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Add a failing CLI regression contract**

Create a temporary state directory containing an empty queue/publications file and an intake file with
one pending bridge whose stage is `failed`. Invoke `runPublication` with:

```js
request: {
  mode: 'retry-stage',
  jobId,
  stage: 'intake-bridge',
  confirmation: 'RESET_FAILED_STAGE',
}
```

Assert that the result is `{ outcome: 'reset', jobId, stage: 'intake-bridge' }` and the persisted stage is
`pending`, has zero attempts, no error, and a `manual_reset` marker.

- [ ] **Step 2: Require the production workflow wiring**

Extend the workflow contract to require `- intake-bridge` and require the publication/reset commit step to
stage `state/intake.json` together with queue and publications state.

- [ ] **Step 3: Run the contract suite and verify RED**

Run:

```bash
PATH=/Users/guilherme/.nvm/versions/node/v20.19.5/bin:/opt/homebrew/bin:$PATH npm run validate
```

Expected: failure because `intake-bridge` is not an accepted retry stage.

- [ ] **Step 4: Commit the regression**

```bash
git add src/modules/validation/run-validation.mjs
git commit -m "test(intake): reproduce unrecoverable bridge failure"
```

### Task 2: Implement the guarded state transition

**Files:**
- Modify: `src/modules/state/queue-operations.mjs`
- Modify: `src/cli/publish.mjs`

- [ ] **Step 1: Add the focused state operation**

Export `resetFailedPendingBridge(intakeState, jobId, { at, reason })`. Validate the timestamp, find the
pending bridge, reject any stage not currently `failed`, and replace the stage with:

```js
{
  status: 'pending',
  attempts: 0,
  updatedAt: at,
  lastError: null,
  lastReset: { at, reason: sanitizeCode(reason, 'manual_reset') },
  result: null,
}
```

- [ ] **Step 2: Route `intake-bridge` through the CLI**

Add `intake-bridge` to the accepted retry stages. In retry mode, load `state/intake.json` with
`migrateIntakeState` and `validateIntakeState`, call `resetFailedPendingBridge`, and persist only that intake
file. Keep every existing queue-stage reset unchanged.

- [ ] **Step 3: Run the contract suite and verify the state behavior is GREEN**

Run the Task 1 validation command. The CLI regression should pass; the workflow contract may remain red
until Task 3.

### Task 3: Expose and persist the recovery operation

**Files:**
- Modify: `.github/workflows/publish-social.yml`
- Modify: `README.md`

- [ ] **Step 1: Add the workflow choice and state path**

Add `intake-bridge` to the retry-stage choices. In `Commit and push publication or reset state`, stage:

```bash
git add -- state/intake.json state/queue.json state/publications.json
```

- [ ] **Step 2: Document the distinction**

Document that `bridge` resets a failed publication-queue deploy while `intake-bridge` resets a failed
snapshot-intake deploy, both under `RESET_FAILED_STAGE` and neither publishing in the reset operation.

- [ ] **Step 3: Run full verification**

Run:

```bash
PATH=/Users/guilherme/.nvm/versions/node/v20.19.5/bin:/opt/homebrew/bin:$PATH npm ci
PATH=/Users/guilherme/.nvm/versions/node/v20.19.5/bin:/opt/homebrew/bin:$PATH npm run validate
PATH=/Users/guilherme/.nvm/versions/node/v20.19.5/bin:/opt/homebrew/bin:$PATH npm run dry-run -- --fixture assets/fixtures/job.json --wordmark ../web/public/openings-wordmark-light.svg --output .tmp/validation-dry-run
```

Expected: all deterministic contracts pass and the dry-run emits the job page, social images, and video.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/modules/state/queue-operations.mjs src/cli/publish.mjs .github/workflows/publish-social.yml README.md
git commit -m "fix(intake): add guarded bridge recovery"
```

### Task 4: Deploy and recover production state

**Files:**
- Runtime state only through the guarded GitHub Actions workflow.

- [ ] **Step 1: Synchronize and push `main`**

Fetch `origin/main`, fast-forward or rebase without overwriting bot state commits, then push the micro-commits.

- [ ] **Step 2: Verify the Validate workflow**

Wait for the new `Validate source and dry run` job and require a successful conclusion.

- [ ] **Step 3: Reset the blocked intake bridge**

Dispatch `publish-social.yml` with mode `retry-stage`, job
`gh_53d53bb4cfce441a70f5e40a`, stage `intake-bridge`, and confirmation `RESET_FAILED_STAGE`. Require a
successful state-only run.

- [ ] **Step 4: Retry one scheduled cycle**

Dispatch mode `scheduled`. Confirm that the intake stage performs a new deploy attempt and either advances
the snapshot watermark or returns a new concrete deployment result; it must not remain failed without an
attempt.
