import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInstagramCardSvg } from './social-card.mjs';
import { ARTWORK_ROTATION } from './job-poster-model.mjs';
import { PREVIEW_SAMPLES } from '../preview/sample-jobs.mjs';

test('soundtrack selection preserves legacy audio and rejects unsupported input', async () => {
  const { resolveReelSoundtrack } = await import('./soundtrack.mjs');
  assert.equal(await resolveReelSoundtrack('<svg data-social-poster-version="3"></svg>'), null);
  await assert.rejects(() => resolveReelSoundtrack('<svg data-social-poster-version="5"></svg>'), /supported poster/u);
  await assert.rejects(() => resolveReelSoundtrack('<svg data-social-poster-version="4"></svg>'));
});

test('licensed tracks alternate with the persisted artwork cycle and remain stable on retries', async () => {
  const module = await import('./reel-video.mjs');
  assert.equal(typeof module.resolveReelSoundtrack, 'function');
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>';
  const chosen = [];
  for (const direction of ARTWORK_ROTATION) {
    const svg = createInstagramCardSvg(PREVIEW_SAMPLES[0].job, { direction, wordmarkSvg });
    const first = await module.resolveReelSoundtrack(svg);
    const retry = await module.resolveReelSoundtrack(svg);
    assert.deepEqual(first, retry);
    assert.equal(first.license, 'CC0-1.0');
    assert.equal(first.durationSeconds, 9);
    const bytes = await readFile(first.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), first.sha256);
    chosen.push(first.id);
  }
  assert.deepEqual(chosen, ['funked-up', 'funky-house', 'funked-up', 'funky-house', 'funked-up', 'funky-house']);
});
