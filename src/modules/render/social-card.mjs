import sharp from 'sharp';

import {
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  INSTAGRAM_IMAGE_HEIGHT,
  INSTAGRAM_IMAGE_WIDTH,
} from '../../config/constants.mjs';
import { escapeAttribute, escapeHtml } from '../../shared/escape.mjs';
import { createCjkFontStyle, SOCIAL_CARD_FONT_STACK } from './cjk-fonts.mjs';
import { formatSalary } from './format-job.mjs';
import { opportunityDescription } from './html-page.mjs';

const COLORS = Object.freeze({
  canvas: '#f5f3ef',
  paper: '#fffefa',
  ink: '#21302e',
  mutedInk: '#5e6663',
  line: '#d8d8d1',
  surfaceMuted: '#eeefeb',
  mint: '#b0ec9c',
  mintDeep: '#315d35',
});
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const SOFT_BREAK = '\u200B';

function titleFontSize(title) {
  const length = [...segmenter.segment(title)].length;
  if (length > 110) return 42;
  if (length > 82) return 48;
  if (length > 58) return 54;
  return 62;
}

function instagramTitleFontSize(title) {
  const length = [...segmenter.segment(title)].length;
  if (length > 120) return 48;
  if (length > 90) return 54;
  if (length > 64) return 60;
  if (length > 42) return 66;
  return 74;
}

function glyphWidth(character, fontSize) {
  if (character === SOFT_BREAK) return 0;
  if (/\s/u.test(character)) return fontSize * 0.3;
  if (/[A-Z0-9]/u.test(character)) return fontSize * 0.62;
  if (/[a-z]/u.test(character)) return fontSize * 0.54;
  if (/[,.;:!?'"()[\]{}\-/]/u.test(character)) return fontSize * 0.34;
  return fontSize * 0.92;
}

function wrapText(value, { fontSize, maxWidth, maxLines }) {
  const segments = [...segmenter.segment(String(value))].map((entry) => entry.segment);
  const lines = [];
  let line = '';
  let width = 0;
  let lastWhitespaceIndex = -1;
  let consumed = 0;

  while (consumed < segments.length && lines.length < maxLines) {
    const character = segments[consumed];
    const characterWidth = glyphWidth(character, fontSize);
    if (line && width + characterWidth > maxWidth) {
      if (lastWhitespaceIndex >= 0) {
        const spill = [...segmenter.segment(line.slice(lastWhitespaceIndex + 1))].map((entry) => entry.segment);
        const completed = line.slice(0, lastWhitespaceIndex).trimEnd();
        lines.push(completed);
        line = spill.join('');
        width = spill.reduce((sum, part) => sum + glyphWidth(part, fontSize), 0);
      } else {
        lines.push(line.trimEnd());
        line = '';
        width = 0;
      }
      lastWhitespaceIndex = -1;
      continue;
    }
    line += character;
    width += characterWidth;
    if (/\s/u.test(character) || character === SOFT_BREAK) {
      lastWhitespaceIndex = line.length - character.length;
    }
    consumed += 1;
  }

  if (line && lines.length < maxLines) {
    lines.push(line.trimEnd());
  }
  if (consumed < segments.length && lines.length > 0) {
    const lastIndex = lines.length - 1;
    const withoutTrailingPunctuation = lines[lastIndex].replace(/[\s,.;:!?-]+$/u, '');
    lines[lastIndex] = `${withoutTrailingPunctuation}…`;
  }
  return lines.filter(Boolean);
}

function useful(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && !/^unknown$/iu.test(trimmed) ? trimmed : null;
}

function formatLocation(country, region) {
  const values = [useful(country), useful(region)].filter(Boolean);
  return [...new Map(values.map((value) => [value.toLocaleLowerCase('en-US'), value])).values()].join(' · ');
}

function distinctTags(tags) {
  const values = [];
  const seen = new Set();
  for (const tag of Array.isArray(tags) ? tags : []) {
    const value = useful(tag);
    const key = value?.toLocaleLowerCase('en-US');
    if (!value || seen.has(key)) continue;
    seen.add(key);
    values.push(value);
    if (values.length === 3) break;
  }
  return values;
}

function displayTitle(value) {
  return String(value).replace(/\s*\|\s*/gu, '—');
}

function presentation(job) {
  const community = useful(job.community?.name) || job.repository;
  const salary = formatSalary(job.salary)?.replace('/', `${SOFT_BREAK}/`);
  const facts = [
    ['Salary', salary],
    ['Job location', formatLocation(job.country, job.region)],
    ['Original source', job.sourceType === 'github-issue' ? 'GitHub Issue' : 'Public listing'],
  ].filter(([, value]) => value);
  const company = useful(job.companyName);
  return {
    eyebrow: `${community} · Open job`,
    title: displayTitle(job.title),
    description: company ? `At ${company}. Shared through ${community}.` : `Shared through ${community}.`,
    fallbackDescription: opportunityDescription(job),
    facts,
    tags: distinctTags(job.tags),
  };
}

function assertTrustedWordmark(wordmarkSvg) {
  if (typeof wordmarkSvg !== 'string' || !/^\s*<svg\b/iu.test(wordmarkSvg)) {
    throw new Error('A canonical SVG wordmark is required');
  }
  if (/<(?:script|foreignObject)\b|(?:href|src)\s*=\s*["']https?:/iu.test(wordmarkSvg)) {
    throw new Error('The SVG wordmark contains unsupported external content');
  }
  return wordmarkSvg;
}

function textLines(lines, { x, y, fontSize, lineHeight, weight = 700, fill = COLORS.ink, attribute = '' }) {
  return lines.map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" fill="${fill}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="${fontSize}" font-weight="${weight}" ${attribute}>${escapeHtml(line)}</text>`).join('');
}

export function createSocialCardSvg(job, { wordmarkSvg }) {
  const trustedWordmark = assertTrustedWordmark(wordmarkSvg);
  const card = presentation(job);
  const fontSize = titleFontSize(card.title);
  const titleLines = wrapText(card.title, { fontSize, maxWidth: 700, maxLines: 3 });
  const titleLineHeight = Math.round(fontSize * 1.04);
  const titleBottom = 222 + Math.max(0, titleLines.length - 1) * titleLineHeight;
  const descriptionLines = wrapText(card.description || card.fallbackDescription, {
    fontSize: 19,
    maxWidth: 690,
    maxLines: 2,
  });
  const descriptionY = titleBottom + 38;
  const tagsY = descriptionY + descriptionLines.length * 27 + 21;
  const wordmarkData = Buffer.from(trustedWordmark).toString('base64');
  const fontStyle = createCjkFontStyle(JSON.stringify(card));

  let tagsMarkup = '';
  let tagX = 84;
  for (const tag of card.tags) {
    const width = Math.min(190, Math.max(72, 28 + [...segmenter.segment(tag)].length * 8));
    if (tagX + width > 805) break;
    tagsMarkup += `<rect x="${tagX}" y="${tagsY}" width="${width}" height="31" rx="15.5" fill="${COLORS.surfaceMuted}"/><text x="${tagX + 13}" y="${tagsY + 21}" fill="${COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="13" font-weight="700">${escapeHtml(tag)}</text>`;
    tagX += width + 9;
  }

  const factsMarkup = card.facts.slice(0, 3).map(([label, value], index) => {
    const y = 176 + index * 92;
    const valueLines = wrapText(value, { fontSize: 19, maxWidth: 242, maxLines: 2 });
    return `${index > 0 ? `<line x1="878" y1="${y - 19}" x2="1128" y2="${y - 19}" stroke="${COLORS.line}"/>` : ''}<text x="878" y="${y}" fill="${COLORS.mutedInk}" font-family="Arial, sans-serif" font-size="12" font-weight="700" letter-spacing="1">${escapeHtml(label.toUpperCase())}</text>${textLines(valueLines, { x: 878, y: y + 28, fontSize: 19, lineHeight: 23, weight: 700 })}`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" viewBox="0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}" role="img" aria-labelledby="card-title card-description">
  <title id="card-title">${escapeHtml(card.title)} — Open job on openings.dev</title>
  <desc id="card-description">${escapeHtml(card.fallbackDescription)}</desc>
  <defs>
    ${fontStyle}
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="${COLORS.ink}" flood-opacity="0.10"/></filter>
    <clipPath id="card-clip"><rect x="42" y="42" width="1116" height="546" rx="26"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="${COLORS.canvas}"/>
  <circle cx="1114" cy="12" r="130" fill="${COLORS.mint}"/>
  <rect x="42" y="42" width="1116" height="546" rx="26" fill="${COLORS.paper}" stroke="${COLORS.line}" filter="url(#shadow)"/>
  <g clip-path="url(#card-clip)">
    <rect x="848" y="125" width="310" height="463" fill="#fbfaf6"/>
    <line x1="42" y1="124.5" x2="1158" y2="124.5" stroke="${COLORS.line}"/>
    <line x1="847.5" y1="125" x2="847.5" y2="588" stroke="${COLORS.line}"/>
  </g>
  <image x="76" y="62" width="238" height="44" preserveAspectRatio="xMinYMid meet" href="data:image/svg+xml;base64,${wordmarkData}"/>
  <text x="1124" y="90" text-anchor="end" fill="${COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="15" font-weight="700">Tech jobs from public communities</text>
  <text x="84" y="168" fill="${COLORS.mintDeep}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="14" font-weight="800" letter-spacing="1.4">${escapeHtml(card.eyebrow.toUpperCase())}</text>
  ${textLines(titleLines, { x: 84, y: 222, fontSize, lineHeight: titleLineHeight, weight: 800, attribute: 'letter-spacing="-1.5" data-title-line="true"' })}
  ${textLines(descriptionLines, { x: 84, y: descriptionY, fontSize: 19, lineHeight: 27, weight: 400, fill: COLORS.mutedInk })}
  ${tagsMarkup}
  ${factsMarkup}
  <rect x="878" y="512" width="250" height="50" rx="25" fill="${COLORS.mint}"/>
  <text x="895" y="544" fill="${COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="15" font-weight="800">View job</text>
  <text x="1104" y="544" text-anchor="end" fill="${COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="21" font-weight="700">→</text>
</svg>`;
}

export function createInstagramCardSvg(job, { wordmarkSvg }) {
  const trustedWordmark = assertTrustedWordmark(wordmarkSvg);
  const card = presentation(job);
  const fontSize = instagramTitleFontSize(card.title);
  const titleLines = wrapText(card.title, { fontSize, maxWidth: 880, maxLines: 6 });
  const titleLineHeight = Math.round(fontSize * 1.08);
  const titleBottom = 316 + Math.max(0, titleLines.length - 1) * titleLineHeight;
  const descriptionLines = wrapText(card.description || card.fallbackDescription, {
    fontSize: 23,
    maxWidth: 870,
    maxLines: 2,
  });
  const descriptionY = titleBottom + 54;
  const tagsY = Math.min(820, descriptionY + descriptionLines.length * 34 + 30);
  const wordmarkData = Buffer.from(trustedWordmark).toString('base64');

  let tagsMarkup = '';
  let tagX = 84;
  for (const tag of card.tags) {
    const width = Math.min(220, Math.max(82, 34 + [...segmenter.segment(tag)].length * 10));
    if (tagX + width > 996) break;
    tagsMarkup += `<rect x="${tagX}" y="${tagsY}" width="${width}" height="40" rx="20" fill="${COLORS.surfaceMuted}"/><text x="${tagX + 17}" y="${tagsY + 27}" fill="${COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="16" font-weight="700">${escapeHtml(tag)}</text>`;
    tagX += width + 12;
  }

  const facts = card.facts.slice(0, 3);
  const factWidth = facts.length === 2 ? 420 : 270;
  const factGap = facts.length === 2 ? 36 : 30;
  const factsMarkup = facts.map(([label, value], index) => {
    const x = 84 + index * (factWidth + factGap);
    const valueLines = wrapText(value, { fontSize: 21, maxWidth: factWidth - 12, maxLines: 2 });
    return `<text x="${x}" y="957" fill="${COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="13" font-weight="700" letter-spacing="1.2">${escapeHtml(label.toUpperCase())}</text>${textLines(valueLines, { x, y: 993, fontSize: 21, lineHeight: 28, weight: 700 })}`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${INSTAGRAM_IMAGE_WIDTH}" height="${INSTAGRAM_IMAGE_HEIGHT}" viewBox="0 0 ${INSTAGRAM_IMAGE_WIDTH} ${INSTAGRAM_IMAGE_HEIGHT}" role="img" aria-labelledby="instagram-card-title instagram-card-description" data-instagram-card="true">
  <title id="instagram-card-title">${escapeHtml(card.title)} — Open job on openings.dev</title>
  <desc id="instagram-card-description">${escapeHtml(card.fallbackDescription)}</desc>
  <defs>
    <filter id="portrait-shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="22" stdDeviation="26" flood-color="${COLORS.ink}" flood-opacity="0.11"/></filter>
    <clipPath id="portrait-card-clip"><rect x="40" y="40" width="1000" height="1270" rx="32"/></clipPath>
  </defs>
  <rect width="1080" height="1350" fill="${COLORS.canvas}"/>
  <circle cx="1010" cy="62" r="190" fill="${COLORS.mint}"/>
  <rect x="40" y="40" width="1000" height="1270" rx="32" fill="${COLORS.paper}" stroke="${COLORS.line}" filter="url(#portrait-shadow)"/>
  <rect data-safe-area="true" x="56" y="56" width="968" height="1238" fill="none"/>
  <g clip-path="url(#portrait-card-clip)">
    <line x1="40" y1="178" x2="1040" y2="178" stroke="${COLORS.line}"/>
    <rect x="40" y="884" width="1000" height="236" fill="#fbfaf6"/>
    <line x1="40" y1="884" x2="1040" y2="884" stroke="${COLORS.line}"/>
    <line x1="40" y1="1120" x2="1040" y2="1120" stroke="${COLORS.line}"/>
  </g>
  <image x="84" y="82" width="274" height="50" preserveAspectRatio="xMinYMid meet" href="data:image/svg+xml;base64,${wordmarkData}"/>
  <text x="996" y="112" text-anchor="end" fill="${COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="16" font-weight="700">Tech jobs from public communities</text>
  <text x="84" y="244" fill="${COLORS.mintDeep}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="16" font-weight="800" letter-spacing="1.5">${escapeHtml(card.eyebrow.toUpperCase())}</text>
  ${textLines(titleLines, { x: 84, y: 316, fontSize, lineHeight: titleLineHeight, weight: 800, attribute: 'letter-spacing="-1.3" data-instagram-title-line="true"' })}
  ${textLines(descriptionLines, { x: 84, y: descriptionY, fontSize: 23, lineHeight: 34, weight: 400, fill: COLORS.mutedInk })}
  ${tagsMarkup}
  ${factsMarkup}
  <rect x="84" y="1162" width="912" height="92" rx="46" fill="${COLORS.mint}"/>
  <text x="118" y="1219" fill="${COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="23" font-weight="800">Find this opening on openings.dev</text>
  <text x="950" y="1221" text-anchor="end" fill="${COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="30" font-weight="700">→</text>
</svg>`;
}

export async function renderSocialCardPng(job, { wordmarkSvg }) {
  const svg = createSocialCardSvg(job, { wordmarkSvg });
  const png = await sharp(Buffer.from(svg)).png({
    compressionLevel: 9,
    palette: true,
    colors: 128,
    quality: 90,
  }).toBuffer();
  const metadata = await sharp(png).metadata();
  if (metadata.format !== 'png' || metadata.width !== IMAGE_WIDTH || metadata.height !== IMAGE_HEIGHT) {
    throw new Error('Rendered social card has invalid PNG dimensions');
  }
  if (png.byteLength >= 2 * 1024 * 1024) {
    throw new Error('Rendered social card exceeds 2 MB');
  }
  return png;
}

export async function renderInstagramCardJpeg(job, { wordmarkSvg }) {
  const svg = createInstagramCardSvg(job, { wordmarkSvg });
  const jpeg = await sharp(Buffer.from(svg))
    .flatten({ background: COLORS.paper })
    .jpeg({ quality: 82, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const metadata = await sharp(jpeg).metadata();
  if (metadata.format !== 'jpeg'
    || metadata.width !== INSTAGRAM_IMAGE_WIDTH
    || metadata.height !== INSTAGRAM_IMAGE_HEIGHT) {
    throw new Error('Rendered Instagram card has invalid JPEG dimensions');
  }
  if (jpeg.byteLength >= 2 * 1024 * 1024) {
    throw new Error('Rendered Instagram card exceeds 2 MB');
  }
  return jpeg;
}

export { COLORS as SOCIAL_CARD_COLORS };
