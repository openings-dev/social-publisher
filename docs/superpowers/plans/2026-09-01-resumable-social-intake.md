# Resumable Social Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish one ready social job before bounded intake, while preserving each completed bridge checkpoint across failures and workflow cancellation.

**Architecture:** Reuse `intakeState.pendingBridges` as a durable per-snapshot journal. The intake orchestrator performs at most one external bridge attempt per CLI invocation, reuses published checkpoints, and returns retryable failures as persisted summaries; the scheduled workflow publishes and commits social state first, then loops through at most eight separately committed intake invocations.

**Tech Stack:** Node.js 20 ESM, deterministic custom validation suite, JSON state in Git, Bash-based GitHub Actions, existing GitHub repository-dispatch bridge deployment.

---

## File structure

- `src/modules/state/queue-operations.mjs`: add a validated transition function for `pendingBridges` stage state.
- `src/modules/publishing/orchestrator.mjs`: turn snapshot intake into a bounded, resumable state machine.
- `src/cli/intake.mjs`: pass the single-attempt limit and persist the structured summary returned by the orchestrator.
- `src/modules/validation/run-validation.mjs`: add deterministic regression contracts for partial progress, checkpoint reuse, retryable failures, and workflow ordering.
- `.github/workflows/publish-social.yml`: publish and commit provider state before an eight-iteration checkpointed intake loop.

### Task 1: Add resumable pending-bridge state transitions

**Files:**
- Modify: `src/modules/validation/run-validation.mjs`
- Modify: `src/modules/state/queue-operations.mjs`

- [ ] **Step 1: Write the failing transition contract**

Import `transitionPendingBridgeStage` beside the existing queue-operation imports. Add a validation that creates an intake state with `enqueueBridgeWork`, transitions its bridge through `publishing`, `retryable`, `publishing`, and `published`, then asserts attempts, safe error metadata, and the stored deployment result. Also assert that an unknown job ID and an invalid transition throw.

```js
validation('transitions durable pending bridge stages safely', () => {
  const job = makeJob();
  const snapshot = makeLoadedSnapshot({
    commit: 'a'.repeat(40), generatedAt: '2026-09-01T18:00:00.000Z',
    dataHash: 'a'.repeat(64), jobs: [job],
  });
  let intake = enqueueBridgeWork({
    schemaVersion: STATE_SCHEMA_VERSION,
    processedSnapshot: null,
    pendingBridges: [],
    removedJobs: [],
  }, { job, snapshot, reason: 'new' });
  intake = transitionPendingBridgeStage(intake, job.id, 'publishing', { at: '2026-09-01T18:01:00.000Z' });
  intake = transitionPendingBridgeStage(intake, job.id, 'retryable', {
    at: '2026-09-01T18:02:00.000Z', errorCode: 'deployment',
  });
  intake = transitionPendingBridgeStage(intake, job.id, 'publishing', { at: '2026-09-01T18:03:00.000Z' });
  intake = transitionPendingBridgeStage(intake, job.id, 'published', {
    at: '2026-09-01T18:04:00.000Z', result: { status: 'deployed' },
  });
  assert.equal(intake.pendingBridges[0].stage.attempts, 2);
  assert.deepEqual(intake.pendingBridges[0].stage.result, { status: 'deployed' });
});
```

- [ ] **Step 2: Run validation and confirm RED**

Run: `npm run validate`

Expected: failure because `transitionPendingBridgeStage` is not exported.

- [ ] **Step 3: Extract the common stage transition and implement the intake wrapper**

Keep the current transition rules, attempt limit, timestamp validation, error-code sanitization, and result semantics in one private `transitionStage(current, nextStatus, options)` helper. Have `transitionQueueStage` call it. Add a `replacePendingBridge` helper and export:

```js
export function transitionPendingBridgeStage(intakeState, jobId, nextStatus, options = {}) {
  validateIntakeState(intakeState);
  return replacePendingBridge(intakeState, jobId, (bridge) => ({
    ...bridge,
    stage: transitionStage(bridge.stage, nextStatus, options),
  }));
}
```

- [ ] **Step 4: Run validation and confirm GREEN**

Run: `npm run validate`

Expected: every validation passes.

- [ ] **Step 5: Commit the state primitive**

```bash
git add src/modules/state/queue-operations.mjs src/modules/validation/run-validation.mjs
git commit -m "feat: checkpoint pending bridge stages"
```

### Task 2: Make snapshot intake bounded and resumable

**Files:**
- Modify: `src/modules/validation/run-validation.mjs`
- Modify: `src/modules/publishing/orchestrator.mjs`

- [ ] **Step 1: Write failing partial-progress and resume contracts**

Extend the intake fixtures with three new jobs. Call `processIntakeSnapshots` with `maxBridgeAttempts: 1` and assert:

```js
assert.equal(first.summary.complete, false);
assert.equal(first.summary.bridges, 1);
assert.equal(first.intakeState.processedSnapshot.commit, previous.commit);
assert.equal(first.intakeState.pendingBridges[0].stage.status, 'published');
assert.equal(first.queueState.items.length, 1);
```

Call it again from `first.intakeState` and `first.queueState`. Assert that the first bridge is not redeployed, the second bridge is published, and the watermark still does not advance. A final unlimited call must publish only the remaining bridge, advance to `current.commit`, and clear the snapshot's `pendingBridges` entries.

Add a failure contract whose publisher throws an error carrying `code = 'bridge_deployment'`. Assert `summary.error === 'bridge_deployment'`, `summary.complete === false`, a retryable bridge checkpoint with one attempt, an unchanged watermark, and no queued social item.

Add a changed-content contract that starts with a checkpoint for the same job ID and an old hash, then proves the new hash replaces it before the single external attempt.

- [ ] **Step 2: Run validation and confirm RED**

Run: `npm run validate`

Expected: partial-progress assertions fail because intake currently publishes every bridge and throws on a bridge error.

- [ ] **Step 3: Implement the bounded intake state machine**

Add `maxBridgeAttempts = Number.POSITIVE_INFINITY` to `processIntakeSnapshots` and reject values other than a positive safe integer or positive infinity. For each bridge:

1. enqueue or refresh its durable checkpoint;
2. reuse a matching `published` checkpoint result without an external call;
3. stop and return `complete: false` before a new call when the attempt limit is exhausted;
4. transition the checkpoint to `publishing`, call `publishBridge`, then transition it to `published` and enqueue an eligible new social job;
5. on error, transition the checkpoint to `retryable` with `safeErrorCode(error, 'bridge')` and return the states with that code in `summary.error`;
6. after every bridge in one snapshot is accounted for, record removals, advance the watermark, and remove only that snapshot delta's completed checkpoints.

Return a stable summary shape on every path:

```js
{
  baseline: boolean,
  bridges: number,
  queued: number,
  removed: number,
  complete: boolean,
  error: string | null,
}
```

- [ ] **Step 4: Run validation and confirm GREEN**

Run: `npm run validate`

Expected: every validation passes, including all existing unbounded intake behavior.

- [ ] **Step 5: Commit resumable intake**

```bash
git add src/modules/publishing/orchestrator.mjs src/modules/validation/run-validation.mjs
git commit -m "feat: make social intake resumable"
```

### Task 3: Persist one intake attempt per CLI invocation

**Files:**
- Modify: `src/modules/validation/run-validation.mjs`
- Modify: `src/cli/intake.mjs`

- [ ] **Step 1: Write the failing CLI persistence contract**

Import `runIntake`. In a temporary state directory, save previous intake, empty queue, and empty publications state. Stub commit listing, snapshots, wordmark loading, and bridge publishing. Invoke `runIntake({ maxBridgeAttempts: 1, ... })`, reload the two changed state files, and assert one durable published checkpoint, one queued job, the old watermark, and a structured log with `complete: false`.

Invoke the same fixture with a bridge publisher that throws and assert the function resolves, the retryable checkpoint is written, and `summary.error` is logged without credential text.

- [ ] **Step 2: Run validation and confirm RED**

Run: `npm run validate`

Expected: the CLI ignores `maxBridgeAttempts` and the persistence assertions fail.

- [ ] **Step 3: Pass the limit into the orchestrator**

Add `maxBridgeAttempts = 1` to `runIntake`, pass it to `processIntakeSnapshots`, and keep saving intake/queue before logging. The direct CLI calls `runIntake` with its one-attempt default. Include all orchestrator summary fields unchanged in the final JSON log.

- [ ] **Step 4: Run validation and confirm GREEN**

Run: `npm run validate`

Expected: every validation passes.

- [ ] **Step 5: Commit the CLI checkpoint behavior**

```bash
git add src/cli/intake.mjs src/modules/validation/run-validation.mjs
git commit -m "feat: persist one intake attempt per run"
```

### Task 4: Publish before an eight-checkpoint intake loop

**Files:**
- Modify: `src/modules/validation/run-validation.mjs`
- Modify: `.github/workflows/publish-social.yml`

- [ ] **Step 1: Write the failing workflow-order contract**

Update the production-workflow validation to assert this strict order:

```js
const publicationIndex = productionWorkflow.indexOf('Publish at most one queued job');
const publicationCommitIndex = productionWorkflow.indexOf('Commit and push publication or reset state');
const intakeIndex = productionWorkflow.indexOf('Process and checkpoint bounded snapshot intake');
assert.ok(publicationIndex < publicationCommitIndex);
assert.ok(publicationCommitIndex < intakeIndex);
```

Extract the intake step and assert it contains `for iteration in {1..8}`, calls `npm run intake`, commits `state/intake.json state/queue.json` inside the loop, stops on `complete`, stops and records an error on `error`, and retains the existing fetch/rebase/validate/push recovery. Assert a later guard step uses `steps.intake.outputs.error` and `exit 1`.

- [ ] **Step 2: Run validation and confirm RED**

Run: `npm run validate`

Expected: workflow ordering and bounded-loop assertions fail against the current intake-first workflow.

- [ ] **Step 3: Reorder and checkpoint the workflow**

Move the existing publication, publication-state commit, and Instagram Story sequence before intake. Replace the old intake plus separate intake commit with one `id: intake` step named `Process and checkpoint bounded snapshot intake` that:

```bash
for iteration in {1..8}; do
  npm run intake -- --data "$DATA_PATH" --state state \
    --wordmark "$WEB_PATH/public/openings-wordmark-light.svg" \
    --output ".tmp/intake-$iteration" | tee .tmp/intake-summary.txt
  summary="$(tail -n 1 .tmp/intake-summary.txt)"
  git add -- state/intake.json state/queue.json
  if ! git diff --cached --quiet; then
    git commit -m 'chore(state): checkpoint social intake [skip ci]'
    git push origin "HEAD:${GITHUB_REF_NAME}" || {
      git fetch origin "$GITHUB_REF_NAME"
      git rebase "origin/$GITHUB_REF_NAME"
      npm run validate
      git push origin "HEAD:${GITHUB_REF_NAME}"
    }
  fi
  complete="$(node -e \
    'process.stdout.write(String(JSON.parse(process.argv[1]).complete === true))' \
    "$summary")"
  error="$(node -e \
    'process.stdout.write(JSON.parse(process.argv[1]).error ?? "")' \
    "$summary")"
  if [[ -n "$error" ]]; then
    echo "error=$error" >> "$GITHUB_OUTPUT"
    break
  fi
  if [[ "$complete" == 'true' ]]; then
    break
  fi
done
```

Add a final scheduled-only guard after the loop so a retryable bridge failure marks the run failed only after its checkpoint has been pushed.

- [ ] **Step 4: Run validation and confirm GREEN**

Run: `npm run validate`

Expected: every validation passes and the static workflow contract confirms provider-first ordering.

- [ ] **Step 5: Commit workflow recovery**

```bash
git add .github/workflows/publish-social.yml src/modules/validation/run-validation.mjs
git commit -m "fix: prevent intake from starving social posts"
```

### Task 5: Verify, push, and observe a real scheduled publication

**Files:**
- Verify only: tracked repository files and generated `.tmp` artifacts
- External state: GitHub `main`, Actions run, social provider results

- [ ] **Step 1: Run complete local verification**

Run:

```bash
npm run validate
npm run dry-run -- --data ../data-pipeline --state state \
  --wordmark ../web/public/openings-wordmark-light.svg \
  --output .tmp/resumable-intake-final
git diff --check
git status --short --branch
```

Expected: validation passes, dry-run emits one review artifact without external writes, diff check is clean, and only the planned local commits are ahead of `origin/main`.

- [ ] **Step 2: Review the micro-commit sequence**

Run: `git log --oneline origin/main..main`

Expected: design, plan, state primitive, orchestrator, CLI, and workflow commits are separated and ordered.

- [ ] **Step 3: Push `main`**

Run: `git push origin main`

Expected: remote `main` advances without force-push.

- [ ] **Step 4: Dispatch the scheduled mode and follow it to completion**

Run:

```bash
gh workflow run publish-social.yml --repo openings-dev/social-publisher \
  --ref main -f mode=scheduled
gh run list --repo openings-dev/social-publisher \
  --workflow publish-social.yml --limit 1
```

Follow the returned run until completion. Expected: the provider publication and publication-state commit occur before bounded intake.

- [ ] **Step 5: Confirm provider results and remote state**

Pull/fetch the state-only commits produced by the workflow, inspect the selected queue entry and publication record, and confirm at least Bluesky and Mastodon have `published` results with public URLs/identifiers. Confirm the intake watermark or `pendingBridges` checkpoint advanced during the same run and no secrets were written to tracked state.

- [ ] **Step 6: Report the outcome**

Provide the pushed commit range, Actions run URL, selected job ID, public social URLs available in state, intake progress, and any provider that remains retryable. Do not claim recovery until the remote state and run logs provide that evidence.
