import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderReelVideo } from '../modules/render/reel-video.mjs';

function parseArguments(argumentsList) {
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid render argument near ${key ?? 'end'}`);
    }
    values[key.slice(2)] = value;
  }
  if (!values.card || !values.output) {
    throw new Error('Render requires --card and --output');
  }
  return values;
}

export async function runReelRender({ cardPath, outputDirectory, ffmpegPath = 'ffmpeg' }) {
  const instagramSvg = await readFile(cardPath, 'utf8');
  return renderReelVideo({ instagramSvg, outputDirectory, ffmpegPath });
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const result = await runReelRender({
    cardPath: resolve(argumentsMap.card),
    outputDirectory: resolve(argumentsMap.output),
    ffmpegPath: argumentsMap.ffmpeg ?? 'ffmpeg',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Reel rendering failed');
    process.exitCode = 1;
  });
}
