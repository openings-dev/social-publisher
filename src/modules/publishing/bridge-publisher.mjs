import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { requestIncrementalBridgeDeployment } from '../deploy/web-deploy-client.mjs';
import { createBridgeHtml } from '../render/html-page.mjs';
import { createInstagramCardSvg, renderSocialCardPng } from '../render/social-card.mjs';
import { INSTAGRAM_CARD_VERSION, SOCIAL_VIDEO_VERSION } from '../../config/constants.mjs';
import { sha256 } from '../../shared/hash.mjs';
import { defaultArtworkDirection } from '../render/job-poster-model.mjs';

export async function renderBridgeArtifacts(job, {
  wordmarkSvg,
  outputRoot,
  origin,
  direction = defaultArtworkDirection(job.id),
}) {
  const directory = resolve(outputRoot, 'jobs', job.id);
  const htmlPath = resolve(directory, 'index.html');
  const imagePath = resolve(directory, 'opengraph-image.png');
  const instagramSvgPath = resolve(directory, 'instagram-image.svg');
  const [png, instagramSvgSource] = await Promise.all([
    renderSocialCardPng(job, { wordmarkSvg, direction }),
    Promise.resolve(createInstagramCardSvg(job, { wordmarkSvg, direction })),
  ]);
  const pngHash = sha256(png);
  const htmlSource = createBridgeHtml(job, { origin, imageHash: pngHash });
  const html = Buffer.from(htmlSource, 'utf8');
  const instagramSvg = Buffer.from(instagramSvgSource, 'utf8');
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(htmlPath, html),
    writeFile(imagePath, png),
    writeFile(instagramSvgPath, instagramSvg),
  ]);
  return Object.freeze({
    htmlPath,
    imagePath,
    instagramSvgPath,
    html,
    png,
    instagramSvg,
    pngHash,
    instagramSvgHash: sha256(instagramSvg),
  });
}

export async function loadCanonicalWordmark(path) {
  return readFile(path, 'utf8');
}

export function createBridgePublisher({
  config,
  wordmarkSvg,
  outputRoot,
  fetchImpl = globalThis.fetch,
  requestDeployment = requestIncrementalBridgeDeployment,
}) {
  if (!config?.webDeploy) {
    throw new Error('Web deploy configuration is required for bridge publication');
  }
  return async function publishBridge({ job, reason, direction = defaultArtworkDirection(job.id) }) {
    const artifacts = await renderBridgeArtifacts(job, {
      wordmarkSvg,
      outputRoot,
      origin: config.publicSiteOrigin,
      direction,
    });
    const deployment = await requestDeployment({
      jobId: job.id,
      contentHash: job.contentHash,
      expectedPngHash: artifacts.pngHash,
      expectedInstagramSvgHash: artifacts.instagramSvgHash,
      expectedInstagramCardVersion: INSTAGRAM_CARD_VERSION,
      expectedSocialVideoVersion: SOCIAL_VIDEO_VERSION,
      forceDeployment: reason === 'instagram_card_upgrade',
      html: artifacts.html,
      image: artifacts.png,
      instagramSvg: artifacts.instagramSvg,
      repository: config.webDeploy.repository,
      token: config.webDeploy.token,
      origin: config.publicSiteOrigin,
      fetchImpl,
    });
    return Object.freeze({
      status: deployment.status,
      canonicalUrl: deployment.verification.canonicalUrl,
      imageUrl: deployment.verification.imageUrl,
      instagramImageUrl: deployment.verification.instagramImageUrl,
      socialVideoUrl: deployment.verification.socialVideoUrl,
      socialVideoCoverUrl: deployment.verification.socialVideoCoverUrl,
      pngHash: artifacts.pngHash,
      instagramSvgHash: artifacts.instagramSvgHash,
      instagramCardVersion: INSTAGRAM_CARD_VERSION,
      socialVideoVersion: SOCIAL_VIDEO_VERSION,
      visualDirection: direction,
    });
  };
}
