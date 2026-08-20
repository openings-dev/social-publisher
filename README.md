# social-publisher

`social-publisher` turns genuinely new jobs indexed by [openings.dev](https://openings.dev) into useful, source-grounded posts for the official [Bluesky](https://bsky.app/profile/openingshq.bsky.social) and [Mastodon](https://mastodon.social/@openingshq) accounts.

The service is intentionally small and cautious. It publishes at most one queued job every two hours, never backfills older issues added through community discovery, and verifies a job-specific Open Graph page before sending either social post.

## How it works

1. Read immutable public snapshots from [`openings-dev/data-pipeline`](https://github.com/openings-dev/data-pipeline).
2. Detect genuinely new open issues and content changes to known jobs.
3. Render and upload only `jobs/<id>/index.html` and `jobs/<id>/opengraph-image.png`.
4. Publish the canonical link to Bluesky and Mastodon with provider-specific duplicate protection.
5. Commit sanitized queue and publication state so interrupted runs can resume safely.

Bluesky receives an explicit external card with the generated thumbnail. Mastodon receives the canonical link and resolves the same Open Graph image through its PreviewCard. X is not included because its write API is not part of the free rollout.

## Safety defaults

- The first production intake records a baseline and queues nothing.
- Scheduled publication stays disabled unless `SOCIAL_AUTO_PUBLISH` is exactly `true`.
- Pull requests receive no production credentials and cannot publish.
- FTP updates are restricted to one validated job directory at a time.
- Per-network state prevents a successful channel from being posted twice when the other fails.
- Errors stored in Git are categorized and sanitized; credentials and raw provider payloads are never tracked.

## Local validation

Use Node.js 20 or newer and npm:

```sh
npm ci
npm run validate
npm run dry-run -- --fixture assets/fixtures/job.json --output .tmp/dry-run
```

Dry run generates the final copy, bridge HTML, and Open Graph image without FTP, provider authentication, tracked-state changes, or external writes.

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
- `controlled` publishes one explicit queued job only when the confirmation is exactly `PUBLISH_ONE_JOB`.
- `retry-stage` resets one failed bridge or provider stage only when the confirmation is exactly `RESET_FAILED_STAGE`; it never publishes in the same operation.
- `scheduled` processes new data and publishes at most one queued job when `SOCIAL_AUTO_PUBLISH` is exactly `true`.

The workflow commits intake/queue state before any provider call, then stores Bluesky and Mastodon outcomes in a second state commit. A repository-wide concurrency lock prevents overlapping publication runs. If a state push races, the workflow rebases once, reruns validation, and otherwise fails closed.

## Configuration

Repository variables:

- `PUBLIC_SITE_ORIGIN=https://openings.dev`
- `MASTODON_BASE_URL=https://mastodon.social`
- `FTP_JOB_ROOT=/public_html/jobs`
- `SOCIAL_AUTO_PUBLISH=false` until controlled rollout passes

Repository secrets:

- `FTP_SERVER`
- `FTP_USERNAME`
- `FTP_PASSWORD`
- `BLUESKY_IDENTIFIER`
- `BLUESKY_APP_PASSWORD`
- `MASTODON_ACCESS_TOKEN`

Prefer a Hostinger FTP account restricted to the jobs directory. Never place credentials in `.env` files committed to this repository.

## Rollout

The production sequence is baseline → real-data dry run → one explicitly confirmed controlled post → duplicate-reconciliation check → automatic publication. Automatic publication must remain disabled if the canonical bridge, Bluesky card, Mastodon PreviewCard, or durable state cannot be verified.

## License

MIT
