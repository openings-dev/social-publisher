import './font-runtime.mjs';
import sharp from 'sharp';
import { escapeHtml } from '../../shared/escape.mjs';
import { sha256 } from '../../shared/hash.mjs';
import { validateEditorialContent } from '../editorial/editorial-model.mjs';
import { fitPosterText } from './poster-typography.mjs';

const FEED = Object.freeze({ width: 1080, height: 1350 });
const STORY = Object.freeze({ width: 1080, height: 1920 });
export const EDITORIAL_RENDER_VERSION = '3';
const DECORATIVE_TITLES = new Set(['Do it today', 'Try this', 'A useful adjustment', 'Why it matters', 'Quick checklist']);
const THEMES = Object.freeze([
  { id: 'night', background: '#172624', ink: '#F2F4F1' },
  { id: 'editorial', background: '#FFFEFA', ink: '#21302E' },
  { id: 'lavender', background: '#EEE8F8', ink: '#21302E' },
  { id: 'peach', background: '#FFE2D7', ink: '#21302E' },
].map(Object.freeze));

export function resolveEditorialTheme(contentId) {
  if (typeof contentId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(contentId)) throw new Error('Editorial content ID is invalid');
  return THEMES[Number.parseInt(sha256(contentId).slice(0, 2), 16) % THEMES.length];
}

function wordmark(wordmarkSvg, theme, story) {
  if (typeof wordmarkSvg !== 'string' || !/^\s*<svg\b/iu.test(wordmarkSvg)
    || /<!DOCTYPE|<!ENTITY|<(?:script|foreignObject)\b|\bon[a-z]+\s*=|(?:href|src)\s*=|@import|url\(/iu.test(wordmarkSvg)) throw new Error('A trusted canonical SVG wordmark is required');
  const svg = theme.id === 'night' ? wordmarkSvg.replace(/#21302e/giu, theme.ink) : wordmarkSvg;
  return `<image data-editorial-wordmark="true" x="108" y="${story ? 304 : 160}" width="320" height="${320 * 219 / 1202}" preserveAspectRatio="xMinYMid meet" href="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"/>`;
}

// Figtree glyphs can overhang their advance box; inset ink from the guide edge.
function text(value, { y, height, size = 38, minimum = 28, weight = 450, theme, width = 848, x = 116 }) {
  const sizes = Array.from({ length: Math.floor((size - minimum) / 2) + 1 }, (_, index) => size - index * 2);
  const layout = fitPosterText(value, { sizes, maxWidth: width, maxHeight: height, maxLines: 30 });
  if (!layout || layout.truncated) throw new Error('Editorial text exceeds its reading guide');
  return layout.lines.map((line, index) => `<text x="${x}" y="${y + layout.fontSize + index * layout.lineHeight}" fill="${theme.ink}" font-family="Figtree, Arial, sans-serif" font-size="${layout.fontSize}" font-weight="${weight}">${escapeHtml(line)}</text>`).join('');
}

function cta(theme, story, pillar) {
  const label = story || pillar === 'linkedin' ? '→ Compartilhe esta dica' : '→ Salve para revisar';
  return `<g data-editorial-cta="true">${text(label, { y: story ? 1460 : 1130, height: 54, size: 32, minimum: 32, theme, weight: 600 })}</g>`;
}

function slideBody(slide, theme, pillar) {
  const hasTitle = !DECORATIVE_TITLES.has(slide.title);
  const title = hasTitle ? text(slide.title, { y: 300, height: 276, size: slide.kind === 'cover' || slide.kind === 'cta' ? 72 : 60, minimum: 44, weight: 700, theme }) : '';
  if (slide.kind === 'example') {
    return `${title}${text('BEFORE', { y: 620, height: 30, size: 22, minimum: 22, weight: 650, theme })}
      ${text(slide.before, { y: 668, height: 186, size: 34, theme })}
      ${text('AFTER', { y: 904, height: 30, size: 22, minimum: 22, weight: 650, theme })}
      ${text(slide.after, { y: 952, height: 232, size: 34, theme })}`;
  }
  if (slide.kind === 'checklist') {
    return title + slide.items.map((item, index) => text(item, { y: (hasTitle ? 620 : 380) + index * (hasTitle ? 144 : 180), height: hasTitle ? 124 : 154, size: 38, minimum: 28, theme })).join('');
  }
  return `${title}${text(slide.body, { y: hasTitle ? 646 : 380, height: slide.kind === 'cta' ? (hasTitle ? 410 : 650) : 514, size: hasTitle ? 40 : 48, minimum: 30, theme })}${slide.kind === 'cta' ? cta(theme, false, pillar) : ''}`;
}

function canvas(content, { theme, story = false, index, body, wordmarkSvg }) {
  const dimensions = story ? STORY : FEED;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}" data-editorial-render-version="${EDITORIAL_RENDER_VERSION}" ${story ? 'data-editorial-story="true"' : `data-editorial-slide="${index + 1}"`} data-content-id="${escapeHtml(content.id)}" data-theme="${theme.id}">
    <rect width="${dimensions.width}" height="${dimensions.height}" fill="${theme.background}"/>
    <g data-essential="true" data-reading-guide="${story ? '108 280 864 1256' : '108 144 864 1062'}">${wordmark(wordmarkSvg, theme, story)}${body}</g>
  </svg>`;
}

export function createEditorialSlideSvg(content, slideIndex, { wordmarkSvg }) {
  validateEditorialContent(content);
  if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= content.slides.length) throw new Error('Editorial slide index is invalid');
  const theme = resolveEditorialTheme(content.id);
  return canvas(content, { theme, index: slideIndex, wordmarkSvg, body: slideBody(content.slides[slideIndex], theme, content.pillar) });
}

export function createEditorialStorySvg(content, { wordmarkSvg }) {
  validateEditorialContent(content);
  const theme = resolveEditorialTheme(content.id);
  const body = `${text(content.story.title, { y: 540, height: 400, size: 76, minimum: 48, weight: 700, theme })}
    ${text(content.story.body, { y: 1000, height: 330, size: 42, minimum: 32, theme })}${cta(theme, true, content.pillar)}`;
  return canvas(content, { theme, story: true, wordmarkSvg, body });
}

async function jpeg(svg, dimensions) {
  const buffer = await sharp(Buffer.from(svg)).flatten({ background: '#FFFEFA' }).jpeg({ quality: 86, chromaSubsampling: '4:4:4' }).toBuffer();
  const metadata = await sharp(buffer).metadata();
  if (metadata.format !== 'jpeg' || metadata.width !== dimensions.width || metadata.height !== dimensions.height) throw new Error('Rendered editorial asset has invalid JPEG dimensions');
  if (buffer.byteLength >= 4 * 1024 * 1024) throw new Error('Rendered editorial asset exceeds 4 MB');
  return buffer;
}

export async function renderEditorialAssets(content, { wordmarkSvg }) {
  validateEditorialContent(content);
  const slides = await Promise.all(content.slides.map((_, index) => jpeg(createEditorialSlideSvg(content, index, { wordmarkSvg }), FEED)));
  const story = await jpeg(createEditorialStorySvg(content, { wordmarkSvg }), STORY);
  return Object.freeze({ slides: Object.freeze(slides), story });
}
