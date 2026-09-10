# social-publisher

`social-publisher` turns genuinely new jobs indexed by [openings.dev](https://openings.dev) into useful, source-grounded posts for the enabled official social accounts. Mastodon is retired from the Openings rollout and remains disabled unless a future reviewed rollout explicitly sets `MASTODON_AUTO_PUBLISH=true`.

The service is intentionally small and cautious. It publishes at most one queued job every two hours, never backfills older issues added through community discovery, and verifies a job-specific Open Graph page before sending a social post.

## How it works

1. Read immutable public snapshots from [`openings-dev/data-pipeline`](https://github.com/openings-dev/data-pipeline).
2. Detect genuinely new open issues and content changes to known jobs.
3. Render the job bridge, Open Graph image, and canonical 4:5 job card, then request an incremental deployment from [`openings-dev/web-deploy`](https://github.com/openings-dev/web-deploy). That deploy also creates the public vertical video and cover required by Instagram.
4. Publish the canonical link through every enabled channel with provider-specific duplicate reconciliation.
5. Record provider IDs and permanent post URLs when available, then commit sanitized queue and publication state so interrupted runs can resume safely.
6. After an Instagram job Reel is durable, publish that same verified 9:16 video as a separate Story and store its result independently.

Bluesky receives an explicit external card. LinkedIn is published immediately through Buffer with the canonical job URL and the existing public 1200×630 image. The API request uses `shareNow`, so it does not occupy a scheduled slot on the Buffer Free plan. Mastodon and Threads receive the canonical link so the public Open Graph preview can resolve naturally. Instagram receives a verified nine-second Reel with a dedicated cover, production caption, and one of two bundled CC0 soundtrack excerpts. Every newly published job Reel can then be mirrored to Instagram Stories. The same H.264/AAC file is ready for a later YouTube Shorts rollout. X is not included because its write API is not part of the free rollout.

## Job artwork and local preview

Job artwork follows the web palette and uses bundled, OFL-licensed Figtree fonts.
The publication cycle is Night → Paper → Night → Lavender → Night → Peach.
The color is reserved when a job is first selected for publication, then retained
across retries and revisions. Network delays may change delivery order. This does
not change the separate editorial-guide carousel catalog.

Story and Reel share the same complete 1080×1920 composition throughout the video.
The internal reading area leaves 108 px on each side, 280 px above and 384 px below;
these are design margins, not a guarantee against every Instagram overlay. Feed
images remain 1080×1350; link cards remain 1200×630.

With the sibling `web` checkout available for the canonical wordmark:

```sh
npm run preview:social
```

Open `http://127.0.0.1:4174/` to compare the final raster artwork, toggle margin
guides and inspect sample jobs. The preview never reads a stash or publishes posts.

Deployment order matters: release the matching `web-deploy` renderer first, then
`social-publisher`. Poster model 4, artwork revision 2 uses image asset version 6 and video version 7; `web-deploy`
continues accepting legacy model 3 / asset version 4 during the transition. Old
bridge assets are refreshed before pending channels run, without repeating already
published social posts. No new service, paid plan or credential is required.

## Instagram editorial guides

Production artwork uses the official wordmark and plain contextual CTA text,
never simulated buttons. Instagram jobs point to the bio link; clickable link
previews point to openings.dev. Guides use saving/sharing calls only on the final
carousel slide, and sharing calls on Stories. The editorial render version is 5
(asset directory `/5`), separate from catalog/state content version 2. Existing
publication checkpoints keep their original asset URLs. Historical job artwork
without a revision marker retains its canonical renderer during rollout.

The separate `Publish Instagram editorial guide` workflow enriches the Instagram feed with two practical carousels per week:

- Tuesday at 12:00 in São Paulo: LinkedIn, résumé, or application.
- Thursday at 12:00: job search or interview.

The deterministic catalog contains 36 complete English guides: 12 about LinkedIn, 8 about resumes, 6 about job search, 4 about applications, and 6 about interviews. Every guide has seven 1080×1350 slides, a concrete before-and-after example, a four-point checklist, a caption, and recorded sources. A topic cannot repeat for at least 84 days, each calendar slot can be consumed only once, and an unfinished guide blocks the next enqueue so failures cannot accumulate.

LinkedIn guidance uses official [LinkedIn Help](https://www.linkedin.com/help/linkedin/topic/a64) documentation. Resume, search, application, and interview guidance records institutional sources from Harvard Career Services, CareerOneStop, and the U.S. Department of Labor. Runtime publishing does not call a generative model: reviewed catalog copy and deterministic layouts are rendered automatically.

Instagram Stories are separately tracked through the professional-account API. Job Stories reuse the job Reel. Editorial Stories evaluate the first verified carousel slide without cropping or redesign; the current 1080×1350 feed media is recorded durably as unsupported and is never sent to Meta because no crop-free Story compatibility can be established. The live path does not render or upload a second Story design.

## Safety defaults

- The first production intake records a baseline and queues nothing.
- Scheduled publication stays disabled unless `SOCIAL_AUTO_PUBLISH` is exactly `true`.
- Pull requests receive no production credentials and cannot publish.
- Hostinger credentials remain exclusively in `web-deploy`; this repository can request only one validated job bridge at a time.
- Social publication starts only after the public HTML, images, Reel cover, and MP4 are reachable and match their delivery contracts.
- Per-network state prevents a successful channel from being posted twice when the other fails.
- Buffer publication reconciles the exact canonical job URL or public image before creating a LinkedIn post. An in-flight match is resumed, while a failed or ambiguous duplicate stops for review.
- Instagram, Threads, and LinkedIn are independent opt-ins. Jobs already known when a channel is activated are never backfilled and keep that new channel as `skipped_before_activation`.
- `INSTAGRAM_STORY_AUTO_PUBLISH` affects only newly enqueued jobs. The schema-3 migration marks historical Story stages `skipped_before_activation`, so activation never backfills old posts.
- Job and editorial Stories use a two-phase durable boundary: a unique publication intent is committed before the Meta call. Job Story provider IDs are reconciled across the queue and publication ledger after a partial checkpoint. An interrupted or ambiguous Story stops for manual review instead of risking a duplicate.
- Enabling a channel affects only jobs enqueued afterward; terminal stages on historical queue items are never reopened.
- A missing permalink never retries an already-created post. The provider ID remains durable and a later duplicate reconciliation can recover the URL.
- Errors stored in Git are categorized and sanitized; credentials and raw provider payloads are never tracked.

## Local validation

Use Node.js 20 or newer, npm, and FFmpeg:

```sh
npm ci
npm run validate
npm run dry-run -- --fixture assets/fixtures/job.json --output .tmp/dry-run
npm run editorial:dry-run -- \
  --content linkedin-headline-clara \
  --wordmark ../web/public/openings-wordmark-light.svg \
  --output .tmp/editorial-review
```

Dry run generates the final copy, bridge HTML, Open Graph image, 4:5 Instagram image, 9:16 Reel cover, and MP4 without deployment requests, provider authentication, tracked-state changes, or external writes. Its approved CC0 soundtrack is bundled locally, with no runtime download or paid service. Night uses Funked Up by Joth; the light variants use Funky House by Of Far Different Nature. The saved artwork cycle alternates the tracks and keeps retries stable. See assets/audio/README.md for licensing and provenance. Legacy model 3 retains its synthesized soundtrack.

To exercise the current public data checkout instead of the fixture:

```sh
npm run dry-run -- \
  --data ../data-pipeline \
  --state state \
  --wordmark ../web/public/openings-wordmark-light.svg
```

## GitHub Actions

`Validate` runs on pull requests and source pushes with read-only repository access. It installs the lockfile, runs all deterministic contracts, and renders the review artifact without reading production secrets.

`Publish social jobs` runs every two hours at minute 17 and can also be started manually:

- `dry-run` renders a downloadable review artifact and performs no external write.
- `controlled` publishes one explicit open job only when the confirmation is exactly `PUBLISH_ONE_JOB`. It can safely enqueue that job after the initial baseline and refuses to republish a completed job.
- `retry-stage` resets one failed stage only when the confirmation is exactly `RESET_FAILED_STAGE`; use `bridge` for a publication-queue deploy or `intake-bridge` for a snapshot-intake deploy. It never publishes in the same operation.
- `scheduled` processes new data and publishes at most one queued job when `SOCIAL_AUTO_PUBLISH` is exactly `true`.

The workflow commits intake/queue state before any provider call, then stores each provider outcome in a second state commit. A repository-wide concurrency lock prevents overlapping publication runs. If a state push races, the workflow rebases once, reruns validation, and otherwise fails closed.

`Publish Instagram editorial guide` runs at `15:00 UTC` on Tuesday and Thursday (12:00 in São Paulo). It uses the same concurrency lock and exact checkpoint order: enqueue and commit intent, observe bounded bucket usage at runtime, upload and verify seven immutable carousel JPEGs in the dedicated public R2 bucket, publish and commit the carousel ID, commit a unique Story intent, then validate crop-free feed-media compatibility and commit either a provider receipt or an explicit unsupported result. Scheduled runs require `INSTAGRAM_EDITORIAL_AUTO_PUBLISH=true`.

Manual editorial modes:

- `dry-run` creates downloadable carousel slides, caption, and manifest without external writes.
- `controlled` publishes one explicit catalog item only when confirmation is exactly `PUBLISH_ONE_EDITORIAL_POST`.
- A failed editorial stage can be reset locally only with the exact confirmation `RESET_EDITORIAL_STAGE`; reset and publication are separate operations.

Editorial progress is stored in `state/editorial.json`. Job intake, provider results, and the non-backfilled Story stage remain in the schema-3 `state/queue.json` and `state/publications.json` files.

## Configuration

Store workflow configuration as individual repository secrets so GitHub masks each
value in logs. Do not combine them into a JSON secret:

- Paths and public data: `DATA_PATH`, `WEB_PATH`, `DATA_MANIFEST_URL`,
  `PUBLIC_SITE_ORIGIN`, and `WEB_DEPLOY_REPOSITORY`
- Provider configuration: `BLUESKY_SERVICE_URL`, `MASTODON_BASE_URL`,
  `THREADS_API_URL`, `INSTAGRAM_API_ORIGIN`, `META_GRAPH_VERSION`,
  `INSTAGRAM_USER_ID`, `LINKEDIN_API_ORIGIN`, `LINKEDIN_API_VERSION`,
  `LINKEDIN_ORGANIZATION_ID`, `LINKEDIN_PROVIDER` (Buffer or the direct provider fallback), `BUFFER_API_ORIGIN`,
  `BUFFER_ORGANIZATION_ID`, `BUFFER_LINKEDIN_CHANNEL_ID`,
  `BUFFER_TWITTER_CHANNEL_ID`, `PUBLISHING_ENDPOINT`, and `PUBLISHING_CLIENT_ID`
- Rollout flags: `SOCIAL_AUTO_PUBLISH`, `MASTODON_AUTO_PUBLISH`, `THREADS_AUTO_PUBLISH`,
  `INSTAGRAM_AUTO_PUBLISH`, `LINKEDIN_AUTO_PUBLISH`,
  `INSTAGRAM_STORY_AUTO_PUBLISH`, `INSTAGRAM_EDITORIAL_AUTO_PUBLISH`,
  `PUBLISHING_SOCIAL_SHADOW_ENABLED`, and `PUBLISHING_MASTODON_ENABLED`
- Direct public media storage: `OPENINGS_R2_ENABLED`, `OPENINGS_R2_ACCOUNT_ID`,
  `OPENINGS_R2_BUCKET`, `OPENINGS_R2_BUCKET_PURPOSE`, and `OPENINGS_R2_PUBLIC_ORIGIN`.
  Job publishing also uses fresh bounded `OPENINGS_R2_CAPACITY_JSON` evidence; editorial
  publishing instead reads object count and retained bytes directly with one bounded listing.

Keep the public `INSTAGRAM_EDITORIAL_AUTO_PUBLISH` repository variable only for
the job-level gate, and ensure it mirrors the same-named secret. GitHub does not
make secrets available while evaluating that gate. All other values above are
read from secrets by the workflow.

Also configure these credential secrets:

- `WEB_DEPLOY_TOKEN` — a fine-grained GitHub token limited to `openings-dev/web-deploy`, with repository Contents set to read and write so it can create `repository_dispatch` events
- `BLUESKY_IDENTIFIER`
- `BLUESKY_APP_PASSWORD`
- `MASTODON_ACCESS_TOKEN`
- `THREADS_ACCESS_TOKEN` — requires `threads_basic` and `threads_content_publish`
- `INSTAGRAM_ACCESS_TOKEN` — for a professional account with `instagram_business_basic` and `instagram_business_content_publish`
- `OPENINGS_R2_ACCESS_KEY_ID` and `OPENINGS_R2_SECRET_ACCESS_KEY` — narrow credentials exposed only to the asset-upload step; uploads are create-only and verified from the public origin before provider publication
- `BUFFER_API_KEY` — the personal key for the `Openings HQ` Buffer account; store it only as a GitHub secret
- `LINKEDIN_ACCESS_TOKEN` — required only by the direct provider and requires LinkedIn `w_organization_social` and `r_organization_social` permissions

`web-deploy` owns the Hostinger FTP secrets and uploads only the requested job directory for incremental events. Never place credentials in `.env` files committed to this repository.

## Rollout

The editorial production sequence is:

1. Configure the dedicated public R2 bucket identity, purpose, origin, and narrow credentials with read/list/create-only object permissions.
2. Configure the Instagram Business account ID, supported Graph API version, and access token.
3. Keep both new flags `false` and run local/editorial dry runs.
4. Run one controlled job publication with Story and one controlled editorial guide.
5. Confirm all seven public JPEG hashes/content types, the feed ID, and the durable crop-free Story compatibility result.
6. Enable `INSTAGRAM_STORY_AUTO_PUBLISH`, then `INSTAGRAM_EDITORIAL_AUTO_PUBLISH`.

For LinkedIn through Buffer:

1. Connect only the official Openings.dev LinkedIn Page to the `Openings HQ` organization.
2. Create one personal key and store it as `BUFFER_API_KEY`; never commit or print its value.
3. Configure `LINKEDIN_PROVIDER=buffer`, `BUFFER_ORGANIZATION_ID`, and `BUFFER_LINKEDIN_CHANNEL_ID` while leaving `LINKEDIN_AUTO_PUBLISH=false`.
4. Run `controlled` with `publish_linkedin` enabled and confirmation `PUBLISH_ONE_JOB`.
5. Verify the Buffer result, public LinkedIn URL, canonical link, image, and duplicate reconciliation.
6. Enable `LINKEDIN_AUTO_PUBLISH=true` only after the controlled publication passes.

For Twitter/X through Buffer:

1. Connect only the official Openings.dev Twitter/X account to the `Openings HQ` organization.
2. Reuse the existing `BUFFER_API_KEY` and `BUFFER_ORGANIZATION_ID`; add `BUFFER_TWITTER_CHANNEL_ID` for the new channel.
3. Twitter/X is enabled by default alongside Bluesky; Mastodon is disabled unless explicitly reactivated through its separate reviewed flag.
4. Run one controlled publication and verify the Buffer result, public tweet URL, canonical link, image, and duplicate reconciliation before relying on the scheduled run.
5. Before this code reaches production, run `npm run migrate:twitter-state -- --state state --confirmation MIGRATE_TWITTER_STATE` once against the live `state/` directory so existing queue items and publication records gain the new `twitter` field.

Buffer downloads the stable image directly from `openings.dev`; this repository does not upload media to Buffer or use a paid storage feature. Keep a flag disabled if its credential, public media, or durable result cannot be verified — Twitter/X has no such flag, so an incomplete `BUFFER_TWITTER_CHANNEL_ID` setup will surface as a retryable `twitter` stage rather than silently skipping. Long-lived Meta tokens and any direct LinkedIn access token must be renewed before expiry. The Instagram account must be a professional Business account authorized for content publishing.

## License

MIT
# Cloudflare social handoff

`@trebla/publishing@0.1.0` prepares and submits one durable `social.shadow`
delivery. The data pipeline retains ownership of web entities. Legacy social
providers still own public posts; a shadow receipt does not indicate a post
was published to a network.

The regular dry run also writes a private handoff under its output directory.
The production bridge submits it before deploying its assets when
`PUBLISHING_SOCIAL_SHADOW_ENABLED` is enabled. Configure `PUBLISHING_ENDPOINT`,
`PUBLISHING_CLIENT_ID`, and `PUBLISHING_CLIENT_SECRET` as individual GitHub
secrets. Dry runs do not read the credential or make platform requests.

For an explicit local handoff:

```sh
npm run platform -- prepare --job job.json --media card.png
npm run platform -- submit --handoff .publishing/outbox/HASH/handoff.json
npm run platform -- status --publication PUBLICATION_ID
```

Submission verifies local media, uploads it, and submits only that envelope.
Capacity deferrals exit with code 75 and retain the handoff for retry. Accepted
receipts suppress repeated local uploads; interrupted submissions reuse the
same idempotency key. Keep the handoff directory and original media together.
Failed automatic runs preserve their recovery artifacts for one day. Restore
them under the same checkout paths when resuming on another runner, since
handoff upload bindings contain absolute local paths. Secrets never belong in
handoffs, source control, or recovery artifacts.
