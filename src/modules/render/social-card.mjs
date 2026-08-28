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
import {
  createSocialPosterModel,
  encodeSocialPosterModel,
  INSTAGRAM_POSTER_GEOMETRY,
  SOCIAL_POSTER_MODEL_VERSION,
} from './social-poster-model.mjs';

const COLORS = Object.freeze({
  canvas: '#f5f3ef',
  paper: '#fffefa',
  ink: '#21302e',
  mutedInk: '#5e6663',
  line: '#d8d8d1',
  surfaceMuted: '#f0f1ed',
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
  if (length > 120) return 54;
  if (length > 90) return 60;
  if (length > 64) return 68;
  if (length > 42) return 76;
  return 88;
}

function instagramFactFontSize(value) {
  const length = [...segmenter.segment(String(value).replaceAll(SOFT_BREAK, ''))].length;
  if (length > 20) return 19;
  if (length > 14) return 22;
  return 25;
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
    community,
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
  const model = createSocialPosterModel(job);
  const { theme } = model;
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

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}" viewBox="0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}" role="img" aria-labelledby="card-title card-description" data-theme="${theme.id}">
  <title id="card-title">${escapeHtml(card.title)} — Open job on openings.dev</title>
  <desc id="card-description">${escapeHtml(card.fallbackDescription)}</desc>
  <defs>
    ${fontStyle}
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="${COLORS.ink}" flood-opacity="0.10"/></filter>
    <clipPath id="card-clip"><rect x="42" y="42" width="1116" height="546" rx="26"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="${COLORS.canvas}"/>
  <circle cx="1114" cy="12" r="148" fill="${theme.soft}"/>
  <circle cx="1140" cy="-6" r="104" fill="${theme.accent}"/>
  <rect x="42" y="42" width="1116" height="546" rx="26" fill="${COLORS.paper}" stroke="${COLORS.line}" filter="url(#shadow)"/>
  <g clip-path="url(#card-clip)">
    <rect x="848" y="125" width="310" height="463" fill="#fbfaf6"/>
    <line x1="42" y1="124.5" x2="1158" y2="124.5" stroke="${COLORS.line}"/>
    <line x1="847.5" y1="125" x2="847.5" y2="588" stroke="${COLORS.line}"/>
  </g>
  <image x="76" y="62" width="238" height="44" preserveAspectRatio="xMinYMid meet" href="data:image/svg+xml;base64,${wordmarkData}"/>
  <text x="1124" y="90" text-anchor="end" fill="${COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="15" font-weight="700">Tech jobs from public communities</text>
  <text x="84" y="168" fill="${COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="14" font-weight="800" letter-spacing="1.4">${escapeHtml(card.eyebrow.toUpperCase())}</text>
  ${textLines(titleLines, { x: 84, y: 222, fontSize, lineHeight: titleLineHeight, weight: 800, attribute: 'letter-spacing="-1.5" data-title-line="true"' })}
  ${textLines(descriptionLines, { x: 84, y: descriptionY, fontSize: 19, lineHeight: 27, weight: 400, fill: COLORS.mutedInk })}
  ${tagsMarkup}
  ${factsMarkup}
  <rect x="878" y="512" width="250" height="50" rx="25" fill="${theme.accent}"/>
  <text x="895" y="544" fill="${COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="15" font-weight="800">View job</text>
  <text x="1104" y="544" text-anchor="end" fill="${COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="21" font-weight="700">→</text>
</svg>`;
}

export function createInstagramCardSvg(job, { wordmarkSvg }) {
  const trustedWordmark = assertTrustedWordmark(wordmarkSvg);
  const card = presentation(job);
  const model = createSocialPosterModel(job);
  const encodedModel = encodeSocialPosterModel(model);
  const geometry = INSTAGRAM_POSTER_GEOMETRY;
  const layout = model.layouts.instagram;
  const titleBlockHeight = layout.titleLines.length * layout.titleLineHeight;
  const titleY = 272 + Math.max(0, (420 - titleBlockHeight) / 2)
    + Math.round(layout.titleFontSize * 0.78);
  const wordmarkData = Buffer.from(trustedWordmark).toString('base64');
  const dominantLength = [...segmenter.segment(model.dominantFact.value)].length;
  const dominantFontSize = dominantLength > 18 ? 38 : dominantLength > 13 ? 58 : dominantLength > 11 ? 76 : 116;
  const dominantLines = wrapText(model.dominantFact.value, {
    fontSize: dominantFontSize,
    maxWidth: 650,
    maxLines: 3,
  });
  const dominantLineHeight = Math.round(dominantFontSize * 1.02);
  const supportingFacts = model.supportingFacts.map((fact, index) => {
    const y = 790 + index * 128;
    const lines = wrapText(fact.value, { fontSize: 31, maxWidth: 290, maxLines: 2 });
    return `<g data-instagram-supporting-fact="true">
      <text x="730" y="${y}" fill="${COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="15" font-weight="800" letter-spacing="1.4">${escapeHtml(fact.label)}</text>
      ${textLines(lines, { x: 730, y: y + 48, fontSize: 31, lineHeight: 38, weight: 750, fill: COLORS.ink })}
    </g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${INSTAGRAM_IMAGE_WIDTH}" height="${INSTAGRAM_IMAGE_HEIGHT}" viewBox="0 0 ${INSTAGRAM_IMAGE_WIDTH} ${INSTAGRAM_IMAGE_HEIGHT}" role="img" aria-labelledby="instagram-card-title instagram-card-description" data-instagram-card="true" data-social-poster-version="${SOCIAL_POSTER_MODEL_VERSION}" data-theme="${model.theme.id}" data-poster-model="${encodedModel}">
  <title id="instagram-card-title">${escapeHtml(card.title)} — Open job on openings.dev</title>
  <desc id="instagram-card-description">${escapeHtml(card.fallbackDescription)}</desc>
  <rect width="1080" height="1350" fill="${COLORS.paper}"/>
  <rect data-editorial-band="true" x="0" y="1107" width="1080" height="243" fill="${model.theme.accent}"/>
  <rect data-safe-area="true" x="${geometry.safeArea.x}" y="${geometry.safeArea.y}" width="${geometry.safeArea.width}" height="${geometry.safeArea.height}" fill="none"/>
  <rect data-poster-role-region="true" x="${geometry.role.x}" y="${geometry.role.y}" width="${geometry.role.width}" height="${geometry.role.height}" fill="none"/>
  <rect data-instagram-facts="true" data-poster-facts-region="true" x="${geometry.facts.x}" y="${geometry.facts.y}" width="${geometry.facts.width}" height="${geometry.facts.height}" rx="28" fill="${COLORS.surfaceMuted}"/>
  <rect data-poster-attribution-region="true" x="${geometry.attribution.x}" y="${geometry.attribution.y}" width="${geometry.attribution.width}" height="${geometry.attribution.height}" fill="none"/>
  <g data-important-content="true" data-x="30" data-y="60" data-width="1020" data-height="92" data-poster-header="true">
    <image data-instagram-wordmark="true" x="30" y="66" width="250" height="46" preserveAspectRatio="xMinYMid meet" href="data:image/svg+xml;base64,${wordmarkData}"/>
    <text x="1050" y="91" text-anchor="end" fill="${COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="20" font-weight="850">${model.handle}</text>
    <text x="1050" y="123" text-anchor="end" fill="${COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="15" font-weight="750">Tech jobs from public communities</text>
  </g>
  <g data-important-content="true" data-x="30" data-y="152" data-width="1020" data-height="590" data-poster-role="true">
    <text x="30" y="210" fill="${COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="17" font-weight="850" letter-spacing="1.6">${escapeHtml(model.eyebrow.toUpperCase())}</text>
    ${textLines(layout.titleLines, { x: 30, y: Math.round(titleY), fontSize: layout.titleFontSize, lineHeight: layout.titleLineHeight, weight: 900, attribute: 'letter-spacing="-2.4" data-instagram-title-line="true"' })}
  </g>
  <g data-important-content="true" data-x="30" data-y="742" data-width="1020" data-height="341" data-poster-facts-content="true">
    <text x="60" y="800" fill="${COLORS.mutedInk}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="16" font-weight="850" letter-spacing="1.5">${escapeHtml(model.dominantFact.label)}</text>
    ${textLines(dominantLines, { x: 60, y: 872, fontSize: dominantFontSize, lineHeight: dominantLineHeight, weight: 900, fill: COLORS.ink, attribute: 'letter-spacing="-1.8" data-instagram-dominant-fact="true"' })}
    <line x1="692" y1="778" x2="692" y2="1047" stroke="${COLORS.line}"/>
    ${supportingFacts}
  </g>
  <g data-important-content="true" data-x="30" data-y="1107" data-width="1020" data-height="183" data-poster-attribution="true">
    <text x="30" y="1160" fill="${COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="12" font-weight="850" letter-spacing="1.5">${escapeHtml(model.attribution.label)}</text>
    <text x="30" y="1212" fill="${COLORS.ink}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="24" font-weight="850">${escapeHtml(model.attribution.value)}</text>
    <rect data-instagram-cta="true" x="700" y="1152" width="350" height="88" rx="44" fill="${COLORS.ink}"/>
    <text x="724" y="1206" fill="${COLORS.paper}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="17" font-weight="800">${escapeHtml(model.attribution.action)}</text>
    <text x="1020" y="1212" text-anchor="end" fill="${model.theme.accent}" font-family="${SOCIAL_CARD_FONT_STACK}" font-size="28" font-weight="850">→</text>
  </g>
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
