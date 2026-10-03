# One daily push without a weekly manual gate

Date: 2026-10-03

## Goal

Keep new-opening notifications useful and predictable: at most one broadcast per
calendar day in `America/Sao_Paulo`, without a weekly manual confirmation that
can stop the publisher.

## Current failure

The sender requires a repository secret containing a Free-plan assertion with a
timestamp no older than seven days. When that timestamp expires, delivery fails
before OneSignal receives the request. The failed intent remains durable and is
resumed safely, but every later run fails for the same reason until someone
manually updates the secret.

OneSignal's current Free plan already limits mobile push to organizations with
up to 1,000 monthly active users and pauses mobile sending when the organization
exceeds that limit. The additional seven-day local expiry does not prevent an
automatic charge; it creates a recurring outage.

## Approved behavior

- Remove the custom weekly Free-plan assertion from runtime configuration and
  from the publishing workflow.
- Keep OneSignal credentials and audience validation unchanged.
- Limit accepted or in-flight broadcasts to one per São Paulo calendar day,
  even if stored legacy state contains a higher configured limit.
- Preserve the existing midnight reset in São Paulo.
- Preserve durable intent, idempotency, retry, stale-job, audience, and
  authentication protections.
- Resume the currently pending notification instead of creating a duplicate.
- Do not add a paid-plan upgrade or any billing action. OneSignal remains
  responsible for pausing mobile sends when its Free-plan limit is exceeded.

## Implementation boundaries

The change is limited to push configuration, the daily-cap constant, workflow
secret wiring, tests, and the operational readiness documentation. Social media
publishing, editorial publishing, Mastodon, and job ingestion are out of scope.

## Verification

Tests must first reproduce both production problems:

1. A missing or old weekly assertion no longer prevents valid push
   configuration.
2. A second broadcast on the same São Paulo day is deferred, including when
   legacy state requests a higher cap.

After the focused tests pass, the complete repository validation must pass. The
change is then published to `main`, and a fresh scheduled-mode run must finish
successfully while resuming the existing pending intent.
