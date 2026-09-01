# Instagram Stories and Editorial Feed Design

## Objective

Extend `social-publisher` so every Instagram feed post created by the service is followed by a Story, and publish three source-grounded educational carousels per week on Instagram. The workflow must be automatic, resumable, duplicate-safe, and independent from Bluesky, Mastodon, and Threads.

## Product scope

The feature covers only Instagram media created by `social-publisher`. Posts created manually in Instagram are out of scope.

There are two feed-content families:

1. New-job Reels already produced by the job publication queue.
2. Educational carousels published on Monday, Wednesday, and Friday.

Every successfully published feed item receives one Story:

- A job Reel reuses its verified 1080×1920 MP4 as a Story.
- An educational carousel receives a dedicated 1080×1920 JPEG teaser that directs viewers to the profile.

The Instagram API cannot reproduce the native in-app “share post to Story” interaction. The publisher creates a separate Story media object through the official `STORIES` container flow. Interactive stickers are out of scope; the rendered call to action says to view the feed post on `@openingshq`.

## Editorial experience

Educational posts use the approved white-led openings.dev visual system: warm-white canvas, dark green typography, one pastel editorial band, strong typographic hierarchy, and compact examples. They do not imitate screenshots or LinkedIn branding.

Each carousel contains seven 1080×1350 JPEG slides:

1. Outcome-led cover.
2. Why the topic matters.
3. First actionable correction.
4. Before-and-after example.
5. Second actionable correction.
6. Short checklist.
7. Save/share/apply call to action and `openings.dev` attribution.

Each caption includes a concise promise, a summary, one concrete action, a prompt to save or share, a link or attribution when a source directly informed the post, and a bounded set of discovery hashtags. Content is written in Brazilian Portuguese. It paraphrases sources and never republishes source prose.

The initial catalog contains 36 complete guides, enough for a 12-week cycle:

- 12 LinkedIn profile guides.
- 8 résumé and portfolio guides.
- 6 job-search guides.
- 4 application guides.
- 6 interview guides.

The LinkedIn series uses Nicole Barra’s “Optimizing Your LinkedIn Profile for International Opportunities” as its initial source. Topics include profile searchability, profile language, headline, About, experience titles and descriptions, skills, Featured work, recommendations, remote-work context, contact information, activity, and privacy/Open to Work settings.

The catalog is structured data checked into the repository. Runtime AI generation is deliberately excluded: publication remains automatic while every fact, example, caption, and source remains reviewable and deterministic. A completed catalog starts another cycle only after every entry has been used and each entry’s minimum repeat interval has elapsed. If no item is eligible, the workflow exits without publishing.

## Scheduling

Editorial publication runs at 12:17 America/Sao_Paulo on Monday, Wednesday, and Friday. The three weekly slots are assigned by pillar:

- Monday: LinkedIn.
- Wednesday: résumé or application.
- Friday: job search or interview.

The scheduler selects the least recently published eligible item in the slot’s pillars. A deterministic content ID breaks ties. It never selects an item already pending or publishing.

The editorial workflow and the existing job workflow share the repository-wide `social-publisher-publication` concurrency group. They therefore cannot write tracked state or call Instagram at the same time.

## Architecture

### Content catalog and renderer

`social-publisher` owns the editorial definitions, validation, captions, and SVG rendering. A definition contains:

- Stable content ID and version.
- Pillar and source metadata.
- Cover promise and slide copy.
- Caption blocks and hashtags.
- Story teaser copy.
- Minimum repeat interval.

The renderer emits seven 4:5 SVGs and one 9:16 Story SVG. Sharp converts local previews to JPEG during validation. Production sends bounded canonical SVG payloads to `web-deploy`, matching the existing credential boundary.

### Public asset deployment

`web-deploy` gains a `publish_instagram_editorial` repository-dispatch contract. It validates the content ID, version, expected asset count, dimensions, allowed SVG features, individual SHA-256 hashes, and total payload size. It converts the SVGs to JPEG and uploads them atomically under:

`/public_html/social/editorial/<content-id>/<version>/`

The directory contains `slide-01.jpg` through `slide-07.jpg`, `story.jpg`, and a small manifest. A full site deployment excludes `/social/editorial/` from destructive mirroring, just as it preserves incremental job bridges.

`social-publisher` polls the public manifest and every JPEG before creating Instagram containers. Verification checks HTTPS, content type, dimensions, version, and hashes.

### Instagram publishing

The Instagram client exposes three bounded operations that share authentication, container polling, result normalization, and error categorization:

- Publish a Reel to the feed.
- Publish a carousel to the feed.
- Publish an image or video Story.

A carousel first creates seven child image containers with `is_carousel_item=true`, then one `CAROUSEL` parent with the ordered child IDs and caption, and finally publishes the parent. A Story creates a `STORIES` container using either `image_url` or `video_url`, waits for readiness, and publishes it.

Feed and Story publication stages are independent. A Story cannot start before its feed stage contains a durable provider media ID. Retrying a Story never invokes the feed publisher.

## State and migration

The tracked state schema increments from version 2 to version 3.

Existing job queue items gain an `instagramStory` stage. Migration assigns:

- `pending` only for newly enqueued jobs whose Instagram feed stage is enabled.
- `skipped_disabled` when Instagram is disabled.
- `skipped_before_activation` for every historical queue item, including previously published jobs, so activation never backfills old Stories.

Editorial state lives in `state/editorial.json` and records:

- The catalog version.
- Pending publication records.
- Per-content last-published timestamps and cycle count.
- Asset, feed, and Story stages with attempts, timestamps, sanitized errors, and provider results.

The state contains no source article bodies, access tokens, raw provider payloads, or other credentials.

## Duplicate safety and failure handling

All external writes happen after durable intent is committed. The editorial workflow follows this order:

1. Select and enqueue one content item.
2. Commit the pending editorial state.
3. Deploy and verify public assets.
4. Publish the feed carousel and save its provider ID.
5. Publish the Story and save its provider ID.
6. Commit each changed result state.

The existing job workflow finishes and commits its normal publication result before a separate Story command selects the oldest job whose Instagram feed is published and Story stage is ready. The Story result is committed in a second checkpoint. This keeps the durable feed boundary explicit without reopening any feed channel.

Feed reconciliation uses the stable editorial marker in the caption and the stored media ID. Story reconciliation uses the canonical public media URL when Instagram exposes it. If a publish response is ambiguous and a unique existing Story cannot be proven, the stage fails closed with `manual_review`; it does not automatically create another Story.

Provider authentication, rate-limit, invalid-media, container, deployment, and ambiguous-publication failures have sanitized codes. Retryable failures receive at most three attempts. A manually controlled reset can reopen only a failed asset, feed, or Story stage.

## Configuration and rollout

Two independent repository variables gate production behavior:

- `INSTAGRAM_STORY_AUTO_PUBLISH` enables Stories for newly created feed publications.
- `INSTAGRAM_EDITORIAL_AUTO_PUBLISH` enables scheduled educational carousels.

The existing Instagram credentials and `instagram_business_content_publish` permission are reused. The account must remain an Instagram Business account because Story publication is not available to Creator accounts through this API.

Rollout sequence:

1. Dry-run renders a complete carousel and Story artifact without external writes.
2. Controlled mode deploys and publishes one explicit editorial content ID after the exact confirmation `PUBLISH_ONE_EDITORIAL_POST`.
3. Controlled job mode publishes one new job with its Story.
4. Story automation is enabled for new job feed posts.
5. Editorial scheduling is enabled.

## Validation

Deterministic validation covers:

- Editorial schema, unique IDs, complete seven-slide structure, captions, sources, and repeat intervals.
- 1080×1350 carousel JPEGs and 1080×1920 Story JPEGs.
- Text fitting and safe-area constraints for short, long, accented, and mixed-language copy.
- Monday/Wednesday/Friday pillar selection and timezone behavior.
- Fair rotation, repeat intervals, and restart determinism.
- Version-2-to-version-3 migration without historical Story backfill.
- Carousel child ordering and official container request parameters.
- Feed-before-Story dependency and Story-only retry behavior.
- Reconciliation after provider timeouts and fail-closed ambiguous responses.
- Cross-repository dispatch validation, public asset verification, and bounded payloads.
- Dry-run output containing all carousel slides, the Story, captions, manifests, and hashes.

Production completion requires both repository validation suites to pass and the controlled rollout to return durable Instagram IDs for feed and Story.

## Out of scope

- Detecting or sharing manually created Instagram posts.
- Instagram stickers, music, polls, mentions, or native post-sharing UI.
- Editorial publication to Threads, Bluesky, Mastodon, or X.
- Runtime AI copy generation.
- Engagement analytics or automatic content optimization.
