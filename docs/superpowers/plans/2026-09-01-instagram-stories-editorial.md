# Instagram Stories and Editorial Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically publish a Story for every Instagram feed post created by `social-publisher` and publish three complete educational carousels per week on Instagram.

**Architecture:** Extend the existing Instagram client with reusable container operations, add a non-backfilled Story stage to job state, and introduce a separate deterministic editorial catalog and state machine. `social-publisher` renders and schedules content while `web-deploy` validates, converts, and hosts bounded editorial assets through a new repository-dispatch contract.

**Tech Stack:** Node.js 20 ESM, Sharp, GitHub Actions, Instagram Graph API, repository dispatch, LFTP, deterministic JSON state.

---

## File structure

### `social-publisher`

- Create `src/content/editorial-catalog.mjs`: 36 complete, source-grounded editorial definitions.
- Create `src/modules/editorial/editorial-model.mjs`: catalog and content validation.
- Create `src/modules/editorial/editorial-scheduler.mjs`: weekday/pillar selection and fair rotation.
- Create `src/modules/editorial/editorial-state.mjs`: versioned editorial state and transitions.
- Create `src/modules/render/editorial-card.mjs`: seven carousel SVGs and one Story SVG.
- Create `src/modules/render/editorial-caption.mjs`: deterministic Portuguese captions.
- Create `src/modules/deploy/editorial-verifier.mjs`: public manifest and JPEG verification.
- Create `src/modules/publishing/editorial-publisher.mjs`: asset deployment plus feed/Story orchestration.
- Create `src/cli/editorial.mjs`: dry-run, enqueue, assets, feed, Story, and controlled modes.
- Create `src/cli/publish-story.mjs`: job Story selection and publication.
- Create `state/editorial.json`: empty tracked editorial state.
- Create `.github/workflows/publish-editorial.yml`: controlled and M/W/F publication workflow.
- Modify `src/modules/networks/instagram-client.mjs`: Reel, carousel, and Story container operations.
- Modify `src/config/constants.mjs`: schema and editorial geometry/constants.
- Modify `src/config/env.mjs`: Story/editorial gates.
- Modify `src/modules/state/state-model.mjs`: validate `instagramStory`.
- Modify `src/modules/state/queue-operations.mjs`: initialize/migrate Story stage without backfill.
- Modify `src/modules/publishing/orchestrator.mjs`: retain Story results in publication state.
- Modify `src/modules/deploy/web-deploy-client.mjs`: editorial dispatch request.
- Modify `src/modules/validation/run-validation.mjs`: register deterministic feature contracts.
- Modify `.github/workflows/publish-social.yml`: commit feed state before a separate Story step.
- Modify `package.json` and `README.md`: commands, flags, and rollout documentation.

### `web-deploy`

- Create `scripts/prepare-editorial-assets.mjs`: validate and materialize canonical editorial SVG payloads.
- Modify `.github/workflows/deploy-hostinger.yml`: handle `publish_instagram_editorial` and preserve `/social/editorial/`.
- Modify `scripts/validate-deploy-contracts.mjs`: validate the new dispatch and upload contract.
- Modify `README.md`: document editorial asset ownership.

### Task 1: Reusable Instagram containers, carousel, and Story

**Files:**

- Modify: `social-publisher/src/modules/networks/instagram-client.mjs`
- Modify: `social-publisher/src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing Instagram client contracts**

Add deterministic fetch recordings that assert:

```js
const carousel = await publishCarouselToInstagram({
  imageUrls: Array.from({ length: 7 }, (_, index) => `https://openings.dev/social/editorial/linkedin-headline/1/slide-${String(index + 1).padStart(2, '0')}.jpg`),
  caption: 'Headline claro ajuda recrutadores.\n\n#OpeningsGuideL01',
  accessToken: 'instagram-token',
  userId: '17841400000000000',
  apiVersion: 'v26.0',
  fetchImpl,
  sleep: async () => {},
});
assert.equal(carousel.id, 'carousel-media');
assert.deepEqual(
  calls.filter(({ body }) => body?.get('is_carousel_item') === 'true').map(({ body }) => body.get('image_url')),
  imageUrls,
);
assert.equal(calls.at(-2).body.get('media_type'), 'CAROUSEL');
assert.equal(calls.at(-2).body.get('children'), childIds.join(','));

const story = await publishStoryToInstagram({
  mediaUrl: 'https://openings.dev/social/editorial/linkedin-headline/1/story.jpg',
  mediaKind: 'image',
  accessToken: 'instagram-token',
  userId: '17841400000000000',
  apiVersion: 'v26.0',
  fetchImpl: storyFetch,
  sleep: async () => {},
});
assert.equal(story.id, 'story-media');
assert.equal(storyCalls[0].body.get('media_type'), 'STORIES');
assert.equal(storyCalls[0].body.get('image_url'), storyUrl);
```

Also assert invalid schemes, fewer than two or more than ten carousel children, mixed image dimensions, invalid `mediaKind`, and ambiguous Story publication returning `instagram_story_ambiguous` without a second publish request.

- [ ] **Step 2: Run validation and confirm RED**

Run:

```bash
/Users/guilherme/.nvm/versions/node/v20.19.5/bin/node src/modules/validation/run-validation.mjs
```

Expected: FAIL because `publishCarouselToInstagram` and `publishStoryToInstagram` are not exported.

- [ ] **Step 3: Extract shared container helpers and implement both publishers**

Keep `publishToInstagram` as the compatible Reel export. Add:

```js
export async function publishCarouselToInstagram(options) {
  const imageUrls = validateCarouselUrls(options.imageUrls);
  const base = apiBase(options.apiOrigin ?? INSTAGRAM_API_ORIGIN, options.apiVersion);
  const children = [];
  for (const imageUrl of imageUrls) {
    const child = await createContainer({
      base,
      userId: options.userId,
      accessToken: options.accessToken,
      fetchImpl: options.fetchImpl,
      parameters: { image_url: imageUrl, is_carousel_item: 'true' },
      errorCode: 'instagram_carousel_container',
    });
    children.push(child.id);
  }
  const parent = await createContainer({
    base,
    userId: options.userId,
    accessToken: options.accessToken,
    fetchImpl: options.fetchImpl,
    parameters: {
      media_type: 'CAROUSEL',
      children: children.join(','),
      caption: validateCaption(options.caption),
    },
    errorCode: 'instagram_carousel_container',
  });
  await waitUntilContainerReady({ ...pollOptions(options), base, containerId: parent.id });
  return publishContainer({ ...publishOptions(options), base, containerId: parent.id, kind: 'carousel' });
}

export async function publishStoryToInstagram(options) {
  const media = validateStoryMedia(options.mediaUrl, options.mediaKind);
  const base = apiBase(options.apiOrigin ?? INSTAGRAM_API_ORIGIN, options.apiVersion);
  const container = await createContainer({
    base,
    userId: options.userId,
    accessToken: options.accessToken,
    fetchImpl: options.fetchImpl,
    parameters: {
      media_type: 'STORIES',
      [media.kind === 'video' ? 'video_url' : 'image_url']: media.url,
    },
    errorCode: 'instagram_story_container',
  });
  await waitUntilContainerReady({ ...pollOptions(options), base, containerId: container.id });
  return publishContainer({ ...publishOptions(options), base, containerId: container.id, kind: 'story' });
}
```

The shared publish helper must perform one publish call, query the returned media ID, and throw `instagram_story_ambiguous` when Story publication has an uncertain response that cannot be reconciled by a unique recent `media_url`.

- [ ] **Step 4: Run validation and confirm GREEN**

Expected: all existing contracts plus the new Instagram contracts pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/networks/instagram-client.mjs src/modules/validation/run-validation.mjs
git commit -m "feat(instagram): publish carousels and stories"
```

### Task 2: Version-3 job Story state without historical backfill

**Files:**

- Modify: `social-publisher/src/config/constants.mjs`
- Modify: `social-publisher/src/modules/state/state-model.mjs`
- Modify: `social-publisher/src/modules/state/load-state.mjs`
- Modify: `social-publisher/src/modules/state/queue-operations.mjs`
- Modify: `social-publisher/src/modules/publishing/orchestrator.mjs`
- Modify: `social-publisher/src/modules/validation/run-validation.mjs`
- Modify: `social-publisher/state/intake.json`
- Modify: `social-publisher/state/queue.json`
- Modify: `social-publisher/state/publications.json`

- [ ] **Step 1: Write failing migration and enqueue contracts**

```js
const migrated = migrateQueueState(versionTwoQueue);
assert.equal(migrated.schemaVersion, 3);
assert.equal(migrated.items[0].instagramStory.status, 'skipped_before_activation');

const withStory = enqueueJob(emptyQueueV3, {
  job,
  snapshot,
  discoveredAt: now,
  enabledChannels: ['instagram'],
  instagramStoryEnabled: true,
});
assert.equal(withStory.items[0].instagram.status, 'pending');
assert.equal(withStory.items[0].instagramStory.status, 'pending');

const withoutStory = enqueueJob(emptyQueueV3, {
  job,
  snapshot,
  discoveredAt: now,
  enabledChannels: ['instagram'],
  instagramStoryEnabled: false,
});
assert.equal(withoutStory.items[0].instagramStory.status, 'skipped_disabled');
```

Assert publications retain `instagramStory` independently and a completed historical item is never reopened.

- [ ] **Step 2: Run validation and confirm RED**

Expected: FAIL because schema version 3 and `instagramStory` do not exist.

- [ ] **Step 3: Implement explicit migration at the load boundary**

Export `migrateIntakeState`, `migrateQueueState`, and `migratePublicationsState`. Only accept schema 2 or 3. For every version-2 queue item add:

```js
instagramStory: {
  status: 'skipped_before_activation',
  attempts: 0,
  updatedAt: null,
  lastError: null,
  lastReset: null,
  result: null,
}
```

`loadStateFile` receives an optional migrate function, migrates before validation, and callers pass the correct migration. New queue items use `instagramStoryEnabled && enabled.has('instagram')` to choose `pending`; otherwise `skipped_disabled`.

- [ ] **Step 4: Migrate tracked JSON and verify GREEN**

Run the validation suite and confirm every state file is schema version 3 with no sensitive keys and no historical pending Story.

- [ ] **Step 5: Commit**

```bash
git add src/config/constants.mjs src/modules/state src/modules/publishing/orchestrator.mjs src/modules/validation/run-validation.mjs state
git commit -m "feat(state): track Instagram stories without backfill"
```

### Task 3: Job Story command and durable workflow checkpoint

**Files:**

- Create: `social-publisher/src/cli/publish-story.mjs`
- Modify: `social-publisher/src/config/env.mjs`
- Modify: `social-publisher/src/modules/state/queue-operations.mjs`
- Modify: `social-publisher/.github/workflows/publish-social.yml`
- Modify: `social-publisher/package.json`
- Modify: `social-publisher/src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing Story-selection contracts**

```js
const selected = selectNextInstagramStory(queue, now);
assert.equal(selected.jobId, readyJob.id);
assert.equal(selectNextInstagramStory(queueWithUnpublishedFeed, now), null);

const result = await runJobStoryPublication({
  stateDirectory,
  env,
  publishStory: async ({ mediaUrl, mediaKind }) => {
    assert.equal(mediaUrl, readyJob.bridge.result.socialVideoUrl);
    assert.equal(mediaKind, 'video');
    return { status: 'published', id: 'story-1', url: null };
  },
});
assert.equal(result.queueState.items[0].instagramStory.status, 'published');
assert.equal(result.queueState.items[0].instagram.result.id, 'feed-1');
```

- [ ] **Step 2: Run validation and confirm RED**

Expected: FAIL because selection and CLI exports do not exist.

- [ ] **Step 3: Implement Story-only state processing**

`runJobStoryPublication` reads the migrated queue, selects only items with a published Instagram feed, published bridge video, and ready Story stage, transitions only `instagramStory`, calls `publishStoryToInstagram`, and atomically saves queue/publication state.

- [ ] **Step 4: Add workflow checkpoint**

After the existing publication result commit, add a Story step gated by exact `INSTAGRAM_STORY_AUTO_PUBLISH=true`, followed by a second commit named `chore(state): record Instagram story [skip ci]`. Reuse the same workflow concurrency group and credentials.

- [ ] **Step 5: Run validation and confirm GREEN**

Expected: the workflow contract proves publication state is committed before the Story command appears.

- [ ] **Step 6: Commit**

```bash
git add src/cli/publish-story.mjs src/config/env.mjs src/modules/state/queue-operations.mjs .github/workflows/publish-social.yml package.json src/modules/validation/run-validation.mjs
git commit -m "feat(instagram): mirror published jobs to stories"
```

### Task 4: Editorial catalog, model, state, and fair scheduler

**Files:**

- Create: `social-publisher/src/content/editorial-catalog.mjs`
- Create: `social-publisher/src/modules/editorial/editorial-model.mjs`
- Create: `social-publisher/src/modules/editorial/editorial-state.mjs`
- Create: `social-publisher/src/modules/editorial/editorial-scheduler.mjs`
- Create: `social-publisher/state/editorial.json`
- Modify: `social-publisher/src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing catalog contracts**

```js
const catalog = validateEditorialCatalog(EDITORIAL_CATALOG);
assert.equal(catalog.length, 36);
assert.deepEqual(countByPillar(catalog), {
  linkedin: 12,
  resume: 8,
  search: 6,
  application: 4,
  interview: 6,
});
for (const item of catalog) {
  assert.match(item.id, /^(?:linkedin|resume|search|application|interview)-[a-z0-9-]+$/u);
  assert.equal(item.slides.length, 7);
  assert.equal(new Set(item.slides.map(({ kind }) => kind)).size >= 5, true);
  assert.equal(item.minRepeatDays >= 84, true);
}
```

Assert all 12 LinkedIn items contain the supplied Nicole Barra URL, every source has title/author/URL, copy has no HTML, and IDs are unique.

- [ ] **Step 2: Write failing state and scheduling contracts**

```js
assert.equal(slotForDate('2026-09-07T15:17:00.000Z', 'America/Sao_Paulo'), 'linkedin');
assert.equal(slotForDate('2026-09-09T15:17:00.000Z', 'America/Sao_Paulo'), 'resume_application');
assert.equal(slotForDate('2026-09-11T15:17:00.000Z', 'America/Sao_Paulo'), 'search_interview');
assert.equal(slotForDate('2026-09-08T15:17:00.000Z', 'America/Sao_Paulo'), null);

const first = selectEditorialItem({ catalog, state: emptyEditorialState(), now: monday });
const restarted = selectEditorialItem({ catalog, state: enqueueEditorial(emptyEditorialState(), first, monday), now: monday });
assert.equal(restarted, null);
```

- [ ] **Step 3: Run validation and confirm RED**

Expected: FAIL because the catalog, model, state, and scheduler are missing.

- [ ] **Step 4: Implement the exact catalog schema and 36 guide definitions**

Each item uses:

```js
{
  id: 'linkedin-headline-clara',
  version: '1',
  pillar: 'linkedin',
  title: 'Seu título está escondendo sua experiência?',
  promise: 'Ajuste três elementos para aparecer nas buscas certas.',
  slides: [
    { kind: 'cover', title: 'Seu título está escondendo sua experiência?', body: 'Ajuste três elementos para aparecer nas buscas certas.' },
    { kind: 'context', title: 'O recrutador pesquisa antes de escrever', body: 'Cargo e habilidades claras ajudam seu perfil a entrar nas buscas relevantes.' },
    { kind: 'action', title: 'Use cargo + especialidade + contexto', body: 'Comece pelo cargo reconhecível e acrescente duas competências centrais.' },
    { kind: 'example', title: 'Troque o genérico pelo específico', before: 'Desenvolvedor apaixonado por tecnologia', after: 'Backend Engineer · Node.js & PostgreSQL · SaaS' },
    { kind: 'action', title: 'Evite a sopa de palavras-chave', body: 'Escolha termos que você consegue sustentar com experiência real.' },
    { kind: 'checklist', title: 'Revise em 30 segundos', items: ['Cargo reconhecível', 'Duas competências centrais', 'Setor ou contexto', 'Sem frases vazias'] },
    { kind: 'cta', title: 'Deixe seu valor óbvio', body: 'Salve, ajuste seu headline e encontre a próxima vaga em openings.dev.' },
  ],
  story: { eyebrow: 'Novo guia no feed', title: 'Seu headline ajuda um recrutador a encontrar você?', body: 'Veja o antes e depois no carrossel.' },
  caption: { hook: 'Seu headline precisa explicar sua direção profissional em segundos.', action: 'Revise cargo, competências e contexto antes da próxima candidatura.' },
  hashtags: ['LinkedIn', 'CarreiraTech', 'VagasTech', 'OpeningsDev'],
  sources: [{ title: 'Optimizing Your LinkedIn Profile for International Opportunities', author: 'Nicole Barra', url: 'https://www.linkedin.com/pulse/optimizing-your-linkedin-profile-international-guide-nicole-barra--ujebf/' }],
  minRepeatDays: 84,
}
```

Implement this exact topic manifest; every entry receives the complete seven-slide, Story, caption, source, hashtag, and repeat fields shown above:

```js
const EDITORIAL_TOPIC_MANIFEST = [
  ['linkedin-headline-clara', 'Seu título está escondendo sua experiência?'],
  ['linkedin-idioma-do-perfil', 'Seu perfil está no idioma das vagas que você busca?'],
  ['linkedin-sobre-que-posiciona', 'A seção Sobre precisa responder cinco perguntas'],
  ['linkedin-titulo-de-experiencia', 'Seu cargo interno pode confundir recrutadores'],
  ['linkedin-resultados-na-experiencia', 'Responsabilidade não é resultado'],
  ['linkedin-skills-encontraveis', 'Escolha skills que ajudam você a ser encontrado'],
  ['linkedin-provas-em-destaque', 'Mostre provas do trabalho na seção Destaques'],
  ['linkedin-recomendacoes-que-comprovam', 'Peça recomendações que comprovem algo concreto'],
  ['linkedin-contexto-remoto', 'Deixe sua experiência remota visível'],
  ['linkedin-contato-profissional', 'Facilite o próximo contato do recrutador'],
  ['linkedin-atividade-estrategica', 'Sua atividade também faz parte do perfil'],
  ['linkedin-privacidade-open-to-work', 'Configure visibilidade e Open to Work com intenção'],
  ['resume-resumo-direto', 'Abra o currículo com direção, não com clichês'],
  ['resume-bullets-de-impacto', 'Transforme tarefas em entregas'],
  ['resume-metricas-com-contexto', 'Use números que expliquem impacto'],
  ['resume-formato-ats', 'Formate o currículo para pessoas e ATS'],
  ['resume-curriculo-por-vaga', 'Adapte o currículo sem reescrever tudo'],
  ['resume-projetos-relevantes', 'Escolha projetos que sustentam a candidatura'],
  ['resume-portfolio-que-prova', 'Faça o portfólio provar o que o currículo afirma'],
  ['resume-revisao-final', 'Faça esta revisão antes de enviar'],
  ['search-busca-com-criterios', 'Defina critérios antes de abrir vinte abas'],
  ['search-alertas-uteis', 'Crie alertas que tragam vagas relevantes'],
  ['search-fontes-alem-do-linkedin', 'Procure vagas além do LinkedIn'],
  ['search-pesquisa-de-empresa', 'Pesquise a empresa antes de aplicar'],
  ['search-networking-intencional', 'Faça networking sem pedir emprego a estranhos'],
  ['search-rotina-semanal', 'Organize uma rotina de busca sustentável'],
  ['application-leia-os-requisitos', 'Separe requisito essencial de preferência'],
  ['application-evidencias-de-fit', 'Conecte cada requisito a uma evidência'],
  ['application-respostas-concisas', 'Responda formulários sem repetir o currículo'],
  ['application-follow-up-profissional', 'Faça follow-up sem pressionar'],
  ['interview-prepare-historias', 'Prepare histórias antes da entrevista'],
  ['interview-metodo-star', 'Use STAR sem soar ensaiado'],
  ['interview-comunique-raciocinio', 'Explique seu raciocínio técnico com clareza'],
  ['interview-perguntas-ao-entrevistador', 'Leve perguntas que revelam o trabalho real'],
  ['interview-entrevista-remota', 'Prepare o ambiente para a entrevista remota'],
  ['interview-revisao-pos-entrevista', 'Aprenda com cada entrevista'],
];
```

- [ ] **Step 5: Implement scheduler and state transitions**

Use `Intl.DateTimeFormat` with `America/Sao_Paulo`, deterministic ID tie-breaking, minimum repeat dates, and stages `assets`, `feed`, and `story`. State validation rejects secrets and unknown catalog IDs.

- [ ] **Step 6: Run validation and confirm GREEN**

Expected: 36 valid entries, exact pillar counts, fair scheduling, no same-slot duplicate after restart.

- [ ] **Step 7: Commit**

```bash
git add src/content src/modules/editorial state/editorial.json src/modules/validation/run-validation.mjs
git commit -m "feat(editorial): add source-grounded content rotation"
```

### Task 5: Editorial carousel, Story renderer, caption, and dry-run

**Files:**

- Create: `social-publisher/src/modules/render/editorial-card.mjs`
- Create: `social-publisher/src/modules/render/editorial-caption.mjs`
- Create: `social-publisher/src/cli/editorial.mjs`
- Modify: `social-publisher/package.json`
- Modify: `social-publisher/src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing render contracts**

```js
const rendered = renderEditorialPost(catalog[0], { wordmarkSvg });
assert.equal(rendered.carouselSvgs.length, 7);
for (const [index, svg] of rendered.carouselSvgs.entries()) {
  assert.match(svg, /width="1080" height="1350"/u);
  assert.match(svg, new RegExp(`data-editorial-slide="${index + 1}"`, 'u'));
  assert.doesNotMatch(svg, /<script|<foreignObject|https?:\/\//u);
}
assert.match(rendered.storySvg, /width="1080" height="1920"/u);
assert.match(rendered.storySvg, /data-editorial-story="true"/u);

const preview = await renderEditorialJpegs(catalog[0], { wordmarkSvg });
for (const jpeg of [...preview.carouselJpegs, preview.storyJpeg]) {
  assert.equal((await sharp(jpeg).metadata()).format, 'jpeg');
}
assert.match(formatEditorialCaption(catalog[0]), /@openingshq/u);
assert.match(formatEditorialCaption(catalog[0]), /#OpeningsGuideL/u);
```

- [ ] **Step 2: Run validation and confirm RED**

Expected: FAIL because editorial render modules do not exist.

- [ ] **Step 3: Implement focused SVG components**

Use shared openings.dev colors/themes, grapheme-aware bounded wrapping, no remote SVG resources, and explicit safe areas. Return canonical SVG buffers plus SHA-256 hashes. `renderEditorialJpegs` uses Sharp quality 84 with 4:4:4 chroma subsampling.

- [ ] **Step 4: Implement deterministic captions and dry-run mode**

`npm run editorial -- --mode dry-run --content linkedin-headline-clara --wordmark <path> --output <path>` writes seven JPEG slides, one Story JPEG, `caption.txt`, and `manifest.json` without environment credentials or state changes.

- [ ] **Step 5: Run validation plus visual dry-run and confirm GREEN**

Expected: all files exist, dimensions match, and no asset exceeds 2 MB.

- [ ] **Step 6: Commit**

```bash
git add src/modules/render src/cli/editorial.mjs package.json src/modules/validation/run-validation.mjs
git commit -m "feat(editorial): render complete Instagram guides"
```

### Task 6: Deploy and host canonical editorial assets

**Files:**

- Modify: `social-publisher/src/modules/deploy/web-deploy-client.mjs`
- Create: `social-publisher/src/modules/deploy/editorial-verifier.mjs`
- Modify: `social-publisher/src/modules/validation/run-validation.mjs`
- Create: `web-deploy/scripts/prepare-editorial-assets.mjs`
- Modify: `web-deploy/scripts/validate-deploy-contracts.mjs`
- Modify: `web-deploy/.github/workflows/deploy-hostinger.yml`

- [ ] **Step 1: Write failing social-publisher dispatch contracts**

```js
const request = buildEditorialDispatchRequest({
  contentId: 'linkedin-headline-clara',
  version: '1',
  carouselSvgs,
  storySvg,
  repository: 'openings-dev/web-deploy',
});
const body = JSON.parse(request.body);
assert.equal(body.event_type, 'publish_instagram_editorial');
assert.equal(body.client_payload.assets.length, 8);
assert.equal(body.client_payload.assets[0].name, 'slide-01');
assert.equal(body.client_payload.assets.at(-1).name, 'story');
```

Assert payload size, canonical base64, SHA-256 values, IDs, versions, and repository names.

- [ ] **Step 2: Write failing web-deploy preparation contracts**

```js
const result = await prepareEditorialAssets({ payload, outputRoot, siteOrigin });
assert.equal(result.remoteDirectory, '/public_html/social/editorial/linkedin-headline-clara/1');
assert.deepEqual((await readdir(result.localDirectory)).sort(), [
  'manifest.json',
  'slide-01.svg', 'slide-02.svg', 'slide-03.svg', 'slide-04.svg',
  'slide-05.svg', 'slide-06.svg', 'slide-07.svg', 'story.svg',
]);
```

Reject path traversal, wrong dimensions, scripts, external URLs, duplicate/missing assets, wrong hashes, and payloads above the bound.

- [ ] **Step 3: Run both validation suites and confirm RED**

Expected: each suite fails because the new contracts are missing.

- [ ] **Step 4: Implement dispatch, preparation, conversion, and atomic upload**

The workflow handles `publish_instagram_editorial`, converts seven slide SVGs to 1080×1350 JPEG and the Story to 1080×1920 JPEG, writes hashes into `manifest.json`, uploads temporary names, renames JPEGs first and the manifest last, and terminates the LFTP session.

Exclude `social/editorial/` and `social/editorial/**` from the full `--delete` mirror. Add a non-deleting full-build mirror only if the web build contains that directory.

- [ ] **Step 5: Implement public verification**

Fetch the manifest and eight URLs with bounded timeouts; validate content type, dimensions, version, and manifest hashes. Poll after repository dispatch until all match.

- [ ] **Step 6: Run both validation suites and confirm GREEN**

Expected: social dispatch/verifier tests and web-deploy preparation/workflow tests pass.

- [ ] **Step 7: Commit both repositories**

```bash
# social-publisher
git add src/modules/deploy src/modules/validation/run-validation.mjs
git commit -m "feat(deploy): request verified editorial assets"

# web-deploy
git add scripts/prepare-editorial-assets.mjs scripts/validate-deploy-contracts.mjs .github/workflows/deploy-hostinger.yml
git commit -m "feat(deploy): host Instagram editorial assets"
```

### Task 7: Editorial stage orchestration and GitHub Actions automation

**Files:**

- Create: `social-publisher/src/modules/publishing/editorial-publisher.mjs`
- Modify: `social-publisher/src/cli/editorial.mjs`
- Create: `social-publisher/.github/workflows/publish-editorial.yml`
- Modify: `social-publisher/src/config/env.mjs`
- Modify: `social-publisher/src/modules/validation/run-validation.mjs`

- [ ] **Step 1: Write failing orchestration contracts**

```js
let state = enqueueScheduledEditorial({ state: emptyEditorialState(), catalog, now: monday });
state = await processEditorialStage({ state, catalog, stage: 'assets', deployAssets, now: minute1 });
assert.equal(state.pending[0].assets.status, 'published');
assert.equal(state.pending[0].feed.status, 'pending');

state = await processEditorialStage({ state, catalog, stage: 'feed', publishCarousel, now: minute2 });
assert.equal(state.pending[0].feed.result.id, 'carousel-media');
assert.equal(state.pending[0].story.status, 'pending');

state = await processEditorialStage({ state, catalog, stage: 'story', publishStory, now: minute3 });
assert.equal(state.pending.length, 0);
assert.equal(state.history['linkedin-headline-clara'].cycles, 1);
```

Assert Story cannot run before feed, a retry of Story never calls feed, an ambiguous Story becomes failed/manual review, and controlled parsing requires `PUBLISH_ONE_EDITORIAL_POST`.

- [ ] **Step 2: Run validation and confirm RED**

Expected: FAIL because the stage orchestrator does not exist.

- [ ] **Step 3: Implement one-stage-per-command orchestration**

Supported CLI modes are `dry-run`, `enqueue`, `assets`, `feed`, `story`, `controlled`, and `reset-stage`. Each production invocation performs one external-write category, saves editorial state atomically, and prints a sanitized JSON summary.

- [ ] **Step 4: Implement scheduled workflow checkpoints**

Create a workflow scheduled by `17 15 * * 1,3,5` and manually dispatchable. It uses the shared concurrency group and this exact order:

1. Validate the controlled gate when manual.
2. Install Node 20, Noto CJK, librsvg, ImageMagick, and exact npm dependencies.
3. Enqueue at most one due item and commit intent.
4. Deploy assets and commit result.
5. Publish feed and commit provider ID.
6. Publish Story and commit provider ID.

Scheduled runs require exact `INSTAGRAM_EDITORIAL_AUTO_PUBLISH=true`. Controlled runs require an explicit content ID and confirmation.

- [ ] **Step 5: Run validation and confirm GREEN**

Expected: state checkpoints appear before dependent external-write steps and all secret-bearing steps are gated.

- [ ] **Step 6: Commit**

```bash
git add src/modules/publishing/editorial-publisher.mjs src/cli/editorial.mjs src/config/env.mjs .github/workflows/publish-editorial.yml src/modules/validation/run-validation.mjs
git commit -m "feat(editorial): automate feed and story publication"
```

### Task 8: Documentation, dry-run artifacts, and complete verification

**Files:**

- Modify: `social-publisher/README.md`
- Modify: `web-deploy/README.md`
- Verify: all files changed by Tasks 1–7

- [ ] **Step 1: Update operator documentation**

Document commands, the two new flags, Business-account requirement, 36-post rotation, M/W/F cadence, Story limitations, controlled confirmations, state migration, asset paths, and rollout order. Explicitly state that activation never backfills historical Stories.

- [ ] **Step 2: Run social-publisher validation**

```bash
/Users/guilherme/.nvm/versions/node/v20.19.5/bin/node src/modules/validation/run-validation.mjs
```

Expected: every deterministic contract passes with no warnings.

- [ ] **Step 3: Run a complete editorial dry-run**

```bash
/Users/guilherme/.nvm/versions/node/v20.19.5/bin/node src/cli/editorial.mjs \
  --mode dry-run \
  --content linkedin-headline-clara \
  --wordmark ../../web/public/openings-wordmark-light.svg \
  --output .tmp/editorial-review
```

Expected: seven 1080×1350 JPEG slides, one 1080×1920 Story JPEG, caption, and manifest.

- [ ] **Step 4: Run existing job dry-run**

```bash
/Users/guilherme/.nvm/versions/node/v20.19.5/bin/node src/cli/dry-run.mjs \
  --fixture assets/fixtures/job.json \
  --wordmark ../../web/public/openings-wordmark-light.svg \
  --output .tmp/job-review
```

Expected: existing job card, Reel, cover, and bridge artifacts remain valid.

- [ ] **Step 5: Run web-deploy contracts**

```bash
/Users/guilherme/.nvm/versions/node/v20.19.5/bin/node scripts/validate-deploy-contracts.mjs
```

Expected: all job bridge and editorial deployment contracts pass.

- [ ] **Step 6: Inspect rendered JPEGs and git diffs**

Open the carousel cover, one example slide, final CTA, and Story. Confirm safe areas, accents, real Portuguese copy, no clipped text, and visual consistency. Run `git diff --check` and verify both worktrees contain only scoped changes.

- [ ] **Step 7: Commit documentation**

```bash
# social-publisher
git add README.md
git commit -m "docs: explain Instagram editorial automation"

# web-deploy
git add README.md
git commit -m "docs: explain editorial asset deployment"
```

- [ ] **Step 8: Request final code review and finish branches**

Use `superpowers:requesting-code-review`, address confirmed findings, rerun all verification commands, then use `superpowers:finishing-a-development-branch` for integration choices.
