# social-publisher

`social-publisher` turns genuinely new jobs indexed by [openings.dev](https://openings.dev) into useful, source-grounded posts for the official [Bluesky](https://bsky.app/profile/openingshq.bsky.social), [Mastodon](https://mastodon.social/@openingshq), [Threads](https://www.threads.com/@openingshq), and [Instagram](https://www.instagram.com/openingshq/) accounts.

The service is intentionally small and cautious. It publishes at most one queued job every two hours, never backfills older issues added through community discovery, and verifies a job-specific Open Graph page before sending either social post.

## How it works

1. Read immutable public snapshots from [`openings-dev/data-pipeline`](https://github.com/openings-dev/data-pipeline).
2. Detect genuinely new open issues and content changes to known jobs.
3. Render `jobs/<id>/index.html` and `jobs/<id>/opengraph-image.png`, then request an incremental deployment from [`openings-dev/web-deploy`](https://github.com/openings-dev/web-deploy). That deploy also creates the public JPEG required by Instagram.
4. Publish the canonical link through every enabled channel with provider-specific duplicate reconciliation.
5. Commit sanitized queue and publication state so interrupted runs can resume safely.

Bluesky receives an explicit external card. Mastodon and Threads receive the canonical link so the public Open Graph preview can resolve naturally. Instagram receives the verified JPEG plus concise job copy. X is not included because its write API is not part of the free rollout.

## Safety defaults

- The first production intake records a baseline and queues nothing.
- Scheduled publication stays disabled unless `SOCIAL_AUTO_PUBLISH` is exactly `true`.
- Pull requests receive no production credentials and cannot publish.
- Hostinger credentials remain exclusively in `web-deploy`; this repository can request only one validated job bridge at a time.
- Social publication starts only after the public HTML and image match the locally generated hashes.
- Per-network state prevents a successful channel from being posted twice when the other fails.
- Instagram and Threads are independent opt-ins. Jobs already known when either channel is activated are never backfilled.
- Errors stored in Git are categorized and sanitized; credentials and raw provider payloads are never tracked.

## Local validation

Use Node.js 20 or newer and npm:

```sh
npm ci
npm run validate
npm run dry-run -- --fixture assets/fixtures/job.json --output .tmp/dry-run
```

Dry run generates the final copy, bridge HTML, and Open Graph image without deployment requests, provider authentication, tracked-state changes, or external writes.

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
- `retry-stage` resets one failed bridge or provider stage only when the confirmation is exactly `RESET_FAILED_STAGE`; it never publishes in the same operation.
- `scheduled` processes new data and publishes at most one queued job when `SOCIAL_AUTO_PUBLISH` is exactly `true`.

The workflow commits intake/queue state before any provider call, then stores each provider outcome in a second state commit. A repository-wide concurrency lock prevents overlapping publication runs. If a state push races, the workflow rebases once, reruns validation, and otherwise fails closed.

## Configuration

Repository variables:

- `PUBLIC_SITE_ORIGIN=https://openings.dev`
- `MASTODON_BASE_URL=https://mastodon.social`
- `WEB_DEPLOY_REPOSITORY=openings-dev/web-deploy`
- `SOCIAL_AUTO_PUBLISH=false` until controlled rollout passes
- `THREADS_AUTO_PUBLISH=false` until the controlled Threads rollout passes
- `INSTAGRAM_AUTO_PUBLISH=false` until the controlled Instagram rollout passes
- `THREADS_API_URL=https://graph.threads.net/v1.0`
- `INSTAGRAM_API_ORIGIN=https://graph.instagram.com`
- `META_GRAPH_VERSION` — the supported Graph API version (`v26.0`)
- `INSTAGRAM_USER_ID` — the numeric ID returned by Instagram Login

Repository secrets:

- `WEB_DEPLOY_TOKEN` — a fine-grained GitHub token limited to `openings-dev/web-deploy`, with repository Contents set to read and write so it can create `repository_dispatch` events
- `BLUESKY_IDENTIFIER`
- `BLUESKY_APP_PASSWORD`
- `MASTODON_ACCESS_TOKEN`
- `THREADS_ACCESS_TOKEN` — requires `threads_basic` and `threads_content_publish`
- `INSTAGRAM_ACCESS_TOKEN` — for a professional account with `instagram_business_basic` and `instagram_business_content_publish`

`web-deploy` owns the Hostinger FTP secrets and uploads only the requested job directory for incremental events. Never place credentials in `.env` files committed to this repository.

## Rollout

The production sequence for a new channel is credentials → controlled post → duplicate-reconciliation check → channel flag. Keep that channel disabled if its token, public media, or durable result cannot be verified. Long-lived Meta tokens must be refreshed before expiry.

## License

MIT
