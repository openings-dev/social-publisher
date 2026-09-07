import { escapeHtml } from '../../shared/escape.mjs';
import { fitPosterText, fitSingleLine as fitLine } from './poster-typography.mjs';
import { createArtworkModel, validateArtworkModel, encodeArtworkModel } from './job-poster-model.mjs';

// Exact web tokens. Night anchors the sequence; only the editorial surface varies.
export const ARTWORK_STYLES = Object.freeze({
  night: Object.freeze({ label: 'Night', layout: 'night', background: '#172624' }),
  editorial: Object.freeze({ label: 'Editorial · Papel', layout: 'editorial', background: '#FFFEFA' }),
  lavender: Object.freeze({ label: 'Editorial · Lavanda', layout: 'editorial', background: '#EEE8F8' }),
  peach: Object.freeze({ label: 'Editorial · Pêssego', layout: 'editorial', background: '#FFE2D7' }),
});
export const ARTWORK_ROTATION = Object.freeze(['night', 'editorial', 'night', 'lavender', 'night', 'peach']);

// Internal conservative composition guides, not universal platform guarantees.
export const ARTWORK_FORMATS = Object.freeze({
  feed: { width: 1080, height: 1350, safe: { x: 108, y: 144, width: 864, height: 1062 } },
  story: { width: 1080, height: 1920, safe: { x: 108, y: 280, width: 864, height: 1256 } },
  reel: { width: 1080, height: 1920, safe: { x: 108, y: 280, width: 864, height: 1256 } },
  link: { width: 1200, height: 630, safe: { x: 72, y: 60, width: 1056, height: 510 } },
});

const fitSingleLine = (value, maxWidth, fontSize) => fitLine(value, { maxWidth, fontSize });

function text(value, x, y, size, { color = '#21302E', weight = 450, anchor = 'start', family = 'Figtree', spacing = 0 } = {}) {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="${family}, Noto Sans CJK SC, Noto Sans CJK JP, Noto Sans CJK KR, Arial, sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${spacing}">${escapeHtml(value)}</text>`;
}

function lines(value, x, top, width, height, { size = 100, maxLines = 4, ...options } = {}) {
  const fit = fitPosterText(value, { maxWidth: width, maxHeight: height, maxLines, sizes: [size, size - 8, size - 16, size - 24, size - 32] });
  return { svg: fit.lines.map((line, index) => text(line, x, top + fit.fontSize + index * fit.lineHeight, fit.fontSize, options).replace('<text ', '<text data-title-line="true" ')).join(''), bottom: top + fit.lines.length * fit.lineHeight };
}

function rule(x, y, width, dark = false) {
  return `<path d="M${x} ${y}h${width}" stroke="${dark ? '#52605C' : '#DDD9D2'}"/>`;
}

function logo(wordmarkSvg, x, y, width, dark = false) {
  const content = dark ? wordmarkSvg.replace(/#21302e/giu, '#F2F4F1') : wordmarkSvg;
  return `<image data-instagram-wordmark="true" x="${x}" y="${y}" width="${width}" height="${width * 219 / 1202}" href="data:image/svg+xml;base64,${Buffer.from(content).toString('base64')}"/>`;
}

function action(x, y, width = 320, size = 30, { dark = false, link = false, center = false } = {}) {
  return `<g data-block="action">${text(link ? '→ openings.dev' : '→ Link na bio', center ? x + width / 2 : x, y + 46, size, { weight: 550, color: dark ? '#B0EC9C' : '#21302E', anchor: center ? 'middle' : 'start' })}</g>`;
}

function verticalAction(x, y, { width, height, size, dark = false }) {
  return `<g data-block="action">${text('→ Link na bio', dark ? x + width / 2 : x, y + height / 2 + size * .34, size, { weight: 550, color: dark ? '#B0EC9C' : '#21302E', anchor: dark ? 'middle' : 'start' })}</g>`;
}

// Organic Story composition. Its larger internal guide is not a universal ad-safe zone.
function story(data, wordmarkSvg, { dark }) {
  const left = 108, width = 864, x = dark ? 540 : left;
  const ink = dark ? '#F2F4F1' : '#21302E', muted = dark ? '#B7BFBB' : '#5E6663';
  const anchor = dark ? 'middle' : 'start';
  const location = fitPosterText(data.place, { sizes: [44], maxWidth: width, maxHeight: 106, maxLines: 2 });
  const salary = fitPosterText(data.salary, { sizes: [96, 88, 80, 72, 64, 56], maxWidth: width, maxHeight: 112, maxLines: 1 });
  return `${logo(wordmarkSvg, dark ? 365 : left, 304, 350, dark)}
    ${!dark ? rule(left, 405, width) : ''}
    <g data-block="role">${lines(data.title, x, 440, width - 16, 400, { size: 124, maxLines: 4, weight: dark ? 500 : 550, color: ink, anchor, spacing: -2.4 }).svg}</g>
    ${data.company ? `<g data-block="company">${text(fitSingleLine(data.company, width, 42), x, 918, 42, { color: muted, anchor })}</g>` : ''}
    <g data-block="work">${data.mode ? text(data.mode, x, 1010, 48, { weight: 550, color: ink, anchor }) : ''}
    ${location.lines.map((line, index) => text(line, x, 1080 + index * 54, 44, { color: muted, anchor })).join('')}</g>
    ${data.salary ? `<g data-block="compensation">${rule(dark ? 452 : left, 1170, dark ? 176 : width, dark)}
    ${text(salary.lines[0], x, 1178 + salary.fontSize, salary.fontSize, { weight: 500, color: ink, anchor })}
    ${text(data.period, x, 1338, 38, { color: muted, anchor })}</g>` : ''}
    ${verticalAction(dark ? 180 : left, 1396, { width: dark ? 720 : width, height: 120, size: 48, dark })}`;
}

function facts(data, x, y, width, { dark = false, center = false, compact = false } = {}) {
  const ink = dark ? '#F2F4F1' : '#21302E', muted = dark ? '#B7BFBB' : '#5E6663';
  const anchor = center ? 'middle' : 'start';
  let svg = '';
  if (data.salary) {
    const fit = fitPosterText(data.salary, { maxWidth: width, maxHeight: 90, maxLines: 1, sizes: compact ? [52, 46, 40, 34, 28, 24, 20] : [76, 68, 60, 52, 44, 36] });
    svg += text(fit.lines[0], x, y + fit.fontSize, fit.fontSize, { weight: 500, color: ink, anchor });
    svg += text(data.period, x, y + (compact ? 87 : 114), compact ? 24 : 28, { color: muted, anchor });
  }
  return svg;
}

function editorial(data, format, wordmarkSvg) {
  if (format === 'link') {
    return `${logo(wordmarkSvg, 72, 62, 248)}
      ${rule(72, 132, 1056)}
      ${lines(data.title, 72, 174, 670, 235, { size: 72, maxLines: 3, weight: 550, spacing: -1.7 }).svg}
      ${text(fitSingleLine(data.company, 640, 27), 72, 446, 27, { color: '#5E6663' })}
      ${data.salary ? rule(798, 201, 330) : ''}${facts(data, 798, 232, 330, { compact: true })}
      ${text(fitSingleLine([data.mode, data.place].filter(Boolean).join(' · '), 650, 25), 72, 531, 25)}
      ${action(798, 474, 330, 28, { link: true })}`;
  }
  const reel = format === 'reel', x = 108, width = reel ? 810 : 864;
  const brandY = reel ? 338 : 160, titleY = reel ? 470 : 316;
  const titleBlock = lines(data.title, x, titleY, width - 20, reel ? 282 : 320, { size: reel ? 92 : 112, maxLines: reel ? 3 : 4, weight: 550, spacing: -2.4 });
  const companyY = reel ? 820 : 775;
  const salaryY = reel ? 924 : 919;
  return `${logo(wordmarkSvg, x, brandY, 290)}
    ${rule(x, brandY + 96, width)}
    ${titleBlock.svg}
    ${text(fitSingleLine(data.company, width, 34), x, companyY, 34, { color: '#5E6663' })}
    ${text(fitSingleLine([data.mode, data.place].filter(Boolean).join(' · '), width, reel ? 38 : 29), x, companyY + 53, reel ? 38 : 29)}
    ${data.salary ? rule(x, salaryY - 22, width) : ''}
    ${facts(data, x, salaryY, width)}
    ${reel ? verticalAction(x, 1140, { width: 460, height: 96, size: 40 }) : action(x, 1115)}
    ${text('openings.dev', x + width, reel ? 1195 : 1160, 28, { anchor: 'end', color: '#5E6663' })}`;
}

function night(data, format, wordmarkSvg) {
  const ink = '#F2F4F1', muted = '#B7BFBB';
  if (format === 'link') {
    return `${logo(wordmarkSvg, 72, 62, 248, true)}
      ${lines(data.title, 72, 177, 710, 222, { size: 76, maxLines: 3, weight: 500, spacing: -1.7, color: ink }).svg}
      ${text(fitSingleLine([data.company, data.mode].filter(Boolean).join(' · '), 710, 27), 72, 450, 27, { color: muted })}
      ${text(fitSingleLine(data.place, 700, 25), 72, 502, 25, { color: muted })}
      ${facts(data, 830, 236, 298, { dark: true, compact: true })}
      ${action(798, 474, 330, 28, { link: true, dark: true })}`;
  }
  const reel = format === 'reel', cx = reel ? 513 : 540, width = reel ? 810 : 864;
  const brandY = reel ? 338 : 160, titleY = reel ? 473 : 320;
  return `${logo(wordmarkSvg, cx - 145, brandY, 290, true)}
    ${lines(data.title, cx, titleY, width - 64, reel ? 285 : 335, { size: reel ? 90 : 108, maxLines: reel ? 3 : 4, weight: 500, color: ink, spacing: -2.2, anchor: 'middle' }).svg}
    ${text(fitSingleLine(data.company, width, 32), cx, reel ? 847 : 792, 32, { color: muted, anchor: 'middle' })}
    ${data.salary ? rule(cx - 88, reel ? 905 : 850, 176, true) : ''}
    ${facts(data, cx, reel ? 922 : 888, width, { dark: true, center: true })}
    ${text(fitSingleLine([data.mode, data.place].filter(Boolean).join(' · '), width, reel ? 38 : 28), cx, reel ? 1090 : 1060, reel ? 38 : 28, { color: muted, anchor: 'middle' })}
    ${reel ? verticalAction(cx - 230, 1140, { width: 460, height: 96, size: 40, dark: true }) : action(cx - 160, 1115, 320, 30, { dark: true, center: true })}`;
}

export function createJobPosterSvg(model, { format, wordmarkSvg }) {
  const data = validateArtworkModel(model);
  const { direction } = data;
  if (typeof wordmarkSvg !== 'string' || !/^\s*<svg\b/iu.test(wordmarkSvg)
    || /<!DOCTYPE|<!ENTITY|<(?:script|foreignObject)\b|\bon[a-z]+\s*=|(?:href|src)\s*=|@import|url\(/iu.test(wordmarkSvg)) throw new Error('A trusted canonical SVG wordmark is required');
  if (!ARTWORK_FORMATS[format]) throw new Error('Unknown artwork format');
  const { width, height, safe } = ARTWORK_FORMATS[format];
  const style = ARTWORK_STYLES[direction];
  if (!style) throw new Error(`Unknown concept style: ${direction}`);
  const dark = style.layout === 'night';
  const background = style.background;
  // Only paper edges extend into the bleed. Essential content stays in the guide.
  const bleed = !dark && format !== 'link' ? `<path d="M${width - 26} 0v${height}M0 ${height - 32}h${width}" stroke="#21302E" stroke-opacity=".10"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(data.title)}" ${format === 'feed' ? `data-instagram-card="true" data-social-poster-version="4" data-poster-model="${encodeArtworkModel(data)}" ` : ''}data-artwork-revision="2" data-direction="${direction}" data-safe="${safe.x},${safe.y},${safe.width},${safe.height}">
    <title>${escapeHtml([data.title, data.company, data.salary, data.period, data.mode, data.place].filter(Boolean).join(' · '))}</title>
    <rect width="${width}" height="${height}" fill="${background}"/>${bleed}
    <g data-essential="true">${['story', 'reel'].includes(format) ? story(data, wordmarkSvg, { dark }) : dark ? night(data, format, wordmarkSvg) : editorial(data, format, wordmarkSvg)}</g>
  </svg>`;
}

export function createArtworkSvg(job, options) {
  return createJobPosterSvg(createArtworkModel(job, options), options);
}
