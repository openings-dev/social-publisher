import {
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  INSTAGRAM_CARD_VERSION,
  OPENINGS_ORIGIN,
  SOCIAL_VIDEO_VERSION,
} from '../../config/constants.mjs';
import { escapeAttribute, escapeHtml } from '../../shared/escape.mjs';
import { buildCanonicalJobUrl } from '../../shared/job-id.mjs';

const MAX_DESCRIPTION_LENGTH = 156;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function plainText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function truncate(value, maximum) {
  if (value.length <= maximum) {
    return value;
  }
  return `${value.slice(0, maximum - 1).trimEnd()}…`;
}

export function opportunityDescription(job) {
  const excerpt = plainText(job.excerpt);
  if (excerpt) {
    return truncate(excerpt, MAX_DESCRIPTION_LENGTH);
  }
  const community = plainText(job.community?.name) || plainText(job.repository);
  return truncate(
    `Review this job shared through ${community}, then open the original public listing for current details.`,
    MAX_DESCRIPTION_LENGTH,
  );
}

function versionedOpenGraphImageUrl(canonicalUrl, imageHash) {
  if (typeof imageHash !== 'string' || !SHA256_PATTERN.test(imageHash)) {
    throw new Error('Open Graph image hash is invalid');
  }
  return `${canonicalUrl}/opengraph-image.png?v=${imageHash.slice(0, 16)}`;
}

export function createBridgeHtml(job, { origin = OPENINGS_ORIGIN, imageHash } = {}) {
  const canonicalUrl = buildCanonicalJobUrl(job.id, origin);
  const imageUrl = versionedOpenGraphImageUrl(canonicalUrl, imageHash);
  const redirectUrl = `${origin.replace(/\/$/u, '')}/?job=${job.id}`;
  const description = opportunityDescription(job);
  const socialAlt = `${job.title} — Open job on openings.dev`;
  const title = job.title;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | openings.dev</title>
  <meta name="description" content="${escapeAttribute(description)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <meta name="theme-color" content="#b0ec9c">
  <link rel="canonical" href="${escapeAttribute(canonicalUrl)}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="openings.dev">
  <meta property="og:locale" content="en_US">
  <meta property="og:title" content="${escapeAttribute(title)}">
  <meta property="og:description" content="${escapeAttribute(description)}">
  <meta property="og:url" content="${escapeAttribute(canonicalUrl)}">
  <meta property="og:image" content="${escapeAttribute(imageUrl)}">
  <meta property="og:image:secure_url" content="${escapeAttribute(imageUrl)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="${IMAGE_WIDTH}">
  <meta property="og:image:height" content="${IMAGE_HEIGHT}">
  <meta property="og:image:alt" content="${escapeAttribute(socialAlt)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeAttribute(title)}">
  <meta name="twitter:description" content="${escapeAttribute(description)}">
  <meta name="twitter:image" content="${escapeAttribute(imageUrl)}">
  <meta name="twitter:image:alt" content="${escapeAttribute(socialAlt)}">
  <meta name="openings:data-hash" content="${escapeAttribute(job.contentHash)}">
  <meta name="openings:instagram-card-version" content="${INSTAGRAM_CARD_VERSION}">
  <meta name="openings:social-video-version" content="${SOCIAL_VIDEO_VERSION}">
  <style>
    :root { color-scheme: light; font-family: Arial, sans-serif; background: #f5f3ef; color: #21302e; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; }
    main { width: min(100%, 720px); padding: clamp(28px, 6vw, 56px); border: 1px solid #d8d8d1; border-radius: 24px; background: #fffefa; box-shadow: 0 18px 44px rgba(33,48,46,.10); }
    p { color: #5e6663; font-size: 18px; line-height: 1.6; }
    h1 { margin: 14px 0 18px; font-size: clamp(36px, 7vw, 64px); line-height: 1.02; letter-spacing: -.04em; }
    .eyebrow { margin: 0; color: #315d35; font-size: 13px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
    a { display: inline-flex; min-height: 48px; align-items: center; margin-top: 10px; padding: 0 20px; border-radius: 999px; background: #b0ec9c; color: #21302e; font-weight: 800; text-decoration: none; }
    a:focus-visible { outline: 3px solid #315d35; outline-offset: 3px; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Open job on openings.dev</p>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(description)}</p>
    <a href="${escapeAttribute(redirectUrl)}">View the current job details →</a>
  </main>
  <script>location.replace(${JSON.stringify(redirectUrl)})</script>
</body>
</html>
`;
}
