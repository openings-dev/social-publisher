import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtworkSvg, ARTWORK_STYLES, ARTWORK_FORMATS } from './job-poster.mjs';
import { PREVIEW_SAMPLES } from '../preview/sample-jobs.mjs';
import { createArtworkSvg as legacyArtwork } from './job-poster-v4.mjs';
import { createArtworkSvg as revisionTwoArtwork } from './job-poster-v6.mjs';
import { decodeJobPosterInput } from './job-poster-input.mjs';
import { createReelStageSvgs } from './reel-video.mjs';

test('English revision preserves layout and canonical revision-two jobs', () => {
  const wordmarkSvg = '<svg viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>';
  for (const direction of Object.keys(ARTWORK_STYLES)) {
    for (const format of Object.keys(ARTWORK_FORMATS)) {
      const options = { direction, format, wordmarkSvg };
      const historical = revisionTwoArtwork(PREVIEW_SAMPLES[0].job, options);
      const current = createArtworkSvg(PREVIEW_SAMPLES[0].job, options);
      assert.equal(current, historical.replaceAll('→ Link na bio', '→ Link in bio').replace('data-artwork-revision="2"', 'data-artwork-revision="3"'));
      if (format === 'feed') {
        assert.equal(decodeJobPosterInput(historical).revision, '2');
        assert.equal(decodeJobPosterInput(current).revision, '3');
        const story = revisionTwoArtwork(PREVIEW_SAMPLES[0].job, { ...options, format: 'story' });
        assert.deepEqual(createReelStageSvgs(historical), [story, story, story, story]);
        assert.throws(() => decodeJobPosterInput(historical.replaceAll('→ Link na bio', '→ Link in bio')), /Noncanonical/u);
        assert.throws(() => decodeJobPosterInput(current.replaceAll('→ Link in bio', '→ Link na bio')), /Noncanonical/u);
      }
    }
  }
});

test('historical artwork keeps its exact Reel composition and unknown revisions fail', () => {
  const options = { direction: 'night', wordmarkSvg: '<svg viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>' };
  const feed = legacyArtwork(PREVIEW_SAMPLES[0].job, { ...options, format: 'feed' });
  const story = legacyArtwork(PREVIEW_SAMPLES[0].job, { ...options, format: 'story' });
  assert.deepEqual(createReelStageSvgs(feed), [story, story, story, story]);
  const current = createArtworkSvg(PREVIEW_SAMPLES[0].job, { ...options, format: 'feed' });
  assert.throws(() => createReelStageSvgs(current.replace(/data-artwork-revision="\d+"/u, 'data-artwork-revision="99"')), /revision/u);
});

test('all job formats use one plain destination-appropriate CTA without a button', () => {
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>';
  for (const direction of Object.keys(ARTWORK_STYLES)) {
    for (const format of Object.keys(ARTWORK_FORMATS)) {
      const svg = createArtworkSvg(PREVIEW_SAMPLES[0].job, { direction, format, wordmarkSvg });
      assert.ok(svg.includes(format === 'link' ? '→ openings.dev' : '→ Link in bio'));
      assert.ok(svg.includes('data-artwork-revision="3"'));
      const actions = [...svg.matchAll(/<g data-block="action">([\s\S]*?)<\/g>/gu)];
      assert.equal(actions.length, 1);
      assert.doesNotMatch(actions[0][1], /<(?:rect|path|circle)\b/u);
      assert.doesNotMatch(svg, /View opening/u);
    }
  }
});
