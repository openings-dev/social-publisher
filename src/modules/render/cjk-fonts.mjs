import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const FONT_FAMILY = 'Openings CJK';
const FONT_WEIGHTS = Object.freeze([400, 700, 800]);
const FONT_SOURCES = Object.freeze({
  sc: Object.freeze({ family: 'Noto Sans SC', packageName: '@fontsource/noto-sans-sc' }),
  jp: Object.freeze({ family: 'Noto Sans JP', packageName: '@fontsource/noto-sans-jp' }),
  kr: Object.freeze({ family: 'Noto Sans KR', packageName: '@fontsource/noto-sans-kr' }),
});
const faceCache = new Map();

function scriptsIn(value) {
  const text = String(value);
  const hasJapanese = /[\u3040-\u30ff\u31f0-\u31ff]/u.test(text);
  const scripts = [];
  if (hasJapanese) scripts.push('jp');
  if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u.test(text)) scripts.push('kr');
  if (/\p{Script=Han}/u.test(text) && !hasJapanese) scripts.push('sc');
  return scripts;
}

function codePoints(value) {
  return new Set([...String(value)].map((character) => character.codePointAt(0)));
}

function unicodeRangeBounds(part) {
  const match = /^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/iu.exec(part.trim());
  if (!match) return null;
  if (match[1].includes('?')) {
    return [
      Number.parseInt(match[1].replaceAll('?', '0'), 16),
      Number.parseInt(match[1].replaceAll('?', 'F'), 16),
    ];
  }
  const start = Number.parseInt(match[1], 16);
  return [start, match[2] ? Number.parseInt(match[2], 16) : start];
}

function rangeContainsCodePoint(unicodeRange, points) {
  return unicodeRange.split(',').some((part) => {
    const bounds = unicodeRangeBounds(part);
    if (!bounds) return false;
    for (const point of points) {
      if (point >= bounds[0] && point <= bounds[1]) return true;
    }
    return false;
  });
}

function loadFaces(sourceKey, weight) {
  const cacheKey = `${sourceKey}:${weight}`;
  if (faceCache.has(cacheKey)) return faceCache.get(cacheKey);
  const source = FONT_SOURCES[sourceKey];
  const cssPath = require.resolve(`${source.packageName}/${weight}.css`);
  const css = readFileSync(cssPath, 'utf8');
  const faces = [...css.matchAll(/@font-face\s*\{([\s\S]*?)\}/gu)].map((match) => {
    const block = match[1];
    const file = /url\((\.\/files\/[^)]+\.woff2)\)/u.exec(block)?.[1];
    const unicodeRange = /unicode-range:\s*([^;]+);/u.exec(block)?.[1];
    if (!file || !unicodeRange) return null;
    return Object.freeze({
      family: source.family,
      fontPath: resolve(dirname(cssPath), file),
      unicodeRange,
      weight,
    });
  }).filter(Boolean);
  faceCache.set(cacheKey, faces);
  return faces;
}

export function createCjkFontStyle(value) {
  const scripts = scriptsIn(value);
  if (scripts.length === 0) return '';
  const points = codePoints(value);
  const rules = [];
  for (const sourceKey of scripts) {
    for (const weight of FONT_WEIGHTS) {
      for (const face of loadFaces(sourceKey, weight)) {
        if (!rangeContainsCodePoint(face.unicodeRange, points)) continue;
        const font = readFileSync(face.fontPath).toString('base64');
        rules.push(`/* ${face.family} */ @font-face { font-family: '${FONT_FAMILY}'; font-style: normal; font-weight: ${weight}; src: url(data:font/woff2;base64,${font}) format('woff2'); unicode-range: ${face.unicodeRange}; }`);
      }
    }
  }
  return rules.length === 0 ? '' : `<style>${rules.join('')}</style>`;
}

export const SOCIAL_CARD_FONT_STACK = `${FONT_FAMILY}, Arial, sans-serif`;
