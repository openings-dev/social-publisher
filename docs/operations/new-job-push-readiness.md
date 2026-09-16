# New-job push readiness

Updated: 2026-09-16

## Current state

The new-job push channel is implemented but disabled in `state/push.json`.
Neither the workflow nor this document authorizes a broadcast. Activation resets
the source boundary to the then-current committed data snapshot, so enabling the
channel cannot backfill historical jobs.

The sender uses `POST https://api.onesignal.com/notifications`, stores an RFC 9562
UUID before the request, reuses it for every retry within OneSignal's 30-day
window, honors `Retry-After`, and treats a successful response without an `id` as
no recipients. An API acceptance is recorded as `accepted`, never as delivered.

The conservative release policy is ten new-job notifications per UTC day, a
24-hour maximum age for an unsent alert, three provider attempts, and automatic
pause on authentication or invalid-request failures. A fresh organization-wide
Free-plan attestation is required every seven days. Sending is blocked at 900 MAU
to leave headroom below the documented 1,000-MAU Free limit.

## Sender ownership audit

A source audit of the checked-out Openings repositories found:

- the mobile repository contains only the receiving OneSignal SDK;
- `social-publisher` now contains the only executable new-job OneSignal sender;
- the older Cloudflare publishing-platform OneSignal adapter exists only in
  unexecuted design and plan documents in this workspace;
- data-pipeline tests explicitly assert that it does not emit `push.onesignal`;
- no second active OneSignal REST sender was found in the checked-out workflows.

External OneSignal automation, Journeys, dashboard campaigns, keys, and deployed
Workers cannot be certified from source. They must be inspected and disabled or
proved non-overlapping before activation.

## Required external gates

All of the following remain blocking:

- record the installed Google Play version code and prove its source revision;
- verify `dev.openings.mobile`, the bundled OneSignal App ID, and Android FCM
  configuration refer to the same production app;
- review the new-job consent copy and publish a replacement app version if the
  Play binary still has editorial-only consent or lacks safe job navigation;
- confirm the organization is on the Free plan, record current organization-wide
  mobile MAU, effective pricing date, and the pause behavior above the limit;
- create or select one app-scoped REST API key and store it only as the protected
  `ONESIGNAL_API_KEY` Actions secret;
- review and store one Android-only audience configuration in the protected
  `ONESIGNAL_AUDIENCE_JSON` secret; do not guess a segment name;
- send first only with `SEND_TEST_PUSH` and explicit owner-controlled Android
  subscription IDs, then observe receipt and exact job navigation on a physical
  device;
- enable `OPENINGS_PUSH_AUTO_PUBLISH` only after the canary and a naturally new
  subsequent event pass without duplicates.

Rollback sets the tracked channel to disabled with `DISABLE_NEW_JOB_PUSH`. It
preserves every intent, idempotency key, OneSignal notification ID, and ambiguous
result for reconciliation, and does not modify website or social state.
