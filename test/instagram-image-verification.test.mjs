import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import { runMetaMigration } from '../src/cli/migrate-meta.mjs';
import { requestIncrementalBridgeDeployment } from '../src/modules/deploy/web-deploy-client.mjs';
import { verifyPublicBridge } from '../src/modules/deploy/public-verifier.mjs';
import { createBridgePublisher } from '../src/modules/publishing/bridge-publisher.mjs';
import { createBridgeHtml } from '../src/modules/render/html-page.mjs';
import { sha256 } from '../src/shared/hash.mjs';

const MAX_INSTAGRAM_IMAGE_BYTES = 2 * 1024 * 1024;
const origin = 'https://openings.dev';
const job = JSON.parse(await readFile(new URL('../assets/fixtures/job.json', import.meta.url), 'utf8'));
const canonicalUrl = `${origin}/jobs/${job.id}`;
const [png, instagramJpeg, alternateInstagramJpeg, wrongSizeInstagramJpeg] = await Promise.all([
  sharp({ create: {
    width: 1200, height: 630, channels: 4, background: { r: 33, g: 48, b: 46, alpha: 1 },
  } }).png().toBuffer(),
  sharp({ create: {
    width: 1080, height: 1350, channels: 3, background: { r: 176, g: 236, b: 156 },
  } }).jpeg().toBuffer(),
  sharp({ create: {
    width: 1080, height: 1350, channels: 3, background: { r: 49, g: 93, b: 53 },
  } }).jpeg().toBuffer(),
  sharp({ create: {
    width: 1080, height: 1349, channels: 3, background: { r: 176, g: 236, b: 156 },
  } }).jpeg().toBuffer(),
]);
const pngHash = sha256(png);
const instagramJpegHash = sha256(instagramJpeg);
const imageUrl = `${canonicalUrl}/opengraph-image.png?v=2.${pngHash.slice(0, 16)}`;
const instagramImageUrl = `${canonicalUrl}/instagram-image.jpg?v=7.${instagramJpegHash.slice(0, 16)}`;
const html = createBridgeHtml(job, { origin, imageHash: pngHash }).replace(
  /\s*<meta name="openings:social-video-version"[^>]*>/u,
  '',
);

function verificationInput(overrides = {}) {
  return {
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: pngHash,
    expectedInstagramSvgHash: sha256('<svg/>'),
    expectedInstagramJpegHash: instagramJpegHash,
    instagramFeedMediaKind: 'image',
    origin,
    ...overrides,
  };
}

function strictImageFetch(instagramReply = () => new Response(instagramJpeg, {
  status: 200,
  headers: { 'content-type': 'image/jpeg' },
}), expectedHash = instagramJpegHash) {
  const calls = [];
  const expectedInstagramUrl = `${canonicalUrl}/instagram-image.jpg?v=7.${expectedHash.slice(0, 16)}`;
  const fetchImpl = async (url, options = {}) => {
    calls.push(url);
    assert.equal(options.method, undefined, `unexpected request method for ${url}`);
    if (url === canonicalUrl) {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url === imageUrl) {
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url === expectedInstagramUrl) return instagramReply(url, options);
    throw new Error(`unexpected URL: ${url}`);
  };
  return { calls, fetchImpl };
}

test('image-mode verification checks only canonical HTML, PNG, and the exact JPEG', async () => {
  const fixture = strictImageFetch();
  const result = await verifyPublicBridge(verificationInput({ fetchImpl: fixture.fetchImpl }));

  assert.deepEqual(fixture.calls, [canonicalUrl, imageUrl, instagramImageUrl]);
  assert.equal(fixture.calls.some(url => url.includes('social-video')), false);
  assert.deepEqual(result, {
    matches: true,
    canonicalUrl,
    imageUrl,
    instagramImageUrl,
    contentHash: job.contentHash,
    pngHash,
    instagramFeedMediaKind: 'image',
    instagramJpegHash,
    instagramCardVersion: '7',
    htmlVerification: 'verified',
  });
  assert.equal(Object.hasOwn(result, 'socialVideoVersion'), false);
});

test('image-mode verification rejects invalid inputs before fetching', async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; throw new Error('must not fetch'); };
  await assert.rejects(
    verifyPublicBridge(verificationInput({ instagramFeedMediaKind: 'carousel', fetchImpl })),
    /Instagram feed media kind is invalid/u,
  );
  await assert.rejects(
    verifyPublicBridge(verificationInput({ expectedInstagramJpegHash: 'invalid', fetchImpl })),
    /Expected Instagram JPEG hash is invalid/u,
  );
  assert.equal(fetches, 0);
});

test('image-mode verification uses the JPEG hash as its cache fingerprint', async () => {
  const fixture = strictImageFetch();
  await verifyPublicBridge(verificationInput({
    expectedInstagramSvgHash: instagramJpegHash.replace(/^./u, instagramJpegHash[0] === 'a' ? 'b' : 'a'),
    fetchImpl: fixture.fetchImpl,
  }));
  assert.equal(fixture.calls[2], instagramImageUrl);
});

const negativeInstagramCases = [
  {
    name: '404',
    expectedReason: 'instagram_image_not_found',
    reply: () => new Response('missing', { status: 404 }),
  },
  {
    name: 'request failure',
    expectedReason: 'instagram_image_request_failed',
    reply: async () => { throw new Error('network unavailable'); },
  },
  {
    name: 'timeout',
    expectedReason: 'instagram_image_request_failed',
    input: { timeoutMs: 5 },
    reply: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  },
  {
    name: 'body read failure',
    expectedReason: 'instagram_image_request_failed',
    reply: () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => { throw new Error('body interrupted'); },
    }),
  },
  {
    name: 'MIME mismatch',
    expectedReason: 'instagram_image_content_type_mismatch',
    reply: () => new Response(instagramJpeg, { headers: { 'content-type': 'image/png' } }),
  },
  {
    name: 'corrupt body',
    expectedReason: 'instagram_image_decode_failed',
    body: Buffer.from('not a jpeg'),
  },
  {
    name: 'truncated real JPEG',
    expectedReason: 'instagram_image_decode_failed',
    body: instagramJpeg.subarray(0, Math.floor(instagramJpeg.byteLength / 2)),
  },
  {
    name: 'different valid same-size JPEG',
    expectedReason: 'instagram_image_hash_mismatch',
    body: alternateInstagramJpeg,
    expectedHash: instagramJpegHash,
  },
  {
    name: 'wrong dimensions',
    expectedReason: 'instagram_image_dimensions_mismatch',
    body: wrongSizeInstagramJpeg,
  },
  {
    name: 'empty body',
    expectedReason: 'instagram_image_size_mismatch',
    body: Buffer.alloc(0),
  },
  {
    name: 'body at the size limit',
    expectedReason: 'instagram_image_size_mismatch',
    body: Buffer.alloc(MAX_INSTAGRAM_IMAGE_BYTES),
  },
];

for (const fixtureCase of negativeInstagramCases) {
  test(`image-mode verification classifies Instagram JPEG ${fixtureCase.name}`, async () => {
    const body = fixtureCase.body;
    const expectedHash = fixtureCase.expectedHash ?? (body ? sha256(body) : instagramJpegHash);
    const fixture = strictImageFetch(fixtureCase.reply ?? (() => new Response(body, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })), expectedHash);
    const result = await verifyPublicBridge(verificationInput({
      expectedInstagramJpegHash: expectedHash,
      fetchImpl: fixture.fetchImpl,
      allowMismatch: true,
      ...fixtureCase.input,
    }));
    assert.deepEqual(result, { matches: false, reason: fixtureCase.expectedReason });
    assert.equal(fixture.calls.some(url => url.includes('social-video')), false);
  });
}

test('default Reel verification retains the cover and MP4 contract', async () => {
  const legacySvgHash = sha256('<svg/>');
  const legacyInstagramUrl = `${canonicalUrl}/instagram-image.jpg?v=7.${legacySvgHash.slice(0, 16)}`;
  const legacyCoverUrl = `${canonicalUrl}/social-video-cover.jpg?v=8.${legacySvgHash.slice(0, 16)}`;
  const legacyVideoUrl = `${canonicalUrl}/social-video.mp4?v=8.${legacySvgHash.slice(0, 16)}`;
  const cover = await sharp({ create: {
    width: 1080, height: 1920, channels: 3, background: { r: 33, g: 48, b: 46 },
  } }).jpeg().toBuffer();
  const calls = [];
  const result = await verifyPublicBridge(verificationInput({
    instagramFeedMediaKind: undefined,
    expectedInstagramJpegHash: undefined,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === canonicalUrl) {
        return new Response(createBridgeHtml(job, { origin, imageHash: pngHash }), {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url === imageUrl) return new Response(png, { headers: { 'content-type': 'image/png' } });
      if (url === legacyInstagramUrl) return new Response(instagramJpeg, { headers: { 'content-type': 'image/jpeg' } });
      if (url === legacyCoverUrl) return new Response(cover, { headers: { 'content-type': 'image/jpeg' } });
      if (url === legacyVideoUrl) return new Response('missing', { status: 404 });
      throw new Error(`unexpected URL: ${url}`);
    },
    allowMismatch: true,
  }));
  assert.deepEqual(result, { matches: false, reason: 'social_video_not_found' });
  assert.deepEqual(calls, [canonicalUrl, imageUrl, legacyInstagramUrl, legacyCoverUrl, legacyVideoUrl]);
});

function deploymentInput(overrides = {}) {
  const instagramSvg = Buffer.from('<svg/>');
  return {
    jobId: job.id,
    contentHash: job.contentHash,
    expectedPngHash: sha256(png),
    expectedInstagramSvgHash: sha256(instagramSvg),
    expectedInstagramJpegHash: sha256(instagramJpeg),
    instagramFeedMediaKind: 'image',
    html: Buffer.from(html),
    image: png,
    instagramSvg,
    instagramJpeg,
    repository: 'openings-dev/web-deploy',
    token: 'test-only-token',
    origin,
    ...overrides,
  };
}

test('image deployment validates local JPEG identity and passes the explicit mode to verification', async () => {
  const verificationInputs = [];
  const result = await requestIncrementalBridgeDeployment(deploymentInput({
    verifyPublic: async (input) => {
      verificationInputs.push(input);
      return { matches: true, instagramFeedMediaKind: 'image', instagramJpegHash };
    },
    fetchImpl: async () => { throw new Error('no public or provider request expected'); },
  }));
  assert.equal(result.status, 'already_current');
  assert.equal(verificationInputs.length, 1);
  assert.equal(verificationInputs[0].instagramFeedMediaKind, 'image');
  assert.equal(verificationInputs[0].expectedInstagramJpegHash, instagramJpegHash);
  assert.equal(Object.hasOwn(verificationInputs[0], 'expectedSocialVideoVersion'), false);
});

test('image deployment rejects invalid mode, missing JPEG, and mismatched JPEG before verification', async () => {
  for (const overrides of [
    { instagramFeedMediaKind: 'carousel' },
    { expectedInstagramJpegHash: undefined },
    { expectedInstagramJpegHash: 'invalid' },
    { instagramJpeg: undefined },
    { instagramJpeg: alternateInstagramJpeg },
  ]) {
    let reads = 0;
    await assert.rejects(requestIncrementalBridgeDeployment(deploymentInput({
      ...overrides,
      verifyPublic: async () => { reads += 1; return { matches: true }; },
      fetchImpl: async () => { reads += 1; throw new Error('must not request'); },
    })));
    assert.equal(reads, 0);
  }
});

test('a platform-owned image mismatch never dispatches the legacy deployer', async () => {
  let writes = 0;
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') {
      writes += 1;
      return new Response(null, { status: 204 });
    }
    if (url === canonicalUrl) {
      return new Response(html, { headers: {
        'content-type': 'text/html',
        'x-publishing-revision': 'approved-revision',
      } });
    }
    if (url === imageUrl) return new Response(png, { headers: { 'content-type': 'image/png' } });
    if (url === instagramImageUrl) {
      return new Response(alternateInstagramJpeg, { headers: { 'content-type': 'image/jpeg' } });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  await assert.rejects(
    requestIncrementalBridgeDeployment(deploymentInput({ fetchImpl })),
    error => error.code === 'bridge_platform_media_pending',
  );
  assert.equal(writes, 0);
});

test('ordinary bridge publishing advertises only verified image-mode identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-image-publisher-'));
  let deploymentInputValue;
  try {
    const publishBridge = createBridgePublisher({
      config: {
        publicSiteOrigin: origin,
        webDeploy: { repository: 'openings-dev/web-deploy', token: 'test-only-token' },
      },
      wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
      outputRoot: directory,
      requestDeployment: async (input) => {
        deploymentInputValue = input;
        return {
          status: 'already_current',
          verification: {
            canonicalUrl,
            imageUrl,
            instagramImageUrl,
            instagramFeedMediaKind: 'image',
            instagramJpegHash: input.expectedInstagramJpegHash,
          },
        };
      },
    });
    const result = await publishBridge({ job, reason: 'instagram_card_upgrade' });

    assert.equal(deploymentInputValue.instagramFeedMediaKind, 'image');
    assert.deepEqual(deploymentInputValue.instagramJpeg, await readFile(join(
      directory, 'jobs', job.id, 'instagram-image.jpg',
    )));
    assert.equal(sha256(deploymentInputValue.instagramJpeg), deploymentInputValue.expectedInstagramJpegHash);
    assert.equal(Object.hasOwn(deploymentInputValue, 'expectedSocialVideoVersion'), false);
    assert.equal(deploymentInputValue.forceDeployment, false);
    assert.equal(result.instagramFeedMediaKind, 'image');
    assert.equal(result.instagramJpegHash, deploymentInputValue.expectedInstagramJpegHash);
    assert.equal(Object.hasOwn(result, 'socialVideoVersion'), false);
    assert.equal(Object.hasOwn(result, 'socialVideoUrl'), false);
    assert.equal(Object.hasOwn(result, 'socialVideoCoverUrl'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Reel bridge publishing keeps verified video fields and upgrade forcing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-reel-publisher-'));
  let deploymentInputValue;
  try {
    const publishBridge = createBridgePublisher({
      config: {
        publicSiteOrigin: origin,
        webDeploy: { repository: 'openings-dev/web-deploy', token: 'test-only-token' },
      },
      wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219"/></svg>',
      outputRoot: directory,
      instagramFeedMediaKind: 'reel',
      requestDeployment: async (input) => {
        deploymentInputValue = input;
        return { status: 'deployed', verification: {
          canonicalUrl, imageUrl, instagramImageUrl,
          socialVideoUrl: `${canonicalUrl}/social-video.mp4`,
          socialVideoCoverUrl: `${canonicalUrl}/social-video-cover.jpg`,
        } };
      },
    });
    const result = await publishBridge({ job, reason: 'instagram_card_upgrade' });
    assert.equal(deploymentInputValue.instagramFeedMediaKind, 'reel');
    assert.equal(deploymentInputValue.expectedSocialVideoVersion, '8');
    assert.equal(deploymentInputValue.forceDeployment, true);
    assert.equal(result.socialVideoVersion, '8');
    assert.equal(result.socialVideoUrl, `${canonicalUrl}/social-video.mp4`);
    assert.equal(result.socialVideoCoverUrl, `${canonicalUrl}/social-video-cover.jpg`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Meta migration explicitly requests a Reel bridge publisher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-meta-reel-'));
  const stateDirectory = join(directory, 'state');
  let publisherOptions;
  try {
    await mkdir(stateDirectory);
    await Promise.all([
      writeFile(join(stateDirectory, 'queue.json'), JSON.stringify({ schemaVersion: 3, items: [] })),
      writeFile(join(stateDirectory, 'publications.json'), JSON.stringify({ schemaVersion: 3, jobs: {} })),
    ]);
    await assert.rejects(runMetaMigration({
      request: { jobIds: [job.id], confirmation: 'MIGRATE_META_POSTS' },
      dataRepositoryPath: '/fixture/data',
      stateDirectory,
      wordmarkPath: '/fixture/wordmark.svg',
      outputPath: join(directory, 'output'),
      env: {
        WEB_DEPLOY_TOKEN: 'deploy-secret',
        THREADS_ACCESS_TOKEN: 'threads-secret',
        INSTAGRAM_ACCESS_TOKEN: 'instagram-secret',
        INSTAGRAM_USER_ID: '17841400000000000',
        META_GRAPH_VERSION: 'v26.0',
      },
      log: () => {},
      dependencies: {
        resolveGitCommit: async () => 'a'.repeat(40),
        loadCanonicalWordmark: async () => '<svg/>',
        loadSnapshot: async () => ({ jobsById: new Map() }),
        createBridgePublisher: (options) => {
          publisherOptions = options;
          return async () => { throw new Error('must not publish'); };
        },
      },
    }), /Completed publication not found/u);
    assert.equal(publisherOptions.instagramFeedMediaKind, 'reel');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
