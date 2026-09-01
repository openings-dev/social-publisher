export const EDITORIAL_CONTENT_VERSION = '2';
export const EDITORIAL_CATALOG_VERSION = '2';

export const BANNED_EDITORIAL_TERMS = Object.freeze([
  'delve',
  'foster',
  'leverage',
  'utilize',
  'facilitate',
  'empower',
  'streamline',
  'robust',
  'cutting-edge',
  'paradigm shift',
  'game changer',
  'this is huge',
  'this changes everything',
  'tapestry',
  'realm',
  'beacon',
  'multifaceted',
  'meticulous',
  'intricate',
  'paramount',
  'transformative',
  'elevate',
  'embark',
  'supercharge',
  'harness',
  'ever-evolving',
]);

const PORTUGUESE_MARKERS = Object.freeze([
  'por que isso importa',
  'faca assim',
  'antes e depois',
  'ajuste que faz diferenca',
  'checklist rapido',
  'aplique hoje',
  'veja o passo a passo completo no feed',
  'salve este guia',
  'curriculo',
  'busca de vagas',
  'candidatura',
  'entrevista',
  'fonte:',
]);

function normalize(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase();
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function readerFacingStrings(content) {
  const values = [content.title, content.promise];
  for (const slide of content.slides ?? []) {
    values.push(slide.title, slide.body, slide.before, slide.after);
    if (Array.isArray(slide.items)) values.push(...slide.items);
  }
  values.push(
    content.story?.eyebrow,
    content.story?.title,
    content.story?.body,
    content.caption?.hook,
    content.caption?.action,
    ...(content.hashtags ?? []),
  );
  return values.filter((value) => typeof value === 'string');
}

function assertEnglishReaderCopy(content) {
  for (const value of readerFacingStrings(content)) {
    if (/[\u2013\u2014]/u.test(value)) {
      throw new Error('editorial copy must not contain dash characters');
    }
    const normalized = normalize(value);
    if (PORTUGUESE_MARKERS.some((marker) => normalized.includes(marker))) {
      throw new Error('editorial content contains Portuguese editorial copy');
    }
    for (const term of BANNED_EDITORIAL_TERMS) {
      const pattern = new RegExp(`(?:^|[^a-z])${escapePattern(term)}(?:$|[^a-z])`, 'u');
      if (pattern.test(normalized)) {
        throw new Error(`editorial content contains banned editorial term: ${term}`);
      }
    }
  }
}

function assertOfficialLinkedInSources(content) {
  if (content.pillar !== 'linkedin') return;
  if (!Array.isArray(content.sources) || content.sources.length === 0) {
    throw new Error('LinkedIn editorial content must use official LinkedIn Help sources');
  }
  for (const source of content.sources) {
    let url;
    try {
      url = new URL(source.url);
    } catch {
      throw new Error('LinkedIn editorial content must use official LinkedIn Help sources');
    }
    if (
      source.author !== 'LinkedIn Help'
      || url.protocol !== 'https:'
      || url.hostname !== 'www.linkedin.com'
      || !url.pathname.startsWith('/help/linkedin/')
    ) {
      throw new Error('LinkedIn editorial content must use official LinkedIn Help sources');
    }
  }
}

export function assertEditorialCopyPolicy(content) {
  assertEnglishReaderCopy(content);
  assertOfficialLinkedInSources(content);
  return content;
}
