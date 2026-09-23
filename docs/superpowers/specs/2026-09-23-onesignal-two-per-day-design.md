# OneSignal Two-Per-Day Limit Design

## Goal

Limit production OneSignal new-job broadcasts to two notifications per civil day
in `America/Sao_Paulo`, regardless of how many scheduled or repository-dispatch
runs execute.

## Root cause

The push orchestrator already counts accepted, submitting, and uncertain intents,
but the durable production state sets `policy.dailyCap` to `10`. The workflow can
run both from repository dispatches and its recurring schedule, so it legitimately
prepares multiple notifications until that high cap is reached.

## Design

Apply the restriction in two layers:

1. Change the durable production push-state policy from 10 to 2 so the existing
   deployed orchestrator stops preparing notifications as soon as the state is
   published.
2. Enforce a code-level maximum of two in the orchestrator by using the lower of
   the persisted policy and the permanent maximum. This prevents an accidental
   future state change from raising production frequency again.

The daily bucket uses `America/Sao_Paulo` rather than UTC. Intent timestamps stay
in ISO UTC form; only their calendar-day comparison is localized. Existing
accepted notifications remain untouched. Pending work stays queued and becomes
eligible on a later day, subject to the existing 24-hour staleness policy.

## Safety and compatibility

- Do not delete, rewrite, or resend prior OneSignal intents.
- Count `submitting`, `accepted`, and `uncertain` intents, as today, so ambiguous
  provider outcomes cannot bypass the cap.
- Keep lower persisted caps valid; the effective cap is `min(policy.dailyCap, 2)`.
- Keep workflow triggers unchanged because reducing cron frequency would not
  constrain repository-dispatch executions.
- Update both the repository seed state and the isolated `push-state` production
  branch to `dailyCap: 2`.

## Verification

Add regression coverage showing that two attempts on the same Sao Paulo day block
a third even when the stored policy is 10 and timestamps cross a UTC date boundary.
Also prove that a new Sao Paulo day permits the next pending intent. Run the focused
push tests and the complete repository validation suite before publishing.
