const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const graphemes = (value) => [...segmenter.segment(String(value))].map(({ segment }) => segment);

export function textWidth(value, fontSize) {
  return graphemes(value).reduce((width, character) => {
    if (/\s/u.test(character)) return width + fontSize * 0.32;
    if (/[ilIjtfr.,:;'!|]/u.test(character)) return width + fontSize * 0.36;
    if (/[MWmw@%]/u.test(character)) return width + fontSize * 0.94;
    if (/[A-Z0-9]/u.test(character)) return width + fontSize * 0.67;
    if (/[a-z]/u.test(character)) return width + fontSize * 0.59;
    if (/[-–—/()[\]]/u.test(character)) return width + fontSize * 0.46;
    return width + fontSize * 1.03;
  }, 0);
}

export function fitSingleLine(value, { fontSize, maxWidth }) {
  const parts = graphemes(String(value).replace(/\s+/gu, ' ').trim());
  if (textWidth(parts.join(''), fontSize) <= maxWidth) return parts.join('');
  while (parts.length && textWidth(`${parts.join('')}…`, fontSize) > maxWidth) parts.pop();
  return `${parts.join('').trimEnd()}…`;
}

export function fitPosterText(value, { sizes, maxWidth, maxLines = 2, maxHeight = Infinity }) {
  const input = String(value).replace(/\s+/gu, ' ').trim();
  let result;
  for (const fontSize of sizes) {
    const lines = [];
    let current = '';
    for (const word of input.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, fontSize) <= maxWidth) { current = candidate; continue; }
      if (current) { lines.push(current); current = ''; }
      for (const character of graphemes(word)) {
        if (current && textWidth(current + character, fontSize) > maxWidth) { lines.push(current); current = ''; }
        current += character;
      }
    }
    if (current) lines.push(current);
    const lineHeight = Math.round(fontSize * 1.06);
    const count = Math.min(maxLines, Math.floor(maxHeight / lineHeight));
    const truncated = lines.length > count;
    result = { lines: lines.slice(0, count), fontSize, lineHeight, truncated };
    if (!truncated) return result;
    const last = result.lines.length - 1;
    if (last >= 0) result.lines[last] = fitSingleLine(`${result.lines[last]}…`, { fontSize, maxWidth });
  }
  return result;
}

export function dominantFactTypography(fact, width) {
  const salary = fact.label === 'SALARY';
  const match = salary ? /^(.*)\/(hour|day|week|month|year)$/u.exec(fact.value) : null;
  const value = match?.[1] ?? fact.value;
  const period = match ? `per ${match[2]}` : null;
  return {
    ...fitPosterText(value, { sizes: [88, 80, 72, 64, 56, 48, 40], maxWidth: width, maxLines: salary ? 1 : 2, maxHeight: 160 }),
    period,
  };
}
