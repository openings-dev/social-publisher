import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSocialJob, resolveSocialTitle } from './social-title.mjs';
import { PREVIEW_SAMPLES } from '../preview/sample-jobs.mjs';
import { createArtworkModel } from './job-poster-model.mjs';
import { formatSocialPost } from './format-job.mjs';
import { createBridgeHtml } from './html-page.mjs';
import { readFile } from 'node:fs/promises';

const job = (title, extra = {}) => ({ ...PREVIEW_SAMPLES[0].job, title, ...extra });

test('normalizes only explicit role, seniority and technology, without changing source data', () => {
  for (const [source, expected, extra] of [
    ['[Remoto] Desenvolvedor Backend Sênior Java — Empresa X', 'Senior Backend Developer · Java', { companyName: 'Empresa X' }],
    ['バックエンドエンジニア募集', 'Backend Engineer'],
    ['シニアソフトウェアエンジニア', 'Senior Software Engineer'],
    ['Senior Software Engineer', 'Senior Software Engineer'],
    ['Product Designer', 'Product Designer'],
    ['Desenvolvedor Full Stack Pleno (React, Node.js)', 'Mid-level Full-stack Developer · React / Node.js'],
    ['[Remote] Senior Backend Engineer - C# / .NET', 'Senior Backend Engineer · C# / .NET'],
  ]) {
    const original = Object.freeze(job(source, extra));
    const prepared = prepareSocialJob(original);
    assert.equal(prepared.socialTitle, expected);
    assert.equal(prepared.title, source);
    assert.equal(original.socialTitle, undefined);
    assert.equal(createArtworkModel(prepared).title, expected);
    assert.equal(formatSocialPost(prepared).title, expected);
  }
});

test('holds unknown words and qualifications instead of guessing or inferring from tags', () => {
  for (const title of ['未知の役職', 'Software Engineer Japanese required', 'Senior Junior Engineer',
    'Engineer or Manager', 'Backend Engineer unpaid internship', 'Développeur mystérieux',
    'Software Engineer 6+ years', 'Principal Backend Engineer - JAVA - HCM Hybrid']) {
    assert.equal(resolveSocialTitle(job(title)).status, 'review_required', title);
    assert.throws(() => prepareSocialJob(job(title)), /review/u);
  }
  assert.equal(prepareSocialJob(job('Software Engineer', { tags: ['Senior', 'Java'] })).socialTitle, 'Software Engineer');
});

test('reviewed overrides apply only to the exact job, source title and revision', () => {
  const source = job('未知の役職');
  const review = { jobId: source.id, contentHash: source.contentHash, sourceTitle: source.title, title: 'Software Engineer' };
  assert.equal(resolveSocialTitle(source, [review]).title, 'Software Engineer');
  for (const change of [{ contentHash: 'c'.repeat(64) }, { title: '変更した役職' }, { id: 'gh_' + 'f'.repeat(24) }]) {
    assert.equal(resolveSocialTitle({ ...source, ...change }, [review]).status, 'review_required');
  }
});

test('website keeps the source title and production CLI enables normalization', async () => {
  const prepared = prepareSocialJob(job('バックエンドエンジニア募集'));
  const html = createBridgeHtml(prepared, { imageHash: 'a'.repeat(64) });
  assert.ok(html.includes(`<h1>${prepared.title}</h1>`));
  assert.ok(!html.includes('<h1>Backend Engineer</h1>'));
  const cli = await readFile(new URL('../../cli/publish.mjs', import.meta.url), 'utf8');
  assert.match(cli, /preparePublicationJob: prepareSocialJob/u);
});
