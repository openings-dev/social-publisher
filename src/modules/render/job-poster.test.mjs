import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstagramCardSvg, createSocialCardSvg } from './social-card.mjs';
import { createReelStageSvgs } from './reel-video.mjs';
import { createConceptPosterSvg } from '../preview/concept-posters.mjs';
import { PREVIEW_SAMPLES } from '../preview/sample-jobs.mjs';

const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>';
const job = PREVIEW_SAMPLES.find(sample => sample.key === 'hourly').job;

test('long salary amounts stay complete in narrow horizontal cards', () => {
  for (const direction of ['night', 'editorial']) {
    const svg = createSocialCardSvg({ ...job, salary: { currency: 'BRL', min: 7000, max: 12000, period: 'month' } }, { direction, wordmarkSvg });
    assert.ok(svg.includes('>R$7,000–R$12,000</text>'), direction);
  }
});

test('Story and Reel use the exact same approved composition in all colors', () => {
  for (const direction of ['night', 'editorial', 'lavender', 'peach']) {
    const options = { direction, wordmarkSvg };
    assert.ok(createConceptPosterSvg(job, { ...options, format: 'story' }) === createConceptPosterSvg(job, { ...options, format: 'reel' }), direction);
  }
});

test('production cards use approved colors, compact payload and no community eyebrow', () => {
  for (const [direction, background] of [['night', '#172624'], ['editorial', '#FFFEFA'], ['lavender', '#EEE8F8'], ['peach', '#FFE2D7']]) {
    for (const render of [createInstagramCardSvg, createSocialCardSvg]) {
      const svg = render(job, { direction, wordmarkSvg });
      assert.ok(svg.includes(`data-direction="${direction}"`), 'Production renderer has not adopted approved artwork');
      assert.ok(svg.includes(`fill="${background}"`));
      assert.ok(svg.includes(render === createSocialCardSvg ? '→ openings.dev' : '→ Link in bio'));
      assert.ok(!svg.includes('From ') && !svg.includes('Openings Fixtures'));
      assert.ok(!svg.includes('data:font/'), 'Font bytes must not inflate dispatch payload');
      assert.ok(svg.length < 16000);
    }
    const feed = createInstagramCardSvg(job, { direction, wordmarkSvg });
    const stages = createReelStageSvgs(feed);
    const story = createConceptPosterSvg(job, { direction, format: 'story', wordmarkSvg });
    assert.equal(stages.length, 4);
    for (const stage of stages) assert.equal(stage, story);
  }
});
