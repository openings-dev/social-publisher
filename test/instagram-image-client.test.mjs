import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPublication } from '../src/cli/publish.mjs';
import { publishImageToInstagram } from '../src/modules/networks/instagram-client.mjs';
import { formatSocialPost } from '../src/modules/render/format-job.mjs';

const userId = '17841400000000000';
const apiVersion = 'v23.0';
const canonicalUrl = 'https://openings.dev/jobs/gh_0123456789abcdef01234567';
const imageUrl = `${canonicalUrl}/instagram-image.jpg?v=7.fixture`;

function makeJob(overrides = {}) {
  return {
    id: 'gh_0123456789abcdef01234567',
    sourceId: 'openings-fixtures/jobs#42',
    title: 'Senior TypeScript Engineer',
    description: 'Build reliable developer tools.',
    issueState: 'open',
    contentHash: '5'.repeat(64),
    repository: 'openings-fixtures/jobs',
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    url: 'https://github.com/openings-fixtures/jobs/issues/42',
    sourceType: 'github-issue',
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function instagramFetchFixture({ recentMedia = [] } = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const request = { url: String(url), options };
    calls.push(request);
    const parsed = new URL(url);
    if (parsed.pathname === `/${apiVersion}/${userId}/media` && options.method !== 'POST') {
      return jsonResponse({ data: recentMedia });
    }
    if (parsed.pathname === `/${apiVersion}/${userId}/media` && options.method === 'POST') {
      return jsonResponse({ id: 'container-1' });
    }
    if (parsed.pathname === `/${apiVersion}/container-1` && options.method !== 'POST') {
      return jsonResponse({ status_code: 'FINISHED' });
    }
    if (parsed.pathname === `/${apiVersion}/${userId}/media_publish` && options.method === 'POST') {
      return jsonResponse({ id: 'media-1' });
    }
    if (parsed.pathname === `/${apiVersion}/media-1` && options.method !== 'POST') {
      return jsonResponse({
        id: 'media-1',
        permalink: 'https://www.instagram.com/p/example/',
      });
    }
    throw new Error(`Unexpected Instagram request: ${options.method ?? 'GET'} ${String(url)}`);
  };
  return { calls, fetch };
}

test('publishes an ordinary Instagram feed image with the canonical caption', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const fixture = instagramFetchFixture();

  const result = await publishImageToInstagram({
    job,
    post,
    imageUrl,
    accessToken: 'instagram-secret',
    userId,
    apiVersion,
    fetchImpl: fixture.fetch,
    sleep: async () => {},
  });

  assert.deepEqual(result, {
    status: 'published',
    id: 'media-1',
    url: 'https://www.instagram.com/p/example/',
  });
  assert.deepEqual(fixture.calls.map(({ url, options }) => {
    const parsed = new URL(url);
    return [options.method ?? 'GET', parsed.pathname, parsed.searchParams.toString()];
  }), [
    ['GET', `/${apiVersion}/${userId}/media`, 'fields=id%2Ccaption%2Cpermalink%2Ctimestamp&limit=50'],
    ['POST', `/${apiVersion}/${userId}/media`, ''],
    ['GET', `/${apiVersion}/container-1`, 'fields=status_code%2Cstatus'],
    ['POST', `/${apiVersion}/${userId}/media_publish`, ''],
    ['GET', `/${apiVersion}/media-1`, 'fields=id%2Cpermalink'],
  ]);
  const create = fixture.calls.find(({ url, options }) => (
    new URL(url).pathname.endsWith(`/${userId}/media`) && options.method === 'POST'
  ));
  const body = new URLSearchParams(create.options.body);
  assert.equal(body.get('image_url'), imageUrl);
  assert.equal(body.get('caption'), [
    'New opening on openings.dev',
    'Senior TypeScript Engineer',
    `Open the full role:\n${canonicalUrl}`,
    'Know someone who fits? Tag them below.',
    'Follow @openingshq for more jobs from public communities.',
    '#TechJobs #OpeningsJobs #Hiring',
  ].join('\n\n'));
  assert.equal(body.has('video_url'), false);
  assert.equal(body.has('cover_url'), false);
  assert.equal(body.has('share_to_feed'), false);
  assert.equal(body.has('media_type'), false);
  assert.equal(fixture.calls.every(({ url }) => new URL(url).origin === 'https://graph.instagram.com'), true);
  assert.equal(fixture.calls.every(({ url }) => new URL(url).pathname.startsWith(`/${apiVersion}/`)), true);
  assert.equal(fixture.calls.filter(({ url, options }) => (
    new URL(url).pathname.endsWith('/media_publish') && options.method === 'POST'
  )).length, 1);
});

test('rejects invalid ordinary feed inputs before any Instagram provider call', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const cases = [
    { imageUrl: undefined, accessToken: 'instagram-secret', userId, post },
    { imageUrl: imageUrl.replace('https:', 'http:'), accessToken: 'instagram-secret', userId, post },
    { imageUrl: canonicalUrl, accessToken: 'instagram-secret', userId, post },
    { imageUrl, accessToken: '', userId, post },
    { imageUrl, accessToken: 'instagram-secret', userId: '', post },
    { imageUrl, accessToken: 'instagram-secret', userId, post: undefined },
    {
      imageUrl,
      accessToken: 'instagram-secret',
      userId,
      post: { ...post, title: 'x'.repeat(2_300) },
    },
  ];

  for (const invalid of cases) {
    let providerCalls = 0;
    await assert.rejects(publishImageToInstagram({
      job,
      apiVersion,
      fetchImpl: async () => {
        providerCalls += 1;
        throw new Error('Provider must not be called');
      },
      ...invalid,
    }));
    assert.equal(providerCalls, 0);
  }
});

test('reconciles existing canonical Instagram media without a provider POST', async () => {
  const job = makeJob();
  const post = formatSocialPost(job);
  const fixture = instagramFetchFixture({
    recentMedia: [{
      id: 'existing-media',
      caption: `New opening\n${post.canonicalUrl}`,
      permalink: 'https://www.instagram.com/p/existing/',
    }],
  });

  const result = await publishImageToInstagram({
    job,
    post,
    imageUrl,
    accessToken: 'instagram-secret',
    userId,
    apiVersion,
    fetchImpl: fixture.fetch,
    sleep: async () => {},
  });

  assert.deepEqual(result, {
    status: 'reconciled',
    id: 'existing-media',
    url: 'https://www.instagram.com/p/existing/',
  });
  assert.equal(fixture.calls.some(({ options }) => options.method === 'POST'), false);
});

test('routes the verified bridge JPEG from the ordinary CLI stage to the image adapter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openings-instagram-image-cli-'));
  const job = makeJob();
  const snapshot = {
    commit: '7'.repeat(40),
    generatedAt: '2026-09-01T13:00:00.000Z',
    dataHash: '7'.repeat(64),
    schemaVersion: 4,
    jobsById: new Map([[job.id, job]]),
  };
  const adapterCalls = [];
  try {
    await Promise.all([
      writeFile(join(directory, 'queue.json'), JSON.stringify({ schemaVersion: 3, items: [] })),
      writeFile(join(directory, 'publications.json'), JSON.stringify({ schemaVersion: 3, jobs: {} })),
    ]);
    const result = await runPublication({
      request: {
        mode: 'controlled',
        jobId: job.id,
        confirmation: 'PUBLISH_ONE_JOB',
      },
      dataRepositoryPath: '/fixture/data',
      stateDirectory: directory,
      wordmarkPath: '/fixture/wordmark.svg',
      outputPath: join(directory, 'output'),
      env: {
        WEB_DEPLOY_TOKEN: 'deploy-secret',
        BLUESKY_IDENTIFIER: 'openingshq.bsky.social',
        BLUESKY_APP_PASSWORD: 'bluesky-secret',
        MASTODON_ACCESS_TOKEN: 'mastodon-secret',
        BUFFER_API_KEY: 'buffer-secret',
        BUFFER_ORGANIZATION_ID: '68b68d3ac159685850cf2b8d',
        BUFFER_TWITTER_CHANNEL_ID: '68b68e0fc159685850cf2c22',
        INSTAGRAM_AUTO_PUBLISH: 'true',
        INSTAGRAM_ACCESS_TOKEN: 'instagram-secret',
        INSTAGRAM_USER_ID: userId,
        META_GRAPH_VERSION: apiVersion,
      },
      log: () => {},
      dependencies: {
        resolveGitCommit: async () => snapshot.commit,
        loadCanonicalWordmark: async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        loadSnapshot: async () => snapshot,
        createBridgePublisher: () => async () => ({
          status: 'deployed',
          instagramImageUrl: imageUrl,
        }),
        publishBluesky: async () => ({ status: 'published' }),
        publishMastodon: async () => ({ status: 'published' }),
        publishTwitter: async () => ({ status: 'published' }),
        publishImageToInstagram: async (input) => {
          adapterCalls.push(input);
          return { status: 'published', id: 'media-cli' };
        },
      },
    });

    assert.equal(result.outcome, 'completed');
    assert.equal(adapterCalls.length, 1);
    assert.equal(adapterCalls[0].imageUrl, imageUrl);
    assert.equal(adapterCalls[0].post.canonicalUrl, canonicalUrl);
    assert.equal(adapterCalls[0].accessToken, 'instagram-secret');
    assert.equal(adapterCalls[0].userId, userId);
    assert.equal(adapterCalls[0].apiVersion, apiVersion);
    assert.equal(adapterCalls[0].apiOrigin, 'https://graph.instagram.com');
    assert.equal(Object.hasOwn(adapterCalls[0], 'videoUrl'), false);
    assert.equal(Object.hasOwn(adapterCalls[0], 'coverUrl'), false);
    assert.equal(JSON.parse(await readFile(join(directory, 'queue.json'), 'utf8'))
      .items[0].instagram.result.id, 'media-cli');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
