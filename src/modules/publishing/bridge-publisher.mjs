import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { deployAndVerifyBridge } from '../deploy/lftp-client.mjs';
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
  const [html, png] = await Promise.all([
    Promise.resolve(createBridgeHtml(job, { origin })),
    renderSocialCardPng(job, { wordmarkSvg }),
  ]);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(htmlPath, html, 'utf8'),
    writeFile(imagePath, png),
  ]);
  return Object.freeze({ htmlPath, imagePath, png, pngHash: sha256(png) });
}

export async function loadCanonicalWordmark(path) {
  return readFile(path, 'utf8');
}

export function createBridgePublisher({
  config,
  wordmarkSvg,
  outputRoot,
  fetchImpl = globalThis.fetch,
  deploy = deployAndVerifyBridge,
}) {
  if (!config?.ftp) {
    throw new Error('FTP configuration is required for bridge publication');
  }
  return async function publishBridge({ job }) {
    const artifacts = await renderBridgeArtifacts(job, {
      wordmarkSvg,
      outputRoot,
      origin: config.publicSiteOrigin,
    });
    const deployment = await deploy({
      jobId: job.id,
      contentHash: job.contentHash,
      expectedPngHash: artifacts.pngHash,
      htmlPath: artifacts.htmlPath,
      imagePath: artifacts.imagePath,
      ftp: { ...config.ftp, jobRoot: config.ftpJobRoot },
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
