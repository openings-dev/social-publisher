import { formatSalary } from './format-job.mjs';

export const ARTWORK_VERSION = 4;
export const ARTWORK_ROTATION = Object.freeze(['night', 'editorial', 'night', 'lavender', 'night', 'peach']);
export const ARTWORK_DIRECTIONS = Object.freeze(['night', 'editorial', 'lavender', 'peach']);
const KEYS = ['version', 'direction', 'title', 'company', 'mode', 'place', 'salary', 'period'];

export function artworkAt(index) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Artwork sequence must be a non-negative integer');
  return ARTWORK_ROTATION[index % ARTWORK_ROTATION.length];
}

export function defaultArtworkDirection(jobId) {
  let hash = 0;
  for (const char of String(jobId)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return artworkAt(hash);
}

const useful = value => typeof value === 'string' && !/^unknown$/iu.test(value.trim())
  ? value.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim() : '';

export function validateArtworkModel(model) {
  if (!model || Array.isArray(model) || typeof model !== 'object'
    || JSON.stringify(Object.keys(model).sort()) !== JSON.stringify([...KEYS].sort())
    || model.version !== ARTWORK_VERSION || !ARTWORK_DIRECTIONS.includes(model.direction)) {
    throw new Error('Artwork model has invalid fields or version');
  }
  for (const key of KEYS.filter(key => !['version', 'direction'].includes(key))) {
    if (typeof model[key] !== 'string' || model[key].length > (key === 'title' ? 800 : 220)
      || /[\u0000-\u001F\u007F]/u.test(model[key])) throw new Error(`Artwork ${key} is invalid`);
  }
  if (!model.title.trim()) throw new Error('Artwork title is required');
  return Object.freeze(model);
}

export function createArtworkModel(job, { direction = defaultArtworkDirection(job.id) } = {}) {
  const company = useful(job.companyName).slice(0, 220);
  let title = useful(job.socialTitle ?? job.title).replace(/\s*\|\s*/gu, '—') || 'Open role';
  const context = [...(Array.isArray(job.tags) ? job.tags : []), job.country, job.region].map(useful).join(' ');
  const mode = /\bhybrid\b|híbrido/iu.test(context) ? 'Hybrid'
    : /\bon[ -]?site\b|presencial|in[ -]?office/iu.test(context) ? 'On-site'
      : /\bremote\b|remoto|worldwide|global/iu.test(context) ? 'Remote' : '';
  if (mode === 'Remote') title = title.replace(/^\[(?:remoto|remote)\]\s*/iu, '');
  if (company && title.toLowerCase().endsWith(` - ${company.toLowerCase()}`)) title = title.slice(0, -company.length - 3).trim();
  const locations = [job.country, job.region].map(useful).filter(value => value && !/^(remote|remoto)$/iu.test(value));
  const place = [...new Map(locations.map(value => [value.toLowerCase(), value])).values()].join(' · ').slice(0, 220);
  const salary = formatSalary(job.salary);
  return validateArtworkModel({ version: ARTWORK_VERSION, direction, title: title.slice(0, 800), company, mode, place,
    salary: salary?.replace(/\/(hour|day|week|month|year)$/u, '') || '',
    period: salary ? `per ${job.salary.period} · ${job.salary.currency}` : '',
  });
}

export function encodeArtworkModel(model) {
  return Buffer.from(JSON.stringify(validateArtworkModel(model))).toString('base64');
}

export function decodeArtworkModel(value) {
  if (typeof value !== 'string' || !value || value.length >= 8192
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error('Invalid artwork base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Noncanonical artwork base64');
  return validateArtworkModel(JSON.parse(bytes.toString('utf8')));
}
