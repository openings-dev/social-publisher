# Intake bridge recovery design

## Problem

Snapshot intake stops permanently when a pending bridge reaches the three-attempt limit. The existing
`retry-stage` operation can reset a failed `bridge` on a publication queue item, but it cannot reset a
failed bridge stored in `state/intake.json`. Scheduled runs therefore preserve the failure and exit on
every subsequent attempt without retrying the deploy.

## Considered approaches

1. Add an explicit `intake-bridge` retry stage. This is unambiguous and preserves the existing manual
   confirmation gate.
2. Make `bridge` inspect both state files and choose a matching failure. This is shorter for operators
   but becomes ambiguous if the same job has failures in both places.
3. Automatically reset failed intake bridges on scheduled runs. This defeats the attempt limit and can
   create an infinite retry loop for persistent deploy failures.

Use approach 1.

## Behavior

- Add `intake-bridge` to the workflow's retry-stage choices and request parser.
- A retry-stage request for `intake-bridge` requires the existing exact confirmation
  `RESET_FAILED_STAGE` and a valid job ID.
- Reset only a matching failed pending bridge in `state/intake.json` to `pending`, with attempts cleared,
  the reset timestamp recorded, and reason `manual_reset`.
- Reject missing jobs and stages that are not currently failed.
- Persist and commit `state/intake.json`. The recovery operation never publishes or deploys by itself.
- Keep the existing `bridge` behavior for publication queue items unchanged.

## Verification

- A regression contract reproduces a failed pending bridge and proves that `intake-bridge` resets only
  that intake record.
- Existing queue-stage recovery contracts continue to pass.
- Workflow validation proves the new option and intake-state commit path are present.
- After deployment, run the guarded recovery for the blocked job and then one scheduled cycle. Confirm
  that intake advances or reports a new concrete deployment failure rather than remaining permanently
  failed without an attempt.
