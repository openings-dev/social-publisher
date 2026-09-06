import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderBridgeArtifacts } from '../publishing/bridge-publisher.mjs';
import { buildRepositoryDispatchRequest } from '../deploy/web-deploy-client.mjs';
import { createReelStageSvgs } from './reel-video.mjs';
import { createSocialPosterModel, encodeSocialPosterModel } from './social-poster-model.mjs';
import { PREVIEW_SAMPLES } from '../preview/sample-jobs.mjs';

const deploy = new URL('../../../../web-deploy/', import.meta.url);
const publisher = new URL('../../../', import.meta.url);
const available = existsSync(new URL('scripts/prepare-job-bridge.mjs', deploy));
const files = ['src/modules/render/job-poster.mjs', 'src/modules/render/job-poster-model.mjs', 'src/modules/render/poster-typography.mjs', 'src/modules/render/format-job.mjs', 'src/modules/render/font-runtime.mjs', 'src/shared/escape.mjs', 'src/shared/job-id.mjs', 'src/config/constants.mjs', 'assets/fonts/figtree.json', 'assets/fonts/OFL.txt'];
files.push('src/modules/render/job-poster-v4.mjs', 'src/modules/render/job-poster-input.mjs');
files.push('src/modules/render/soundtrack.mjs', 'assets/audio/README.md', 'assets/audio/funked-up.mp3', 'assets/audio/funky-house.mp3');

test('clean editorial dispatches use a separate render namespace and pass deployment validation', { skip: !available }, async () => {
  const { EDITORIAL_CATALOG } = await import('../../content/editorial-catalog.mjs');
  const { createEditorialSlideSvg, createEditorialStorySvg, EDITORIAL_RENDER_VERSION } = await import('./editorial-card.mjs');
  const { buildEditorialDispatchRequest } = await import('../deploy/web-deploy-client.mjs');
  const { prepareEditorialAssets } = await import(new URL('scripts/prepare-editorial-assets.mjs', deploy));
  const directory = await mkdtemp(join(tmpdir(), 'openings-clean-editorial-'));
  const wordmarkSvg = '<svg viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>';
  try {
    for (const content of EDITORIAL_CATALOG) {
      assert.equal(content.version, '2');
      const request = buildEditorialDispatchRequest({ contentId: content.id, version: EDITORIAL_RENDER_VERSION,
        carouselSvgs: content.slides.map((_, index) => createEditorialSlideSvg(content, index, { wordmarkSvg })),
        storySvg: createEditorialStorySvg(content, { wordmarkSvg }), repository: 'openings-dev/web-deploy' });
      const payload = JSON.parse(request.body).client_payload;
      assert.equal(payload.content_version, '4');
      const result = await prepareEditorialAssets({ outputRoot: directory, siteOrigin: 'https://openings.dev', payload: {
        contentId: payload.content_id, contentVersion: payload.content_version,
        assets: payload.assets.map(({ name, sha256, svg_gzip_base64 }) => ({ name, sha256, svgGzipBase64: svg_gzip_base64 })),
      } });
      assert.ok(result.remoteDirectory.endsWith(`/${content.id}/4`));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy poster payloads retain the deployment renderer output', { skip: !available }, async () => {
  const remote = await import(new URL('scripts/render-reel.mjs', deploy));
  const model = encodeSocialPosterModel(createSocialPosterModel(PREVIEW_SAMPLES[1].job));
  const wordmark = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>').toString('base64');
  const svg = `<svg width="1080" height="1350" data-instagram-card="true" data-social-poster-version="3" data-poster-model="${model}"><image data-instagram-wordmark="true" href="data:image/svg+xml;base64,${wordmark}"/></svg>`;
  assert.deepEqual(createReelStageSvgs(svg), remote.createReelStageSvgs(svg));
});

test('portable artwork modules match the deployment repository byte-for-byte', { skip: !available }, async () => {
  for (const file of files) {
    const source = await readFile(new URL(file, publisher));
    const mirror = await readFile(new URL(`scripts/social-artwork/${file}`, deploy));
    assert.ok(source.equals(mirror), `${file}: re-sync the deployment copy before rollout`);
  }
});

test('real image dispatches fit GitHub limits and pass standalone deployment validation', { skip: !available }, async () => {
  const { prepareJobBridgePayload } = await import(new URL('scripts/prepare-job-bridge.mjs', deploy));
  const remote = await import(new URL('scripts/render-reel.mjs', deploy));
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>';
  const directory = await mkdtemp(join(tmpdir(), 'openings-artwork-contract-'));
  try {
    for (const direction of ['night', 'editorial', 'lavender', 'peach']) {
      const job = PREVIEW_SAMPLES[1].job;
      const artifacts = await renderBridgeArtifacts(job, { direction, wordmarkSvg, outputRoot: directory, origin: 'https://openings.dev' });
      const request = buildRepositoryDispatchRequest({ jobId: job.id, contentHash: job.contentHash, ...artifacts, image: artifacts.png, repository: 'openings-dev/web-deploy' });
      assert.ok(request.body.length < 65536);
      const payload = JSON.parse(request.body).client_payload;
      const input = { jobId: payload.job_id, contentHash: payload.content_hash, htmlSha256: payload.html_sha256, imageSha256: payload.image_sha256, instagramSvgSha256: payload.instagram_svg_sha256, htmlBase64: payload.html_base64, imageBase64: payload.image_base64, instagramSvgBase64: payload.instagram_svg_base64 };
      await prepareJobBridgePayload({ payload: input, outputRoot: join(directory, 'deploy'), siteOrigin: 'https://openings.dev' });
      for (const version of ['5', '6', '8']) {
        const html = Buffer.from(input.htmlBase64, 'base64').toString().replace('name="openings:social-video-version" content="7"', `name="openings:social-video-version" content="${version}"`);
        const revised = { ...input, htmlBase64: Buffer.from(html).toString('base64'), htmlSha256: createHash('sha256').update(html).digest('hex') };
        const prepare = () => prepareJobBridgePayload({ payload: revised, outputRoot: join(directory, `deploy-${version}`), siteOrigin: 'https://openings.dev' });
        await assert.rejects(prepare, /unsupported social-video-version/u);
      }
      assert.deepEqual(remote.createReelStageSvgs(artifacts.instagramSvg.toString()), createReelStageSvgs(artifacts.instagramSvg.toString()));
      const localAudio = await (await import('./soundtrack.mjs')).resolveReelSoundtrack(artifacts.instagramSvg.toString());
      const remoteAudio = await remote.resolveReelSoundtrack(artifacts.instagramSvg.toString());
      assert.equal(remoteAudio.id, localAudio.id);
      assert.ok((await readFile(remoteAudio.path)).equals(await readFile(localAudio.path)));
      const { createArtworkSvg: legacyArtwork } = await import('./job-poster-v4.mjs');
      const legacySvg = legacyArtwork(job, { direction, format: 'feed', wordmarkSvg });
      for (const version of ['5', '6']) {
        const html = Buffer.from(input.htmlBase64, 'base64').toString()
          .replace('name="openings:instagram-card-version" content="6"', 'name="openings:instagram-card-version" content="5"')
          .replace('name="openings:social-video-version" content="7"', `name="openings:social-video-version" content="${version}"`);
        const legacyInput = { ...input, htmlBase64: Buffer.from(html).toString('base64'), htmlSha256: createHash('sha256').update(html).digest('hex'),
          instagramSvgBase64: Buffer.from(legacySvg).toString('base64'), instagramSvgSha256: createHash('sha256').update(legacySvg).digest('hex') };
        await prepareJobBridgePayload({ payload: legacyInput, outputRoot: join(directory, `legacy-${version}`), siteOrigin: 'https://openings.dev' });
        assert.deepEqual(remote.createReelStageSvgs(legacySvg), createReelStageSvgs(legacySvg));
        assert.ok(remote.createReelStageSvgs(legacySvg)[0].includes('View opening'));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
