import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { EDITORIAL_CATALOG } from '../content/editorial-catalog.mjs';
import { readEnvironment } from '../config/env.mjs';
import { sha256 } from '../shared/hash.mjs';
import { requestEditorialDeployment } from '../modules/deploy/web-deploy-client.mjs';
import { resetEditorialStage, validateEditorialState } from '../modules/editorial/editorial-state.mjs';
import { publishCarouselToInstagram, publishStoryToInstagram } from '../modules/networks/instagram-client.mjs';
import {
  enqueueScheduledEditorial,
  prepareEditorialStageIntent,
  processEditorialStage,
} from '../modules/publishing/editorial-publisher.mjs';
import { renderEditorialAssets } from '../modules/render/editorial-card.mjs';
import { formatEditorialCaption } from '../modules/render/editorial-caption.mjs';
import { loadStateFile } from '../modules/state/load-state.mjs';
import { saveStateFile } from '../modules/state/save-state.mjs';

function parseArguments(argumentsList) {
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argumentsList[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

export function parseEditorialRequest({ mode, contentId, stage, confirmation }) {
  if (!['dry-run', 'enqueue', 'assets', 'feed', 'story-intent', 'story', 'controlled', 'reset-stage'].includes(mode)) {
    throw new Error(`Unsupported editorial mode: ${String(mode)}`);
  }
  if (contentId !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(contentId)) {
    throw new Error('Editorial content ID is invalid');
  }
  if (mode === 'controlled') {
    if (!contentId) throw new Error('Controlled editorial publication requires a content ID');
    if (confirmation !== 'PUBLISH_ONE_EDITORIAL_POST') {
      throw new Error('Controlled editorial publication requires the exact confirmation PUBLISH_ONE_EDITORIAL_POST');
    }
  }
  if (mode === 'reset-stage') {
    if (!contentId || !['assets', 'feed', 'story'].includes(stage)) throw new Error('Editorial reset requires content and stage');
    if (confirmation !== 'RESET_EDITORIAL_STAGE') {
      throw new Error('Editorial reset requires the exact confirmation RESET_EDITORIAL_STAGE');
    }
  }
  return { mode, contentId: contentId ?? null, stage: stage ?? null };
}

export async function renderEditorialDryRun({ content, wordmarkPath, outputPath, log = console.log }) {
  const wordmarkSvg = await readFile(wordmarkPath, 'utf8');
  const rendered = await renderEditorialAssets(content, { wordmarkSvg });
  const caption = formatEditorialCaption(content);
  const directory = resolve(outputPath, 'editorial', content.id);
  await mkdir(directory, { recursive: true });
  const slideEntries = rendered.slides.map((buffer, index) => ({
    path: `slide-${String(index + 1).padStart(2, '0')}.jpg`,
    sha256: sha256(buffer),
  }));
  const storyEntry = { path: 'story.jpg', sha256: sha256(rendered.story) };
  const manifest = {
    schemaVersion: 1,
    contentId: content.id,
    contentVersion: content.version,
    pillar: content.pillar,
    slides: slideEntries,
    story: storyEntry,
    caption: { path: 'caption.txt', sha256: sha256(caption) },
    sources: content.sources,
  };
  const writes = slideEntries.map((entry, index) => writeFile(resolve(directory, entry.path), rendered.slides[index]));
  writes.push(
    writeFile(resolve(directory, storyEntry.path), rendered.story),
    writeFile(resolve(directory, 'caption.txt'), `${caption}\n`, 'utf8'),
    writeFile(resolve(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  );
  await Promise.all(writes);
  const files = [...slideEntries.map(({ path }) => resolve(directory, path)), resolve(directory, 'story.jpg'), resolve(directory, 'caption.txt'), resolve(directory, 'manifest.json')];
  log(`Editorial dry run: ${content.id}`);
  log(`Artifacts: ${directory}`);
  return Object.freeze({ contentId: content.id, directory, caption, manifest, files: Object.freeze(files) });
}

export async function runEditorialCommand({
  mode,
  stateDirectory,
  wordmarkPath,
  outputPath,
  contentId,
  stage,
  confirmation,
  operationKey,
  env = process.env,
  now = new Date().toISOString(),
  log = console.log,
  dependencies = {},
}) {
  const request = parseEditorialRequest({ mode, contentId, stage, confirmation });
  if (mode === 'dry-run') {
    const content = contentId
      ? EDITORIAL_CATALOG.find(({ id }) => id === contentId)
      : EDITORIAL_CATALOG[0];
    if (!content) throw new Error(`Unknown editorial content: ${contentId}`);
    return renderEditorialDryRun({ content, wordmarkPath, outputPath, log });
  }
  const statePath = resolve(stateDirectory, 'editorial.json');
  let state = await loadStateFile(statePath, (value) => validateEditorialState(value, EDITORIAL_CATALOG));
  if (mode === 'reset-stage') {
    state = resetEditorialStage(state, request.contentId, request.stage, { at: now });
    await saveStateFile(statePath, state, (value) => validateEditorialState(value, EDITORIAL_CATALOG));
    const summary = { outcome: 'reset', contentId: request.contentId, stage: request.stage };
    log(JSON.stringify(summary));
    return { ...summary, state };
  }
  if ((mode === 'enqueue' || mode === 'controlled')) {
    if (mode === 'enqueue' && env.INSTAGRAM_EDITORIAL_AUTO_PUBLISH !== 'true') {
      const summary = { outcome: 'disabled', contentId: null };
      log(JSON.stringify(summary));
      return { ...summary, state };
    }
    const next = enqueueScheduledEditorial({
      state,
      catalog: EDITORIAL_CATALOG,
      now,
      contentId: mode === 'controlled' ? request.contentId : null,
    });
    const added = next.pending.find(({ contentId: candidate }) => !state.pending.some(({ contentId: previous }) => previous === candidate));
    state = next;
    await saveStateFile(statePath, state, (value) => validateEditorialState(value, EDITORIAL_CATALOG));
    const summary = { outcome: added ? 'enqueued' : 'idle', contentId: added?.contentId ?? null };
    log(JSON.stringify(summary));
    return { ...summary, state };
  }
  if (env.INSTAGRAM_EDITORIAL_AUTO_PUBLISH !== 'true') {
    const summary = { outcome: 'disabled', contentId: null, stage: mode };
    log(JSON.stringify(summary));
    return { ...summary, state };
  }

  const persistState = async (value) => saveStateFile(
    statePath,
    value,
    (candidate) => validateEditorialState(candidate, EDITORIAL_CATALOG),
  );
  if (mode === 'story-intent') {
    const result = prepareEditorialStageIntent({
      state,
      catalog: EDITORIAL_CATALOG,
      stage: 'story',
      operationKey,
      now,
    });
    state = result.state;
    await persistState(state);
    log(JSON.stringify({
      outcome: result.outcome,
      contentId: result.selectedContentId,
      stage: 'story',
      error: result.errorCode ?? null,
    }));
    return result;
  }

  const configMode = mode === 'assets' ? 'editorial-assets' : `editorial-${mode}`;
  const config = readEnvironment({ env, mode: configMode });
  const options = {
    state,
    catalog: EDITORIAL_CATALOG,
    stage: mode,
    now,
    operationKey,
    persistState,
  };
  if (mode === 'assets') {
    options.wordmarkSvg = await readFile(wordmarkPath, 'utf8');
    options.deployAssets = dependencies.deployAssets ?? (({ content, carouselSvgs, storySvg }) => requestEditorialDeployment({
      contentId: content.id,
      version: content.version,
      carouselSvgs,
      storySvg,
      repository: config.webDeploy.repository,
      token: config.webDeploy.token,
      origin: config.publicSiteOrigin,
    }));
  } else if (mode === 'feed') {
    options.publishCarousel = dependencies.publishCarousel ?? ((input) => publishCarouselToInstagram({
      ...input,
      accessToken: config.instagram.accessToken,
      userId: config.instagram.userId,
      apiVersion: config.instagram.apiVersion,
      apiOrigin: config.instagram.apiOrigin,
    }));
  } else {
    options.publishStory = dependencies.publishStory ?? ((input) => publishStoryToInstagram({
      ...input,
      accessToken: config.instagram.accessToken,
      userId: config.instagram.userId,
      apiVersion: config.instagram.apiVersion,
      apiOrigin: config.instagram.apiOrigin,
    }));
  }
  const result = await processEditorialStage(options);
  state = result.state;
  await persistState(state);
  log(JSON.stringify({ outcome: result.outcome, contentId: result.selectedContentId, stage: mode, error: result.errorCode ?? null }));
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const mode = args.mode ?? 'dry-run';
  const contentId = args.id ?? EDITORIAL_CATALOG[0].id;
  const result = await runEditorialCommand({
    mode,
    contentId: args.content ?? args.id ?? (mode === 'dry-run' ? contentId : undefined),
    stage: args.stage,
    confirmation: args.confirmation,
    operationKey: args.operation ?? process.env.EDITORIAL_OPERATION_KEY,
    stateDirectory: resolve(args.state ?? 'state'),
    wordmarkPath: resolve(args.wordmark ?? process.env.OPENINGS_WORDMARK_PATH ?? '../web/public/openings-wordmark-light.svg'),
    outputPath: resolve(args.output ?? '.tmp/editorial'),
  });
  if (result.outcome === 'retryable' || result.outcome === 'failed_manual_review') {
    throw new Error(`Editorial ${mode} did not complete: ${result.outcome}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Editorial dry run failed');
    process.exitCode = 1;
  });
}
