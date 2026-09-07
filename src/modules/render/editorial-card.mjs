import './font-runtime.mjs';
import sharp from 'sharp';
import { escapeHtml } from '../../shared/escape.mjs';
import { sha256 } from '../../shared/hash.mjs';
import { validateEditorialContent } from '../editorial/editorial-model.mjs';
import { fitPosterText, textWidth } from './poster-typography.mjs';

const FEED = Object.freeze({ width: 1080, height: 1350 });
const STORY = Object.freeze({ width: 1080, height: 1920 });
export const EDITORIAL_RENDER_VERSION = '5';
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

function wordmark(wordmarkSvg, theme, y, alignment) {
  if (typeof wordmarkSvg !== 'string' || !/^\s*<svg\b/iu.test(wordmarkSvg)
    || /<!DOCTYPE|<!ENTITY|<(?:script|foreignObject)\b|\bon[a-z]+\s*=|(?:href|src)\s*=|@import|url\(/iu.test(wordmarkSvg)) throw new Error('A trusted canonical SVG wordmark is required');
  const svg = theme.id === 'night' ? wordmarkSvg.replace(/#21302e/giu, theme.ink) : wordmarkSvg;
  return `<image data-editorial-wordmark="true" x="${alignment === 'center' ? 365 : 124}" y="${y}" width="350" height="${350 * 219 / 1202}" preserveAspectRatio="xMinYMid meet" href="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"/>`;
}

function ctaLabel(story, pillar) {
  return story || pillar === 'linkedin' ? 'Share this tip →' : 'Save for later →';
}

function slideBlocks(slide, pillar, short) {
  const blocks = [];
  if (!DECORATIVE_TITLES.has(slide.title)) blocks.push({ value: slide.title, size: 96, minimum: 64, weight: 550, gap: 64, title: true, accent: short && slide.kind === 'cover' });
  if (slide.kind === 'example') {
    blocks.push({ value: 'BEFORE', size: 24, gap: 40 }, { value: slide.before, size: 46, gap: 16 });
    blocks.push({ value: 'AFTER', size: 24, gap: 40 }, { value: slide.after, size: 46, gap: 16 });
  } else if (slide.kind === 'checklist') {
    blocks.push(...slide.items.map(value => ({ value, size: 46, gap: 32 })));
  } else {
    blocks.push({ value: slide.body, size: blocks.length ? 46 : 56, gap: blocks.length ? 40 : 64 });
  }
  if (slide.kind === 'cta') blocks.push({ value: short ? 'Save for your next portfolio update →' : ctaLabel(false, pillar), size: 34, gap: 52, cta: true });
  return blocks;
}

function stack(blocks, { theme, story, alignment, wordmarkSvg }) {
  const guideTop = story ? 280 : 144;
  const guideHeight = story ? 1256 : 1062;
  const logoHeight = 350 * 219 / 1202;
  let measured, height;
  for (let reduction = 0; reduction <= 40; reduction += 2) {
    measured = blocks.map(block => {
      const minimum = block.minimum ?? Math.min(block.size, 38);
      let size = Math.max(minimum, block.size - reduction);
      while (size > minimum && block.value.split(/\s+/u).some(word => textWidth(word, size) > 810)) size -= 2;
      if (block.value.split(/\s+/u).some(word => textWidth(word, size) > 810)) throw new Error('Editorial word exceeds its reading guide');
      const parts = block.value.split('\n').map(value => fitPosterText(value, { sizes: [size], maxWidth: 810, maxLines: 30 }));
      // Authored line breaks are reviewed at native size; preserve their composition.
      const fit = { ...parts[0], lines: block.value.includes('\n') ? block.value.split('\n') : parts.flatMap(part => part.lines), truncated: parts.some(part => part.truncated), lineHeight: Math.round(size * (block.title ? 1.06 : 1.3)) };
      if (fit.truncated) throw new Error('Editorial text exceeds its reading guide');
      return { ...block, fit, height: size + (fit.lines.length - 1) * fit.lineHeight };
    });
    height = logoHeight + measured.reduce((sum, block) => sum + block.gap + block.height, 0);
    if (height <= guideHeight - 32) break;
  }
  if (height > guideHeight - 32) throw new Error('Editorial text exceeds its reading guide');
  const top = guideTop + (guideHeight - height) / 2;
  let y = top + logoHeight;
  const body = measured.map(block => {
    y += block.gap;
    // Approximate Figtree's cap-height baseline; leave descent space in each block.
    const baseline = y + block.fit.fontSize * 0.8;
    const text = block.fit.lines.map((line, index) => {
      const color = block.accent && index === block.fit.lines.length - 1 ? (theme.id === 'night' ? '#B0EC9C' : '#2F6B3A')
        : block.title || block.cta ? theme.ink : theme.id === 'night' ? '#B7BFBB' : '#5E6663';
      return `<text x="${alignment === 'center' ? 540 : 132}" y="${baseline + index * block.fit.lineHeight}" fill="${color}" font-family="Figtree, Arial, sans-serif" font-size="${block.fit.fontSize}" font-weight="${block.weight ?? 400}" letter-spacing="${block.title ? -1.6 : 0}" text-anchor="${alignment === 'center' ? 'middle' : 'start'}">${escapeHtml(line)}</text>`;
    }).join('');
    y += block.height;
    return block.cta ? `<g data-editorial-cta="true">${text}</g>` : text;
  }).join('');
  return `<g data-group-top="${top}" data-group-height="${height}">${wordmark(wordmarkSvg, theme, top, alignment)}${body}</g>`;
}

function resolveAlignment(alignment, theme) {
  const resolved = alignment ?? 'left';
  if (!['center', 'left'].includes(resolved)) throw new Error('Editorial alignment is invalid');
  return resolved;
}

function canvas(content, { theme, story = false, index, blocks, wordmarkSvg, alignment }) {
  const dimensions = story ? STORY : FEED;
  const resolved = resolveAlignment(alignment, theme);
  const body = stack(blocks, { theme, story, wordmarkSvg, alignment: resolved });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}" data-editorial-render-version="${EDITORIAL_RENDER_VERSION}" ${story ? 'data-editorial-story="true"' : `data-editorial-slide="${index + 1}"`} data-content-id="${escapeHtml(content.id)}" data-theme="${theme.id}" data-alignment="${resolved}">
    <rect width="${dimensions.width}" height="${dimensions.height}" fill="${theme.background}"/>
    <g data-essential="true" data-reading-guide="${story ? '108 280 864 1256' : '108 144 864 1062'}">${body}</g>
  </svg>`;
}

export function createEditorialSlideSvg(content, slideIndex, { wordmarkSvg, alignment }) {
  validateEditorialContent(content);
  if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= content.slides.length) throw new Error('Editorial slide index is invalid');
  const short = content.layout === 'short-guide';
  const theme = short ? THEMES[[0, 1, 1, 2, 1, 1, 0][slideIndex]] : resolveEditorialTheme(content.id);
  return canvas(content, { theme, index: slideIndex, wordmarkSvg, alignment, blocks: slideBlocks(content.slides[slideIndex], content.pillar, short) });
}

export function createEditorialStorySvg(content, { wordmarkSvg, alignment }) {
  validateEditorialContent(content);
  const theme = content.layout === 'short-guide' ? THEMES[0] : resolveEditorialTheme(content.id);
  const blocks = [{ value: content.story.title, size: 96, minimum: 64, weight: 550, gap: 64, title: true, accent: content.layout === 'short-guide' },
    { value: content.story.body, size: 46, gap: 40 },
    { value: ctaLabel(true, content.pillar), size: 34, gap: 52, cta: true }];
  return canvas(content, { theme, story: true, wordmarkSvg, alignment, blocks });
}

async function jpeg(svg, dimensions) {
  const buffer = await sharp(Buffer.from(svg)).flatten({ background: '#FFFEFA' }).jpeg({ quality: 86, chromaSubsampling: '4:4:4' }).toBuffer();
  const metadata = await sharp(buffer).metadata();
  if (metadata.format !== 'jpeg' || metadata.width !== dimensions.width || metadata.height !== dimensions.height) throw new Error('Rendered editorial asset has invalid JPEG dimensions');
  if (buffer.byteLength >= 4 * 1024 * 1024) throw new Error('Rendered editorial asset exceeds 4 MB');
  return buffer;
}

export async function renderEditorialAssets(content, { wordmarkSvg, alignment }) {
  validateEditorialContent(content);
  const slides = await Promise.all(content.slides.map((_, index) => jpeg(createEditorialSlideSvg(content, index, { wordmarkSvg, alignment }), FEED)));
  const story = await jpeg(createEditorialStorySvg(content, { wordmarkSvg, alignment }), STORY);
  return Object.freeze({ slides: Object.freeze(slides), story });
}
