# Social Publisher Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore scheduled social publication by supporting the reviewed data schemas, preventing terminal bridge failures from starving healthy queue items, and propagating piped command failures in GitHub Actions.

**Architecture:** Keep snapshot compatibility bounded to explicitly reviewed versions. Centralize regular queue eligibility in `queue-operations.mjs` so both selection and preflight use one rule, while leaving Instagram Story readiness independent. Configure the workflow's run shell once so every `tee` pipeline inherits Bash `pipefail` behavior.

**Tech Stack:** Node.js 20 ES modules, deterministic `node:assert` validation contracts, GitHub Actions YAML, Git micro-commits.

---

## File structure

- `src/modules/data/load-snapshot.mjs`: owns the reviewed snapshot-schema compatibility boundary.
- `src/modules/state/queue-operations.mjs`: owns regular social queue eligibility and ordering.
- `src/modules/publishing/scheduled-work.mjs`: consumes the shared eligibility rule when calculating scheduled queue depth.
- `src/modules/validation/run-validation.mjs`: contains all regression contracts and static workflow checks.
- `.github/workflows/publish-social.yml`: selects explicit Bash semantics for every run step.

### Task 1: Support reviewed snapshot schemas

**Files:**
- Modify: `src/modules/validation/run-validation.mjs`
- Modify: `src/modules/data/load-snapshot.mjs`

- [ ] **Step 1: Write the failing compatibility contracts**

Extend the snapshot loader contracts immediately after `loads one complete immutable data snapshot`:

```js
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
```

- [ ] **Step 2: Run validation and verify RED**

Run:

```bash
PATH=/Users/guilherme/.nvm/versions/node/v20.19.5/bin:$PATH npm run validate
```

Expected: FAIL in `loads every reviewed data snapshot schema` with `Unsupported data schemaVersion: 5`.

- [ ] **Step 3: Implement the bounded compatibility set**

Replace the scalar version constant and equality check:

```js
const SUPPORTED_SCHEMA_VERSIONS = new Set([4, 5, 6]);

if (!SUPPORTED_SCHEMA_VERSIONS.has(manifest.schemaVersion)) {
  throw new Error(`Unsupported data schemaVersion: ${String(manifest.schemaVersion)}`);
}
```

Keep all existing manifest, page, ID, job, hash, and timestamp validation unchanged.

- [ ] **Step 4: Run validation and verify GREEN**

Run the same validation command. Expected: every deterministic contract passes.

- [ ] **Step 5: Commit the schema fix**

```bash
git add src/modules/data/load-snapshot.mjs src/modules/validation/run-validation.mjs
git commit -m "fix: support current data snapshot schemas"
```

### Task 2: Prevent failed bridges from starving the queue

**Files:**
- Modify: `src/modules/validation/run-validation.mjs`
- Modify: `src/modules/state/queue-operations.mjs`
- Modify: `src/modules/publishing/scheduled-work.mjs`

- [ ] **Step 1: Write the failing selection and preflight regression**

Add a contract after the queue-priority validations. Build two enqueued jobs, replace the older item's bridge with a valid terminal failure, and assert both queue selection and preflight ignore it:

```js
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
```

Use the existing imports for `MAX_CHANNEL_ATTEMPTS`, `decideScheduledWork`,
`resetFailedStage`, and the other queue operations; add them only if the current
import list does not already expose them.

- [ ] **Step 2: Run validation and verify RED**

Run the full validation command. Expected: FAIL because the blocked job is still selected or queue depth is `2`.

- [ ] **Step 3: Centralize regular publication eligibility**

Export the eligibility rule from `queue-operations.mjs`:

```js
export function isReadyQueueItem(item) {
  if (READY_STATUSES.has(item.bridge.status)) return true;
  return item.bridge.status === 'published'
    && SOCIAL_CHANNELS.some((channel) => READY_STATUSES.has(item[channel].status));
}
```

Use `isReadyQueueItem` inside `selectNextQueueItem`. In `scheduled-work.mjs`, import it from `queue-operations.mjs` and remove the duplicate local regular-item rule. Keep Story readiness unchanged.

- [ ] **Step 4: Run validation and verify GREEN**

Run the full validation command. Expected: all contracts pass, including the new poison-item regression.

- [ ] **Step 5: Commit the queue fix**

```bash
git add src/modules/state/queue-operations.mjs src/modules/publishing/scheduled-work.mjs src/modules/validation/run-validation.mjs
git commit -m "fix: skip queue items blocked by failed bridges"
```

### Task 3: Make piped workflow failures visible

**Files:**
- Modify: `src/modules/validation/run-validation.mjs`
- Modify: `.github/workflows/publish-social.yml`

- [ ] **Step 1: Write the failing workflow contract**

In the workflow validation that reads `publish-social.yml`, assert an explicit Bash default:

```js
assert.match(
  productionWorkflow,
  /^defaults:\n  run:\n    shell: bash$/mu,
);
```

- [ ] **Step 2: Run validation and verify RED**

Run the full validation command. Expected: FAIL because the workflow has no explicit Bash default.

- [ ] **Step 3: Configure explicit Bash semantics**

Add this top-level block after `concurrency` and before `jobs`:

```yaml
defaults:
  run:
    shell: bash
```

GitHub Actions invokes an explicitly selected Bash shell with `-e -o pipefail`, so `npm ... | tee ...` now preserves the npm command's failure status.

- [ ] **Step 4: Run validation and verify GREEN**

Run the full validation command. Expected: every contract passes.

- [ ] **Step 5: Commit the workflow fix**

```bash
git add .github/workflows/publish-social.yml src/modules/validation/run-validation.mjs
git commit -m "fix: propagate social workflow pipeline failures"
```

### Task 4: Retire closed queue entries before selection

**Files:**
- Modify: `src/modules/validation/run-validation.mjs`
- Modify: `src/modules/state/queue-operations.mjs`
- Modify: `src/modules/publishing/orchestrator.mjs`
- Modify: `src/cli/dry-run.mjs`

- [ ] **Step 1: Write a failing publication regression**

Create a queue with a starving stale job and a healthy open job. Give both a
published bridge, provide a current snapshot containing only the healthy job,
and call `processOnePublication`. Assert that the stale stages become
`skipped_closed`, the healthy job is selected, and its providers publish during
the same call.

- [ ] **Step 2: Run validation and verify RED**

Run the full validation command. Expected: FAIL because the existing
orchestrator returns `skipped_closed` after selecting only the stale job.

- [ ] **Step 3: Normalize missing jobs before automatic selection**

Add `markMissingJobsClosed(queueState, openJobIds, at)` to
`queue-operations.mjs`. It must validate the timestamp and state, convert the
iterable of current IDs to a `Set`, and call `markJobClosed` for every missing
queue item. Use it in scheduled `processOnePublication` before
`selectNextQueueItem`, and in `runSnapshotDryRun` on an in-memory queue copy
before dry-run selection. Preserve the existing controlled-job behavior.

- [ ] **Step 4: Run validation and the real schema-6 dry-run**

Run the full validation command, then the schema-6 dry-run command from the
verification task. Expected: both pass, and the dry-run selects an open job.

- [ ] **Step 5: Commit the closed-item fix**

```bash
git commit -m "fix: retire closed jobs before queue selection" -- src/modules/state/queue-operations.mjs src/modules/publishing/orchestrator.mjs src/cli/dry-run.mjs src/modules/validation/run-validation.mjs
```

### Task 5: Full recovery verification

**Files:**
- Verify only; do not commit generated `.tmp` artifacts.

- [ ] **Step 1: Run the complete deterministic suite**

```bash
PATH=/Users/guilherme/.nvm/versions/node/v20.19.5/bin:$PATH npm run validate
```

Expected: all deterministic contracts pass with no errors.

- [ ] **Step 2: Exercise the real schema-6 data checkout in dry-run mode**

```bash
PATH=/Users/guilherme/.nvm/versions/node/v20.19.5/bin:$PATH npm run dry-run -- --data ../data-pipeline --state state --wordmark ../web/public/openings-wordmark-light.svg --output .tmp/recovery-dry-run
```

Expected: the command completes, selects or reports the next eligible item, and renders review artifacts without external writes.

- [ ] **Step 3: Verify repository integrity**

```bash
git diff --check
rg -n '<<<<<<<|=======|>>>>>>>' . --glob '!node_modules/**' --glob '!.git/**'
git status --short --branch
git log --oneline --decorate -8
```

Expected: no whitespace errors, no merge markers, no unexpected tracked changes, and separate schema, queue, and workflow commits after the design and plan commits.

- [ ] **Step 4: Confirm no external mutation**

Do not run a controlled publication, retry-stage operation, workflow dispatch, or `git push`. Report that deploying the local commits is required before production scheduling can recover.
