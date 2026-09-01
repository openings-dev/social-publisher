# English Instagram Editorial Catalog Design

## Goal

Make every future Instagram career tip from `social-publisher` read as natural English. Keep the existing published tip post and its Story unchanged. Job opening posts remain outside this change, and an original job title may stay in the language used by the employer.

The editorial catalog keeps its current 36 topics, seven-slide carousel format, dedicated Story image, Monday, Wednesday, and Friday schedule, duplicate protection, and durable publication state.

## Content policy

Every reader-facing editorial field must be English:

- carousel titles, body copy, examples, checklists, and calls to action;
- Story labels, titles, and body copy;
- captions, action labels, source labels, and hashtags.

The writing should sound like practical advice from a sharp career editor. It should use direct verbs, concrete examples, varied sentence shapes, and specific next actions. Human review applies the full `no-ai-slop` checklist to generic motivation, dramatic fragments, rhetorical setups, fake insight, inflated importance, recap endings, and robotic symmetry.

Editorial copy must not contain em dashes or en dashes. Hyphens remain valid inside ordinary compound words and identifiers. Automated validation rejects the banned vocabulary and deterministic text patterns defined by the repository's `no-ai-slop` checks. Qualitative patterns remain part of the full catalog review.

## Source policy

Future captions may name institutional and first-party sources. LinkedIn guidance must use official LinkedIn documentation. Resume, application, search, and interview guidance may continue to use Harvard Career Services, CareerOneStop, and the U.S. Department of Labor.

The previously used personal LinkedIn article and its author must be removed from the catalog, caption output, validation contracts, README, and active editorial documentation. Captions use `Source:` for one source and `Sources:` for more than one source.

Sources support the advice, but the copy must remain original. No source sentence may be copied into a slide or caption.

## Catalog and versioning

All 36 catalog entries move to content version `2`. The editorial state's `catalogVersion` also moves to `2` so the deployment path and state describe the same generation of content. The state schema remains version 1 because its structure does not change.

Version 1 history remains valid. The state migration preserves the existing publication record for `linkedin-headline-clara`, including its provider IDs and URLs. The migration does not enqueue, delete, replace, or republish that item.

State validation accepts version 1 history as a legacy publication and requires version 2 for new pending editorial work. The first LinkedIn topic remains subject to the existing 84-day repeat interval. When it becomes eligible again, it will deploy to the immutable `/2/` asset path and publish in English.

Topics with no publication history remain eligible on their normal schedule. The next scheduled item uses version 2 and English assets.

## Rendering and captions

The rendering pipeline keeps the existing visual system and dimensions:

- 36 carousels with seven 1080 by 1350 slides each;
- 36 dedicated 1080 by 1920 Story images;
- 36 captions within Instagram's 2,200-character limit.

Shared labels move to English, including `Why it matters`, `Try this`, `Before and after`, `Quick checklist`, and `Do it today`. Pillar labels become `LINKEDIN`, `RESUME`, `JOB SEARCH`, `APPLICATION`, and `INTERVIEW`.

Captions start with the topic, explain the action without repeating every slide, provide one specific next step, name approved sources, and finish with a small set of English discovery hashtags. The source line is informational, not promotional.

## Validation

Validation must fail before deployment when any future editorial item has:

- Portuguese interface labels or known Portuguese catalog phrases;
- an em dash or en dash in reader-facing copy;
- the retired personal LinkedIn source, author, or URL;
- a non-English editorial hashtag;
- banned `no-ai-slop` vocabulary or a deterministic prohibited text pattern;
- missing approved source metadata;
- fewer or more than seven slides, four checklist items, or one Story;
- a caption longer than the Instagram limit;
- a pending version that does not match the catalog item.

A full catalog review renders all 252 slides, 36 Story images, and 36 captions. It checks dimensions, source metadata, output limits, versioned paths, and the existing duplicate-safe publication contracts. The reviewer then applies the complete `no-ai-slop` evaluation to all 36 captions and the underlying catalog copy.

## Rollout

1. Disable only `INSTAGRAM_EDITORIAL_AUTO_PUBLISH` while the catalog changes are in flight. Job publication and job Stories continue normally.
2. Rewrite the catalog and shared caption labels in English.
3. Replace the LinkedIn source with official LinkedIn documentation.
4. Add the catalog and state migration for version 2.
5. Render and validate every catalog entry locally.
6. Push the change and wait for the read-only `Validate` workflow to pass.
7. Re-enable `INSTAGRAM_EDITORIAL_AUTO_PUBLISH`.
8. Let the next normal editorial schedule publish the first version 2 guide. Do not run a controlled replacement post.

If validation or the remote workflow fails, keep editorial publishing disabled. Existing job workflows remain unaffected.

## Success criteria

- The existing Portuguese tip post and Story remain untouched.
- Every future editorial carousel, Story, and caption is English.
- No future editorial output names or links to the retired personal LinkedIn article.
- Institutional and official sources remain visible in English captions.
- Future editorial copy contains no em dash or en dash and passes the `no-ai-slop` checks.
- Version 1 publication history remains intact and no completed item is republished early.
- The next eligible scheduled guide publishes through the existing automatic workflow after version 2 is enabled.
