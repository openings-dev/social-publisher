import { INSTAGRAM_CARD_VERSION, OPENINGS_ORIGIN } from '../../config/constants.mjs';

const HASH = /^[0-9a-f]{64}$/u;
const isHash = value => typeof value === 'string' && HASH.test(value);

export function hasInstagramFeedImage(bridge) {
  if (bridge?.instagramFeedMediaKind !== 'image'
    || bridge.instagramCardVersion !== INSTAGRAM_CARD_VERSION
    || !isHash(bridge.instagramJpegHash)) return false;
  try {
    const url = new URL(bridge.instagramImageUrl);
    return url.protocol === 'https:' && url.pathname.toLowerCase().endsWith('.jpg')
      && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function hasRecordedVideo(candidate, jobId) {
  if (!candidate || !isHash(candidate.pngHash) || !isHash(candidate.instagramSvgHash)
    || typeof candidate.socialVideoVersion !== 'string'
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(candidate.socialVideoVersion)) return false;
  const prefix = `${OPENINGS_ORIGIN}/jobs/${jobId}`;
  const version = `${candidate.socialVideoVersion}.${candidate.instagramSvgHash.slice(0, 16)}`;
  return candidate.socialVideoUrl === `${prefix}/social-video.mp4?v=${version}`
    && candidate.socialVideoCoverUrl === `${prefix}/social-video-cover.jpg?v=${version}`;
}

// A published legacy bridge records HTTP/type/ftyp and cover-dimension checks.
// These hashes identify its source artwork; they are not a decoded MP4 checksum.
export function pendingBridgeMediaResult(item) {
  const previous = item.bridge.result;
  if (item.bridge.status !== 'published') {
    return previous?.storyMediaCandidate ? { storyMediaCandidate: previous.storyMediaCandidate } : null;
  }
  if (!hasRecordedVideo(previous, item.jobId)) return null;
  return { storyMediaCandidate: {
    contentHash: item.contentHash,
    socialTitle: previous.socialTitle ?? null,
    visualDirection: previous.visualDirection ?? null,
    pngHash: previous.pngHash,
    instagramSvgHash: previous.instagramSvgHash,
    socialVideoUrl: previous.socialVideoUrl,
    socialVideoCoverUrl: previous.socialVideoCoverUrl,
    socialVideoVersion: previous.socialVideoVersion,
  } };
}

export function retainedStoryMedia(candidate, { job, direction, bridge }) {
  if (!hasRecordedVideo(candidate, job.id)
    || candidate.contentHash !== job.contentHash
    || candidate.socialTitle !== (job.socialTitle ?? null)
    || (candidate.visualDirection !== null && candidate.visualDirection !== direction)
    || candidate.pngHash !== bridge.pngHash
    || candidate.instagramSvgHash !== bridge.instagramSvgHash) return {};
  return {
    socialVideoUrl: candidate.socialVideoUrl,
    socialVideoCoverUrl: candidate.socialVideoCoverUrl,
    socialVideoVersion: candidate.socialVideoVersion,
  };
}
