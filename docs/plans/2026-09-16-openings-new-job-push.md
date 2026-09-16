# Openings new-job push implementation plan

**Goal:** Add a disabled-by-default, durable OneSignal channel for genuinely new
Openings jobs without coupling it to website or social publication.

**Architecture:** A dedicated GitHub Actions workflow consumes the same immutable
data history as social intake, but owns `state/push.json` and a small push-only
orchestrator. It persists an immutable intent and UUID before calling OneSignal,
sends at most one request per run, and checkpoints the provider result with the
existing Git writer/concurrency boundary. Mobile accepts only versioned `{ jobId }`
additional data and routes validated clicks to the existing job detail screen.

## Task 1: Lock the push state and eligibility contract

- [ ] Add failing tests for schema validation, activation boundary, new-only
  intake, updates/closures/duplicates, daily cap, maximum age, and push-only work.
- [ ] Implement a versioned push state with durable pending, accepted, failed,
  uncertain, and skipped outcomes.
- [ ] Persist exact payload, audience version, source identity, activation
  boundary, creation time, and a stable UUID before any provider request.

## Task 2: Add the OneSignal adapter and bounded orchestrator

- [ ] Add failing tests for accepted, no-recipient, 429/Retry-After,
  authentication/configuration failure, timeout ambiguity, and idempotent retry.
- [ ] Implement a redacting OneSignal client that reuses the saved UUID and never
  claims provider acceptance as device delivery.
- [ ] Process at most one new request per invocation and never mint a replacement
  UUID after the provider idempotency window.

## Task 3: Add the independent workflow

- [ ] Add a push-only CLI and preflight that recognizes pending work independently
  from all social stages and title-review holds.
- [ ] Add a disabled-by-default workflow with the existing serialized Git writer,
  immutable data checkout, state checkpoints, manual test-subscription gate, and
  no Worker adapter activation.
- [ ] Record the old-sender inventory and the external activation gates.

## Task 4: Upgrade mobile consent and safe navigation

- [ ] Make the existing editorial consent document obsolete so every historical
  choice receives the reviewed new-job explanation in all six locales.
- [ ] Add withdrawal without affecting browsing or other local state.
- [ ] Validate the versioned click payload, register and remove the exact SDK
  listener, ignore foreground receipt, and route foreground/background/cold-start
  clicks to the existing job detail screen only after navigation is ready.
- [ ] Cover missing/closed/offline behavior through the existing recoverable job
  detail states.

## Task 5: Verify without activating production

- [ ] Run publisher validation and mobile JavaScript checks.
- [ ] Run Android debug build and record any host-tool blocker separately.
- [ ] Update privacy/release evidence without inventing account, Play, MAU, FCM,
  credential, or physical-device proof.
- [ ] Keep broadcast disabled until an owner-controlled subscription canary and
  all external Free-plan and release gates pass.
