import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { PREVIEW_SAMPLES } from '../src/modules/preview/sample-jobs.mjs';
import { renderBridgeArtifacts } from '../src/modules/publishing/bridge-publisher.mjs';
import { createInstagramCardSvg, renderInstagramCardJpeg, renderSocialCardPng } from '../src/modules/render/social-card.mjs';
import { sha256 } from '../src/shared/hash.mjs';

test('bridge artifacts include the rendered Instagram feed JPEG', async () => {
  const job = PREVIEW_SAMPLES[1].job;
  const wordmarkSvg = '<svg viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>';
  const outputRoot = await mkdtemp(join(tmpdir(), 'openings-feed-contract-'));
  const options = { outputRoot, origin: 'https://openings.dev', direction: 'night', wordmarkSvg };

  try {
    const result = await renderBridgeArtifacts(job, options);
    assert.ok(result.instagramJpegPath, 'renderBridgeArtifacts must return instagramJpegPath');
    assert.ok(result.instagramJpeg, 'renderBridgeArtifacts must return instagramJpeg');
    assert.ok(result.instagramJpegHash, 'renderBridgeArtifacts must return instagramJpegHash');

    const [storedJpeg, expectedJpeg, expectedPng, expectedSvg] = await Promise.all([
      readFile(result.instagramJpegPath),
      renderInstagramCardJpeg(job, options),
      renderSocialCardPng(job, options),
      Promise.resolve(createInstagramCardSvg(job, options)),
    ]);
    const metadata = await sharp(storedJpeg).metadata();

    assert.deepEqual(storedJpeg, result.instagramJpeg);
    assert.deepEqual(storedJpeg, expectedJpeg);
    assert.equal(result.instagramJpegHash, sha256(storedJpeg));
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 1080);
    assert.equal(metadata.height, 1350);
    assert.ok(storedJpeg.byteLength < 2 * 1024 * 1024);

    assert.deepEqual(result.png, expectedPng);
    assert.equal(result.pngHash, sha256(expectedPng));
    assert.equal(result.instagramSvg.toString('utf8'), expectedSvg);
    assert.equal(result.instagramSvgHash, sha256(Buffer.from(expectedSvg, 'utf8')));
    assert.equal(result.htmlPath, join(outputRoot, 'jobs', job.id, 'index.html'));
    assert.equal(result.imagePath, join(outputRoot, 'jobs', job.id, 'opengraph-image.png'));
    assert.equal(result.instagramSvgPath, join(outputRoot, 'jobs', job.id, 'instagram-image.svg'));
    assert.equal(result.instagramJpegPath, join(outputRoot, 'jobs', job.id, 'instagram-image.jpg'));
    assert.ok(result.html.byteLength > 0);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('normal platform validation includes the Instagram JPEG regression', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts['test:platform'], /test\/instagram-image-artifacts\.test\.mjs/u);
  assert.match(packageJson.scripts['test:platform'], /test\/instagram-image-verification\.test\.mjs/u);
  assert.match(packageJson.scripts.validate, /npm run test:platform/u);
});
