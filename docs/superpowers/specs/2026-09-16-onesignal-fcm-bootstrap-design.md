# OneSignal FCM Bootstrap Design

## Goal

Configure the production Openings OneSignal application to send Android push
notifications through Firebase Cloud Messaging v1 without exposing the Firebase
service-account key or enabling automatic broadcasts.

## Current state

- The OneSignal application `Openings` exists on the Free plan.
- Its app-scoped REST API key and App ID are stored as protected GitHub Actions
  secrets in `openings-dev/social-publisher`.
- The Firebase project is `openingshq`.
- A dedicated service account,
  `onesignal-fcm-sender@openingshq.iam.gserviceaccount.com`, has the two roles
  recommended by OneSignal: Firebase Cloud Messaging API Admin and Firebase
  Viewer.
- A single JSON key exists locally and has not been committed.
- The push sender remains disabled. This bootstrap must not activate it or send
  a notification.

## Chosen approach

Use GitHub Actions as a short-lived credential bridge because the browser's
native file picker cannot be controlled safely in the current environment.

1. Store the Firebase JSON temporarily as the protected repository secret
   `ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON`.
2. Add a manual-only workflow and a small tested configurator.
3. The configurator validates the OneSignal App ID, Firebase project ID,
   service-account email, credential type, and private-key presence before any
   request.
4. The workflow sends the credential only to OneSignal's official Update App
   endpoint using the existing app-scoped REST API key.
5. It reads the app back from OneSignal and verifies that FCM v1 is configured
   without logging either credential.
6. After a successful run, delete the temporary GitHub secret and the local
   JSON file. Keep the manual workflow for explicit future credential rotation.

## Security boundaries

- The workflow uses `workflow_dispatch` only, has `contents: read`, and accepts
  an exact confirmation phrase.
- Secrets are scoped only to the configuration step and masked before use.
- The Firebase credential is parsed in memory. Its private key, REST key, and
  complete JSON are never printed, committed, archived, or uploaded as an
  artifact.
- The configurator rejects a different Firebase project, service-account email,
  OneSignal App ID, malformed JSON, or missing private key before network I/O.
- The workflow neither changes `OPENINGS_PUSH_AUTO_PUBLISH` nor invokes the push
  delivery CLI.
- Cleanup is explicit and verified by listing secret names only.

## Components and data flow

`workflow_dispatch` provides a fixed confirmation phrase. GitHub injects the
three protected secrets into one Node process. The process validates local
metadata, sends an authenticated update to the single expected OneSignal app,
then requests that app's metadata and checks for an FCM v1 configuration marker.
Only a non-sensitive success summary is written.

After the workflow succeeds, operator-side cleanup removes
`ONESIGNAL_FCM_SERVICE_ACCOUNT_JSON` from GitHub and deletes the downloaded
Firebase JSON. The permanent OneSignal REST key and App ID remain protected for
the existing push publication workflow.

## Error handling

- Validation failures exit before any HTTP request.
- OneSignal non-2xx responses report only status and a bounded, sanitized error
  classification.
- Read-back mismatch fails closed and leaves the sender disabled.
- Any failed run preserves the temporary secret and local JSON only long enough
  for a controlled retry; cleanup occurs only after confirmed configuration.

## Testing and verification

- Unit tests cover accepted credentials, every identity mismatch, missing
  private-key material, request shape, authorization header, and sanitized
  errors.
- A workflow contract test proves manual-only execution, least privilege,
  confirmation gating, exact secret names, and absence of push activation or
  delivery commands.
- The repository's complete `npm run validate` suite must pass before merge.
- Production verification requires a successful manual workflow run, OneSignal
  read-back confirmation, absence of the temporary GitHub secret, and absence
  of the local JSON file.

## Out of scope

- Enabling automatic new-job broadcasts.
- Defining the production audience.
- Sending the physical-device canary.
- Publishing a new mobile binary with the new OneSignal App ID.

Those remain separate gates after FCM bootstrap succeeds.
