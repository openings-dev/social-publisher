# OneSignal Two-Per-Day Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Limit new-job OneSignal broadcasts to two per Sao Paulo civil day.

**Architecture:** Preserve the durable state policy while applying a permanent code ceiling of two in the push orchestrator. Compare intent timestamps in `America/Sao_Paulo`, update the seed state, and separately migrate the live `push-state` branch.

**Tech Stack:** Node.js ESM, `node:test`, GitHub Actions durable state branch.

---

### Task 1: Add a failing daily-limit regression

**Files:**
- Modify: `test/push-orchestrator.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a test that keeps the persisted policy at 10, adds two counted intents whose
UTC timestamps fall on the same Sao Paulo date, and expects a third intent to be
blocked with `reason: "daily_cap"`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/push-orchestrator.test.mjs`

Expected: the new test fails because the current effective cap remains 10 and day
comparison uses UTC.

- [ ] **Step 3: Commit the failing regression**

```bash
git add test/push-orchestrator.test.mjs
git commit -m "test(push): cap daily OneSignal broadcasts"
```

### Task 2: Enforce the permanent Sao Paulo cap

**Files:**
- Modify: `src/modules/push/push-orchestrator.mjs`
- Modify: `state/push.json`
- Test: `test/push-orchestrator.test.mjs`

- [ ] **Step 1: Implement localized day comparison**

Replace the UTC string-slice day helper with an `Intl.DateTimeFormat` configured
for `America/Sao_Paulo`, and compare every counted intent through that helper.

- [ ] **Step 2: Apply the permanent maximum**

Define a maximum of 2 and block preparation when the counted total reaches
`Math.min(next.policy.dailyCap, MAX_DAILY_PUSHES)`.

- [ ] **Step 3: Update the repository seed state**

Change only `state/push.json` policy `dailyCap` from 10 to 2. Preserve every
intent and all other state fields byte-for-byte.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/push-orchestrator.test.mjs test/push-intake.test.mjs`

Expected: all focused push tests pass.

- [ ] **Step 5: Run complete validation**

Run: `npm run validate` with Node and `ffmpeg` available on `PATH`.

Expected: all platform, artwork, and repository validations pass.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/modules/push/push-orchestrator.mjs state/push.json
git commit -m "fix(push): limit OneSignal to two daily broadcasts"
```

### Task 3: Apply the live production policy and publish

**Files:**
- Modify on `push-state`: `state/push.json`

- [ ] **Step 1: Update isolated production state**

Create an isolated worktree at `origin/push-state`, change only
`policy.dailyCap` from 10 to 2, validate the resulting JSON with
`validatePushState`, and commit the exact state change.

- [ ] **Step 2: Publish the state branch**

Push the state commit normally to `push-state` without force. This makes the
existing production runtime stop after two counted notifications on the current
Sao Paulo day.

- [ ] **Step 3: Publish application code**

Update against the latest `origin/main`, rerun complete validation, and push the
linear, reviewed commits to `main` without force.

- [ ] **Step 4: Verify remote refs**

Confirm `origin/main` and `origin/push-state` match the locally verified commits.
