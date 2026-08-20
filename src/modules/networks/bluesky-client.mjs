import { AtpAgent, RichText } from '@atproto/api';

import { BLUESKY_SERVICE_URL } from '../../config/constants.mjs';
import { sha256 } from '../../shared/hash.mjs';
import { opportunityDescription } from '../render/html-page.mjs';

const POST_COLLECTION = 'app.bsky.feed.post';

function blueskyError(code, message) {
  const error = new Error(message);
  error.name = 'BlueskyPublicationError';
  error.code = code;
  return error;
}

export function blueskyRecordKey(jobId) {
  return `opening-${sha256(jobId).slice(0, 24)}`;
}

function isRecordNotFound(error) {
  return error?.error === 'RecordNotFound'
    || error?.name === 'RecordNotFoundError'
    || (error?.status === 400 && /not.?found/iu.test(error?.message ?? ''));
}

function publicPostUrl(handle, rkey) {
  return `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${rkey}`;
}

async function findExistingRecord(agent, { repo, rkey, canonicalUrl, handle }) {
  let response;
  try {
    response = await agent.com.atproto.repo.getRecord({
      repo,
      collection: POST_COLLECTION,
      rkey,
    });
  } catch (error) {
    if (isRecordNotFound(error)) {
      return null;
    }
    throw blueskyError('bluesky_reconciliation', 'Bluesky record reconciliation failed');
  }
  const externalUrl = response.data?.value?.embed?.external?.uri;
  if (externalUrl !== canonicalUrl) {
    throw blueskyError('bluesky_conflict', 'Bluesky has a conflicting deterministic record');
  }
  return Object.freeze({
    status: 'reconciled',
    uri: response.data.uri,
    cid: response.data.cid,
    url: publicPostUrl(handle, rkey),
  });
}

export async function publishToBluesky({
  job,
  post,
  png,
  publicationCreatedAt,
  credentials,
  service = BLUESKY_SERVICE_URL,
  agentFactory = (serviceUrl) => new AtpAgent({ service: serviceUrl }),
}) {
  const agent = agentFactory(service);
  let loginResponse;
  try {
    loginResponse = await agent.login({
      identifier: credentials.identifier,
      password: credentials.appPassword,
    });
  } catch {
    throw blueskyError('bluesky_authentication', 'Bluesky authentication failed');
  }

  const session = agent.session ?? loginResponse?.data;
  const repo = session?.did;
  const handle = session?.handle ?? credentials.identifier;
  if (typeof repo !== 'string' || repo.length === 0 || typeof handle !== 'string' || handle.length === 0) {
    throw blueskyError('bluesky_session', 'Bluesky authentication returned an invalid session');
  }

  const rkey = blueskyRecordKey(job.id);
  const existing = await findExistingRecord(agent, {
    repo,
    rkey,
    canonicalUrl: post.canonicalUrl,
    handle,
  });
  if (existing) {
    return existing;
  }

  const richText = new RichText({ text: post.text });
  richText.detectFacetsWithoutResolution();

  let thumbnail;
  try {
    const response = await agent.uploadBlob(png, { encoding: 'image/png' });
    thumbnail = response.data?.blob;
  } catch {
    throw blueskyError('bluesky_thumbnail_upload', 'Bluesky thumbnail upload failed');
  }
  if (!thumbnail) {
    throw blueskyError('bluesky_thumbnail_missing', 'Bluesky thumbnail upload returned no blob');
  }

  const record = {
    $type: POST_COLLECTION,
    text: richText.text,
    facets: richText.facets,
    createdAt: publicationCreatedAt,
    embed: {
      $type: 'app.bsky.embed.external',
      external: {
        uri: post.canonicalUrl,
        title: job.title,
        description: opportunityDescription(job),
        thumb: thumbnail,
      },
    },
  };

  let response;
  try {
    response = await agent.com.atproto.repo.putRecord({
      repo,
      collection: POST_COLLECTION,
      rkey,
      validate: true,
      record,
    });
  } catch {
    throw blueskyError('bluesky_publication', 'Bluesky record publication failed');
  }

  return Object.freeze({
    status: 'published',
    uri: response.data.uri,
    cid: response.data.cid,
    url: publicPostUrl(handle, rkey),
  });
}
