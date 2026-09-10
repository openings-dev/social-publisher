import {
  BLUESKY_SERVICE_URL,
  BUFFER_API_ORIGIN,
  DEFAULT_SOCIAL_CHANNELS,
  INSTAGRAM_API_ORIGIN,
  LINKEDIN_API_ORIGIN,
  MASTODON_BASE_URL,
  OPENINGS_ORIGIN,
  THREADS_API_URL,
  WEB_DEPLOY_REPOSITORY,
} from './constants.mjs';

const DEPLOY_KEYS = ['WEB_DEPLOY_TOKEN'];
const SOCIAL_KEYS = [
  'BLUESKY_IDENTIFIER',
  'BLUESKY_APP_PASSWORD',
  'MASTODON_ACCESS_TOKEN',
  'BUFFER_API_KEY',
  'BUFFER_ORGANIZATION_ID',
  'BUFFER_TWITTER_CHANNEL_ID',
];

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

function normalizeExactOrigin(value, fallback, key) {
  const candidate = value?.trim() || fallback;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Invalid URL configuration: ${key}`);
  }
  if (url.pathname !== '/') {
    throw new Error(`Invalid URL configuration: ${key}`);
  }
  return normalizeOrigin(candidate, fallback, key);
}

export function readEnvironment({ env = process.env, mode = 'dry-run', intakeStrategy = 'legacy' } = {}) {
  if (intakeStrategy !== 'legacy' && intakeStrategy !== 'selected-media-owner') {
    throw new Error('Intake strategy is invalid');
  }
  const automatic = env.SOCIAL_AUTO_PUBLISH === 'true';
  const metaMigration = mode === 'meta-migration';
  const storyMode = mode === 'story';
  const editorialAssetsMode = mode === 'editorial-assets';
  const editorialInstagramMode = mode === 'editorial-feed' || mode === 'editorial-story';
  const selectedMediaOwnerIntake = mode === 'intake' && intakeStrategy === 'selected-media-owner';
  const requiresDeploy = (mode === 'intake' && !selectedMediaOwnerIntake)
    || mode === 'scheduled' || mode === 'controlled' || metaMigration || editorialAssetsMode;
  const requiresSocial = mode === 'controlled' || (mode === 'scheduled' && automatic);
  const platformMastodonEnabled = requiresSocial && env.PUBLISHING_MASTODON_ENABLED === 'true';
  const threadsEnabled = env.THREADS_AUTO_PUBLISH === 'true';
  const instagramEnabled = env.INSTAGRAM_AUTO_PUBLISH === 'true';
  const linkedinEnabled = env.LINKEDIN_AUTO_PUBLISH === 'true';
  const linkedinProvider = env.LINKEDIN_PROVIDER?.trim() || 'direct';
  const instagramStoryEnabled = env.INSTAGRAM_STORY_AUTO_PUBLISH === 'true';
  const instagramEditorialEnabled = env.INSTAGRAM_EDITORIAL_AUTO_PUBLISH === 'true';
  const enabledChannels = [
    ...DEFAULT_SOCIAL_CHANNELS,
    ...(threadsEnabled ? ['threads'] : []),
    ...(instagramEnabled ? ['instagram'] : []),
    ...(linkedinEnabled ? ['linkedin'] : []),
  ];

  if (requiresDeploy) {
    requireKeys(env, DEPLOY_KEYS);
  }
  if (requiresSocial) {
    requireKeys(env, SOCIAL_KEYS.filter(key => !(platformMastodonEnabled && key === 'MASTODON_ACCESS_TOKEN')));
    if (threadsEnabled) requireKeys(env, ['THREADS_ACCESS_TOKEN']);
    if (instagramEnabled) {
      requireKeys(env, ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_USER_ID', 'META_GRAPH_VERSION']);
      if (!/^v\d+\.\d+$/u.test(env.META_GRAPH_VERSION)) {
        throw new Error('Invalid configuration: META_GRAPH_VERSION');
      }
    }
    if (linkedinEnabled) {
      if (linkedinProvider === 'direct') {
        requireKeys(env, [
          'LINKEDIN_ACCESS_TOKEN',
          'LINKEDIN_ORGANIZATION_ID',
          'LINKEDIN_API_VERSION',
        ]);
        if (!/^[1-9][0-9]{0,19}$/u.test(env.LINKEDIN_ORGANIZATION_ID)) {
          throw new Error('Invalid configuration: LINKEDIN_ORGANIZATION_ID');
        }
        if (!/^20[0-9]{4}$/u.test(env.LINKEDIN_API_VERSION)) {
          throw new Error('Invalid configuration: LINKEDIN_API_VERSION');
        }
      } else if (linkedinProvider === 'buffer') {
        requireKeys(env, [
          'BUFFER_API_KEY',
          'BUFFER_ORGANIZATION_ID',
          'BUFFER_LINKEDIN_CHANNEL_ID',
        ]);
      } else {
        throw new Error('Invalid configuration: LINKEDIN_PROVIDER');
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
  if (storyMode || editorialInstagramMode) {
    requireKeys(env, ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_USER_ID', 'META_GRAPH_VERSION']);
    if (!/^v\d+\.\d+$/u.test(env.META_GRAPH_VERSION)) {
      throw new Error('Invalid configuration: META_GRAPH_VERSION');
    }
  }

  const platformEnabled = requiresDeploy && env.PUBLISHING_SOCIAL_SHADOW_ENABLED === 'true';
  if (platformEnabled || platformMastodonEnabled) requireKeys(env, ['PUBLISHING_ENDPOINT', 'PUBLISHING_CLIENT_ID', 'PUBLISHING_CLIENT_SECRET']);
  return Object.freeze({
    platformMastodon: platformMastodonEnabled ? Object.freeze({
      baseUrl: normalizeExactOrigin(env.PUBLISHING_ENDPOINT, undefined, 'PUBLISHING_ENDPOINT'),
      clientId: env.PUBLISHING_CLIENT_ID,
      secret: env.PUBLISHING_CLIENT_SECRET,
    }) : null,
    platformShadow: platformEnabled ? Object.freeze({
      baseUrl: normalizeExactOrigin(env.PUBLISHING_ENDPOINT, undefined, 'PUBLISHING_ENDPOINT'),
      clientId: env.PUBLISHING_CLIENT_ID,
      secret: env.PUBLISHING_CLIENT_SECRET,
    }) : null,
    mode,
    publishEnabled: mode === 'controlled' || metaMigration || (mode === 'scheduled' && automatic),
    instagramStoryEnabled,
    instagramEditorialEnabled,
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
    mastodonAccessToken: requiresSocial && !platformMastodonEnabled ? env.MASTODON_ACCESS_TOKEN : null,
    threads: (metaMigration || (requiresSocial && threadsEnabled)) ? Object.freeze({
      accessToken: env.THREADS_ACCESS_TOKEN,
      apiUrl: normalizeApiBase(env.THREADS_API_URL, THREADS_API_URL, 'THREADS_API_URL'),
    }) : null,
    instagram: (storyMode || editorialInstagramMode || metaMigration || (requiresSocial && instagramEnabled)) ? Object.freeze({
      accessToken: env.INSTAGRAM_ACCESS_TOKEN,
      userId: env.INSTAGRAM_USER_ID,
      apiVersion: env.META_GRAPH_VERSION,
      apiOrigin: normalizeOrigin(env.INSTAGRAM_API_ORIGIN, INSTAGRAM_API_ORIGIN, 'INSTAGRAM_API_ORIGIN'),
    }) : null,
    linkedin: requiresSocial && linkedinEnabled ? Object.freeze(linkedinProvider === 'buffer' ? {
      provider: 'buffer',
      apiKey: env.BUFFER_API_KEY,
      organizationId: env.BUFFER_ORGANIZATION_ID,
      channelId: env.BUFFER_LINKEDIN_CHANNEL_ID,
      apiOrigin: normalizeExactOrigin(
        env.BUFFER_API_ORIGIN,
        BUFFER_API_ORIGIN,
        'BUFFER_API_ORIGIN',
      ),
    } : {
      provider: 'direct',
      accessToken: env.LINKEDIN_ACCESS_TOKEN,
      organizationId: env.LINKEDIN_ORGANIZATION_ID,
      organizationUrn: `urn:li:organization:${env.LINKEDIN_ORGANIZATION_ID}`,
      apiVersion: env.LINKEDIN_API_VERSION,
      apiOrigin: normalizeOrigin(
        env.LINKEDIN_API_ORIGIN,
        LINKEDIN_API_ORIGIN,
        'LINKEDIN_API_ORIGIN',
      ),
    }) : null,
    twitter: requiresSocial ? Object.freeze({
      apiKey: env.BUFFER_API_KEY,
      organizationId: env.BUFFER_ORGANIZATION_ID,
      channelId: env.BUFFER_TWITTER_CHANNEL_ID,
      apiOrigin: normalizeExactOrigin(
        env.BUFFER_API_ORIGIN,
        BUFFER_API_ORIGIN,
        'BUFFER_API_ORIGIN',
      ),
    }) : null,
  });
}
