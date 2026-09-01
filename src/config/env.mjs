import {
  BLUESKY_SERVICE_URL,
  DEFAULT_SOCIAL_CHANNELS,
  INSTAGRAM_API_ORIGIN,
  MASTODON_BASE_URL,
  OPENINGS_ORIGIN,
  THREADS_API_URL,
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

function normalizeApiBase(value, fallback, key) {
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
  return url.toString().replace(/\/$/u, '');
}

export function readEnvironment({ env = process.env, mode = 'dry-run' } = {}) {
  const automatic = env.SOCIAL_AUTO_PUBLISH === 'true';
  const metaMigration = mode === 'meta-migration';
  const storyMode = mode === 'story';
  const requiresDeploy = mode === 'intake' || mode === 'scheduled' || mode === 'controlled' || metaMigration;
  const requiresSocial = mode === 'controlled' || (mode === 'scheduled' && automatic);
  const threadsEnabled = env.THREADS_AUTO_PUBLISH === 'true';
  const instagramEnabled = env.INSTAGRAM_AUTO_PUBLISH === 'true';
  const instagramStoryEnabled = env.INSTAGRAM_STORY_AUTO_PUBLISH === 'true';
  const enabledChannels = [
    ...DEFAULT_SOCIAL_CHANNELS,
    ...(threadsEnabled ? ['threads'] : []),
    ...(instagramEnabled ? ['instagram'] : []),
  ];

  if (requiresDeploy) {
    requireKeys(env, DEPLOY_KEYS);
  }
  if (requiresSocial) {
    requireKeys(env, SOCIAL_KEYS);
    if (threadsEnabled) requireKeys(env, ['THREADS_ACCESS_TOKEN']);
    if (instagramEnabled) {
      requireKeys(env, ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_USER_ID', 'META_GRAPH_VERSION']);
      if (!/^v\d+\.\d+$/u.test(env.META_GRAPH_VERSION)) {
        throw new Error('Invalid configuration: META_GRAPH_VERSION');
      }
    }
  }
  if (metaMigration) {
    requireKeys(env, [
      'THREADS_ACCESS_TOKEN',
      'INSTAGRAM_ACCESS_TOKEN',
      'INSTAGRAM_USER_ID',
      'META_GRAPH_VERSION',
    ]);
    if (!/^v\d+\.\d+$/u.test(env.META_GRAPH_VERSION)) {
      throw new Error('Invalid configuration: META_GRAPH_VERSION');
    }
  }
  if (storyMode) {
    requireKeys(env, ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_USER_ID', 'META_GRAPH_VERSION']);
    if (!/^v\d+\.\d+$/u.test(env.META_GRAPH_VERSION)) {
      throw new Error('Invalid configuration: META_GRAPH_VERSION');
    }
  }

  return Object.freeze({
    mode,
    publishEnabled: mode === 'controlled' || metaMigration || (mode === 'scheduled' && automatic),
    instagramStoryEnabled,
    enabledChannels: Object.freeze(enabledChannels),
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
    threads: (metaMigration || (requiresSocial && threadsEnabled)) ? Object.freeze({
      accessToken: env.THREADS_ACCESS_TOKEN,
      apiUrl: normalizeApiBase(env.THREADS_API_URL, THREADS_API_URL, 'THREADS_API_URL'),
    }) : null,
    instagram: (storyMode || metaMigration || (requiresSocial && instagramEnabled)) ? Object.freeze({
      accessToken: env.INSTAGRAM_ACCESS_TOKEN,
      userId: env.INSTAGRAM_USER_ID,
      apiVersion: env.META_GRAPH_VERSION,
      apiOrigin: normalizeOrigin(env.INSTAGRAM_API_ORIGIN, INSTAGRAM_API_ORIGIN, 'INSTAGRAM_API_ORIGIN'),
    }) : null,
  });
}
