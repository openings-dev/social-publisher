# English Instagram Editorial Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every future Instagram editorial tip with reviewed English copy while preserving the already published Portuguese post and its publication history.

**Architecture:** Keep the deterministic 36-guide catalog and existing Monday, Wednesday, Friday scheduler. Move the active catalog and state to version 2, add a reusable English copy policy to the existing content validator, use only official LinkedIn Help pages for LinkedIn guidance, and allow immutable version 1 history to remain valid. Job publication logic stays unchanged.

**Tech Stack:** Node.js 20+, ECMAScript modules, `node:assert`, Sharp, GitHub Actions, Meta Instagram Graph API.

---

## Accepted catalog shape

The active catalog keeps these topic IDs and counts:

| Pillar | Count | Topic IDs |
| --- | ---: | --- |
| LinkedIn | 12 | `linkedin-headline-clara`, `linkedin-idioma-do-perfil`, `linkedin-sobre-que-posiciona`, `linkedin-titulo-de-experiencia`, `linkedin-resultados-na-experiencia`, `linkedin-skills-encontraveis`, `linkedin-provas-em-destaque`, `linkedin-recomendacoes-que-comprovam`, `linkedin-contexto-remoto`, `linkedin-contato-profissional`, `linkedin-atividade-estrategica`, `linkedin-privacidade-open-to-work` |
| Resume | 8 | `resume-resumo-direto`, `resume-bullets-de-impacto`, `resume-metricas-com-contexto`, `resume-formato-ats`, `resume-curriculo-por-vaga`, `resume-projetos-relevantes`, `resume-portfolio-que-prova`, `resume-revisao-final` |
| Search | 6 | `search-busca-com-criterios`, `search-alertas-uteis`, `search-fontes-alem-do-linkedin`, `search-pesquisa-de-empresa`, `search-networking-intencional`, `search-rotina-semanal` |
| Application | 4 | `application-leia-os-requisitos`, `application-evidencias-de-fit`, `application-respostas-concisas`, `application-follow-up-profissional` |
| Interview | 6 | `interview-prepare-historias`, `interview-metodo-star`, `interview-comunique-raciocinio`, `interview-perguntas-ao-entrevistador`, `interview-entrevista-remota`, `interview-revisao-pos-entrevista` |

Every guide remains seven slides in this order: cover, context, action, example, action, checklist, CTA. Every guide also retains one Story, one caption, three to eight hashtags, at least one HTTPS source, and an 84-day minimum repeat interval.

## Task 1: Lock the new rules with failing validation coverage

**Files:**

- Modify: `src/modules/validation/run-validation.mjs:4367`
- Test: `src/modules/validation/run-validation.mjs`

- [ ] Add imports for `assertEditorialCopyPolicy` and `EDITORIAL_CONTENT_VERSION` from the new policy module that Task 2 will create.
- [ ] Change the catalog expectation from version `1` to `2`.
- [ ] Replace the personal-source assertion with source policy assertions:

```js
for (const item of EDITORIAL_CATALOG) {
  assert.equal(item.version, EDITORIAL_CONTENT_VERSION);
  assertEditorialCopyPolicy(item);
}
for (const item of EDITORIAL_CATALOG.filter(({ pillar }) => pillar === 'linkedin')) {
  assert.ok(item.sources.every(({ author, url }) => (
    author === 'LinkedIn Help'
      && new URL(url).hostname === 'www.linkedin.com'
      && new URL(url).pathname.startsWith('/help/linkedin/')
  )));
}
```

- [ ] Add negative fixtures proving the policy rejects Unicode dash characters, Portuguese shared labels, banned filler terms, and a non-official LinkedIn source.
- [ ] Change the formatted caption assertion from `Fonte:` to `Sources:` and assert that the output has no `\u2013` or `\u2014`.
- [ ] Add state coverage showing a version 2 catalog accepts version 1 publication history but enqueues new content as version 2.
- [ ] Run `npm run validate`.
- [ ] Expected result: FAIL because the policy module does not exist and the active catalog is still version 1.
- [ ] Commit the failing tests:

```bash
git add src/modules/validation/run-validation.mjs
git commit -m "test: define English editorial policy"
```

## Task 2: Add the deterministic English copy policy

**Files:**

- Create: `src/content/editorial-copy-policy.mjs`
- Modify: `src/modules/editorial/editorial-model.mjs:1-70`
- Test: `src/modules/validation/run-validation.mjs`

- [ ] Define `EDITORIAL_CONTENT_VERSION = '2'` and `EDITORIAL_CATALOG_VERSION = '2'`.
- [ ] Define the exact banned no-ai-slop terms as case-insensitive whole words or phrases:

```js
export const BANNED_EDITORIAL_TERMS = Object.freeze([
  'delve', 'foster', 'leverage', 'utilize', 'facilitate', 'empower',
  'streamline', 'robust', 'cutting-edge', 'paradigm shift', 'game changer',
  'this is huge', 'this changes everything', 'tapestry', 'realm', 'beacon',
  'multifaceted', 'meticulous', 'intricate', 'paramount', 'transformative',
  'elevate', 'embark', 'supercharge', 'harness', 'ever-evolving',
]);
```

- [ ] Traverse title, promise, slides, Story, caption, and hashtags as reader-facing text. Do not apply language checks to source titles, author names, or URLs.
- [ ] Reject `\u2013` and `\u2014` everywhere in reader-facing text.
- [ ] Reject the retired Portuguese shared labels and calls to action:

```js
const PORTUGUESE_MARKERS = Object.freeze([
  'por que isso importa', 'faca assim', 'antes e depois',
  'ajuste que faz diferenca', 'checklist rapido', 'aplique hoje',
  'veja o passo a passo completo no feed', 'salve este guia',
  'curriculo', 'busca de vagas', 'candidatura', 'entrevista', 'fonte:',
]);
```

- [ ] Normalize diacritics before matching markers so an old accented label also fails.
- [ ] Require every LinkedIn guide source to use `https://www.linkedin.com/help/linkedin/` and author `LinkedIn Help`.
- [ ] Call `assertEditorialCopyPolicy(content)` from `validateEditorialContent` after structural checks.
- [ ] Accept only version 2 content in `validateEditorialContent`.
- [ ] Run `npm run validate`.
- [ ] Expected result: FAIL on the old catalog copy and version.
- [ ] Commit:

```bash
git add src/content/editorial-copy-policy.mjs src/modules/editorial/editorial-model.mjs
git commit -m "feat: enforce English editorial copy policy"
```

## Task 3: Convert the shared catalog scaffold and caption to English

**Files:**

- Modify: `src/content/editorial-catalog.mjs:1-65`
- Modify: `src/modules/render/editorial-caption.mjs:1-22`
- Test: `src/modules/validation/run-validation.mjs`

- [ ] Replace the single LinkedIn source with topic-specific official LinkedIn Help constants for profile quality, headline, language, About, Experience, Featured, recommendations, skills, contact information, activity, and Open to Work.
- [ ] Keep the institutional Harvard, CareerOneStop, and U.S. Department of Labor sources.
- [ ] Change pillar labels to `LINKEDIN`, `RESUME`, `JOB SEARCH`, `APPLICATION`, and `INTERVIEW`.
- [ ] Change shared slide labels to `Why it matters`, `Do this`, `Before and after`, `A useful adjustment`, `Quick checklist`, and `Apply it today`.
- [ ] Change the Story ending to `Read the full guide in the feed.`
- [ ] Change the caption ending to `Save this guide before your next application.`
- [ ] Use `CareerTips` instead of the Portuguese career hashtag.
- [ ] Render sources as `${title}, ${author}` and label the section `Sources:`. Do not use a dash as a separator.
- [ ] Run `npm run validate`.
- [ ] Expected result: FAIL because individual guide bodies are still Portuguese.
- [ ] Commit:

```bash
git add src/content/editorial-catalog.mjs src/modules/render/editorial-caption.mjs
git commit -m "feat: translate editorial publishing scaffold"
```

## Task 4: Rewrite all 12 LinkedIn guides

**Files:**

- Modify: `src/content/editorial-catalog.mjs:67-251`
- Test: `src/modules/validation/run-validation.mjs`

- [ ] Rewrite each LinkedIn title, promise, context, two actions, before and after example, four checklist items, and CTA in direct English.
- [ ] Preserve each topic's practical intent and existing ID.
- [ ] Use the most specific official source for each topic:

| Topic | Official source |
| --- | --- |
| Headline | Edit your profile intro |
| Profile language | Create or delete a profile in another language |
| About | Edit the About section in your profile |
| Experience titles and results | Manage your Experience section |
| Skills | Add and remove skills on your profile |
| Featured proof | Featured section on your profile FAQs |
| Recommendations | Request a recommendation |
| Remote context and profile quality | How do I create a good LinkedIn profile? |
| Contact information | Manage your contact and personal info |
| Strategic activity | LinkedIn profile overview |
| Open to Work privacy | Let recruiters know you are Open to Work |

- [ ] Keep examples specific, such as `Backend Developer | Node.js and APIs | Reliable payment systems`, and avoid inflated claims.
- [ ] Run `npm run validate`.
- [ ] Expected result: FAIL only on the remaining Portuguese pillars.
- [ ] Commit:

```bash
git add src/content/editorial-catalog.mjs
git commit -m "content: rewrite LinkedIn guides in English"
```

## Task 5: Rewrite all 8 resume guides

**Files:**

- Modify: `src/content/editorial-catalog.mjs`
- Test: `src/modules/validation/run-validation.mjs`

- [ ] Rewrite the summary, impact bullets, metrics, ATS format, role tailoring, projects, portfolio, and final review guides.
- [ ] Use `resume` consistently, without accented spelling, to keep reader-facing copy ASCII-safe.
- [ ] Retain institutional Harvard and U.S. Department of Labor sources.
- [ ] Keep every example grounded in a task, scope, and result. Do not invent credentials or promise hiring outcomes.
- [ ] Run `npm run validate`.
- [ ] Expected result: FAIL only on search, application, and interview guides.
- [ ] Commit:

```bash
git add src/content/editorial-catalog.mjs
git commit -m "content: rewrite resume guides in English"
```

## Task 6: Rewrite the 6 search and 4 application guides

**Files:**

- Modify: `src/content/editorial-catalog.mjs`
- Test: `src/modules/validation/run-validation.mjs`

- [ ] Rewrite search criteria, alerts, job sources, company research, networking, and weekly routine guides.
- [ ] Rewrite requirements, evidence of fit, concise answers, and professional follow-up guides.
- [ ] Retain CareerOneStop as the primary search source and the existing institutional resume source where an application guide needs resume evidence.
- [ ] Keep advice usable in one sitting, with concrete quantities, time boxes, or checks when helpful.
- [ ] Run `npm run validate`.
- [ ] Expected result: FAIL only on interview guides and state version assertions.
- [ ] Commit:

```bash
git add src/content/editorial-catalog.mjs
git commit -m "content: rewrite search and application guides in English"
```

## Task 7: Rewrite all 6 interview guides and complete copy review

**Files:**

- Modify: `src/content/editorial-catalog.mjs`
- Test: `src/modules/validation/run-validation.mjs`

- [ ] Rewrite story preparation, STAR, reasoning, interviewer questions, remote interviews, and post-interview review guides.
- [ ] Retain only U.S. Department of Labor interview sources.
- [ ] Read every title, promise, example, and CTA aloud for rhythm. Replace generic encouragement with a specific action.
- [ ] Search the active content and renderer for Unicode dash characters and banned no-ai-slop terms:

```bash
rg -n '[–—]|delve|foster|leverage|utilize|facilitate|empower|streamline|robust|cutting-edge|paradigm shift|game changer|this is huge|this changes everything|tapestry|realm|beacon|multifaceted|meticulous|intricate|paramount|transformative|elevate|embark|supercharge|harness|ever-evolving' src/content/editorial-catalog.mjs src/modules/render/editorial-caption.mjs
```

- [ ] Expected result: no matches.
- [ ] Run `npm run validate`.
- [ ] Expected result: FAIL only on state version assertions.
- [ ] Commit:

```bash
git add src/content/editorial-catalog.mjs
git commit -m "content: rewrite interview guides in English"
```

## Task 8: Migrate active state to catalog version 2 without losing history

**Files:**

- Modify: `src/modules/editorial/editorial-state.mjs:1-75`
- Modify: `state/editorial.json:1-45`
- Test: `src/modules/validation/run-validation.mjs`

- [ ] Make `createEmptyEditorialState()` return catalog version 2.
- [ ] Require active state catalog version 2.
- [ ] When a catalog is supplied, map content IDs to their versions and require each pending item's `contentVersion` to match the active guide.
- [ ] Without a catalog, accept positive numeric pending content versions so transitions can validate durable items.
- [ ] Accept positive numeric history publication versions. This preserves the published version 1 entry.
- [ ] Change only `state/editorial.json.catalogVersion` to `2`. Keep the existing history entry, version 1 asset URLs, feed ID, Story ID, and publication timestamp unchanged.
- [ ] Run `npm run validate`.
- [ ] Expected result: PASS.
- [ ] Commit:

```bash
git add src/modules/editorial/editorial-state.mjs state/editorial.json src/modules/validation/run-validation.mjs
git commit -m "feat: migrate editorial catalog state to version 2"
```

## Task 9: Update documentation and render every deliverable

**Files:**

- Modify: `README.md:22-31`
- Modify: `docs/superpowers/specs/2026-09-01-english-editorial-catalog-design.md`
- Test: generated files under a temporary directory only

- [ ] Update the README to say all future editorial tips are English and LinkedIn guidance uses official LinkedIn Help documentation.
- [ ] Confirm no active documentation instructs the publisher to use a personal LinkedIn article.
- [ ] Run the validation suite:

```bash
npm run validate
```

- [ ] Expected result: PASS.
- [ ] Render every guide to a temporary directory, checking seven feed images, one Story image, a caption, and a manifest per guide:

```bash
for id in $(node -e "import('./src/content/editorial-catalog.mjs').then(({EDITORIAL_CATALOG}) => console.log(EDITORIAL_CATALOG.map(({id}) => id).join(' ')))"); do
  npm run editorial:dry-run -- --content "$id" --output "/tmp/openings-editorial-v2/$id"
done
```

- [ ] Expected result: 36 successful runs and no file-count or image-dimension errors.
- [ ] Manually inspect at least one rendered guide from each pillar for clipping, hierarchy, and readable Story composition.
- [ ] Commit:

```bash
git add README.md docs/superpowers/specs/2026-09-01-english-editorial-catalog-design.md
git commit -m "docs: document English editorial publishing"
```

## Task 10: Safe rollout and remote verification

**Files:**

- Verify: `.github/workflows/publish-social.yml`
- Verify: `.github/workflows/validate.yml`
- Verify: GitHub Actions repository variables

- [ ] Pause only `INSTAGRAM_EDITORIAL_AUTO_PUBLISH` before pushing the implementation. Leave job feed and Story automation enabled.
- [ ] Run final local checks:

```bash
npm run validate
git status --short
git diff --check origin/main...HEAD
```

- [ ] Expected result: validation passes, no unexpected uncommitted files, and no whitespace errors.
- [ ] Push the local commits to `main`.
- [ ] Wait for the remote `Validate` workflow to pass on the pushed commit.
- [ ] Re-enable `INSTAGRAM_EDITORIAL_AUTO_PUBLISH` only after remote validation succeeds.
- [ ] Confirm `INSTAGRAM_AUTO_PUBLISH` and `INSTAGRAM_STORY_AUTO_PUBLISH` are still enabled.
- [ ] Do not dispatch an immediate editorial post. The next scheduled slot selects an eligible English version 2 topic automatically.
- [ ] Confirm the current Portuguese post and its Story history remain untouched in `state/editorial.json`.

## Final acceptance checklist

- [ ] 36 active guides and 252 feed slides are in English.
- [ ] 36 Stories and 36 captions are in English.
- [ ] All active content versions are `2`.
- [ ] Active editorial state catalog version is `2`.
- [ ] Published version 1 history is unchanged and valid.
- [ ] LinkedIn guides use official LinkedIn Help sources only.
- [ ] No reader-facing editorial copy contains `\u2013` or `\u2014`.
- [ ] No reader-facing editorial copy contains a banned no-ai-slop term.
- [ ] Job publication behavior is unchanged.
- [ ] Remote validation passes before editorial automation is re-enabled.
