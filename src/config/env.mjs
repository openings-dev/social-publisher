import {
  BLUESKY_SERVICE_URL,
  MASTODON_BASE_URL,
  OPENINGS_ORIGIN,
  WEB_DEPLOY_REPOSITORY,
} from './constants.mjs';

const DEPLOY_KEYS = ['WEB_DEPLOY_TOKEN'];
const SOCIAL_KEYS = ['BLUESKY_IDENTIFIER', 'BLUESKY_APP_PASSWORD', 'MASTODON_ACCESS_TOKEN'];

function requireKeys(env, keys) {
  const missing = keys.filter((key) => typeof env[key] !== 'string' || env[key].trim() === '');
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}

function normalizeOrigin(value, fallback, key) {
  const candidate = value?.trim() || fallback;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Invalid URL configuration: ${key}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid URL configuration: ${key}`);
  }
  return url.origin;
}

export function readEnvironment({ env = process.env, mode = 'dry-run' } = {}) {
  const automatic = env.SOCIAL_AUTO_PUBLISH === 'true';
  const requiresDeploy = mode === 'intake' || mode === 'scheduled' || mode === 'controlled';
  const requiresSocial = mode === 'controlled' || (mode === 'scheduled' && automatic);

  if (requiresDeploy) {
    requireKeys(env, DEPLOY_KEYS);
  }
  if (requiresSocial) {
    requireKeys(env, SOCIAL_KEYS);
  }

  return Object.freeze({
    mode,
    publishEnabled: mode === 'controlled' || (mode === 'scheduled' && automatic),
    publicSiteOrigin: normalizeOrigin(env.PUBLIC_SITE_ORIGIN, OPENINGS_ORIGIN, 'PUBLIC_SITE_ORIGIN'),
    mastodonBaseUrl: normalizeOrigin(env.MASTODON_BASE_URL, MASTODON_BASE_URL, 'MASTODON_BASE_URL'),
    blueskyServiceUrl: normalizeOrigin(env.BLUESKY_SERVICE_URL, BLUESKY_SERVICE_URL, 'BLUESKY_SERVICE_URL'),
    webDeploy: requiresDeploy ? Object.freeze({
      repository: env.WEB_DEPLOY_REPOSITORY?.trim() || WEB_DEPLOY_REPOSITORY,
      token: env.WEB_DEPLOY_TOKEN,
    }) : null,
    bluesky: requiresSocial ? Object.freeze({
      identifier: env.BLUESKY_IDENTIFIER,
      appPassword: env.BLUESKY_APP_PASSWORD,
    }) : null,
    mastodonAccessToken: requiresSocial ? env.MASTODON_ACCESS_TOKEN : null,
  });
}
