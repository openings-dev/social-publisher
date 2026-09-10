import assert from 'node:assert/strict';
import test from 'node:test';

import { publishImageToInstagram } from '../src/modules/networks/instagram-client.mjs';
import { formatSocialPost } from '../src/modules/render/format-job.mjs';

const userId = '17841400000000000';
const apiVersion = 'v23.0';
const canonicalUrl = 'https://openings.dev/jobs/gh_0123456789abcdef01234567';
const imageUrl = `${canonicalUrl}/instagram-image.jpg?v=7.fixture`;
const exactMedia = Object.freeze({
  id: 'existing-media',
  caption: `Legacy Reel\n${canonicalUrl}\n#OpeningsJobs`,
  permalink: 'https://www.instagram.com/reel/existing/',
});

function makeJob() {
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
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function adapterInput(fetchImpl, overrides = {}) {
  const job = makeJob();
  return {
    job,
    post: formatSocialPost(job),
    imageUrl,
    accessToken: 'instagram-secret',
    userId,
    apiVersion,
    fetchImpl,
    sleep: async () => {},
    ...overrides,
  };
}

function pagedFixture({ pages, publishReply = { id: 'published-media' } }) {
  const calls = [];
  let scan = 0;
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    if (parsed.pathname === `/${apiVersion}/${userId}/media` && options.method !== 'POST') {
      const reply = pages[scan++];
      if (reply instanceof Error) throw reply;
      return json(reply);
    }
    if (parsed.pathname === `/${apiVersion}/${userId}/media` && options.method === 'POST') {
      return json({ id: 'container-one' });
    }
    if (parsed.pathname === `/${apiVersion}/container-one`) {
      return json({ status_code: 'FINISHED' });
    }
    if (parsed.pathname === `/${apiVersion}/${userId}/media_publish`) {
      if (publishReply instanceof Error) throw publishReply;
      return json(publishReply);
    }
    if (parsed.pathname === `/${apiVersion}/published-media`) {
      return json({ id: 'published-media', permalink: 'https://www.instagram.com/p/published/' });
    }
    throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${parsed}`);
  };
  return { calls, fetch };
}

function postCount(calls) {
  return calls.filter(({ options }) => options.method === 'POST').length;
}

test('scans the complete bounded history before reconciling one exact legacy Reel', async () => {
  const fixture = pagedFixture({ pages: [
    { data: [{ id: 'lookalike', caption: `${canonicalUrl}/apply`, permalink: null }], paging: { next: 'https://untrusted.example/leak', cursors: { after: 'cursor-one' } } },
    { data: [exactMedia], paging: { next: 'https://untrusted.example/leak2', cursors: { after: 'cursor-two' } } },
    { data: [{ id: 'other', caption: `${canonicalUrl}?ref=other`, permalink: null }] },
  ] });

  const result = await publishImageToInstagram(adapterInput(fixture.fetch));

  assert.deepEqual(result, {
    status: 'reconciled',
    id: exactMedia.id,
    url: exactMedia.permalink,
  });
  assert.equal(postCount(fixture.calls), 0);
  assert.deepEqual(fixture.calls.map(({ url }) => ({
    origin: url.origin,
    path: url.pathname,
    after: url.searchParams.get('after'),
  })), [
    { origin: 'https://graph.instagram.com', path: `/${apiVersion}/${userId}/media`, after: null },
    { origin: 'https://graph.instagram.com', path: `/${apiVersion}/${userId}/media`, after: 'cursor-one' },
    { origin: 'https://graph.instagram.com', path: `/${apiVersion}/${userId}/media`, after: 'cursor-two' },
  ]);
});

test('holds for review when exact canonical media is duplicated across pages', async () => {
  const fixture = pagedFixture({ pages: [
    { data: [exactMedia], paging: { cursors: { after: 'next-page' } } },
    { data: [{ ...exactMedia, id: 'duplicate-media' }] },
  ] });

  await assert.rejects(
    publishImageToInstagram(adapterInput(fixture.fetch)),
    (error) => error?.code === 'instagram_image_ambiguous',
  );
  assert.equal(postCount(fixture.calls), 0);
});

test('plain empty completed history permits a fresh image attempt but reconcile-only never creates', async () => {
  const fresh = pagedFixture({ pages: [{ data: [] }] });
  const result = await publishImageToInstagram(adapterInput(fresh.fetch));
  assert.equal(result.id, 'published-media');
  assert.equal(postCount(fresh.calls), 2);

  const recovery = pagedFixture({ pages: [{ data: [] }] });
  await assert.rejects(
    publishImageToInstagram(adapterInput(recovery.fetch, { reconcileOnly: true })),
    (error) => error?.code === 'instagram_image_ambiguous',
  );
  assert.equal(postCount(recovery.calls), 0);
});

test('unavailable or malformed initial history is an image review hold with no POST', async () => {
  const cases = [
    [new Error('network unavailable')],
    [{ notData: [] }],
    [{ data: [null] }],
    [{ data: [], paging: { next: 'https://untrusted.example/next' } }],
    [{ data: [], paging: { cursors: { after: 'bad cursor' } } }],
    [
      { data: [], paging: { cursors: { after: 'repeat' } } },
      { data: [], paging: { cursors: { after: 'repeat' } } },
    ],
  ];

  for (const pages of cases) {
    const fixture = pagedFixture({ pages });
    await assert.rejects(
      publishImageToInstagram(adapterInput(fixture.fetch)),
      (error) => error?.code === 'instagram_image_ambiguous',
    );
    assert.equal(postCount(fixture.calls), 0);
  }
});

test('a continuation at the five-page cap is unproven and cannot create', async () => {
  const pages = Array.from({ length: 5 }, (_, index) => ({
    data: [],
    paging: { cursors: { after: `cursor-${index + 1}` } },
  }));
  const fixture = pagedFixture({ pages });

  await assert.rejects(
    publishImageToInstagram(adapterInput(fixture.fetch)),
    (error) => error?.code === 'instagram_image_ambiguous',
  );
  assert.equal(fixture.calls.length, 5);
  assert.equal(postCount(fixture.calls), 0);
});

test('an ambiguous publish reconciles one exact receipt after checking all remaining pages', async () => {
  const fixture = pagedFixture({
    pages: [
      { data: [] },
      { data: [exactMedia], paging: { cursors: { after: 'remaining' } } },
      { data: [] },
    ],
    publishReply: new Error('response timeout'),
  });

  const result = await publishImageToInstagram(adapterInput(fixture.fetch));

  assert.equal(result.status, 'reconciled');
  assert.equal(result.id, exactMedia.id);
  assert.equal(fixture.calls.filter(({ url, options }) => (
    url.pathname.endsWith('/media_publish') && options.method === 'POST'
  )).length, 1);
});

test('a malformed successful publish response reconciles, while an unproven result never retries POST', async () => {
  const reconciled = pagedFixture({
    pages: [{ data: [] }, { data: [exactMedia] }],
    publishReply: {},
  });
  assert.equal((await publishImageToInstagram(adapterInput(reconciled.fetch))).id, exactMedia.id);

  const ambiguous = pagedFixture({
    pages: [{ data: [] }, { data: [] }],
    publishReply: {},
  });
  await assert.rejects(
    publishImageToInstagram(adapterInput(ambiguous.fetch)),
    (error) => error?.code === 'instagram_image_ambiguous',
  );
  assert.equal(ambiguous.calls.filter(({ url, options }) => (
    url.pathname.endsWith('/media_publish') && options.method === 'POST'
  )).length, 1);
});
