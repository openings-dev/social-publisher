import { sha256 } from '../../shared/hash.mjs';
import { validateEditorialCatalog } from '../editorial/editorial-model.mjs';
import { selectEditorialItem } from '../editorial/editorial-scheduler.mjs';
import {
  enqueueEditorialItem,
  transitionEditorialStage,
  validateEditorialState,
} from '../editorial/editorial-state.mjs';
import { createEditorialSlideSvg } from '../render/editorial-card.mjs';
import { formatEditorialCaption } from '../render/editorial-caption.mjs';

const READY = new Set(['pending', 'publishing', 'retryable']);

function localDate(now, timeZone = 'America/Sao_Paulo') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function enqueueScheduledEditorial({ state, catalog, now = new Date().toISOString(), contentId = null }) {
  validateEditorialCatalog(catalog);
  validateEditorialState(state, catalog);
  let selection;
  if (contentId !== null) {
    if (state.pending.length > 0) {
      if (state.pending[0].contentId === contentId) return state;
      throw new Error(`Another editorial guide is already pending: ${state.pending[0].contentId}`);
    }
    const content = catalog.find((candidate) => candidate.id === contentId);
    if (!content) throw new Error(`Unknown editorial content: ${contentId}`);
    const scheduledDate = localDate(now);
    if (Object.values(state.history).some(({ lastPublication }) => (
      lastPublication.scheduledDate === scheduledDate
    ))) return state;
    selection = { content, scheduledDate };
  } else {
    selection = selectEditorialItem({ catalog, state, now });
  }
  return selection ? enqueueEditorialItem(state, selection, { at: now }) : state;
}

function prerequisitesMet(item, stage) {
  if (stage === 'assets') return true;
  if (stage === 'feed') return item.assets.status === 'published';
  return item.assets.status === 'published' && item.feed.status === 'published';
}

function safeErrorCode(error, stage) {
  if (typeof error?.code === 'string' && /^[a-z0-9_-]{1,64}$/u.test(error.code)) return error.code;
  return stage === 'assets' ? 'editorial_deploy_provider' : `instagram_editorial_${stage}`;
}

function assertOperationKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,96}$/u.test(value)) {
    throw new Error('Editorial operation key is required');
  }
  return value;
}

export function assessEditorialStoryReuse(media) {
  let url;
  try { url = new URL(media?.url); } catch { return Object.freeze({ supported: false, reason: 'editorial_story_media_contract_missing' }); }
  if (url.protocol !== 'https:' || media.mediaType !== 'image/jpeg'
    || !Number.isSafeInteger(media.width) || !Number.isSafeInteger(media.height)
    || media.width < 1 || media.height < 1) {
    return Object.freeze({ supported: false, reason: 'editorial_story_media_contract_missing' });
  }
  if (media.width * 16 !== media.height * 9) {
    return Object.freeze({ supported: false, reason: 'editorial_story_feed_media_compatibility_unverified' });
  }
  return Object.freeze({ supported: true, media: Object.freeze({
    url: url.toString(), mediaType: media.mediaType, width: media.width, height: media.height,
  }) });
}

export function prepareEditorialStageIntent({
  state,
  catalog,
  stage,
  operationKey,
  now = new Date().toISOString(),
}) {
  validateEditorialCatalog(catalog);
  validateEditorialState(state, catalog);
  if (stage !== 'story') throw new Error('Only the editorial Story uses a manual-review intent boundary');
  const safeOperationKey = assertOperationKey(operationKey);
  const waiting = state.pending.filter((item) => READY.has(item[stage].status));
  const selected = waiting.find((item) => prerequisitesMet(item, stage));
  if (!selected) return { outcome: waiting.length > 0 ? 'blocked' : 'idle', selectedContentId: null, state };
  if (selected[stage].status === 'publishing') {
    if (selected[stage].result?.operationKey === safeOperationKey) {
      return { outcome: 'prepared', selectedContentId: selected.contentId, state };
    }
    const failed = transitionEditorialStage(state, selected.contentId, stage, 'failed', {
      at: now,
      errorCode: 'instagram_story_interrupted',
    });
    return { outcome: 'failed_manual_review', selectedContentId: selected.contentId, state: failed, errorCode: 'instagram_story_interrupted' };
  }
  const prepared = transitionEditorialStage(state, selected.contentId, stage, 'publishing', {
    at: now,
    intent: { operationKey: safeOperationKey },
  });
  return { outcome: 'prepared', selectedContentId: selected.contentId, state: prepared };
}

export async function processEditorialStage({
  state,
  catalog,
  stage,
  now = new Date().toISOString(),
  wordmarkSvg,
  deployAssets,
  publishCarousel,
  publishStory,
  operationKey,
  persistState = async () => {},
}) {
  validateEditorialCatalog(catalog);
  validateEditorialState(state, catalog);
  if (!['assets', 'feed', 'story'].includes(stage)) throw new Error(`Unknown editorial stage: ${stage}`);
  const waiting = state.pending.filter((item) => READY.has(item[stage].status));
  const selected = waiting.find((item) => prerequisitesMet(item, stage));
  if (!selected) return { outcome: waiting.length > 0 ? 'blocked' : 'idle', selectedContentId: null, state };
  const content = catalog.find((item) => item.id === selected.contentId);
  let nextState;
  if (stage === 'story') {
    const safeOperationKey = assertOperationKey(operationKey);
    if (selected.story.status !== 'publishing' || selected.story.result?.operationKey !== safeOperationKey) {
      if (selected.story.status === 'publishing') {
        nextState = transitionEditorialStage(state, content.id, stage, 'failed', {
          at: now,
          errorCode: 'instagram_story_interrupted',
        });
        return { outcome: 'failed_manual_review', selectedContentId: content.id, state: nextState, errorCode: 'instagram_story_interrupted' };
      }
      return { outcome: 'blocked', selectedContentId: content.id, state };
    }
    nextState = state;
  } else {
    nextState = transitionEditorialStage(state, content.id, stage, 'publishing', { at: now });
    await persistState(nextState);
  }
  try {
    let result;
    if (stage === 'assets') {
      if (typeof deployAssets !== 'function') throw new Error('Editorial asset deployment is unavailable');
      const carouselSvgs = content.slides.map((_, index) => createEditorialSlideSvg(content, index, { wordmarkSvg }));
      const deployment = await deployAssets({ content, carouselSvgs });
      const verification = deployment?.verification;
      if (!verification || !Array.isArray(verification.carouselUrls) || verification.carouselUrls.length !== 7
        || !Array.isArray(verification.carouselMedia) || verification.carouselMedia.length !== 7
        || verification.carouselMedia.some((media, index) => media?.url !== verification.carouselUrls[index]
          || media.mediaType !== 'image/jpeg' || media.width !== 1080 || media.height !== 1350)) {
        throw new Error('Editorial deployment returned invalid public assets');
      }
      result = {
        status: deployment.status,
        ...(typeof verification.manifestUrl === 'string' ? { manifestUrl: verification.manifestUrl } : {}),
        carouselUrls: [...verification.carouselUrls],
        carouselMedia: verification.carouselMedia.map((media) => ({ ...media })),
      };
    } else if (stage === 'feed') {
      if (typeof publishCarousel !== 'function') throw new Error('Editorial carousel publisher is unavailable');
      const assets = selected.assets.result;
      const reconciliationMarker = `#OpeningsGuide${sha256(`${content.id}:${selected.scheduledDate}`).slice(0, 10)}`;
      result = await publishCarousel({
        imageUrls: assets.carouselUrls,
        caption: `${formatEditorialCaption(content)}\n\n${reconciliationMarker}`,
        reconciliationMarker,
        content,
      });
    } else {
      const candidate = selected.assets.result.carouselMedia?.[0] ?? {
        url: selected.assets.result.carouselUrls?.[0], mediaType: null, width: null, height: null,
      };
      const compatibility = assessEditorialStoryReuse(candidate);
      if (!compatibility.supported) {
        result = { status: 'unsupported', reason: compatibility.reason,
          mediaUrl: candidate.url ?? null, mediaType: candidate.mediaType, width: candidate.width, height: candidate.height };
        nextState = transitionEditorialStage(nextState, content.id, stage, 'published', { at: now, result });
        return { outcome: 'unsupported', selectedContentId: content.id, state: nextState, result };
      }
      if (typeof publishStory !== 'function') throw new Error('Editorial Story publisher is unavailable');
      result = await publishStory({ mediaUrl: compatibility.media.url, mediaKind: 'image',
        width: compatibility.media.width, height: compatibility.media.height, content });
    }
    nextState = transitionEditorialStage(nextState, content.id, stage, 'published', { at: now, result });
    return { outcome: 'published', selectedContentId: content.id, state: nextState, result };
  } catch (error) {
    const errorCode = safeErrorCode(error, stage);
    const manualReview = stage === 'story' && errorCode === 'instagram_story_ambiguous';
    nextState = transitionEditorialStage(nextState, content.id, stage, manualReview ? 'failed' : 'retryable', {
      at: now,
      errorCode,
    });
    return {
      outcome: manualReview ? 'failed_manual_review' : 'retryable',
      selectedContentId: content.id,
      state: nextState,
      errorCode,
    };
  }
}
