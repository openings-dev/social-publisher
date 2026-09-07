# Clean social artwork for openings.dev

## Approval and purpose

The user approved combining quick tips, before/after examples and practical guides,
then requested the official openings logo, fewer labels, no drawn CTA buttons and
contextual calls to save, share, like or visit the bio link. These rules also apply
to job artwork. The approved local reference is
`../../../../.superpowers/brainstorm/83611-1788713954/content/editorial-contextual-cta.html`.
The reference is a mockup, not a production renderer or an actual job listing.

This spec covers the first independently releasable part: consistent production
artwork. Content expansion and TikTok publishing remain subsequent work, not claims
of functionality delivered by this change.

## Visual contract

- Use the canonical wordmark from `web/public/openings-wordmark-light.svg` and its
  dark-background counterpart. Never reconstruct the symbol or wordmark as text.
- Preserve Figtree and the existing Night, paper, lavender and peach palette.
- Retain meaningful titles, examples and checklist content. Remove series names,
  decorative numbering, eyebrows such as “Your turn”, “The interview kit”,
  “Your next step” and ornamental badges from exported editorial images.
- “Before” and “After” are useful comparison labels and remain. Internal guide IDs,
  slide indices and series metadata remain in data, not in the visible artwork.
- Render the CTA as a single plain-text line with a leading arrow: no pill,
  filled rectangle, border, shadow or simulated clickable control.
- Use one contextual call per standalone asset. In a carousel, reserve the CTA for
  the final slide rather than repeating an engagement request on every slide.
- Job Instagram feed, Reel and Story artwork uses `→ Link na bio`.
- Editorial saving-oriented guides use `→ Salve para revisar`; sharing-oriented
  examples use `→ Compartilhe esta dica`. Other calls, including liking, must be
  explicitly assigned in the reviewed catalog, not randomly combined.
- Match CTAs to the destination: do not ask users to save a Story when that action
  is unavailable. Use a suitable sharing call for editorial Stories instead.
- Retain English editorial body copy. Portuguese CTA labels match the approved
  mockup; do not translate the complete catalog as a side effect.
- For clickable link-preview cards used outside Instagram/TikTok, remove the fake
  button but use `→ openings.dev` instead of implying that the link is in a bio.
  Actual website links and buttons are outside this visual-only scope.

## Layout and formats

Job feed remains 1080×1350. Job Story and Reel remain the same 1080×1920 composition.
Editorial feed and Story retain their existing export dimensions. Essential content
must fit the established conservative reading guides; decorative backgrounds may
bleed to the edges. These guides are internal targets, not universal platform
guarantees. Test long text and CTA contrast in light and dark variants.

Reflow the editorial templates to achieve the approved clean hierarchy rather than
merely hiding text while leaving its blank containers. Preserve the seven-slide
production carousel contract and all substantive guidance. The three-slide mockup
demonstrates visual direction; it does not authorize dropping four content slides.

## Implementation boundaries

1. Add a focused, deterministic CTA selector/renderer with separate job, link-card,
   editorial-feed and editorial-Story contexts. Rendering uses validated choices,
   never arbitrary SVG or HTML. Selection is stable across retries.
2. Update `src/modules/render/job-poster.mjs` and its portable web-deploy copy.
   Preserve the saved artwork rotation and music selection. Do not edit unrelated
   legacy WIP in `social-poster-model.mjs` or `reel-poster.mjs`.
3. Update `src/modules/render/editorial-card.mjs` to the clean wordmark/title/body/
   CTA hierarchy. Keep catalog source references and copy validation intact.
4. Keep production previews on the same renderers as actual exports. The local
   HTML mockup must not become a separate production rendering implementation.
5. Version changed assets and update matching deployment validation/cache contracts.
   Preserve pending historical payload compatibility explicitly. Do not overwrite
   completed publication results, clear ledgers or replay previously published posts.

## Publication and state safety

Do not change provider credentials, activate another destination, dispatch posts,
change scheduled frequency or increase daily volume in this visual release.
Keep the existing durable publication checkpoints and duplicate protection.
Leave original licensed music and its alternating selection unchanged.
Use local micro-commits on main, preserving the stash and unrelated user files.
When push is authorized, release the compatible web-deploy changes before publisher.

## Acceptance checks

- Tests first demonstrate that the old fake buttons/labels violate this contract.
- Every current job direction and format has exactly one destination-appropriate
  plain CTA, with no CTA background shape.
- Every editorial catalog entry renders all seven slides and its Story without
  forbidden decorative labels, overflow or clipped text.
- Native render inspection confirms official logo, readable contrast and content
  within the target guide, including longest titles, examples and CTA labels.
- Story and Reel job SVGs remain byte-identical; both licensed soundtracks still
  produce valid native videos with the existing dimensions and audio encoding.
- Publisher validation, standalone deployment contracts and portable-file parity
  pass. Retry tests confirm stable selection and no duplicate publication.
- Produce a local review gallery using real renderers before releasing.

## Follow-on work, tracked separately

After the visual release, expand the reviewed tips catalog and implement derived
quick-tip images and editorial videos. Preserve source attribution, avoid invented
results and set an explicit reviewed content cadence before enabling more posts.

For TikTok, verify the available account connection, free publishing route, supported
photo/video operations, permissions and destination-specific layout requirements.
Asset generation and successful TikTok publication are separate acceptance criteria.
Do not label the destination active or promise automatic posting until a verified
integration exists. Any required account access or terms acceptance is handled
separately with the user.

## Self-review

The approved visual rules are covered without changing content language, publication
volume or the seven-slide schema. Contextual CTAs distinguish Stories and clickable
link previews from feed assets. The remaining content/video/TikTok expansion is
explicitly separate so this first release can be tested and shipped independently.

## Approved compact editorial revision

The subsequent approved text-only preview centers the complete logo/text/CTA stack
vertically and reduces internal gaps. Implemented as editorial render revision 4:

- Center within the existing reading guide (feed midpoint 675px; Story midpoint
  908px), preserving the larger bottom reserve for social interface overlays.
- Keep both horizontal alignments. Night and lavender default to centered text;
  paper and peach default to left-aligned text. Each guide stays stable on retries.
- Use 64px after the logo/title transition, 40px before supporting text and 52px
  before a closing CTA. Examples use 16px label spacing; checklist items use 32px.
- Start titles at 104px and support at 46px, reducing only when longer content
  requires it. Never truncate text or split a long word between lines.
- Use the approved short portfolio cover, contribution and decision copy while
  retaining its seven-slide structure, practical example, checklist, confidentiality
  reminder and source. Other guides keep their existing copy.
- New exports use the `/4` asset namespace. Content/state version 2 and saved
  publication checkpoints are unchanged. Job artwork and music are unchanged.

The production preview is generated by `.tmp/preview-centered-production.mjs`.
Native tests cover all 36 guides, seven slides plus Story, in both alignments.

## English brand refinement (supersedes prior editorial details)

The user approved `brand-editorial-english-v1.html` and confirmed this profile is
English-only. Editorial render revision 5 implements the approved seven-slide
portfolio case study, with one instruction and brief support per slide. This guide
uses a validated `short-guide` sequence of cover, five actions and final CTA.
The remaining 35 guides keep their existing content and example/checklist schema.

Use the official 350px wordmark, 96px Figtree display at weight 550, muted 46px body
copy, authored line breaks where supplied, and left alignment by default. Center
alignment remains available. Portfolio colors follow Night, Paper, Paper, Lavender,
Paper, Paper, Night, with restrained Brand Mint emphasis on the cover. Preserve
vertical centering inside the existing reading guides and never truncate copy.

New editorial calls are `Share this tip →`, `Save for later →` and, for the portfolio
closing slide, `Save for your next portfolio update →`. New job cards use
`→ Link in bio`; clickable preview cards retain `→ openings.dev`. This supersedes
the earlier Portuguese CTA exception. Original listing data remains unchanged.

Editorial assets use namespace `/5`. Job artwork revision 3 uses image version 7
and video version 8. Freeze revision 2 as `job-poster-v6.mjs`, keep historical
payloads canonical and preserve their renderers, metadata and audio. Deployment
compatibility must ship before the publisher when pushing is authorized.

No schedule, provider access, publication ledger, job layout, or soundtrack change
is included. Production review gallery: `.tmp/preview-brand-production.mjs`.
