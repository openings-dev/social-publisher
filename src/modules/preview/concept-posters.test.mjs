import assert from 'node:assert/strict';
import test from 'node:test';
import * as concepts from './concept-posters.mjs';
import { PREVIEW_SAMPLES } from './sample-jobs.mjs';

const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>';

test('new artwork removes the community eyebrow in every layout and format', () => {
  for (const direction of ['editorial', 'night', 'lavender', 'peach']) {
    for (const format of ['feed', 'story', 'reel', 'link']) {
      const svg = concepts.createConceptPosterSvg(PREVIEW_SAMPLES[0].job, { direction, format, wordmarkSvg });
      assert.equal(/>From [^<]*</u.test(svg), false, `${direction}/${format}: community eyebrow remains`);
      assert.equal(svg.includes('Openings Fixtures'), false);
      assert.ok(svg.includes('View opening'));
    }
  }
});

test('editorial variants use the exact web palette and keep the mint action', () => {
  for (const [direction, color] of [['editorial', '#FFFEFA'], ['night', '#172624'], ['lavender', '#EEE8F8'], ['peach', '#FFE2D7']]) {
    const svg = concepts.createConceptPosterSvg(PREVIEW_SAMPLES[1].job, { direction, format: 'feed', wordmarkSvg });
    assert.ok(svg.includes(`<rect width="1080" height="1350" fill="${color}"/>`), direction);
    assert.ok(svg.includes('fill="#B0EC9C"'), `${direction}: mint action`);
    assert.ok(svg.includes('$60–$110'));
    assert.ok(svg.includes('per hour · USD'));
    assert.ok(svg.includes('data-safe="108,144,864,1062"'));
  }
});

test('preview proposes a repeatable dark/light cycle with three editorial colors', () => {
  assert.deepEqual(concepts.CONCEPT_ROTATION, ['night', 'editorial', 'night', 'lavender', 'night', 'peach']);
  assert.equal(Object.keys(concepts.CONCEPT_STYLES ?? {}).length, 4);
});

test('Story and Reel share the approved larger reading area', () => {
  assert.deepEqual(concepts.CONCEPT_FORMATS.story, {
    width: 1080, height: 1920, safe: { x: 108, y: 280, width: 864, height: 1256 },
  });
  assert.deepEqual(concepts.CONCEPT_FORMATS.reel, concepts.CONCEPT_FORMATS.story);
});

test('Story separates work model and location, and makes its action readable', () => {
  assert.ok(concepts.CONCEPT_FORMATS.story, 'Story format is missing');
  const job = PREVIEW_SAMPLES.find(sample => sample.key === 'hourly').job;
  for (const direction of Object.keys(concepts.CONCEPT_STYLES)) {
    const svg = concepts.createConceptPosterSvg(job, { direction, format: 'story', wordmarkSvg });
    assert.match(svg, /font-size="48"[^>]*>Remote<\/text>/u);
    assert.match(svg, /font-size="44"[^>]*>Brazil · South America<\/text>/u);
    assert.match(svg, /font-size="48"[^>]*>View opening<\/text>/u);
    assert.match(svg, /data-block="action"/u);
    assert.ok(svg.includes('$60–$110'));
    assert.ok(svg.includes('per hour · USD'));
    assert.equal(svg.includes('From '), false);
  }
});

test('Reel uses the approved Story typography', () => {
  const job = PREVIEW_SAMPLES.find(sample => sample.key === 'hourly').job;
  for (const direction of ['editorial', 'night']) {
    const svg = concepts.createConceptPosterSvg(job, { direction, format: 'reel', wordmarkSvg });
    assert.match(svg, /font-size="48"[^>]*>Remote<\/text>/u);
    assert.match(svg, /font-size="44"[^>]*>Brazil · South America<\/text>/u);
    assert.match(svg, /font-size="48"[^>]*>View opening<\/text>/u);
  }
});
