import assert from 'node:assert/strict';
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
      assert.deepEqual(remote.createReelStageSvgs(artifacts.instagramSvg.toString()), createReelStageSvgs(artifacts.instagramSvg.toString()));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
