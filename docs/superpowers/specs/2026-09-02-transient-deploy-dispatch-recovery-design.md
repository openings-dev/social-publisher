# Deploy Dispatch Recovery Design

## Context

Scheduled run `33623661025` published one queued job to all enabled social channels and published its Instagram Story. The later intake phase then deployed seven job bridges successfully. Its eighth bridge, `gh_785da28a609b497462469c95`, failed before a corresponding `web-deploy` workflow run was created and was preserved for retry with error code `deployment`.

Reproducing the exact bridge in a Linux container with the same CJK fonts as the GitHub runner produced a `repository_dispatch` body of 61,261 characters. The project rejected bodies above 60,000 characters even though GitHub accepts a client payload below 64 KB. The rejection therefore happened locally, before a `web-deploy` run could be created. The generic error code hid that distinction.

## Design

Keep the existing checkpoint and idempotency model. Align the local dispatch limit with GitHub's strict less-than-64-KB contract, using 65,535 characters for the ASCII JSON body. Assign `bridge_payload` to a locally oversized bridge so the saved checkpoint identifies the real failure boundary.

Retain the bounded retry around only the GitHub dispatch request:

- accept `204` immediately;
- retry transport exceptions, HTTP `429`, HTTP `5xx`, and HTTP `422` responses whose body identifies GitHub endpoint throttling;
- honor a numeric `Retry-After` header when present, otherwise use a short fixed delay;
- reject other HTTP `4xx` responses immediately;
- expose a stable `bridge_dispatch` error code after exhaustion so the checkpoint identifies the failing boundary;
- leave public verification polling and the workflow's preserved-error behavior unchanged.

The default is three dispatch attempts. Tests inject the sleep function and delay so validation remains deterministic and fast.

## Recovery

After the change passes the full deterministic validation suite and is pushed to `main`, reset only the affected failed bridge and run the scheduled workflow once. Existing publication state prevents already completed social posts from being duplicated. The preserved intake bridge is retried, and the run is monitored through completion.

## Success criteria

- A transient transport failure followed by a `204` dispatches successfully.
- A transient HTTP response followed by a `204` dispatches successfully.
- An authentication response or a genuine HTTP `422` validation response is not retried.
- Exhausted transient attempts report `bridge_dispatch` without leaking credentials.
- A valid body between 60,000 characters and 64 KB is accepted.
- A locally oversized body reports `bridge_payload`.
- The full validation suite passes.
- The pending bridge is deployed and the recovery workflow completes successfully.
