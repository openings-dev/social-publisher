import { formatSalary } from './format-job.mjs';

export const SOCIAL_POSTER_MODEL_VERSION = 1;
export const SOCIAL_SAFE_INSET_X = 30;
export const SOCIAL_SAFE_INSET_Y = 60;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const INSTAGRAM_POSTER_GEOMETRY = deepFreeze({
  canvas: { width: 1080, height: 1350 },
  safeArea: { x: 30, y: 60, width: 1020, height: 1230 },
  header: { x: 30, y: 60, width: 1020, height: 92 },
  role: { x: 30, y: 152, width: 1020, height: 590 },
  facts: { x: 0, y: 742, width: 1080, height: 432 },
  attribution: { x: 30, y: 1174, width: 1020, height: 116 },
});

export const REEL_POSTER_GEOMETRY = deepFreeze({
  canvas: { width: 1080, height: 1920 },
  safeArea: { x: 30, y: 60, width: 1020, height: 1800 },
  header: { x: 30, y: 60, width: 1020, height: 130 },
  role: { x: 30, y: 190, width: 1020, height: 866 },
  facts: { x: 0, y: 1056, width: 1080, height: 614 },
  attribution: { x: 30, y: 1670, width: 1020, height: 190 },
});

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const MODEL_KEYS = Object.freeze([
  'attribution',
  'community',
  'dominantFact',
  'eyebrow',
  'handle',
  'layouts',
  'supportingFacts',
  'title',
  'version',
]);

function graphemes(value) {
  return [...segmenter.segment(String(value))].map(({ segment }) => segment);
}

function glyphWidth(character, fontSize) {
  if (/\s/u.test(character)) return fontSize * 0.31;
  if (/[A-Z0-9]/u.test(character)) return fontSize * 0.62;
  if (/[a-z]/u.test(character)) return fontSize * 0.53;
  if (/[,.;:!?\u2013\u2014'"()[\]{}\-/]/u.test(character)) return fontSize * 0.35;
  if (/\p{Extended_Pictographic}/u.test(character)) return fontSize;
  return fontSize * 0.93;
}

function wrapText(value, { fontSize, maxWidth, maxLines }) {
  const input = graphemes(value);
  const lines = [];
  let current = [];
  let currentWidth = 0;
  let lastBreak = -1;
  let index = 0;

  while (index < input.length && lines.length < maxLines) {
    const character = input[index];
    const width = glyphWidth(character, fontSize);
    if (current.length > 0 && currentWidth + width > maxWidth) {
      if (lastBreak >= 0) {
        const completed = current.slice(0, lastBreak).join('').trimEnd();
        const spill = current.slice(lastBreak + 1);
        if (completed) lines.push(completed);
        current = spill;
        currentWidth = spill.reduce((sum, part) => sum + glyphWidth(part, fontSize), 0);
      } else {
        lines.push(current.join('').trimEnd());
        current = [];
        currentWidth = 0;
      }
      lastBreak = -1;
      continue;
    }
    current.push(character);
    currentWidth += width;
    if (/\s/u.test(character)) lastBreak = current.length - 1;
    index += 1;
  }

  if (current.length > 0 && lines.length < maxLines) {
    lines.push(current.join('').trimEnd());
  }
  const truncated = index < input.length;
  if (truncated && lines.length > 0) {
    const lastIndex = lines.length - 1;
    const availableWidth = maxWidth - glyphWidth('…', fontSize);
    const parts = graphemes(lines[lastIndex].replace(/[\s,.;:!?\u2013\u2014-]+$/u, ''));
    while (parts.length > 0
      && parts.reduce((sum, part) => sum + glyphWidth(part, fontSize), 0) > availableWidth) {
      parts.pop();
    }
    lines[lastIndex] = `${parts.join('').trimEnd()}…`;
  }
  return { lines: lines.filter(Boolean), truncated };
}

function normalizeTitle(value) {
  const normalized = String(value ?? '').replace(/\s*\|\s*/gu, '—').replace(/\s+/gu, ' ').trim();
  if (normalized === '') return 'Open role';
  const titleGraphemes = graphemes(normalized);
  if (titleGraphemes.length > 64 && /^\p{Extended_Pictographic}/u.test(titleGraphemes[0])) {
    return titleGraphemes.slice(1).join('').trimStart();
  }
  return normalized;
}

function fitTitle(title, { sizes, maxWidth, maxHeight, maxLines }) {
  for (const titleFontSize of sizes) {
    const titleLineHeight = Math.round(titleFontSize * 0.94);
    const result = wrapText(title, { fontSize: titleFontSize, maxWidth, maxLines });
    if (!result.truncated && result.lines.length * titleLineHeight <= maxHeight) {
      return deepFreeze({ titleLines: result.lines, titleFontSize, titleLineHeight });
    }
  }
  const titleFontSize = sizes.at(-1);
  const titleLineHeight = Math.round(titleFontSize * 0.94);
  const result = wrapText(title, { fontSize: titleFontSize, maxWidth, maxLines });
  return deepFreeze({ titleLines: result.lines, titleFontSize, titleLineHeight });
}

function useful(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized && !/^unknown$/iu.test(normalized) ? normalized : null;
}

function formatLocation(country, region) {
  const values = [useful(country), useful(region)].filter(Boolean);
  return [...new Map(values.map((value) => [value.toLocaleLowerCase('en-US'), value])).values()].join(' · ');
}

function findWorkMode(job) {
  const haystack = [
    ...(Array.isArray(job.tags) ? job.tags : []),
    job.country,
    job.region,
  ].filter(Boolean).join(' ').toLocaleLowerCase('en-US');
  if (/\bhybrid\b|\bh[ií]brido\b/u.test(haystack)) return 'HYBRID';
  if (/\bon[ -]?site\b|\bonsite\b|\bin[ -]?office\b|\bpresencial\b/u.test(haystack)) return 'ON-SITE';
  if (/\bremote\b|\bremoto\b|\bworldwide\b|\bglobal\b/u.test(haystack)) return 'REMOTE';
  return null;
}

function repositoryOwner(repository) {
  return useful(repository)?.split('/')[0] ?? 'openings community';
}

function fact(label, value) {
  return deepFreeze({ label, value });
}

function distinctFacts(values) {
  const seen = new Set();
  return values.filter((entry) => {
    if (!entry?.value) return false;
    const key = entry.value.toLocaleLowerCase('en-US');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertPlainKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactKeys(value, expected, label);
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const safeExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(safeExpected)) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function assertString(value, label, maximumLength) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximumLength
    || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertFact(value, label) {
  assertPlainKeys(value, ['label', 'value'], label);
  assertString(value.label, `${label}.label`, 40);
  assertString(value.value, `${label}.value`, 180);
}

function assertLayout(value, label) {
  assertPlainKeys(value, ['titleFontSize', 'titleLineHeight', 'titleLines'], label);
  if (!Array.isArray(value.titleLines) || value.titleLines.length < 1 || value.titleLines.length > 5) {
    throw new Error(`${label}.titleLines is invalid`);
  }
  value.titleLines.forEach((line, index) => assertString(line, `${label}.titleLines[${index}]`, 180));
  if (!Number.isInteger(value.titleFontSize) || value.titleFontSize < 68 || value.titleFontSize > 160) {
    throw new Error(`${label}.titleFontSize is invalid`);
  }
  if (!Number.isInteger(value.titleLineHeight)
    || value.titleLineHeight < 60 || value.titleLineHeight > 170) {
    throw new Error(`${label}.titleLineHeight is invalid`);
  }
}

export function validateSocialPosterModel(value) {
  assertPlainKeys(value, MODEL_KEYS, 'Poster model');
  if (value.version !== SOCIAL_POSTER_MODEL_VERSION) throw new Error('Poster model version is invalid');
  assertString(value.handle, 'Poster handle', 40);
  assertString(value.community, 'Poster community', 160);
  assertString(value.eyebrow, 'Poster eyebrow', 220);
  assertString(value.title, 'Poster title', 800);
  assertFact(value.dominantFact, 'Poster dominant fact');
  if (!Array.isArray(value.supportingFacts) || value.supportingFacts.length > 2) {
    throw new Error('Poster supporting facts are invalid');
  }
  value.supportingFacts.forEach((entry, index) => assertFact(entry, `Poster supportingFacts[${index}]`));
  assertPlainKeys(value.attribution, ['action', 'label', 'value'], 'Poster attribution');
  assertString(value.attribution.label, 'Poster attribution label', 60);
  assertString(value.attribution.value, 'Poster attribution value', 160);
  assertString(value.attribution.action, 'Poster attribution action', 120);
  assertPlainKeys(value.layouts, ['instagram', 'reel'], 'Poster layouts');
  assertLayout(value.layouts.instagram, 'Poster Instagram layout');
  assertLayout(value.layouts.reel, 'Poster Reel layout');
  return deepFreeze(value);
}

export function createSocialPosterModel(job) {
  const community = useful(job.community?.name) || repositoryOwner(job.repository);
  const title = normalizeTitle(job.title);
  const salary = useful(formatSalary(job.salary));
  const workMode = findWorkMode(job);
  const location = formatLocation(job.country, job.region);

  let dominantFact;
  if (salary) dominantFact = fact('SALARY', salary);
  else if (workMode) dominantFact = fact('WORK MODE', workMode);
  else if (location) dominantFact = fact('LOCATION', location);
  else dominantFact = fact('STATUS', 'OPEN ROLE');

  const supportingCandidates = distinctFacts([
    workMode ? fact('WORK MODE', workMode) : null,
    fact('LOCATION', location || 'Location not specified'),
    fact('SOURCE', job.sourceType === 'github-issue' ? 'GitHub issue' : 'Public listing'),
    fact('COMMUNITY', community),
  ]).filter(({ value }) => value.toLocaleLowerCase('en-US')
    !== dominantFact.value.toLocaleLowerCase('en-US'));

  return validateSocialPosterModel({
    version: SOCIAL_POSTER_MODEL_VERSION,
    handle: '@openingshq',
    community,
    eyebrow: `${community} · New opening`,
    title,
    dominantFact,
    supportingFacts: supportingCandidates.slice(0, 2),
    attribution: {
      label: 'SHARED THROUGH',
      value: community,
      action: 'Find this opening on openings.dev',
    },
    layouts: {
      instagram: fitTitle(title, {
        sizes: [112, 104, 96, 88, 80, 72, 68],
        maxWidth: 960,
        maxHeight: 440,
        maxLines: 5,
      }),
      reel: fitTitle(title, {
        sizes: [136, 128, 120, 112, 104, 96, 88, 80, 72, 68],
        maxWidth: 960,
        maxHeight: 690,
        maxLines: 5,
      }),
    },
  });
}

export function encodeSocialPosterModel(model) {
  const validated = validateSocialPosterModel(structuredClone(model));
  const encoded = Buffer.from(JSON.stringify(validated), 'utf8').toString('base64');
  if (encoded.length >= 8_192) throw new Error('Poster model is too large');
  return encoded;
}

export function decodeSocialPosterModel(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length >= 8_192
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error('Poster model must use bounded canonical base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('Poster model base64 is not canonical');
  let parsed;
  try {
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('Poster model JSON is invalid');
  }
  return validateSocialPosterModel(parsed);
}
