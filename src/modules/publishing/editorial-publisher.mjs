import { sha256 } from '../../shared/hash.mjs';
import { validateEditorialCatalog } from '../editorial/editorial-model.mjs';
import { selectEditorialItem } from '../editorial/editorial-scheduler.mjs';
import {
  enqueueEditorialItem,
  transitionEditorialStage,
  validateEditorialState,
} from '../editorial/editorial-state.mjs';
import { createEditorialSlideSvg, createEditorialStorySvg } from '../render/editorial-card.mjs';
import { formatEditorialCaption } from '../render/editorial-caption.mjs';

const READY = new Set(['pending', 'retryable']);

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
    if (state.pending.length > 0) return state;
    const content = catalog.find((candidate) => candidate.id === contentId);
    if (!content) throw new Error(`Unknown editorial content: ${contentId}`);
    selection = { content, scheduledDate: localDate(now) };
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

export async function processEditorialStage({
  state,
  catalog,
  stage,
  now = new Date().toISOString(),
  wordmarkSvg,
  deployAssets,
  publishCarousel,
  publishStory,
  persistState = async () => {},
}) {
  validateEditorialCatalog(catalog);
  validateEditorialState(state, catalog);
  if (!['assets', 'feed', 'story'].includes(stage)) throw new Error(`Unknown editorial stage: ${stage}`);
  const waiting = state.pending.filter((item) => READY.has(item[stage].status));
  const selected = waiting.find((item) => prerequisitesMet(item, stage));
  if (!selected) return { outcome: waiting.length > 0 ? 'blocked' : 'idle', selectedContentId: null, state };
  const content = catalog.find((item) => item.id === selected.contentId);
  let nextState = transitionEditorialStage(state, content.id, stage, 'publishing', { at: now });
  await persistState(nextState);
  try {
    let result;
    if (stage === 'assets') {
      if (typeof deployAssets !== 'function') throw new Error('Editorial asset deployment is unavailable');
      const carouselSvgs = content.slides.map((_, index) => createEditorialSlideSvg(content, index, { wordmarkSvg }));
      const storySvg = createEditorialStorySvg(content, { wordmarkSvg });
      const deployment = await deployAssets({ content, carouselSvgs, storySvg });
      const verification = deployment?.verification;
      if (!verification || !Array.isArray(verification.carouselUrls) || verification.carouselUrls.length !== 7
        || typeof verification.storyUrl !== 'string') {
        throw new Error('Editorial deployment returned invalid public assets');
      }
      result = {
        status: deployment.status,
        manifestUrl: verification.manifestUrl,
        carouselUrls: [...verification.carouselUrls],
        storyUrl: verification.storyUrl,
      };
    } else if (stage === 'feed') {
      if (typeof publishCarousel !== 'function') throw new Error('Editorial carousel publisher is unavailable');
      const assets = selected.assets.result;
      const reconciliationMarker = `#OpeningsGuide${sha256(content.id).slice(0, 10)}`;
      result = await publishCarousel({
        imageUrls: assets.carouselUrls,
        caption: `${formatEditorialCaption(content)}\n\n${reconciliationMarker}`,
        reconciliationMarker,
        content,
      });
    } else {
      if (typeof publishStory !== 'function') throw new Error('Editorial Story publisher is unavailable');
      result = await publishStory({ mediaUrl: selected.assets.result.storyUrl, mediaKind: 'image', content });
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
