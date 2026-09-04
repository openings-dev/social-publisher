# Bound scheduled intake FTP pressure

## Problem

One scheduled Social Publisher run can perform eight snapshot-intake iterations. Each successful
iteration can dispatch a separate incremental `web-deploy` workflow and therefore open a new FTP
session against Hostinger.

Run `33894510734` completed four incremental deployments in sequence. Its fifth deployment,
`gh_2ae9c1200647b294684ff5fd`, reached the Hostinger control channel but every data transfer stalled
while uploading the first Open Graph image. All eight retries in `web-deploy` failed with
`max-retries exceeded`. The Social Publisher correctly preserved that intake bridge as `retryable`,
but then reported the deployment error after its bounded public-verification window.

Increasing the retry count again would keep one runner occupied longer without reducing the burst
of independent FTP sessions. Ignoring the intake error would hide a real publication dependency
failure.

## Design

Limit scheduled snapshot intake to four iterations per workflow run.

- The publication phase remains unchanged and still publishes at most one queued job.
- Each intake iteration continues to checkpoint `state/intake.json` and `state/queue.json` before the
  next iteration.
- A run that reaches the four-iteration limit without completing the snapshot exits successfully
  with `complete: false`. The next scheduled run resumes from the committed checkpoint.
- A real deployment error still stops the loop, preserves the `retryable` bridge, and fails the run.
- Manual controlled publication and recovery modes remain unchanged.

This bounds incremental FTP session pressure without weakening error visibility or state safety.
Four is based on the observed safe batch in the failing run and keeps intake throughput above the
single social publication processed by each scheduled cycle.

## Verification

- The workflow contract must reject the previous eight-iteration loop and require exactly four.
- The complete deterministic validation suite must pass.
- The existing retryable bridge must be retried only after the current full deployment is no longer
  using Hostinger FTP.
- A proof scheduled run must publish normally, resume intake from the checkpoint, and finish green.
