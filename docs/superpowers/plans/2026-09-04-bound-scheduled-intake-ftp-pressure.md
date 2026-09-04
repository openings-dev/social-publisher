# Bound Scheduled Intake FTP Pressure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent one scheduled Social Publisher run from opening more than four sequential incremental FTP deployment sessions.

**Architecture:** Keep the existing resumable intake and per-iteration state checkpoints. Change only the workflow batch bound from eight to four, while preserving the existing behavior that real deployment errors are stored and surfaced.

**Tech Stack:** GitHub Actions YAML, Node.js deterministic contract validation.

---

### Task 1: Add the failing workflow contract

**Files:**
- Modify: `src/modules/validation/run-validation.mjs:6435`

- [ ] **Step 1: Replace the old eight-iteration assertion with the required bound**

```js
assert.match(intakeStep, /for iteration in \{1\.\.4\}/u);
assert.doesNotMatch(intakeStep, /for iteration in \{1\.\.8\}/u);
```

- [ ] **Step 2: Run the contract suite and verify RED**

Run:

```bash
PATH=/Users/guilherme/.nvm/versions/node/v20.19.5/bin:$PATH npm run validate
```

Expected: FAIL because `.github/workflows/publish-social.yml` still contains
`for iteration in {1..8}`.

- [ ] **Step 3: Commit the regression contract**

```bash
git add src/modules/validation/run-validation.mjs
git commit -m "test(intake): reproduce excessive FTP deployment burst"
```

### Task 2: Apply the minimal workflow fix

**Files:**
- Modify: `.github/workflows/publish-social.yml:364`

- [ ] **Step 1: Bound one scheduled intake batch to four iterations**

```bash
for iteration in {1..4}; do
```

- [ ] **Step 2: Run the contract suite and verify GREEN**

Run:

```bash
PATH=/Users/guilherme/.nvm/versions/node/v20.19.5/bin:$PATH npm run validate
```

Expected: PASS with all deterministic contracts validated.

- [ ] **Step 3: Run the complete local dry-run**

Run:

```bash
PATH=/Users/guilherme/.nvm/versions/node/v20.19.5/bin:$PATH npm run dry-run
```

Expected: PASS and list the five generated social artifacts.

- [ ] **Step 4: Commit the production change**

```bash
git add .github/workflows/publish-social.yml
git commit -m "fix(intake): bound incremental FTP pressure"
```

### Task 3: Recover and prove production

**Files:**
- State commits produced by GitHub Actions: `state/intake.json`, `state/queue.json`, `state/publications.json`

- [ ] **Step 1: Wait until the already-running full web deployment releases the Hostinger FTP session**

Run:

```bash
gh run view 33901348352 --repo openings-dev/web-deploy --json status,conclusion,url
```

Expected: `status` is `completed` before retrying Social Publisher.

- [ ] **Step 2: Push the micro-commits to `main` and require the validation workflow to pass**

Run:

```bash
git push origin main
gh run list --repo openings-dev/social-publisher --workflow validate.yml --limit 1
```

Expected: the run for the fix commit concludes successfully.

- [ ] **Step 3: Dispatch one scheduled proof cycle**

Run:

```bash
gh workflow run publish-social.yml --repo openings-dev/social-publisher --ref main -f mode=scheduled
```

Expected: the retryable bridge `gh_2ae9c1200647b294684ff5fd` becomes published or already current, no intake error is emitted, and the workflow concludes successfully.

- [ ] **Step 4: Synchronize generated state and run final verification**

Run:

```bash
git fetch origin main
git merge --ff-only origin/main
PATH=/Users/guilherme/.nvm/versions/node/v20.19.5/bin:$PATH npm run validate
git status --short --branch
```

Expected: all deterministic contracts pass and local `main` is clean and synchronized with `origin/main`.
