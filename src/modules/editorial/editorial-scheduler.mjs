import { validateEditorialCatalog } from './editorial-model.mjs';
import { validateEditorialState } from './editorial-state.mjs';

const DAY_SLOTS = Object.freeze({
  Mon: ['linkedin'],
  Wed: ['resume', 'application'],
  Fri: ['search', 'interview'],
});

function localParts(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('scheduler date is invalid');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
}

export function slotForDate(now, { timeZone = 'America/Sao_Paulo' } = {}) {
  const parts = localParts(now, timeZone);
  const pillars = DAY_SLOTS[parts.weekday];
  if (!pillars) return null;
  return { key: `${parts.year}-${parts.month}-${parts.day}`, pillars: [...pillars] };
}

export function selectEditorialItem({ catalog, state, now = new Date().toISOString(), timeZone = 'America/Sao_Paulo' }) {
  validateEditorialCatalog(catalog);
  validateEditorialState(state, catalog);
  const slot = slotForDate(now, { timeZone });
  if (!slot || state.pending.length > 0) return null;
  if (Object.values(state.history).some(({ lastPublication }) => (
    lastPublication.scheduledDate === slot.key
  ))) return null;
  const pendingIds = new Set(state.pending.map(({ contentId }) => contentId));
  const nowMs = Date.parse(now);
  const eligible = catalog.filter((content) => {
    if (!slot.pillars.includes(content.pillar) || pendingIds.has(content.id)) return false;
    const last = state.history[content.id]?.lastPublishedAt;
    return !last || nowMs - Date.parse(last) >= content.minRepeatDays * 24 * 60 * 60 * 1000;
  });
  eligible.sort((left, right) => {
    const leftLast = state.history[left.id]?.lastPublishedAt;
    const rightLast = state.history[right.id]?.lastPublishedAt;
    if (!leftLast && rightLast) return -1;
    if (leftLast && !rightLast) return 1;
    if (leftLast !== rightLast) return String(leftLast ?? '').localeCompare(String(rightLast ?? ''));
    return left.id.localeCompare(right.id);
  });
  return eligible[0] ? { content: eligible[0], scheduledDate: slot.key } : null;
}
