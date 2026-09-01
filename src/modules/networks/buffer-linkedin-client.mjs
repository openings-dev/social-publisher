const MAX_RESPONSE_CHARACTERS = 1_000_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const LINKEDIN_HOST_PATTERN = /^(?:[a-z0-9-]+\.)*linkedin\.com$/u;

function publicationError(code, message, diagnostic = null) {
  const error = new Error(message);
  error.code = code;
  if (diagnostic) error.diagnostic = Object.freeze({ ...diagnostic });
  return error;
}

function requiredSecret(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096) {
    throw publicationError('buffer_configuration', 'Buffer API authentication is required');
  }
  return value.trim();
}

function requiredIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw publicationError('buffer_configuration', `Buffer ${label} is invalid`);
  }
  return value;
}

function exactApiOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw publicationError('buffer_configuration', 'Buffer API origin is invalid');
  }
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash) {
    throw publicationError('buffer_configuration', 'Buffer API origin is invalid');
  }
  return url.origin;
}

function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') {
    throw publicationError('buffer_configuration', 'Buffer HTTP client is unavailable');
  }
  return fetchImpl;
}

function normalizeConfiguration({
  apiKey,
  organizationId,
  channelId,
  apiOrigin,
  fetchImpl,
}) {
  return Object.freeze({
    apiKey: requiredSecret(apiKey),
    organizationId: requiredIdentifier(organizationId, 'organization ID'),
    channelId: requiredIdentifier(channelId, 'LinkedIn channel ID'),
    apiOrigin: exactApiOrigin(apiOrigin),
    fetchImpl: assertFetch(fetchImpl),
  });
}

async function bufferGraphql({
  apiKey,
  apiOrigin,
  operation,
  query,
  variables,
  fetchImpl,
}) {
  let response;
  try {
    response = await fetchImpl(apiOrigin, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operationName: operation, query, variables }),
    });
  } catch {
    throw publicationError('buffer_response', 'Buffer request failed', { operation });
  }

  if (response.status === 401 || response.status === 403) {
    throw publicationError('buffer_authentication', 'Buffer authentication failed', { operation });
  }
  if (response.status === 429) {
    throw publicationError('buffer_rate_limit', 'Buffer rate limit reached', { operation });
  }
  if (!response.ok) {
    throw publicationError('buffer_response', 'Buffer request failed', {
      operation,
      status: response.status,
    });
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw publicationError('buffer_response', 'Buffer returned an invalid response type', { operation });
  }
  const source = await response.text();
  if (source.length > MAX_RESPONSE_CHARACTERS) {
    throw publicationError('buffer_response', 'Buffer response exceeded the safe size', { operation });
  }
  let payload;
  try {
    payload = JSON.parse(source);
  } catch {
    throw publicationError('buffer_response', 'Buffer returned invalid JSON', { operation });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw publicationError('buffer_response', 'Buffer returned an invalid response', { operation });
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw publicationError('buffer_graphql', 'Buffer GraphQL request failed', { operation });
  }
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw publicationError('buffer_response', 'Buffer returned an invalid response', { operation });
  }
  return payload.data;
}

const GET_CHANNELS_QUERY = `
  query GetChannels($organizationId: OrganizationId!) {
    channels(input: { organizationId: $organizationId }) {
      id
      service
      isDisconnected
      isLocked
    }
  }
`;

const GET_RECENT_POSTS_QUERY = `
  query GetRecentPosts($organizationId: OrganizationId!, $channelId: ChannelId!) {
    posts(
      first: 20
      input: {
        organizationId: $organizationId
        filter: { channelIds: [$channelId] }
        sort: [{ field: createdAt, direction: desc }]
      }
    ) {
      edges {
        node {
          id
          text
          status
          externalLink
          channelId
          assets { source }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CREATE_POST_MUTATION = `
  mutation CreateLinkedInPost(
    $text: String!
    $channelId: ChannelId!
    $imageUrl: String!
    $altText: String!
  ) {
    createPost(input: {
      text: $text
      channelId: $channelId
      schedulingType: automatic
      mode: shareNow
      assets: [{ image: { url: $imageUrl, metadata: { altText: $altText } } }]
    }) {
      __typename
      ... on PostActionSuccess {
        post { id status externalLink }
      }
      ... on MutationError { message }
    }
  }
`;

const GET_POST_QUERY = `
  query GetPost($postId: PostId!) {
    post(input: { id: $postId }) {
      id
      status
      externalLink
    }
  }
`;

async function loadLinkedInChannel(configuration) {
  const data = await bufferGraphql({
    ...configuration,
    operation: 'GetChannels',
    query: GET_CHANNELS_QUERY,
    variables: { organizationId: configuration.organizationId },
  });
  if (!Array.isArray(data.channels)) {
    throw publicationError('buffer_response', 'Buffer returned invalid channels', {
      operation: 'GetChannels',
    });
  }
  const channel = data.channels.find(({ id } = {}) => id === configuration.channelId);
  if (!channel
    || channel.service !== 'linkedin'
    || channel.isDisconnected !== false
    || channel.isLocked !== false) {
    throw publicationError('buffer_configuration', 'Buffer LinkedIn channel is unavailable');
  }
  return Object.freeze({ id: channel.id, service: channel.service });
}

export async function verifyBufferLinkedInChannel({
  apiKey,
  organizationId,
  channelId,
  apiOrigin = 'https://api.buffer.com',
  fetchImpl = globalThis.fetch,
}) {
  const configuration = normalizeConfiguration({
    apiKey,
    organizationId,
    channelId,
    apiOrigin,
    fetchImpl,
  });
  return loadLinkedInChannel(configuration);
}

function validatePublicMedia(imageUrl, publicSiteOrigin) {
  let media;
  let site;
  try {
    media = new URL(imageUrl);
    site = new URL(publicSiteOrigin);
  } catch {
    throw publicationError('buffer_media', 'Buffer image URL is invalid');
  }
  if (site.protocol !== 'https:'
    || site.username
    || site.password
    || site.pathname !== '/'
    || site.search
    || site.hash
    || media.protocol !== 'https:'
    || media.username
    || media.password
    || media.origin !== site.origin
    || media.pathname === '/') {
    throw publicationError('buffer_media', 'Buffer image URL is invalid');
  }
  return media.toString();
}

function validatePublication(job, post) {
  if (typeof job?.title !== 'string' || job.title.trim() === '') {
    throw publicationError('buffer_configuration', 'Buffer job title is invalid');
  }
  if (typeof post?.text !== 'string' || post.text.trim() === ''
    || typeof post.canonicalUrl !== 'string' || post.canonicalUrl.trim() === '') {
    throw publicationError('buffer_configuration', 'Buffer post content is invalid');
  }
  return Object.freeze({
    text: post.text,
    canonicalUrl: post.canonicalUrl,
    altText: `${job.title.trim()} job opening on openings.dev`.slice(0, 300),
  });
}

function validatePolling({ pollAttempts, pollDelayMs, sleep }) {
  if (!Number.isInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > 20
    || !Number.isInteger(pollDelayMs) || pollDelayMs < 0 || pollDelayMs > 60_000
    || typeof sleep !== 'function') {
    throw publicationError('buffer_configuration', 'Buffer polling configuration is invalid');
  }
  return Object.freeze({ pollAttempts, pollDelayMs, sleep });
}

function normalizeLinkedInUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw publicationError('buffer_response', 'Buffer returned an invalid LinkedIn URL');
  }
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || !LINKEDIN_HOST_PATTERN.test(url.hostname.toLowerCase())) {
    throw publicationError('buffer_response', 'Buffer returned an invalid LinkedIn URL');
  }
  return url.toString();
}

function normalizePost(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || !IDENTIFIER_PATTERN.test(value.id)
    || typeof value.status !== 'string') {
    throw publicationError('buffer_response', 'Buffer returned an invalid post', { operation });
  }
  return value;
}

async function listRecentPosts(configuration) {
  const data = await bufferGraphql({
    ...configuration,
    operation: 'GetRecentPosts',
    query: GET_RECENT_POSTS_QUERY,
    variables: {
      organizationId: configuration.organizationId,
      channelId: configuration.channelId,
    },
  });
  if (!data.posts || typeof data.posts !== 'object' || !Array.isArray(data.posts.edges)) {
    throw publicationError('buffer_reconciliation', 'Buffer recent posts are unavailable');
  }
  return data.posts.edges;
}

function mutationFailure(payload) {
  const typename = payload?.__typename;
  if (typename === 'UnauthorizedError') {
    return publicationError('buffer_authentication', 'Buffer authentication failed', {
      operation: 'CreateLinkedInPost',
    });
  }
  if (typename === 'LimitReachedError') {
    return publicationError('buffer_rate_limit', 'Buffer publication limit reached', {
      operation: 'CreateLinkedInPost',
    });
  }
  if (typename === 'InvalidInputError'
    && /image|media|dimension|asset|fetch/iu.test(String(payload?.message ?? ''))) {
    return publicationError('buffer_media', 'Buffer rejected the public image', {
      operation: 'CreateLinkedInPost',
    });
  }
  return publicationError('buffer_publication', 'Buffer publication failed', {
    operation: 'CreateLinkedInPost',
  });
}

async function createPost(configuration, publication, imageUrl) {
  const data = await bufferGraphql({
    ...configuration,
    operation: 'CreateLinkedInPost',
    query: CREATE_POST_MUTATION,
    variables: {
      text: publication.text,
      channelId: configuration.channelId,
      imageUrl,
      altText: publication.altText,
    },
  });
  if (!data.createPost || data.createPost.__typename !== 'PostActionSuccess') {
    throw mutationFailure(data.createPost);
  }
  return normalizePost(data.createPost.post, 'CreateLinkedInPost');
}

function completedResult(post, status = 'published') {
  if (post.status !== 'sent') {
    throw publicationError('buffer_response', 'Buffer post is not complete');
  }
  return Object.freeze({
    status,
    id: post.id,
    url: normalizeLinkedInUrl(post.externalLink),
    provider: 'buffer',
  });
}

async function pollPost(configuration, postId, polling, resultStatus = 'published') {
  for (let attempt = 0; attempt < polling.pollAttempts; attempt += 1) {
    const data = await bufferGraphql({
      ...configuration,
      operation: 'GetPost',
      query: GET_POST_QUERY,
      variables: { postId },
    });
    const post = normalizePost(data.post, 'GetPost');
    if (post.id !== postId) {
      throw publicationError('buffer_response', 'Buffer returned the wrong post', {
        operation: 'GetPost',
      });
    }
    if (post.status === 'sent') return completedResult(post, resultStatus);
    if (post.status === 'error') {
      throw publicationError('buffer_publication', 'Buffer could not publish the LinkedIn post');
    }
    if (post.status === 'needs_approval' || post.status === 'draft') {
      throw publicationError('buffer_processing', 'Buffer did not start automatic publication');
    }
    if (post.status !== 'sending' && post.status !== 'scheduled') {
      throw publicationError('buffer_processing', 'Buffer returned an unexpected post status');
    }
    if (attempt + 1 < polling.pollAttempts) await polling.sleep(polling.pollDelayMs);
  }
  throw publicationError('buffer_processing', 'Buffer publication processing timed out');
}

export async function publishToLinkedInViaBuffer({
  job,
  post,
  imageUrl,
  publicSiteOrigin,
  apiKey,
  organizationId,
  channelId,
  apiOrigin = 'https://api.buffer.com',
  fetchImpl = globalThis.fetch,
  pollAttempts = 12,
  pollDelayMs = 5_000,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
}) {
  const publication = validatePublication(job, post);
  const publicImageUrl = validatePublicMedia(imageUrl, publicSiteOrigin);
  const polling = validatePolling({ pollAttempts, pollDelayMs, sleep });
  const configuration = normalizeConfiguration({
    apiKey,
    organizationId,
    channelId,
    apiOrigin,
    fetchImpl,
  });
  await loadLinkedInChannel(configuration);
  await listRecentPosts(configuration);
  const created = await createPost(configuration, publication, publicImageUrl);
  if (created.status === 'sent') return completedResult(created);
  if (created.status !== 'sending' && created.status !== 'scheduled') {
    if (created.status === 'error') {
      throw publicationError('buffer_publication', 'Buffer could not publish the LinkedIn post');
    }
    throw publicationError('buffer_processing', 'Buffer did not start automatic publication');
  }
  return pollPost(configuration, created.id, polling);
}
