import sharp from 'sharp';

import { escapeHtml } from '../../shared/escape.mjs';
import { sha256 } from '../../shared/hash.mjs';
import { validateEditorialContent } from '../editorial/editorial-model.mjs';
import { createCjkFontStyle, SOCIAL_CARD_FONT_STACK } from './cjk-fonts.mjs';
import { SOCIAL_CARD_COLORS } from './social-card.mjs';
import { SOCIAL_THEMES } from './social-theme.mjs';

const FEED = Object.freeze({ width: 1080, height: 1350 });
const STORY = Object.freeze({ width: 1080, height: 1920 });
const PILLAR_LABEL = Object.freeze({
  linkedin: 'LINKEDIN', resume: 'RESUME', search: 'JOB SEARCH',
  application: 'APPLICATION', interview: 'INTERVIEW',
});
const segmenter = new Intl.Segmenter('en-US', { granularity: 'grapheme' });

function assertWordmark(value) {
  if (typeof value !== 'string' || !/^\s*<svg\b/iu.test(value)) throw new Error('A canonical SVG wordmark is required');
  if (/<(?:script|foreignObject)\b|(?:href|src)\s*=\s*["']https?:/iu.test(value)) {
    throw new Error('The SVG wordmark contains unsupported external content');
  }
  return value;
}
export function resolveEditorialTheme(contentId) {
  if (typeof contentId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(contentId)) {
    throw new Error('Editorial content ID is invalid');
  }
  return SOCIAL_THEMES[Number.parseInt(sha256(contentId).slice(0, 8), 16) % SOCIAL_THEMES.length];
}

function glyphWidth(character, size) {
  if (/\s/u.test(character)) return size * 0.3;
  if (/[A-Z0-9]/u.test(character)) return size * 0.62;
  if (/[a-zà-ÿ]/iu.test(character)) return size * 0.53;
  if (/[,.;:!?"'()[\]{}\-/]/u.test(character)) return size * 0.32;
  return size * 0.85;
}

function wrap(value, { size, width, lines }) {
  const words = String(value).trim().split(/\s+/u);
  const output = [];
  let current = '';
  let currentWidth = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const wordWidth = [...segmenter.segment(word)].reduce((sum, item) => sum + glyphWidth(item.segment, size), 0);
    const spaceWidth = current ? glyphWidth(' ', size) : 0;
    if (current && currentWidth + spaceWidth + wordWidth > width) {
      output.push(current);
      current = '';
      currentWidth = 0;
      if (output.length === lines) break;
    }
    current += `${current ? ' ' : ''}${word}`;
    currentWidth += spaceWidth + wordWidth;
  }
  if (current && output.length < lines) output.push(current);
  if (output.join(' ').length < String(value).trim().length && output.length > 0) {
    output[output.length - 1] = `${output[output.length - 1].replace(/[\s,.;:!?-]+$/u, '')}…`;
  }
  return output;
}

function linesMarkup(lines, { x, y, size, height, weight = 700, fill = SOCIAL_CARD_COLORS.ink, anchor = 'start' }) {
  return lines.map((line, index) => `<text x="${x}" y="${y + index * height}" text-anchor="${anchor}" fill="${fill}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="${size}" font-weight="${weight}">${escapeHtml(line)}</text>`).join('');
}

function wordmarkData(wordmarkSvg) {
  return Buffer.from(assertWordmark(wordmarkSvg)).toString('base64');
}

function sharedDefinitions(content) {
  return `<defs>${createCjkFontStyle(JSON.stringify(content))}<filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="16" stdDeviation="22" flood-color="${SOCIAL_CARD_COLORS.ink}" flood-opacity="0.09"/></filter></defs>`;
}

function header(content, theme, mark, slideNumber) {
  return `<image x="58" y="58" width="238" height="44" preserveAspectRatio="xMinYMid meet" href="data:image/svg+xml;base64,${mark}"/>
    <rect x="836" y="56" width="186" height="48" rx="24" fill="${theme.soft}"/>
    <text x="929" y="87" text-anchor="middle" fill="${SOCIAL_CARD_COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="14" font-weight="850" letter-spacing="1">${escapeHtml(PILLAR_LABEL[content.pillar])}</text>
    <text x="58" y="1290" fill="${SOCIAL_CARD_COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="15" font-weight="750">@openingshq</text>
    <text x="1022" y="1290" text-anchor="end" fill="${SOCIAL_CARD_COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="15" font-weight="750">${slideNumber} / 7</text>`;
}

function standardBody(slide, theme, slideIndex) {
  const titleSize = slide.title.length > 58 ? 49 : 57;
  const titleLines = wrap(slide.title, { size: titleSize, width: 870, lines: 3 });
  const bodyLines = wrap(slide.body, { size: 31, width: 820, lines: 7 });
  return `<text x="58" y="225" fill="${theme.accent}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="104" font-weight="900">0${slideIndex + 1}</text>
    ${linesMarkup(titleLines, { x: 58, y: 365, size: titleSize, height: 61, weight: 850 })}
    <rect x="58" y="610" width="964" height="478" rx="34" fill="${SOCIAL_CARD_COLORS.surfaceMuted}"/>
    <rect x="58" y="610" width="18" height="478" rx="9" fill="${theme.accent}"/>
    ${linesMarkup(bodyLines, { x: 112, y: 700, size: 31, height: 48, weight: 520 })}`;
}

function coverBody(content, slide, theme) {
  const titleSize = slide.title.length > 62 ? 58 : 68;
  const titleLines = wrap(slide.title, { size: titleSize, width: 900, lines: 5 });
  const titleY = 355;
  const bottom = titleY + (titleLines.length - 1) * Math.round(titleSize * 1.05);
  const bodyLines = wrap(slide.body, { size: 29, width: 760, lines: 4 });
  return `<circle cx="930" cy="270" r="162" fill="${theme.soft}"/>
    <circle cx="976" cy="224" r="92" fill="${theme.accent}"/>
    <text x="58" y="235" fill="${SOCIAL_CARD_COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="17" font-weight="850" letter-spacing="2">PRACTICAL GUIDE · ${escapeHtml(PILLAR_LABEL[content.pillar])}</text>
    ${linesMarkup(titleLines, { x: 58, y: titleY, size: titleSize, height: Math.round(titleSize * 1.05), weight: 880 })}
    <line x1="58" y1="${bottom + 58}" x2="350" y2="${bottom + 58}" stroke="${theme.accent}" stroke-width="12" stroke-linecap="round"/>
    ${linesMarkup(bodyLines, { x: 58, y: bottom + 132, size: 29, height: 43, weight: 520, fill: SOCIAL_CARD_COLORS.mutedInk })}
    <rect x="58" y="1138" width="270" height="68" rx="34" fill="${SOCIAL_CARD_COLORS.ink}"/>
    <text x="193" y="1181" text-anchor="middle" fill="${SOCIAL_CARD_COLORS.paper}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="17" font-weight="850">SWIPE TO APPLY →</text>`;
}

function exampleBody(slide, theme) {
  const titleLines = wrap(slide.title, { size: 57, width: 870, lines: 2 });
  const beforeLines = wrap(slide.before, { size: 28, width: 392, lines: 6 });
  const afterLines = wrap(slide.after, { size: 28, width: 392, lines: 6 });
  const panel = (x, label, lines, fill, lineColor) => `<rect x="${x}" y="455" width="454" height="600" rx="34" fill="${fill}"/>
    <text x="${x + 42}" y="520" fill="${lineColor}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="15" font-weight="900" letter-spacing="2">${label}</text>
    <line x1="${x + 42}" y1="550" x2="${x + 412}" y2="550" stroke="${lineColor}" stroke-opacity="0.45"/>
    ${linesMarkup(lines, { x: x + 42, y: 630, size: 28, height: 45, weight: 680 })}`;
  return `<text x="58" y="225" fill="${theme.accent}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="104" font-weight="900">04</text>
    ${linesMarkup(titleLines, { x: 58, y: 365, size: 57, height: 61, weight: 850 })}
    ${panel(58, 'BEFORE', beforeLines, '#f5ece8', '#a34f42')}
    ${panel(568, 'AFTER', afterLines, theme.soft, '#315d35')}`;
}

function checklistBody(slide, theme) {
  const titleLines = wrap(slide.title, { size: 57, width: 870, lines: 2 });
  const items = slide.items.map((item, index) => {
    const x = index % 2 === 0 ? 58 : 552;
    const y = index < 2 ? 470 : 750;
    const itemLines = wrap(item, { size: 28, width: 350, lines: 3 });
    return `<rect x="${x}" y="${y}" width="470" height="236" rx="30" fill="${index === 3 ? theme.soft : SOCIAL_CARD_COLORS.surfaceMuted}"/>
      <circle cx="${x + 53}" cy="${y + 56}" r="25" fill="${theme.accent}"/>
      <path d="M${x + 42} ${y + 56}l8 8 15-18" fill="none" stroke="${SOCIAL_CARD_COLORS.ink}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      ${linesMarkup(itemLines, { x: x + 36, y: y + 126, size: 28, height: 39, weight: 760 })}`;
  }).join('');
  return `<text x="58" y="225" fill="${theme.accent}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="104" font-weight="900">06</text>
    ${linesMarkup(titleLines, { x: 58, y: 365, size: 57, height: 61, weight: 850 })}${items}`;
}

function ctaBody(slide, theme) {
  const titleLines = wrap(slide.title, { size: 68, width: 860, lines: 3 });
  const bodyLines = wrap(slide.body, { size: 34, width: 760, lines: 6 });
  return `<rect x="58" y="210" width="964" height="886" rx="44" fill="${theme.soft}"/>
    <circle cx="890" cy="350" r="190" fill="${theme.accent}"/>
    <text x="110" y="305" fill="${SOCIAL_CARD_COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="16" font-weight="850" letter-spacing="2">YOUR NEXT STEP</text>
    ${linesMarkup(titleLines, { x: 110, y: 420, size: 68, height: 72, weight: 900 })}
    ${linesMarkup(bodyLines, { x: 110, y: 700, size: 34, height: 51, weight: 550 })}
    <rect x="110" y="970" width="360" height="76" rx="38" fill="${SOCIAL_CARD_COLORS.ink}"/>
    <text x="290" y="1017" text-anchor="middle" fill="${SOCIAL_CARD_COLORS.paper}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="18" font-weight="850">SAVE AND TRY IT</text>`;
}

export function createEditorialSlideSvg(content, slideIndex, { wordmarkSvg }) {
  validateEditorialContent(content);
  if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= content.slides.length) {
    throw new Error('Editorial slide index is invalid');
  }
  const slide = content.slides[slideIndex];
  const theme = resolveEditorialTheme(content.id);
  const mark = wordmarkData(wordmarkSvg);
  let body;
  if (slide.kind === 'cover') body = coverBody(content, slide, theme);
  else if (slide.kind === 'example') body = exampleBody(slide, theme);
  else if (slide.kind === 'checklist') body = checklistBody(slide, theme);
  else if (slide.kind === 'cta') body = ctaBody(slide, theme);
  else body = standardBody(slide, theme, slideIndex);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FEED.width}" height="${FEED.height}" viewBox="0 0 ${FEED.width} ${FEED.height}" data-editorial-slide="${slideIndex + 1}" data-content-id="${escapeHtml(content.id)}" data-theme="${theme.id}">
    ${sharedDefinitions(content)}<rect width="1080" height="1350" fill="${SOCIAL_CARD_COLORS.paper}"/>
    <rect x="0" y="0" width="18" height="1350" fill="${theme.accent}"/>${header(content, theme, mark, slideIndex + 1)}${body}
  </svg>`;
}

export function createEditorialStorySvg(content, { wordmarkSvg }) {
  validateEditorialContent(content);
  const theme = resolveEditorialTheme(content.id);
  const mark = wordmarkData(wordmarkSvg);
  const titleSize = content.story.title.length > 62 ? 62 : 72;
  const title = wrap(content.story.title, { size: titleSize, width: 860, lines: 5 });
  const body = wrap(content.story.body, { size: 32, width: 760, lines: 5 });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${STORY.width}" height="${STORY.height}" viewBox="0 0 ${STORY.width} ${STORY.height}" data-editorial-story="true" data-content-id="${escapeHtml(content.id)}" data-theme="${theme.id}">
    ${sharedDefinitions(content)}<rect width="1080" height="1920" fill="${SOCIAL_CARD_COLORS.paper}"/>
    <circle cx="880" cy="280" r="330" fill="${theme.soft}"/><circle cx="950" cy="190" r="190" fill="${theme.accent}"/>
    <image x="72" y="102" width="260" height="48" preserveAspectRatio="xMinYMid meet" href="data:image/svg+xml;base64,${mark}"/>
    <rect x="72" y="380" width="250" height="58" rx="29" fill="${theme.accent}"/>
    <text x="197" y="417" text-anchor="middle" fill="${SOCIAL_CARD_COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="15" font-weight="900" letter-spacing="1.7">NEW GUIDE · ${escapeHtml(content.story.eyebrow)}</text>
    ${linesMarkup(title, { x: 72, y: 600, size: titleSize, height: Math.round(titleSize * 1.06), weight: 900 })}
    <line x1="72" y1="1015" x2="380" y2="1015" stroke="${theme.accent}" stroke-width="14" stroke-linecap="round"/>
    ${linesMarkup(body, { x: 72, y: 1110, size: 32, height: 49, weight: 530, fill: SOCIAL_CARD_COLORS.mutedInk })}
    <rect x="72" y="1550" width="936" height="174" rx="42" fill="${SOCIAL_CARD_COLORS.ink}" filter="url(#shadow)"/>
    <text x="118" y="1620" fill="${theme.accent}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="15" font-weight="900" letter-spacing="2">FULL STEP-BY-STEP</text>
    <text x="118" y="1680" fill="${SOCIAL_CARD_COLORS.paper}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="32" font-weight="850">View the carousel in the feed</text>
    <text x="956" y="1678" text-anchor="end" fill="${theme.accent}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="48" font-weight="900">↓</text>
    <text x="72" y="1818" fill="${SOCIAL_CARD_COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="18" font-weight="750">@openingshq · openings.dev</text>
  </svg>`;
}

async function jpeg(svg, dimensions) {
  const buffer = await sharp(Buffer.from(svg)).flatten({ background: SOCIAL_CARD_COLORS.paper })
    .jpeg({ quality: 86, chromaSubsampling: '4:4:4' }).toBuffer();
  const metadata = await sharp(buffer).metadata();
  if (metadata.format !== 'jpeg' || metadata.width !== dimensions.width || metadata.height !== dimensions.height) {
    throw new Error('Rendered editorial asset has invalid JPEG dimensions');
  }
  if (buffer.byteLength >= 4 * 1024 * 1024) throw new Error('Rendered editorial asset exceeds 4 MB');
  return buffer;
}

export async function renderEditorialAssets(content, { wordmarkSvg }) {
  validateEditorialContent(content);
  const slides = await Promise.all(content.slides.map((_, index) => (
    jpeg(createEditorialSlideSvg(content, index, { wordmarkSvg }), FEED)
  )));
  const story = await jpeg(createEditorialStorySvg(content, { wordmarkSvg }), STORY);
  return Object.freeze({ slides: Object.freeze(slides), story });
}
