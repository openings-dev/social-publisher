import { join, resolve } from 'node:path';

import {
  INSTAGRAM_CARD_VERSION,
  OPENINGS_ORIGIN,
  OPEN_GRAPH_IMAGE_VERSION,
  SOCIAL_VIDEO_VERSION,
} from '../../config/constants.mjs';
import { sha256 } from '../../shared/hash.mjs';
import { renderReelVideo } from '../render/reel-video.mjs';
import { renderBridgeArtifacts } from './bridge-publisher.mjs';
import { describeOpeningsMediaFile } from './openings-media-files.mjs';
import {
  buildOpeningsR2Manifest,
  updateOpeningsR2FileState,
  validateOpeningsR2Manifest,
} from './openings-r2-manifest.mjs';
import { ensureOpeningsR2Objects } from './openings-r2-store.mjs';
import { verifyOpeningsR2File } from './openings-r2-verifier.mjs';

function consumers({ enabledChannels, linkedinProvider, storyEnabled }) {
  const enabled = new Set(enabledChannels);
  return {
    opengraph: [
      ...(enabled.has('twitter') ? ['twitter'] : []),
      ...(enabled.has('linkedin') && linkedinProvider === 'buffer' ? ['linkedin'] : []),
    ],
    'instagram-feed': enabled.has('instagram') ? ['instagram'] : [],
    'social-video': storyEnabled ? ['instagramStory'] : [],
  };
}

export function createOpeningsR2BridgePublisher({
  publicOrigin,
  outputRoot,
  wordmarkSvg,
  enabledChannels,
  linkedinProvider,
  storyEnabled,
  r2Config,
  capacity,
  now = () => new Date(),
  dependencies = {},
}) {
  const render = dependencies.renderBridgeArtifacts ?? renderBridgeArtifacts;
  const describe = dependencies.describeMediaFile ?? describeOpeningsMediaFile;
  const ensureObjects = dependencies.ensureObjects ?? ensureOpeningsR2Objects;
  const verifyFile = dependencies.verifyFile ?? verifyOpeningsR2File;
  const renderStory = dependencies.renderReelVideo ?? renderReelVideo;
  const consumersByRole = consumers({ enabledChannels, linkedinProvider, storyEnabled });
  return async function publishBridge({ job, queueItem, direction, checkpointMedia }) {
    if (typeof checkpointMedia !== 'function') throw new Error('R2 media checkpoint is required');
    const instant = now();
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new Error('R2 media clock is invalid');
    const artifacts = await render(job, { wordmarkSvg, outputRoot, origin: OPENINGS_ORIGIN, direction });
    const declarations = [
      { role: 'opengraph', fileName: 'opengraph-image.png', logicalArtifactId: 'opengraph',
        renderVersion: OPEN_GRAPH_IMAGE_VERSION, filePath: artifacts.imagePath },
      { role: 'instagram-feed', fileName: 'instagram-image.jpg', logicalArtifactId: 'instagram-feed',
        renderVersion: INSTAGRAM_CARD_VERSION, filePath: artifacts.instagramJpegPath },
    ];
    if (storyEnabled) {
      const story = await renderStory({
        instagramSvg: Buffer.isBuffer(artifacts.instagramSvg)
          ? artifacts.instagramSvg.toString('utf8') : artifacts.instagramSvg,
        outputDirectory: resolve(outputRoot, 'jobs', job.id),
      });
      declarations.push({ role: 'social-video', fileName: 'social-video.mp4', logicalArtifactId: 'social-video',
        renderVersion: SOCIAL_VIDEO_VERSION, filePath: story.videoPath });
    }
    const required = declarations.filter((item) => consumersByRole[item.role].length > 0);
    if (required.length === 0) throw new Error('No public R2 media consumer is enabled');
    const described = await Promise.all(required.map((item) => describe(item)));
    const files = described.map((item, index) => ({ ...item, fileName: required[index].fileName }));
    const requestDigest = sha256(JSON.stringify({
      contractVersion: 'openings-direct-r2/v1', jobId: job.id, sourceId: job.sourceId,
      contentHash: job.contentHash, direction, files,
    }));
    const mediaOwner = {
      jobId: job.id,
      sourceId: job.sourceId,
      contentHash: job.contentHash,
      requestDigest,
      preparedAt: instant.toISOString(),
      files,
    };
    let manifest = buildOpeningsR2Manifest({ mediaOwner, publicOrigin, consumersByRole });
    await checkpointMedia(manifest);
    const preparationDirectory = join(outputRoot, 'jobs', job.id);
    manifest = await ensureObjects({
      config: r2Config,
      manifest,
      preparationDirectory,
      capacity,
      now: () => instant,
      checkpoint: checkpointMedia,
    });
    for (const file of manifest.files) {
      const verified = await verifyFile(file, { publicOrigin });
      manifest = updateOpeningsR2FileState(manifest, file.role, verified.uploadState);
    }
    manifest = validateOpeningsR2Manifest(manifest, queueItem);
    await checkpointMedia(manifest);
    const byRole = Object.fromEntries(manifest.files.map((file) => [file.role, file]));
    return Object.freeze({
      status: 'hosted',
      canonicalUrl: `${OPENINGS_ORIGIN}/jobs/${job.id}`,
      imageUrl: byRole.opengraph?.url,
      instagramImageUrl: byRole['instagram-feed']?.url,
      socialVideoUrl: byRole['social-video']?.url,
      pngHash: byRole.opengraph?.sha256,
      instagramJpegHash: byRole['instagram-feed']?.sha256,
      instagramCardVersion: INSTAGRAM_CARD_VERSION,
      instagramFeedMediaKind: 'image',
      socialVideoVersion: byRole['social-video'] ? SOCIAL_VIDEO_VERSION : undefined,
      visualDirection: direction,
      r2Media: manifest,
    });
  };
}
