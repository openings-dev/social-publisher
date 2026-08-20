import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { formatSocialPost } from '../modules/render/format-job.mjs';
import { createBridgeHtml } from '../modules/render/html-page.mjs';
import { renderSocialCardPng } from '../modules/render/social-card.mjs';
import { assertValidJobId } from '../shared/job-id.mjs';

function parseArguments(argumentsList) {
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const key = argument.slice(2);
    const value = argumentsList[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    values[key] = value;
    index += 1;
  }
  return values;
}

function validateFixture(job) {
  assertValidJobId(job?.id);
  if (typeof job.title !== 'string' || job.title.trim() === '') {
    throw new Error('Fixture job title is required');
  }
  if (typeof job.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(job.contentHash)) {
    throw new Error('Fixture job contentHash is invalid');
  }
  return job;
}

export async function runDryRun({ fixturePath, wordmarkPath, outputPath, log = console.log }) {
  const fixture = validateFixture(JSON.parse(await readFile(fixturePath, 'utf8')));
  const wordmarkSvg = await readFile(wordmarkPath, 'utf8');
  const jobDirectory = resolve(outputPath, 'jobs', fixture.id);
  const htmlPath = resolve(jobDirectory, 'index.html');
  const imagePath = resolve(jobDirectory, 'opengraph-image.png');
  const post = formatSocialPost(fixture);
  const [html, png] = await Promise.all([
    Promise.resolve(createBridgeHtml(fixture)),
    renderSocialCardPng(fixture, { wordmarkSvg }),
  ]);

  await mkdir(dirname(htmlPath), { recursive: true });
  await Promise.all([
    writeFile(htmlPath, html, 'utf8'),
    writeFile(imagePath, png),
  ]);

  log(`Dry-run job: ${fixture.id}`);
  log(`\n${post.text}\n`);
  log(`Artifacts:\n- ${htmlPath}\n- ${imagePath}`);

  return Object.freeze({
    jobId: fixture.id,
    post,
    files: Object.freeze([htmlPath, imagePath]),
  });
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const fixturePath = resolve(args.fixture ?? 'assets/fixtures/job.json');
  const outputPath = resolve(args.output ?? '.tmp/dry-run');
  const wordmarkPath = resolve(
    args.wordmark
      ?? process.env.OPENINGS_WORDMARK_PATH
      ?? '../openings/public/openings-wordmark-light.svg',
  );
  await runDryRun({ fixturePath, wordmarkPath, outputPath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Dry run failed');
    process.exitCode = 1;
  });
}
