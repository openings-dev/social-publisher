import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { stagePlatformHandoff } from '@trebla/publishing';

import {
  INSTAGRAM_CARD_VERSION,
  OPEN_GRAPH_IMAGE_VERSION,
  OPENINGS_ORIGIN,
  SOCIAL_CHANNELS,
  SOCIAL_VIDEO_VERSION,
} from '../../config/constants.mjs';
import { formatSocialPost } from '../render/format-job.mjs';
import { prepareSocialJob } from '../render/social-title.mjs';
import { renderReelVideo } from '../render/reel-video.mjs';
import {
  isReadyQueueItem,
  queuedArtworkDirection,
  reservePublicationArtwork,
  selectNextQueueItem,
} from '../state/queue-operations.mjs';
import { validateQueueState } from '../state/state-model.mjs';
import { renderBridgeArtifacts } from './bridge-publisher.mjs';
import { describeOpeningsMediaFile } from './openings-media-files.mjs';
import {
  buildOpeningsMediaOwnerEnvelope,
  validateOpeningsMediaOwnerRecord,
} from './openings-media-owner.mjs';
import {
  readOpeningsJobContent,
  readOpeningsMediaMetadata,
  validateOpeningsMediaMetadata,
} from './openings-media-reader.mjs';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FILES = Object.freeze([
  Object.freeze({ role: 'opengraph', fileName: 'opengraph-image.png', logicalArtifactId: 'opengraph',
    renderVersion: OPEN_GRAPH_IMAGE_VERSION }),
  Object.freeze({ role: 'instagram-feed', fileName: 'instagram-image.jpg', logicalArtifactId: 'instagram-feed',
    renderVersion: INSTAGRAM_CARD_VERSION }),
  Object.freeze({ role: 'social-video', fileName: 'social-video.mp4', logicalArtifactId: 'social-video',
    renderVersion: SOCIAL_VIDEO_VERSION }),
]);

function fixedTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function activeStory(item) {
  return !['skipped_disabled', 'skipped_before_activation'].includes(item.instagramStory.status);
}

function startedPublication(item) {
  return [...SOCIAL_CHANNELS, 'instagramStory']
    .some((channel) => item[channel].attempts > 0 || item[channel].status === 'published');
}

function requireCurrentSource(selected, snapshot) {
  if (!snapshot || !(snapshot.jobsById instanceof Map)) throw new Error('Current Openings snapshot is required');
  const job = snapshot.jobsById.get(selected.jobId);
  if (!job || job.issueState !== 'open' || job.id !== selected.jobId || job.sourceId !== selected.sourceId
    || job.contentHash !== selected.contentHash) {
    throw new Error('Openings source identity changed');
  }
  return job;
}

function requireAuthoritativeContent(content, selected, sourceJob, metadata) {
  if (!content || typeof content !== 'object' || Array.isArray(content)
    || content.id !== selected.jobId || content.issueState !== 'open'
    || content.sourceId !== selected.sourceId || content.sourceType !== sourceJob.sourceType
    || content.contentHash !== selected.contentHash || metadata.entityRevision !== selected.contentHash) {
    throw new Error('Openings source identity changed');
  }
  return content;
}

function validateLifetime(preparedAt, expiresAt) {
  if (!fixedTimestamp(expiresAt)) throw new Error('Openings media owner expiry is invalid');
  const lifetime = Date.parse(expiresAt) - Date.parse(preparedAt);
  if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > WEEK_MS) {
    throw new Error('Openings media owner expiry is invalid');
  }
}

function sameDescriptor(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function prepareNextOpeningsMediaOwner({
  queueState,
  currentSnapshot,
  transport,
  gatewayOrigin,
  expiresAt,
  outputRoot,
  wordmarkSvg,
  now = () => new Date(),
  checkpoint = async () => {},
  dependencies = {},
}) {
  let nextQueue = validateQueueState(queueState);
  const instant = now();
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new Error('Preparation clock is invalid');
  const preparedAt = instant.toISOString();
  const selected = selectNextQueueItem(nextQueue, preparedAt);
  if (!selected) return { outcome: 'idle', selectedJobId: null, queueState: nextQueue };
  if (Object.hasOwn(selected, 'mediaOwner')) {
    const mediaOwner = validateOpeningsMediaOwnerRecord(selected.mediaOwner, selected);
    return {
      outcome: 'resume_needed', selectedJobId: selected.jobId,
      requestDigest: mediaOwner.requestDigest, mediaOwner, queueState: nextQueue,
    };
  }
  if (!isReadyQueueItem(selected)) throw new Error('Selected Openings job is not ready');
  if (typeof checkpoint !== 'function') throw new Error('Queue checkpoint must be a function');
  validateLifetime(preparedAt, expiresAt);
  const sourceJob = requireCurrentSource(selected, currentSnapshot);
  const readMetadata = dependencies.readMetadata ?? readOpeningsMediaMetadata;
  const readContent = dependencies.readContent ?? readOpeningsJobContent;
  const metadata = validateOpeningsMediaMetadata(await readMetadata({
    jobId: selected.jobId, transport, gatewayOrigin, now, nonce: dependencies.nonce,
  }), { jobId: selected.jobId, gatewayOrigin });
  if (metadata.latestGeneration === Number.MAX_SAFE_INTEGER) throw new Error('Openings media generation overflow');
  const content = requireAuthoritativeContent(await readContent({
    selectedJob: sourceJob, metadata, transport, gatewayOrigin, now, nonce: dependencies.nonce,
  }), selected, sourceJob, metadata);
  const started = startedPublication(selected);
  const preparedJob = started
    ? { ...content, ...(selected.bridge.result?.socialTitle
      ? { socialTitle: selected.bridge.result.socialTitle } : {}) }
    : (dependencies.prepareSocialJob ?? prepareSocialJob)(content);
  const post = formatSocialPost(preparedJob);
  nextQueue = reservePublicationArtwork(nextQueue, selected.jobId);
  const direction = queuedArtworkDirection(nextQueue, selected.jobId);
  const storyRequired = activeStory(selected);
  const parentDirectory = resolve(outputRoot, 'openings-media-owner');
  await mkdir(parentDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(parentDirectory, '.prepare-'));
  let finalDirectory = null;
  let createdFinal = false;
  let keepFinal = false;
  try {
    const bridge = await (dependencies.renderBridgeArtifacts ?? renderBridgeArtifacts)(preparedJob, {
      wordmarkSvg, outputRoot: temporaryDirectory, origin: OPENINGS_ORIGIN, direction,
    });
    const sourceFiles = [bridge.imagePath, bridge.instagramJpegPath];
    if (storyRequired) {
      if (!bridge.instagramSvg) throw new Error('Required Story source media is missing');
      const story = await (dependencies.renderReelVideo ?? renderReelVideo)({
        instagramSvg: Buffer.isBuffer(bridge.instagramSvg) ? bridge.instagramSvg.toString('utf8') : bridge.instagramSvg,
        outputDirectory: resolve(temporaryDirectory, 'jobs', selected.jobId),
        ffmpegPath: dependencies.ffmpegPath,
        execFileImpl: dependencies.ffmpegExecFile,
      });
      if (!story?.videoPath) throw new Error('Required Story media is missing');
      sourceFiles.push(story.videoPath);
    }
    const declarations = FILES.slice(0, storyRequired ? 3 : 2);
    const describe = dependencies.describeMediaFile ?? describeOpeningsMediaFile;
    const media = await Promise.all(declarations.map((declaration, index) => describe({
      ...declaration,
      filePath: sourceFiles[index],
      ffprobePath: dependencies.ffprobePath,
      execFileImpl: dependencies.ffprobeExecFile,
    })));
    const generation = metadata.latestGeneration + 1;
    const socialTitle = preparedJob.socialTitle ?? preparedJob.title;
    const canonical = {
      title: socialTitle,
      ...(typeof content.description === 'string' ? { summary: content.description } : {}),
      canonicalUrl: post.canonicalUrl,
      language: 'en',
    };
    const built = buildOpeningsMediaOwnerEnvelope({
      jobId: selected.jobId,
      entityRevision: metadata.entityRevision,
      entityContentSha256: metadata.entityContentSha256,
      generation,
      expiresAt,
      canonical,
      formattedText: post.text,
      media,
    });
    finalDirectory = join(parentDirectory, built.requestDigest);
    await mkdir(finalDirectory);
    createdFinal = true;
    await Promise.all(declarations.map((declaration, index) => copyFile(
      sourceFiles[index], join(finalDirectory, declaration.fileName), constants.COPYFILE_EXCL,
    )));
    const verified = await Promise.all(declarations.map((declaration) => describe({
      ...declaration,
      filePath: join(finalDirectory, declaration.fileName),
      ffprobePath: dependencies.ffprobePath,
      execFileImpl: dependencies.ffprobeExecFile,
    })));
    if (!verified.every((item, index) => sameDescriptor(item, media[index]))) {
      throw new Error('Prepared media changed after finalization');
    }
    const files = declarations.map((declaration, index) => ({ ...media[index], fileName: declaration.fileName }));
    const mediaOwner = validateOpeningsMediaOwnerRecord({
      schemaVersion: 1,
      jobId: selected.jobId,
      sourceId: selected.sourceId,
      dataCommit: selected.dataCommit,
      dataHash: selected.dataHash,
      contentHash: selected.contentHash,
      entityRevision: metadata.entityRevision,
      entityContentSha256: metadata.entityContentSha256,
      generation,
      preparedAt,
      expiresAt,
      requestDigest: built.requestDigest,
      canonical,
      formattedText: post.text,
      socialTitle,
      direction,
      storyRequired,
      envelope: built.envelope,
      files,
    }, selected);
    const handoff = {
      envelope: built.envelope,
      uploads: built.envelope.artifacts.map((reference, index) => ({
        reference,
        filePath: join(finalDirectory, declarations[index].fileName),
      })),
    };
    await stagePlatformHandoff(handoff, { prepare: async (envelope) => ({ envelope }) });
    const handoffPath = join(finalDirectory, 'handoff.json');
    await writeFile(handoffPath, `${JSON.stringify(handoff)}\n`, { flag: 'wx', mode: 0o600 });
    nextQueue = validateQueueState({
      ...nextQueue,
      items: nextQueue.items.map((item) => item.jobId === selected.jobId ? { ...item, mediaOwner } : item),
    });
    keepFinal = true;
    await checkpoint({ queueState: nextQueue, jobId: selected.jobId, requestDigest: built.requestDigest });
    return {
      outcome: 'archive_required',
      selectedJobId: selected.jobId,
      requestDigest: built.requestDigest,
      mediaOwner,
      preparationDirectory: finalDirectory,
      handoffPath,
      queueState: nextQueue,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    if (finalDirectory && createdFinal && !keepFinal) await rm(finalDirectory, { recursive: true, force: true });
  }
}
