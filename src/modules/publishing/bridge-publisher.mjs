import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { requestIncrementalBridgeDeployment } from '../deploy/web-deploy-client.mjs';
import { createBridgeHtml } from '../render/html-page.mjs';
import { renderSocialCardPng } from '../render/social-card.mjs';
import { sha256 } from '../../shared/hash.mjs';

export async function renderBridgeArtifacts(job, {
  wordmarkSvg,
  outputRoot,
  origin,
}) {
  const directory = resolve(outputRoot, 'jobs', job.id);
  const htmlPath = resolve(directory, 'index.html');
  const imagePath = resolve(directory, 'opengraph-image.png');
  const [htmlSource, png] = await Promise.all([
    Promise.resolve(createBridgeHtml(job, { origin })),
    renderSocialCardPng(job, { wordmarkSvg }),
  ]);
  const html = Buffer.from(htmlSource, 'utf8');
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(htmlPath, html),
    writeFile(imagePath, png),
  ]);
  return Object.freeze({ htmlPath, imagePath, html, png, pngHash: sha256(png) });
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
  return async function publishBridge({ job }) {
    const artifacts = await renderBridgeArtifacts(job, {
      wordmarkSvg,
      outputRoot,
      origin: config.publicSiteOrigin,
    });
    const deployment = await requestDeployment({
      jobId: job.id,
      contentHash: job.contentHash,
      expectedPngHash: artifacts.pngHash,
      html: artifacts.html,
      image: artifacts.png,
      repository: config.webDeploy.repository,
      token: config.webDeploy.token,
      origin: config.publicSiteOrigin,
      fetchImpl,
    });
    return Object.freeze({
      status: deployment.status,
      canonicalUrl: deployment.verification.canonicalUrl,
      imageUrl: deployment.verification.imageUrl,
      pngHash: artifacts.pngHash,
    });
  };
}
