# Transient Deploy Dispatch Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover transient GitHub deployment dispatch failures in-place without duplicating completed social publications.

**Architecture:** Keep bridge rendering, state checkpoints, and public verification unchanged. Isolate the GitHub `repository_dispatch` call behind a bounded retry that retries only transport errors, HTTP 429, and HTTP 5xx responses, then reports a stable bridge error code if attempts are exhausted.

**Tech Stack:** Node.js 20 ESM, native Fetch API, `node:assert`, GitHub Actions.

---

### Task 1: Specify bounded dispatch retries

**Files:**
- Modify: `src/modules/validation/run-validation.mjs`
- Test: `src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write a failing validation for a transient transport failure**

Extend the existing `skips current bridges and dispatches stale bridges exactly once` validation with a request whose first `fetchImpl` call throws and whose second call returns `204`. Inject `sleep: async (delay) => delays.push(delay)`, `dispatchAttempts: 2`, `dispatchRetryDelayMs: 25`, and assert two dispatch calls, one delay of `25`, and a deployed result.

- [ ] **Step 2: Write a failing validation for HTTP retry classification**

Add cases showing that HTTP `503` is retried before a successful `204`, while HTTP `403` is rejected after one call. Assert that exhausted HTTP `503` attempts throw an error with `code === 'bridge_dispatch'` and do not include the token.

- [ ] **Step 3: Run validation and verify RED**

Run: `npm run validate`

Expected: FAIL because `requestIncrementalBridgeDeployment` does not recognize `dispatchAttempts` or retry a failed dispatch.

- [ ] **Step 4: Commit the regression specification**

```bash
git add src/modules/validation/run-validation.mjs
git commit -m "test(deploy): cover transient dispatch recovery"
```

### Task 2: Implement bounded dispatch recovery

**Files:**
- Modify: `src/modules/deploy/web-deploy-client.mjs`

- [ ] **Step 1: Add dispatch retry helpers**

Add constants for the default attempt count and delay, a `bridgeDispatchError(message)` helper that assigns `error.code = 'bridge_dispatch'`, a status classifier that retries `429` and `500..599`, and a delay selector that honors a numeric `Retry-After` response header.

- [ ] **Step 2: Replace the single dispatch request with a bounded loop**

Extend `requestIncrementalBridgeDeployment` with injectable `dispatchAttempts = 3` and `dispatchRetryDelayMs = 2_000`. Validate and cap attempts, reuse the existing injected `sleep`, retry only the classified transient cases, return on `204`, and throw `bridge_dispatch` immediately for permanent responses or after exhaustion.

- [ ] **Step 3: Run validation and verify GREEN**

Run: `npm run validate`

Expected: PASS with all deterministic contracts validated.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/modules/deploy/web-deploy-client.mjs
git commit -m "fix(deploy): retry transient dispatch failures"
```

### Task 3: Verify and recover the preserved bridge

**Files:**
- Verify: `state/intake.json`
- Verify: `.github/workflows/publish-social.yml`

- [ ] **Step 1: Run fresh repository verification**

Run: `npm run validate`

Expected: exit code `0` and no failed deterministic contracts.

- [ ] **Step 2: Confirm the worktree contains only intended commits**

Run: `git status --short --branch && git log -4 --oneline`

Expected: clean `main`, ahead of `origin/main` only by the documentation, regression, and implementation micro-commits.

- [ ] **Step 3: Push `main`**

Run: `git push origin main`

Expected: the new commits are accepted by `origin/main`.

- [ ] **Step 4: Dispatch the scheduled recovery workflow**

Run: `gh workflow run publish-social.yml --repo openings-dev/social-publisher -f mode=scheduled`

Expected: one new `Publish social jobs` run starts on the pushed `main` revision.

- [ ] **Step 5: Monitor the recovery and inspect final state**

Wait for the new run, confirm a successful conclusion, synchronize `main`, and verify that `gh_785da28a609b497462469c95` is no longer a retryable pending bridge. Confirm the previously completed publication IDs remain unchanged.
