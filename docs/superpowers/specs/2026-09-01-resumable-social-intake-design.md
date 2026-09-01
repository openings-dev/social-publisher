# Resumable Social Intake Design

## Goal

Keep scheduled social publishing active while the data pipeline has a large
snapshot backlog or the public job-page deployment is slow or temporarily
unavailable. Every scheduled run must publish at most one already-ready job
before doing bounded intake work, and successful intake work must survive a
later bridge failure or workflow interruption.

The change remains inside the existing free infrastructure: GitHub Actions,
the current `web-deploy` workflow, and the configured social-provider APIs. It
does not add a hosted queue, paid scheduler, database, or third-party service.

## Current failure

The scheduled workflow currently performs the complete snapshot intake before
calling any social provider. The unprocessed range contains 19 snapshots and
139 new or changed job bridges. A bridge deployment can take two to three
minutes, while the workflow has a 120-minute timeout.

Intake saves `state/intake.json` and `state/queue.json` only after every bridge
has completed. A timeout or one failed FTP upload therefore discards all local
intake progress. The next run repeats the same bridge checks and still does not
reach Bluesky, Mastodon, Threads, or Instagram, even though publishable entries
already exist in the durable queue.

## Scheduled workflow order

A scheduled run uses this order:

1. Preflight detects queued publications, pending intake, or both.
2. If a publishable queue item exists, publish at most one item first.
3. Commit and push publication state before starting intake.
4. Process one bridge attempt from the oldest unprocessed snapshot range.
5. Commit and push its intake and queue checkpoint.
6. Repeat steps 4 and 5 up to eight times while work remains and no bridge has
   failed.
7. If intake recorded a retryable bridge error, mark the workflow unsuccessful
   only after the checkpoint commit so monitoring remains truthful without
   losing progress.

The publication phase remains skipped when there is no eligible queue item.
The intake phase remains skipped for dry-run, controlled, retry-stage, and Meta
migration modes.

## Resumable intake state

`pendingBridges` becomes the durable checkpoint for the snapshot currently
being processed. A bridge entry is enqueued before its external deployment and
kept after success with its stage result marked `published`. A retryable
deployment failure is stored as `retryable` with the existing safe error code.

On the next run, intake deterministically recalculates the same snapshot delta:

- a matching `published` bridge is reused without another deployment;
- a matching `pending` or `retryable` bridge consumes one attempt from the
  per-run budget;
- a bridge whose content hash changed replaces the stale checkpoint;
- a successful eligible new job is added to the social queue and receives the
  persisted bridge result;
- changed jobs update their public bridge but are not incorrectly enqueued as
  newly discovered jobs.

The processed snapshot watermark advances only after every bridge in that
snapshot delta is published or otherwise fully accounted for. At that point,
its temporary bridge checkpoints are removed and removed-job bookkeeping is
applied. A partially processed snapshot leaves the watermark unchanged and the
checkpoint entries intact.

No schema migration is needed because `pendingBridges` and its validated stage
model already exist in schema version 3. Existing empty state remains valid.

## Intake budget and selection

The intake CLI processes at most one external bridge attempt per invocation.
The scheduled workflow invokes it up to eight times, committing after every
invocation. Reused published checkpoints do not consume an iteration because
they require no external write; the command advances past them until it finds
one external attempt or finishes the snapshot range.

Eight attempts keep a typical run well below the two-hour job timeout while
allowing up to 96 bridge attempts per day on the existing two-hour schedule.
The oldest unprocessed snapshot and its deterministic bridge order always take
priority, preventing newer snapshots from starving older work.

## Error handling

Bridge errors are isolated to the affected checkpoint. The intake command
saves the resulting retryable state and emits a machine-readable summary with
the processed count, remaining work, and whether an error occurred. It does not
continue hammering the same failed bridge during one run.

The workflow commits that state with its existing rebase-and-validate retry.
Only afterward does a guard step fail the run when the summary reports an
error. Provider publication failures continue to use the existing retryable
queue stages and are committed before the workflow exits.

If the workflow is externally cancelled during a single bridge deployment or
before the immediately following commit, public verification on the next run
safely reconciles an already completed deploy. At most that in-flight bridge
lacks a Git checkpoint; all earlier bridges from the same run remain durable.

## Verification

Deterministic validation contracts cover:

- publication steps occurring before intake in the scheduled workflow;
- a single-attempt intake invocation stopping without advancing an incomplete
  snapshot watermark;
- the workflow limiting itself to eight committed intake iterations;
- a second run reusing published bridge checkpoints without duplicate external
  writes;
- watermark advancement and checkpoint cleanup after the remaining bridges
  complete;
- retryable bridge failures being saved and reported;
- changed-content checkpoints replacing stale content safely;
- preflight continuing to run for queued publications and unfinished intake.

Final verification runs the complete validation suite, a dry-run artifact,
tracked-state validation, workflow syntax/static contracts, `git diff --check`,
and a controlled scheduled execution. The live verification succeeds only when
the workflow commits state and at least Bluesky and Mastodon record a real
publication result for the selected queued job.

## Delivery

Implementation lands directly on `main` in small commits: validation contracts,
resumable intake behavior, workflow ordering/checkpointing, and any resulting
state publication commit. After local verification, the commits are pushed and
one scheduled run is dispatched and observed through completion.
