import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtworkSvg, ARTWORK_STYLES, ARTWORK_FORMATS } from './job-poster.mjs';
import { PREVIEW_SAMPLES } from '../preview/sample-jobs.mjs';
import { createArtworkSvg as legacyArtwork } from './job-poster-v4.mjs';
import { createReelStageSvgs } from './reel-video.mjs';

test('historical artwork keeps its exact Reel composition and unknown revisions fail', () => {
  const options = { direction: 'night', wordmarkSvg: '<svg viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>' };
  const feed = legacyArtwork(PREVIEW_SAMPLES[0].job, { ...options, format: 'feed' });
  const story = legacyArtwork(PREVIEW_SAMPLES[0].job, { ...options, format: 'story' });
  assert.deepEqual(createReelStageSvgs(feed), [story, story, story, story]);
  const current = createArtworkSvg(PREVIEW_SAMPLES[0].job, { ...options, format: 'feed' });
  assert.throws(() => createReelStageSvgs(current.replace('data-artwork-revision="2"', 'data-artwork-revision="99"')), /revision/u);
});

test('all job formats use one plain destination-appropriate CTA without a button', () => {
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>';
  for (const direction of Object.keys(ARTWORK_STYLES)) {
    for (const format of Object.keys(ARTWORK_FORMATS)) {
      const svg = createArtworkSvg(PREVIEW_SAMPLES[0].job, { direction, format, wordmarkSvg });
      assert.ok(svg.includes(format === 'link' ? '→ openings.dev' : '→ Link na bio'));
      const actions = [...svg.matchAll(/<g data-block="action">([\s\S]*?)<\/g>/gu)];
      assert.equal(actions.length, 1);
      assert.doesNotMatch(actions[0][1], /<(?:rect|path|circle)\b/u);
      assert.doesNotMatch(svg, /View opening/u);
    }
  }
});
