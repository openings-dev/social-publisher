import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { formatSocialPost } from '../modules/render/format-job.mjs';
import { createBridgeHtml } from '../modules/render/html-page.mjs';
import {
  createInstagramCardSvg,
  renderInstagramCardJpeg,
  renderSocialCardPng,
} from '../modules/render/social-card.mjs';
import { renderReelVideo } from '../modules/render/reel-video.mjs';
import { resolveGitCommit } from '../modules/data/git-json.mjs';
import { loadSnapshot } from '../modules/data/load-snapshot.mjs';
import { collectDelta } from '../modules/intake/collect-delta.mjs';
import { isEligibleNewJob } from '../modules/intake/eligibility.mjs';
import { loadStateFile } from '../modules/state/load-state.mjs';
import {
  markMissingJobsClosed,
  selectNextQueueItem,
} from '../modules/state/queue-operations.mjs';
import {
  migrateIntakeState,
  migratePublicationsState,
  migrateQueueState,
  validateIntakeState,
  validatePublicationsState,
  validateQueueState,
} from '../modules/state/state-model.mjs';
import { assertValidJobId } from '../shared/job-id.mjs';
import { sha256 } from '../shared/hash.mjs';

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
  const instagramImagePath = resolve(jobDirectory, 'instagram-image.jpg');
  const post = formatSocialPost(fixture);
  const instagramSvg = createInstagramCardSvg(fixture, { wordmarkSvg });
  const [png, instagramJpeg] = await Promise.all([
    renderSocialCardPng(fixture, { wordmarkSvg }),
    renderInstagramCardJpeg(fixture, { wordmarkSvg }),
  ]);
  const html = createBridgeHtml(fixture, { imageHash: sha256(png) });

  await mkdir(dirname(htmlPath), { recursive: true });
  await Promise.all([
    writeFile(htmlPath, html, 'utf8'),
    writeFile(imagePath, png),
    writeFile(instagramImagePath, instagramJpeg),
  ]);
  const reel = await renderReelVideo({
    instagramSvg,
    outputDirectory: jobDirectory,
  });

  log(`Dry-run job: ${fixture.id}`);
  log(`\n${post.text}\n`);
  log(`Artifacts:\n- ${htmlPath}\n- ${imagePath}\n- ${instagramImagePath}\n- ${reel.coverPath}\n- ${reel.videoPath}`);

  return Object.freeze({
    jobId: fixture.id,
    post,
    files: Object.freeze([htmlPath, imagePath, instagramImagePath, reel.coverPath, reel.videoPath]),
  });
}

export async function runSnapshotDryRun({
  dataRepositoryPath,
  stateDirectory,
  wordmarkPath,
  outputPath,
  dataReference = 'HEAD',
  jobId,
  log = console.log,
}) {
  const [currentCommit, intakeState, queueState, publicationsState] = await Promise.all([
    resolveGitCommit(dataRepositoryPath, dataReference),
    loadStateFile(resolve(stateDirectory, 'intake.json'), validateIntakeState, migrateIntakeState),
    loadStateFile(resolve(stateDirectory, 'queue.json'), validateQueueState, migrateQueueState),
    loadStateFile(resolve(stateDirectory, 'publications.json'), validatePublicationsState, migratePublicationsState),
  ]);
  const current = await loadSnapshot(dataRepositoryPath, currentCommit);
  const previous = intakeState.processedSnapshot === null
    ? null
    : await loadSnapshot(dataRepositoryPath, intakeState.processedSnapshot.commit);
  const delta = collectDelta(previous, current);
  const eligible = previous === null
    ? []
    : delta.new.filter((job) => isEligibleNewJob(job, previous.generatedAt, publicationsState));
  const currentQueue = markMissingJobsClosed(
    queueState,
    current.jobsById.keys(),
    current.generatedAt,
  );
  const queued = selectNextQueueItem(currentQueue);
  const selectedId = jobId ?? queued?.jobId ?? eligible[0]?.id ?? current.jobsById.keys().next().value;
  const selected = current.jobsById.get(assertValidJobId(selectedId));
  if (!selected) {
    throw new Error(`Dry-run job is not open in the current snapshot: ${selectedId}`);
  }
  const temporaryFixturePath = resolve(outputPath, '.selected-job.json');
  await mkdir(dirname(temporaryFixturePath), { recursive: true });
  await writeFile(temporaryFixturePath, `${JSON.stringify(selected, null, 2)}\n`, 'utf8');
  const result = await runDryRun({ fixturePath: temporaryFixturePath, wordmarkPath, outputPath, log });
  log(JSON.stringify({
    snapshot: current.commit,
    baseline: previous === null,
    delta: { new: delta.new.length, changed: delta.changed.length, removed: delta.removed.length },
    eligible: eligible.length,
    queueSelection: queued?.jobId ?? null,
  }));
  return { ...result, snapshot: current, delta, eligible, queueSelection: queued?.jobId ?? null };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const outputPath = resolve(args.output ?? '.tmp/dry-run');
  const wordmarkPath = resolve(
    args.wordmark
      ?? process.env.OPENINGS_WORDMARK_PATH
      ?? '../web/public/openings-wordmark-light.svg',
  );
  if (args.data) {
    await runSnapshotDryRun({
      dataRepositoryPath: resolve(args.data),
      stateDirectory: resolve(args.state ?? 'state'),
      wordmarkPath,
      outputPath,
      dataReference: args.ref ?? 'HEAD',
      jobId: args.job,
    });
    return;
  }
  const fixturePath = resolve(args.fixture ?? 'assets/fixtures/job.json');
  await runDryRun({ fixturePath, wordmarkPath, outputPath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Dry run failed');
    process.exitCode = 1;
  });
}
