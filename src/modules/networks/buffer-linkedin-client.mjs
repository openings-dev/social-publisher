const MAX_RESPONSE_CHARACTERS = 1_000_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

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

export async function verifyBufferLinkedInChannel({
  apiKey,
  organizationId,
  channelId,
  apiOrigin = 'https://api.buffer.com',
  fetchImpl = globalThis.fetch,
}) {
  const configuration = {
    apiKey: requiredSecret(apiKey),
    organizationId: requiredIdentifier(organizationId, 'organization ID'),
    channelId: requiredIdentifier(channelId, 'LinkedIn channel ID'),
    apiOrigin: exactApiOrigin(apiOrigin),
    fetchImpl: assertFetch(fetchImpl),
  };
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
