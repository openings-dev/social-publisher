# LinkedIn Organization Publishing Design

## Objective

Extend `social-publisher` so genuinely new openings.dev jobs can be published automatically to the official openings.dev LinkedIn Page. LinkedIn is an independent, opt-in channel with the same durable queue, bounded retry, duplicate-reconciliation, and no-backfill guarantees as the existing providers.

The integration publishes organic article posts on behalf of the organization. Each post contains the existing social commentary, the canonical job URL, and an explicitly supplied 1200×630 openings.dev thumbnail, title, and description. Personal-profile publishing, sponsored content, analytics, comments, reactions, and editorial posts are out of scope.

## External prerequisites

The openings.dev LinkedIn Page must exist and the member authorizing the integration must have a role permitted to publish organization content. A LinkedIn developer application must be associated with the Page and approved for the Community Management API.

The authorization grant must include:

- `w_organization_social` to upload the Page-owned thumbnail and create the post;
- `r_organization_social` to find recent Page posts and reconcile ambiguous publication attempts.

The repository never performs the interactive OAuth authorization flow. Initial token acquisition and renewal happen outside GitHub Actions. The resulting access token is stored only as a repository secret. Automatic refresh-token handling is excluded from the first release because the current publisher treats Meta credentials the same way and GitHub Actions cannot safely rotate its own repository secrets without broader credentials.

## Publication experience

LinkedIn receives an organic article post rather than a text-only or image-only post. The visible commentary reuses `formatSocialPost(job)` so the title, useful location and salary facts, canonical URL, and bounded hashtags stay aligned with Bluesky, Mastodon, and Threads.

The article attachment is explicit because LinkedIn's Posts API does not scrape a URL to build an article preview. It contains:

- `source`: the canonical openings.dev job URL;
- `thumbnail`: a LinkedIn Image URN created from the canonical 1200×630 social-card PNG;
- `title`: the normalized job title;
- `description`: the existing source-grounded opportunity description.

The post is public, distributed to the organization's main feed, published immediately, and reshares remain enabled. No LinkedIn-specific copy generator is introduced.

## Architecture

### Configuration

`linkedin` becomes a member of `SOCIAL_CHANNELS` but not `DEFAULT_SOCIAL_CHANNELS`. `readEnvironment` enables it only when `LINKEDIN_AUTO_PUBLISH` is exactly `true`.

An enabled production publication requires:

- `LINKEDIN_ACCESS_TOKEN` as a secret;
- `LINKEDIN_ORGANIZATION_ID` as a repository variable containing digits only;
- `LINKEDIN_API_VERSION` as a repository variable in `YYYYMM` format;
- `LINKEDIN_API_ORIGIN`, defaulting to `https://api.linkedin.com`, as an optional repository variable.

The environment reader exposes a frozen LinkedIn configuration object containing the access token, organization ID, organization URN, API version, and normalized API origin. Credentials never enter tracked state, logs, summaries, or error diagnostics.

### LinkedIn client

`src/modules/networks/linkedin-client.mjs` owns all LinkedIn HTTP behavior. It accepts the normalized job, formatted post, rendered PNG, access token, organization ID, API version, and an injectable `fetch` implementation.

Every versioned LinkedIn API request includes:

- `Authorization: Bearer <token>`;
- `Linkedin-Version: <YYYYMM>`;
- `X-Restli-Protocol-Version: 2.0.0`.

Publication follows this sequence:

1. Find up to 100 recent posts authored by the organization, ordered by creation time.
2. Reconcile an existing post whose article `source` or commentary contains the exact canonical URL.
3. Initialize a Page-owned image upload through `/rest/images?action=initializeUpload`.
4. Upload the canonical PNG to the returned HTTPS upload URL.
5. Poll the Image resource until it is `AVAILABLE`, fails processing, or reaches a small bounded deadline.
6. Create the article post through `/rest/posts`.
7. Read the provider Post URN from the `x-restli-id` response header and normalize the public URL as `https://www.linkedin.com/feed/update/<post-urn>/`.

The upload URL must be HTTPS, contain no user information, and use a LinkedIn-controlled hostname. Redirects are rejected. The client validates response status, JSON content types where JSON is expected, Image URN shape, Post URN shape, and the exact author URN before returning a durable result.

### Duplicate safety

The first recent-post lookup happens before any image upload. If it finds the canonical URL, the client returns:

```json
{
  "status": "reconciled",
  "id": "urn:li:share:123",
  "url": "https://www.linkedin.com/feed/update/urn:li:share:123/"
}
```

If post creation fails or times out after the request may have reached LinkedIn, the client performs the same lookup once more. It returns `reconciled` only when an exact canonical URL match is proven. Otherwise it throws a sanitized `linkedin_publication` error and lets the durable queue retry later. A retry always reconciles before creating another post.

Image uploads may be orphaned when a post request fails; this is acceptable because they are not visible feed publications. The client does not attempt to delete remote images.

### Orchestration

The publication CLI renders the existing 1200×630 PNG and passes it to the LinkedIn client. The orchestrator receives `publishLinkedIn`, adds it to its channel-to-publisher map, and processes it through the generic `publishQueueStage` path. LinkedIn therefore inherits the existing `pending → publishing → published/retryable/failed` state machine and three-attempt limit.

Completion requires every channel, including LinkedIn, to be in a terminal success or intentional-skip state. The publications state records the normalized LinkedIn result alongside the other provider results. The CLI summary exposes `linkedin` and `linkedinError` without raw provider payloads.

## State migration and activation

Adding a required queue stage changes the tracked state schema. Implementation increments from the schema version present when this feature begins. With the current runtime schema, that is version 2 to version 3. If another approved feature increments the schema first, LinkedIn uses the next available version and the migration composes with that feature instead of reusing version 3.

All existing queue items receive a terminal LinkedIn stage:

- `status: skipped_before_activation`;
- zero attempts;
- migration timestamp in `updatedAt`;
- null error, reset, and result fields.

Existing completed publications gain `linkedin: null`. New jobs enqueued while LinkedIn is disabled receive `skipped_disabled`; new jobs enqueued after activation receive `pending`. Enabling LinkedIn never reopens either historical status, so the rollout cannot backfill or duplicate old jobs.

The migration updates `state/intake.json`, `state/queue.json`, and `state/publications.json` to the new schema atomically in the implementation commit. Validation rejects mixed-version or missing-stage state.

## Workflow and rollout

The manual workflow gains:

- `linkedin` as a retry-stage choice;
- `publish_linkedin` as an independent controlled-publication boolean;
- LinkedIn variables and the access-token secret in the provider step.

`publish_linkedin=true` enables LinkedIn only for that controlled run. It does not enable Threads or Instagram and does not mutate the scheduled repository variable. Scheduled publishing includes LinkedIn only when both `SOCIAL_AUTO_PUBLISH=true` and `LINKEDIN_AUTO_PUBLISH=true`.

Rollout sequence:

1. Create and verify the LinkedIn developer application against the openings.dev Page.
2. Obtain Community Management API access and an organization-authorized token.
3. Configure the organization ID, API version, and token while leaving `LINKEDIN_AUTO_PUBLISH=false`.
4. Run a dry publication contract locally with injected HTTP responses.
5. Run one controlled job with `publish_linkedin=true` and the existing exact confirmation `PUBLISH_ONE_JOB`.
6. Confirm the durable Post URN, public feed URL, article thumbnail, title, description, and canonical link.
7. Retry the same controlled job and confirm that no second post is created.
8. Set `LINKEDIN_AUTO_PUBLISH=true` for newly enqueued scheduled jobs.

## Error handling

The client exposes only bounded, non-sensitive error codes:

- `linkedin_authentication` for 401/403 authorization failures;
- `linkedin_reconciliation` when recent posts cannot be read or have an invalid shape;
- `linkedin_image_initialization` for invalid upload initialization;
- `linkedin_image_upload` for binary upload failure;
- `linkedin_image_processing` for failed or expired image processing;
- `linkedin_publication` for post creation failure without successful reconciliation;
- `linkedin_response` for malformed successful responses;
- `linkedin_configuration` for invalid local identifiers, versions, or origins.

The orchestrator sanitizes unexpected failures through its existing provider error boundary. No response body, token, upload URL, or authorization header is persisted.

## Validation

Deterministic validation covers:

- LinkedIn disabled by default and independently enabled by its exact flag.
- Required secret, numeric organization ID, `YYYYMM` API version, and HTTPS origin validation.
- State migration without historical backfill and state validation requiring a LinkedIn stage.
- New queue-item behavior before and after activation.
- Recent-post reconciliation by exact canonical URL.
- Image initialization, binary upload, availability polling, and article request shape.
- Required LinkedIn and Rest.li headers on every versioned API request.
- Rejection of unsafe upload URLs, redirects, invalid URNs, invalid content types, and malformed results.
- Post-creation reconciliation after an ambiguous network failure.
- Durable normalized result and public URL generation.
- Orchestrator isolation: a LinkedIn failure does not republish completed providers.
- Manual retry-stage support and independent controlled rollout.
- Workflow and README configuration contracts.

The complete `npm run validate` suite must pass without production credentials or external network access.

## Out of scope

- Publishing to a personal LinkedIn profile.
- Sponsored, targeted, carousel, video, document, poll, or reshare posts.
- Comments, reactions, mentions, analytics, webhooks, or post editing/deletion.
- Automatic OAuth consent, access-token refresh, or repository-secret mutation.
- Backfilling jobs known before LinkedIn activation.
- Changing the canonical social copy or visual design.
