import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { requestIncrementalBridgeDeployment } from '../deploy/web-deploy-client.mjs';
import { createBridgeHtml } from '../render/html-page.mjs';
import { createInstagramCardSvg, renderSocialCardPng } from '../render/social-card.mjs';
import { INSTAGRAM_CARD_VERSION, SOCIAL_VIDEO_VERSION } from '../../config/constants.mjs';
import { sha256 } from '../../shared/hash.mjs';

export async function renderBridgeArtifacts(job, {
  wordmarkSvg,
  outputRoot,
  origin,
}) {
  const directory = resolve(outputRoot, 'jobs', job.id);
  const htmlPath = resolve(directory, 'index.html');
  const imagePath = resolve(directory, 'opengraph-image.png');
  const instagramSvgPath = resolve(directory, 'instagram-image.svg');
  const [htmlSource, png] = await Promise.all([
    Promise.resolve(createBridgeHtml(job, { origin })),
    renderSocialCardPng(job, { wordmarkSvg }),
  ]);
  const html = Buffer.from(htmlSource, 'utf8');
  const instagramSvg = Buffer.from(createInstagramCardSvg(job, { wordmarkSvg }), 'utf8');
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
    pngHash: sha256(png),
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
  return async function publishBridge({ job, reason }) {
    const artifacts = await renderBridgeArtifacts(job, {
      wordmarkSvg,
      outputRoot,
      origin: config.publicSiteOrigin,
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
    });
  };
}
