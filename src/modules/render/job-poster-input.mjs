import { createJobPosterSvg } from './job-poster.mjs';
import { createJobPosterSvg as createLegacyJobPosterSvg } from './job-poster-v4.mjs';
import { createJobPosterSvg as createRevisionTwoJobPosterSvg } from './job-poster-v6.mjs';
import { decodeArtworkModel } from './job-poster-model.mjs';

// Select only known canonical render revisions; historical queued SVGs stay valid.
export function decodeJobPosterInput(svg) {
  const root = typeof svg === 'string' ? /^<svg\b[^>]*>/u.exec(svg)?.[0] : null;
  if (!root) throw new Error('Missing artwork root');
  const revision = /\bdata-artwork-revision="([^"]*)"/u.exec(root)?.[1];
  if (revision !== undefined && !['2', '3'].includes(revision)) throw new Error('Unsupported artwork revision');
  const model = decodeArtworkModel(/\bdata-poster-model="([A-Za-z0-9+/]+={0,2})"/u.exec(root)?.[1]);
  const mark = /<image\b(?=[^>]*\bdata-instagram-wordmark="true")[^>]*\bhref="data:image\/svg\+xml;base64,([A-Za-z0-9+/]+={0,2})"/u.exec(svg)?.[1];
  if (!mark) throw new Error('Missing artwork wordmark');
  const wordmarkSvg = Buffer.from(mark, 'base64').toString('utf8');
  const render = revision === '3' ? createJobPosterSvg : revision === '2' ? createRevisionTwoJobPosterSvg : createLegacyJobPosterSvg;
  if (render(model, { format: 'feed', wordmarkSvg }) !== svg) throw new Error('Noncanonical artwork SVG');
  return { model, wordmarkSvg, render, revision: revision ?? '1' };
}
