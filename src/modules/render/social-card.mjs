import sharp from 'sharp';

import { IMAGE_HEIGHT, IMAGE_WIDTH } from '../../config/constants.mjs';
import { escapeAttribute, escapeHtml } from '../../shared/escape.mjs';
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

function titleFontSize(title) {
  const length = [...segmenter.segment(title)].length;
  if (length > 110) return 42;
  if (length > 82) return 48;
  if (length > 58) return 54;
  return 62;
}

function glyphWidth(character, fontSize) {
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
    if (/\s/u.test(character)) {
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

function presentation(job) {
  const community = useful(job.community?.name) || job.repository;
  const facts = [
    ['Salary', formatSalary(job.salary)],
    ['Job location', formatLocation(job.country, job.region)],
    ['Original source', job.sourceType === 'github-issue' ? 'GitHub Issue' : 'Public listing'],
  ].filter(([, value]) => value);
  const company = useful(job.companyName);
  return {
    eyebrow: `${community} · Open job`,
    title: job.title,
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
  return lines.map((line, index) => `<text x="${x}" y="${y + index * lineHeight}" fill="${fill}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}" ${attribute}>${escapeHtml(line)}</text>`).join('');
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

  let tagsMarkup = '';
  let tagX = 84;
  for (const tag of card.tags) {
    const width = Math.min(190, Math.max(72, 28 + [...segmenter.segment(tag)].length * 8));
    if (tagX + width > 805) break;
    tagsMarkup += `<rect x="${tagX}" y="${tagsY}" width="${width}" height="31" rx="15.5" fill="${COLORS.surfaceMuted}"/><text x="${tagX + 13}" y="${tagsY + 21}" fill="${COLORS.ink}" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeHtml(tag)}</text>`;
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
  <text x="1124" y="90" text-anchor="end" fill="${COLORS.mutedInk}" font-family="Arial, sans-serif" font-size="15" font-weight="700">Tech jobs from public communities</text>
  <text x="84" y="168" fill="${COLORS.mintDeep}" font-family="Arial, sans-serif" font-size="14" font-weight="800" letter-spacing="1.4">${escapeHtml(card.eyebrow.toUpperCase())}</text>
  ${textLines(titleLines, { x: 84, y: 222, fontSize, lineHeight: titleLineHeight, weight: 800, attribute: 'letter-spacing="-1.5" data-title-line="true"' })}
  ${textLines(descriptionLines, { x: 84, y: descriptionY, fontSize: 19, lineHeight: 27, weight: 400, fill: COLORS.mutedInk })}
  ${tagsMarkup}
  ${factsMarkup}
  <rect x="878" y="512" width="250" height="50" rx="25" fill="${COLORS.mint}"/>
  <text x="895" y="544" fill="${COLORS.ink}" font-family="Arial, sans-serif" font-size="15" font-weight="800">View job</text>
  <text x="1104" y="544" text-anchor="end" fill="${COLORS.ink}" font-family="Arial, sans-serif" font-size="21" font-weight="700">→</text>
</svg>`;
}

export async function renderSocialCardPng(job, { wordmarkSvg }) {
  const svg = createSocialCardSvg(job, { wordmarkSvg });
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  const metadata = await sharp(png).metadata();
  if (metadata.format !== 'png' || metadata.width !== IMAGE_WIDTH || metadata.height !== IMAGE_HEIGHT) {
    throw new Error('Rendered social card has invalid PNG dimensions');
  }
  if (png.byteLength >= 2 * 1024 * 1024) {
    throw new Error('Rendered social card exceeds 2 MB');
  }
  return png;
}

export { COLORS as SOCIAL_CARD_COLORS };
