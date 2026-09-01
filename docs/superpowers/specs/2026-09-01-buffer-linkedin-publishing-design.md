# Buffer-backed LinkedIn Publishing Design

## Objective

Publish genuinely new openings.dev jobs immediately to the official Openings.dev LinkedIn Page through Buffer while keeping the integration within Buffer's Free plan. The existing durable LinkedIn queue stage, bounded retries, duplicate protection, and no-backfill behavior remain intact.

Buffer becomes the active LinkedIn provider because direct access to LinkedIn's Community Management API requires a registered legal organization. The existing direct LinkedIn client stays available as a disabled fallback for a future eligibility change. Personal-profile publishing, Buffer queue scheduling, paid Buffer features, analytics, comments, reactions, and editorial posts are out of scope.

## Approved product behavior

The Social Publisher publishes each LinkedIn post immediately. It does not add posts to Buffer's schedule queue.

Each post contains:

- the existing deterministic social copy from `formatSocialPost(job)`;
- the canonical openings.dev job URL inside that copy;
- the verified 1200×630 job card already deployed by the bridge stage;
- accessible alternative text derived from the job title.

The Buffer request uses `schedulingType: automatic` and `mode: shareNow`. This preserves the current one-job-at-a-time workflow and avoids consuming the Free plan's scheduled-post allowance.

## External prerequisites

The Buffer organization is `Openings HQ`, owned by `id@openings.dev`, on the Free plan. Its three free channel slots are currently unused.

Before production activation:

1. Connect the Openings.dev LinkedIn Page as a Buffer channel using a LinkedIn member who is a Page Super Admin.
2. Create one personal Buffer API key in the Buffer account.
3. Store the key only as the `BUFFER_API_KEY` GitHub Actions secret.
4. Discover and store the Buffer organization and LinkedIn channel IDs as repository variables.

Connecting the Page, creating the key, and sending the controlled public post are separate external writes. Each requires action-time confirmation. The API key must never be displayed in logs, copied into a tracked file, or persisted in local shell history.

## Architecture

### Provider selection and configuration

`LINKEDIN_AUTO_PUBLISH` remains the only feature gate for the LinkedIn queue stage. A new `LINKEDIN_PROVIDER` variable selects `buffer` or `direct`; the existing direct provider remains the default for backward compatibility.

The Buffer provider requires:

- `BUFFER_API_KEY` as a repository secret;
- `BUFFER_ORGANIZATION_ID` as a repository variable;
- `BUFFER_LINKEDIN_CHANNEL_ID` as a repository variable;
- `BUFFER_API_ORIGIN`, defaulting to `https://api.buffer.com`, as an optional repository variable.

When `LINKEDIN_PROVIDER=buffer`, direct LinkedIn credentials are not required. When `LINKEDIN_PROVIDER=direct`, the current access token, organization ID, API version, and API origin requirements remain unchanged. Unknown providers, blank IDs, and unsafe API origins fail configuration before publication starts.

The GitHub Actions workflow passes only the configuration required by the selected provider. Summaries expose the provider name and sanitized error code, never credentials or raw GraphQL responses.

### Buffer client

`src/modules/networks/buffer-linkedin-client.mjs` owns Buffer GraphQL behavior. It accepts the normalized job, formatted post, public image URL, API key, organization ID, LinkedIn channel ID, normalized API origin, and injectable `fetch` and timing functions.

Every request is a JSON `POST` to the exact configured HTTPS API origin with `Authorization: Bearer <key>`. Redirects are rejected. The client validates HTTP status, JSON content type, GraphQL top-level errors, typed mutation errors, provider identifiers, channel ownership, channel service, post status, and external links.

Publication follows this sequence:

1. Query the configured channel and prove it belongs to the configured organization, has service `linkedin`, and is neither disconnected nor locked.
2. Query recent posts for that organization and channel, newest first, and reconcile an exact canonical job URL in the post text or image source.
3. Create one post with the formatted text, `schedulingType: automatic`, `mode: shareNow`, and the bridge's stable public `imageUrl` asset.
4. Poll the returned Buffer post ID through a small bounded deadline.
5. Return only after Buffer reports `sent` with a valid public LinkedIn `externalLink`.

The normalized durable result is:

```json
{
  "status": "published",
  "id": "buffer-post-id",
  "url": "https://www.linkedin.com/...",
  "provider": "buffer"
}
```

A reconciled publication uses `status: reconciled` with the same remaining fields.

### Public media

Buffer does not accept binary uploads through its public API. The client therefore uses `queueItem.bridge.result.imageUrl`, which already identifies a public, direct, stable HTTPS PNG on `openings.dev`.

The client accepts only HTTPS media URLs on the configured public site origin, with no credentials. The bridge stage has already verified the image's availability, content type, dimensions, and hash before any social provider runs. Buffer receives the image URL only after the bridge stage is `published`.

### Duplicate safety and ambiguous outcomes

Every attempt reconciles before creating a post. The lookup filters by the configured organization and channel, sorts newest first, and examines a bounded recent window across `sending`, `sent`, `scheduled`, and `error` statuses.

- A matching `sent` post with a valid LinkedIn external link returns `reconciled`.
- A matching `sending` or `scheduled` post resumes polling that Buffer post instead of creating another.
- A matching `error` post fails closed with a sanitized publication error and is never duplicated automatically.

If the create request times out or loses its response, the client performs the same lookup once more. It resumes a uniquely matched post or throws a retryable sanitized error when no post can be proven. A retry begins with reconciliation again.

The exact canonical URL is the idempotency marker. Substring lookalikes, another channel, another organization, and malformed provider results never count as reconciliation.

### Orchestration and state

The existing `linkedin` queue stage and schema remain unchanged. No state migration is required.

The publication CLI chooses the direct or Buffer callback from the validated provider configuration. The Buffer callback receives the public bridge image URL rather than rendering or uploading another PNG. The orchestrator continues to process it through the generic `publishQueueStage` state machine, so completed Bluesky, Mastodon, Threads, and Instagram stages are never replayed after a LinkedIn-only failure.

Historical queue items keep `skipped_before_activation` or `skipped_disabled`. Enabling Buffer does not reopen them, so there is no LinkedIn backfill. Only newly enqueued jobs after activation receive `linkedin.status: pending`, except for an explicitly selected controlled validation job prepared through the existing safe retry mechanism.

## Error handling

The Buffer client exposes bounded, non-sensitive codes:

- `buffer_authentication` for invalid or unauthorized API keys;
- `buffer_configuration` for invalid local IDs, origins, or channel mismatches;
- `buffer_graphql` for malformed GraphQL responses or top-level query failures;
- `buffer_reconciliation` when recent posts cannot be read safely;
- `buffer_media` when the public image URL is invalid or Buffer rejects it;
- `buffer_publication` for typed create errors or terminal provider failures;
- `buffer_processing` for an unexpected status or bounded polling timeout;
- `buffer_rate_limit` for HTTP or typed quota/rate-limit failures;
- `buffer_response` for malformed successful responses.

Error diagnostics may contain only a bounded provider category and operation name. They exclude the API key, authorization header, GraphQL variables, response body, post text, and media URL.

## Free-plan budget

Immediate posts do not occupy Buffer's scheduled queue. A normal publication uses one channel validation query, one reconciliation query, one mutation, and a bounded number of status queries. This remains comfortably inside the Free plan's current allowance for the expected openings.dev publication volume.

The client avoids unbounded pagination and polling. A rate-limit response stops the attempt and lets the durable queue retry later; it never falls back to an unapproved paid feature or another account.

## Workflow and rollout

The manual workflow keeps `linkedin` as an independent controlled channel. It gains the Buffer secret and provider variables while preserving the direct LinkedIn variables as fallback configuration.

Rollout sequence:

1. Connect the Openings.dev LinkedIn Page to the existing `Openings HQ` Buffer organization.
2. Create the personal API key and transfer it directly into the GitHub secret without exposing its value.
3. Discover the organization and LinkedIn channel IDs through the authenticated API and configure repository variables.
4. Leave `LINKEDIN_AUTO_PUBLISH=false`.
5. Run all deterministic validation without production credentials or network access.
6. Run one explicit controlled publication with `publish_linkedin=true` and the existing `PUBLISH_ONE_JOB` confirmation.
7. Confirm the Buffer record, public LinkedIn URL, copy, canonical link, and image.
8. Retry reconciliation against the same canonical job URL and prove that a second post is not created.
9. Set `LINKEDIN_PROVIDER=buffer` and `LINKEDIN_AUTO_PUBLISH=true` for newly enqueued scheduled jobs.

If the controlled post fails, automation remains disabled. Direct LinkedIn publishing remains configured only as dormant code; it is not used without valid LinkedIn Community Management credentials.

## Validation

Implementation follows test-driven development. Deterministic contracts cover:

- Buffer selected independently from the direct LinkedIn provider.
- Required Buffer key and IDs only when Buffer is selected and LinkedIn is enabled.
- Exact HTTPS API-origin and public-media-origin validation.
- Channel organization, LinkedIn service, disconnected, and locked checks.
- Authorization headers and GraphQL query/mutation variables without secret leakage.
- `shareNow`, automatic scheduling, formatted text, stable image URL, and alternative text.
- Typed mutation errors, top-level GraphQL errors, invalid content types, malformed JSON, unsafe redirects, and rate limits.
- Reconciliation by exact canonical URL across sent and in-flight posts.
- Resumed polling for a matching in-flight post and fail-closed handling for an errored post.
- Post-create reconciliation after an ambiguous network failure.
- Polling success, provider error, unexpected status, and bounded timeout.
- Normalized Buffer ID and LinkedIn external link in durable publication state.
- Provider isolation so LinkedIn retries never republish completed channels.
- Workflow variables, secret wiring, controlled activation, documentation, and Free-plan constraints.

The complete `npm run validate` suite must pass before any controlled external post.

## Documentation sources

- [Buffer API quick start](https://developers.buffer.com/guides/getting-started.html)
- [Posts and scheduling](https://developers.buffer.com/guides/posts-and-scheduling.html)
- [Hosting media](https://developers.buffer.com/guides/hosting-media.html)
- [Retrieving channel posts](https://developers.buffer.com/examples/get-posts-for-channels.html)
- [Buffer API reference](https://developers.buffer.com/reference.html)

## Out of scope

- Buffer scheduling queues or approval workflows.
- Paid Buffer features or additional channel slots.
- Publishing to a personal LinkedIn profile.
- Buffer-managed copy generation, AI assistance, or asset hosting.
- Editorial LinkedIn content, carousels, videos, documents, polls, or first comments.
- Engagement analytics, post editing, deletion, or reactions.
- Automatic API-key creation, rotation, or recovery after revocation.
- Reopening or backfilling historical jobs.
