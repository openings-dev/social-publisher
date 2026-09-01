import { MAX_CHANNEL_ATTEMPTS } from '../../config/constants.mjs';
import { EDITORIAL_CATALOG_VERSION } from '../../content/editorial-copy-policy.mjs';
import { assertNoSensitiveKeys, validateStageState } from '../state/state-model.mjs';
import { validateEditorialCatalog } from './editorial-model.mjs';

const STAGES = new Set(['assets', 'feed', 'story']);
const CONTENT_VERSION_PATTERN = /^[1-9]\d*$/u;
const TRANSITIONS = Object.freeze({
  pending: new Set(['publishing', 'retryable', 'failed']),
  publishing: new Set(['published', 'retryable', 'failed']),
  retryable: new Set(['publishing', 'failed']),
  published: new Set(),
  failed: new Set(),
});

function stageState() {
  return { status: 'pending', attempts: 0, updatedAt: null, lastError: null, lastReset: null, result: null };
}

function iso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO date`);
  return value;
}

function code(value, fallback = 'unknown_error') {
  return typeof value === 'string' && /^[a-z0-9_-]{1,64}$/u.test(value) ? value : fallback;
}

export function createEmptyEditorialState() {
  return { schemaVersion: 1, catalogVersion: EDITORIAL_CATALOG_VERSION, pending: [], history: {} };
}

export function validateEditorialState(value, catalog = null) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('editorial state must be an object');
  if (value.schemaVersion !== 1 || value.catalogVersion !== EDITORIAL_CATALOG_VERSION) {
    throw new Error('editorial state version is unsupported');
  }
  if (!Array.isArray(value.pending) || value.history === null || typeof value.history !== 'object' || Array.isArray(value.history)) {
    throw new Error('editorial state collections are invalid');
  }
  const catalogVersions = catalog
    ? new Map(validateEditorialCatalog(catalog).map(({ id, version }) => [id, version]))
    : null;
  const seenIds = new Set();
  const seenDates = new Set();
  for (const item of value.pending) {
    if (typeof item?.contentId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.contentId)) {
      throw new Error('pending editorial contentId is invalid');
    }
    if (catalogVersions && !catalogVersions.has(item.contentId)) {
      throw new Error(`unknown pending editorial content: ${item.contentId}`);
    }
    if (seenIds.has(item.contentId) || seenDates.has(item.scheduledDate)) throw new Error('editorial pending items must be unique');
    seenIds.add(item.contentId);
    seenDates.add(item.scheduledDate);
    if (
      !CONTENT_VERSION_PATTERN.test(item.contentVersion)
      || (catalogVersions && catalogVersions.get(item.contentId) !== item.contentVersion)
      || !/^\d{4}-\d{2}-\d{2}$/u.test(item.scheduledDate)
    ) throw new Error('pending editorial metadata is invalid');
    iso(item.createdAt, 'pending editorial createdAt');
    for (const stage of STAGES) validateStageState(item[stage], `editorial ${stage}`);
  }
  for (const [contentId, entry] of Object.entries(value.history)) {
    if (catalogVersions && !catalogVersions.has(contentId)) throw new Error(`unknown editorial history content: ${contentId}`);
    iso(entry?.lastPublishedAt, 'editorial lastPublishedAt');
    if (!Number.isInteger(entry.cycles) || entry.cycles < 1) throw new Error('editorial history cycles is invalid');
    const publication = entry.lastPublication;
    if (publication === null || typeof publication !== 'object' || Array.isArray(publication)
      || !CONTENT_VERSION_PATTERN.test(publication.contentVersion)
      || !/^\d{4}-\d{2}-\d{2}$/u.test(publication.scheduledDate)) {
      throw new Error('editorial history publication is invalid');
    }
    for (const stage of STAGES) {
      if (publication[stage] === null || typeof publication[stage] !== 'object' || Array.isArray(publication[stage])) {
        throw new Error(`editorial history ${stage} result is invalid`);
      }
    }
  }
  assertNoSensitiveKeys(value, 'editorial state');
  return value;
}

export function enqueueEditorialItem(state, selection, { at = new Date().toISOString() } = {}) {
  validateEditorialState(state);
  iso(at, 'editorial enqueue timestamp');
  if (!selection?.content || typeof selection.scheduledDate !== 'string') throw new Error('editorial selection is invalid');
  if (state.pending.some(({ contentId, scheduledDate }) => (
    contentId === selection.content.id || scheduledDate === selection.scheduledDate
  ))) return state;
  return validateEditorialState({
    ...state,
    pending: [...state.pending, {
      contentId: selection.content.id,
      contentVersion: selection.content.version,
      pillar: selection.content.pillar,
      scheduledDate: selection.scheduledDate,
      createdAt: at,
      assets: stageState(),
      feed: stageState(),
      story: stageState(),
    }],
  });
}

export function transitionEditorialStage(state, contentId, stageName, nextStatus, {
  at = new Date().toISOString(), errorCode, result, intent,
} = {}) {
  validateEditorialState(state);
  if (!STAGES.has(stageName)) throw new Error(`unknown editorial stage: ${stageName}`);
  iso(at, 'editorial transition timestamp');
  const index = state.pending.findIndex((item) => item.contentId === contentId);
  if (index < 0) throw new Error(`pending editorial item not found: ${contentId}`);
  const item = state.pending[index];
  const current = item[stageName];
  if (current.status === nextStatus) return state;
  if (!TRANSITIONS[current.status]?.has(nextStatus)) {
    throw new Error(`invalid editorial transition: ${current.status} -> ${nextStatus}`);
  }
  const attempts = current.attempts + (nextStatus === 'publishing' ? 1 : 0);
  if (attempts > MAX_CHANNEL_ATTEMPTS) throw new Error('maximum editorial stage attempts reached');
  const effectiveStatus = nextStatus === 'retryable' && attempts >= MAX_CHANNEL_ATTEMPTS ? 'failed' : nextStatus;
  const nextStage = {
    ...current,
    status: effectiveStatus,
    attempts,
    updatedAt: at,
    lastError: ['retryable', 'failed'].includes(effectiveStatus) ? { code: code(errorCode), at } : null,
    result: effectiveStatus === 'published'
      ? { ...(result ?? {}) }
      : nextStatus === 'publishing' && intent
        ? { operationKey: intent.operationKey }
        : current.result,
  };
  const updated = { ...item, [stageName]: nextStage };
  if (stageName === 'story' && effectiveStatus === 'published') {
    const previous = state.history[contentId];
    return validateEditorialState({
      ...state,
      pending: state.pending.filter((candidate) => candidate.contentId !== contentId),
      history: {
        ...state.history,
        [contentId]: {
          lastPublishedAt: at,
          cycles: (previous?.cycles ?? 0) + 1,
          lastPublication: {
            scheduledDate: item.scheduledDate,
            contentVersion: item.contentVersion,
            assets: { ...(item.assets.result ?? {}) },
            feed: { ...(item.feed.result ?? {}) },
            story: { ...(nextStage.result ?? {}) },
          },
        },
      },
    });
  }
  const pending = state.pending.slice();
  pending[index] = updated;
  return validateEditorialState({ ...state, pending });
}

export function resetEditorialStage(state, contentId, stageName, {
  at = new Date().toISOString(), reason = 'manual_reset',
} = {}) {
  validateEditorialState(state);
  if (!STAGES.has(stageName)) throw new Error(`unknown editorial stage: ${stageName}`);
  iso(at, 'editorial reset timestamp');
  const index = state.pending.findIndex((item) => item.contentId === contentId);
  if (index < 0) throw new Error(`pending editorial item not found: ${contentId}`);
  const item = state.pending[index];
  if (item[stageName].status !== 'failed') throw new Error('only a failed editorial stage can be reset');
  const pending = state.pending.slice();
  pending[index] = {
    ...item,
    [stageName]: {
      ...stageState(),
      updatedAt: at,
      lastReset: { at, reason: code(reason, 'manual_reset') },
    },
  };
  return validateEditorialState({ ...state, pending });
}
