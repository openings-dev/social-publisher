# Social Publisher Recovery Design

## Goal

Restore scheduled social publishing without losing the LinkedIn or Instagram
Stories/Editorial work already being integrated into `main`. The recovery must
prevent one failed bridge from starving the queue, consume the reviewed data
schemas used by the data pipeline, and make command failures fail the GitHub
Actions job.

## Integration strategy

The active merge is completed in place. Conflicts combine both feature sets:
LinkedIn remains a regular social channel, while Instagram Stories retain their
separate durable intent and publication flow. Tracked queue and publication
state contain both `linkedin` and `instagramStory` fields. When the current
remote state is merged afterward, its provider results and attempt history are
authoritative; only the new channel fields are added to those records.

No history is rewritten. The integration merge and each recovery concern are
committed separately on `main`. Nothing is pushed.

## Snapshot compatibility

The snapshot loader accepts data schema versions 4, 5, and 6. These versions
share every field consumed by the publisher; versions 5 and 6 only extend the
manifest and job records with data that the publisher does not use. All existing
field-level validation remains active, and any version outside the reviewed set
is rejected.

Regression contracts load representative manifests for versions 5 and 6 and
continue to reject an unknown future version.

## Queue eligibility

A regular social publication is automatically eligible in either case:

1. its bridge is `pending` or `retryable`; or
2. its bridge is `published` and at least one enabled social channel is
   `pending` or `retryable`.

Social stages behind a terminally failed bridge remain untouched so an operator
can explicitly reset and recover the bridge. They are not selected by scheduled
work and therefore cannot block a healthy item behind them. Controlled mode can
still target the failed item and receives the existing `bridge_unavailable`
outcome until it is reset.

The preflight queue-depth calculation uses the same eligibility rule as the
publisher. Instagram Story readiness remains independent and still requires its
published Instagram and bridge prerequisites.

Regression contracts cover a failed-bridge poison item followed by a healthy
item, the matching preflight depth, and manual recovery compatibility.

## Closed queue entries

Before automatic selection, the publisher compares queued IDs with the current
immutable snapshot and marks every missing job `skipped_closed` in one state
transition. It then selects an open item during the same run, so a batch of
closed jobs cannot consume multiple scheduled cycles. Snapshot dry-runs apply
the same normalization in memory, without persisting state.

A regression contract starts with a stale starving item followed by an open
item and proves that the stale stages are closed while the open item is
published in the same operation.

## Workflow failure propagation

The social workflow explicitly uses Bash for all `run` steps. GitHub Actions
then invokes Bash with `-e -o pipefail`, so failures from intake, publication, or
Meta migration commands are not hidden by `tee`. A static validation contract
protects this workflow setting.

## State recovery

The failed bridge record is preserved with its attempt and error history. It is
not silently reset because doing so could repeat an external deployment without
operator intent. Once the fixes are deployed, the remaining healthy queue can
advance. The existing controlled reset command remains the recovery path for the
failed bridge.

## Verification

Each behavior change follows a red-green cycle in the deterministic validation
suite. Final verification includes the complete validation command, dry-run
artifact generation, tracked-state validation, workflow conflict scans,
`git diff --check`, and a final review of the micro-commit sequence. External
publication and push operations are outside this work.
