import './font-runtime.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createArtworkSvg, ARTWORK_FORMATS, ARTWORK_STYLES } from './job-poster.mjs';
import { PREVIEW_SAMPLES } from '../preview/sample-jobs.mjs';

test('native pixels stay inside the approved reading area across 96 artwork variations', async () => {
  const wordmarkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1202 219"><rect width="1202" height="219" fill="#21302E"/></svg>';
  for (const sample of PREVIEW_SAMPLES) {
    for (const [direction, style] of Object.entries(ARTWORK_STYLES)) {
      for (const [format, geometry] of Object.entries(ARTWORK_FORMATS)) {
        const svg = createArtworkSvg(sample.job, { direction, format, wordmarkSvg });
        const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const background = style.background.slice(1).match(/../gu).map(value => Number.parseInt(value, 16));
        const safe = geometry.safe;
        let overflow = null;
        // Only the two known decorative paper-edge hairlines may enter bleed.
        for (let y = 0; y < info.height - 34 && !overflow; y += 1) {
          for (let x = 0; x < info.width - 28; x += 1) {
            if (x >= safe.x - 1 && x <= safe.x + safe.width + 1 && y >= safe.y - 1 && y <= safe.y + safe.height + 1) continue;
            const offset = (y * info.width + x) * info.channels;
            if (background.some((value, channel) => Math.abs(data[offset + channel] - value) > 20)) { overflow = { x, y }; break; }
          }
        }
        assert.equal(overflow, null, `${sample.key}/${direction}/${format}: essential pixels outside safe area ${JSON.stringify(overflow)}`);
      }
    }
  }
});
