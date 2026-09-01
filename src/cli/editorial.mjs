import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { EDITORIAL_CATALOG } from '../content/editorial-catalog.mjs';
import { sha256 } from '../shared/hash.mjs';
import { renderEditorialAssets } from '../modules/render/editorial-card.mjs';
import { formatEditorialCaption } from '../modules/render/editorial-caption.mjs';

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

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const contentId = args.id ?? EDITORIAL_CATALOG[0].id;
  const content = EDITORIAL_CATALOG.find(({ id }) => id === contentId);
  if (!content) throw new Error(`Unknown editorial content: ${contentId}`);
  await renderEditorialDryRun({
    content,
    wordmarkPath: resolve(args.wordmark ?? process.env.OPENINGS_WORDMARK_PATH ?? '../web/public/openings-wordmark-light.svg'),
    outputPath: resolve(args.output ?? '.tmp/editorial'),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Editorial dry run failed');
    process.exitCode = 1;
  });
}

