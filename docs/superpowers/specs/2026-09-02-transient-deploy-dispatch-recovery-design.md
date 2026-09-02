# Transient Deploy Dispatch Recovery Design

## Context

Scheduled run `33623661025` published one queued job to all enabled social channels and published its Instagram Story. The later intake phase then deployed seven job bridges successfully. Its eighth bridge, `gh_785da28a609b497462469c95`, failed before a corresponding `web-deploy` workflow run was created and was preserved as `retryable` with error code `deployment`.

The failure boundary is the GitHub `repository_dispatch` request. The current client performs that request once, converts transport failures and non-204 responses into a generic exception, and relies on the next social-publisher run to retry the entire bridge operation.

## Design

Keep the existing checkpoint and idempotency model. Add a small bounded retry around only the GitHub dispatch request:

- accept `204` immediately;
- retry transport exceptions, HTTP `429`, and HTTP `5xx` responses;
- honor a numeric `Retry-After` header when present, otherwise use a short fixed delay;
- reject other HTTP `4xx` responses immediately;
- expose a stable `bridge_dispatch` error code after exhaustion so the checkpoint identifies the failing boundary;
- leave public verification polling and the workflow's preserved-error behavior unchanged.

The default is three dispatch attempts. Tests inject the sleep function and delay so validation remains deterministic and fast.

## Recovery

After the change passes the full deterministic validation suite and is pushed to `main`, run the scheduled workflow once. Existing publication state prevents already completed social posts from being duplicated. The preserved intake bridge is retried, and the run is monitored through completion.

## Success criteria

- A transient transport failure followed by a `204` dispatches successfully.
- A transient HTTP response followed by a `204` dispatches successfully.
- An authentication or validation response is not retried.
- Exhausted transient attempts report `bridge_dispatch` without leaking credentials.
- The full validation suite passes.
- The pending bridge is deployed and the recovery workflow completes successfully.
