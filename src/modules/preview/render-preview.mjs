import '../render/font-runtime.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PREVIEW_SAMPLES } from './sample-jobs.mjs';
import { CONCEPT_FORMATS, CONCEPT_ROTATION, CONCEPT_STYLES, createConceptPosterSvg } from './concept-posters.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, '.tmp/social-preview');
const wordmarkSvg = await readFile(resolve(root, '../web/public/openings-wordmark-light.svg'), 'utf8');
await mkdir(output, { recursive: true });

for (const sample of PREVIEW_SAMPLES) {
  for (const direction of Object.keys(CONCEPT_STYLES)) {
    const directory = resolve(output, sample.key, direction);
    await mkdir(directory, { recursive: true });
    for (const format of Object.keys(CONCEPT_FORMATS)) {
      const svg = createConceptPosterSvg(sample.job, { direction, format, wordmarkSvg });
      await writeFile(resolve(directory, `${format}.svg`), svg);
      await sharp(Buffer.from(svg)).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toFile(resolve(directory, `${format}.jpg`));
    }
  }
}
await writeFile(resolve(output, 'manifest.json'), JSON.stringify({
  version: Date.now(), variants: Object.keys(CONCEPT_STYLES), formats: CONCEPT_FORMATS,
  styles: CONCEPT_STYLES,
  sequence: CONCEPT_ROTATION.map((variant, index) => ({ variant, sample: ['typescript', 'hourly', 'minimal', 'frontend', 'hourly', 'typescript'][index] })),
  samples: PREVIEW_SAMPLES.map(({ key, label, job }) => ({ key, label, title: job.title })),
}, null, 2));
console.log('Social preview images updated.');
