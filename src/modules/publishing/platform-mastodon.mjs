import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFileOutbox, createPublishingClient, validatePublicationEnvelope } from '@trebla/publishing';
import { sha256 } from '../../shared/hash.mjs';
import { assertValidJobId } from '../../shared/job-id.mjs';
import { readSocialPublication } from './platform-publisher.mjs';

export async function publishMastodonThroughPlatform({
  job, post, outboxDirectory, transport, pollAttempts = 6,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  assertValidJobId(job.id);
  if (!Number.isSafeInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > 6) throw new Error('Invalid status poll limit');
  if (!transport?.baseUrl || !transport.clientId || !transport.secret) throw new Error('Publishing credentials are required');
  const endpoint = new URL(transport.baseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Publishing endpoint must be a plain HTTPS origin');
  }
  const identity = { tenant: 'openings', sourceType: 'social-mastodon', sourceId: job.id,
    revision: 'first-publication-v1', idempotencyKey: `openings:social-mastodon:${job.id}:first-publication-v1` };
  const id = sha256(identity.idempotencyKey);
  const directory = resolve(outboxDirectory, id);
  const outbox = createFileOutbox(directory);
  let publicationId;
  let previouslyAccepted = false;
  try {
    const receipt = JSON.parse(await readFile(resolve(directory, 'accepted', `${id}.json`), 'utf8'));
    if (typeof receipt.publicationId !== 'string' || !receipt.publicationId) throw new Error('Invalid acceptance receipt');
    publicationId = receipt.publicationId;
    previouslyAccepted = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!publicationId) {
    // Reuse the original persisted copy on every retry of this job's first post.
    let envelope;
    try {
      envelope = validatePublicationEnvelope(JSON.parse(await readFile(resolve(directory, `${id}.json`), 'utf8')));
      if (JSON.stringify(envelope.identity) !== JSON.stringify(identity)) throw new Error('Invalid pending identity');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      envelope = validatePublicationEnvelope({ schemaVersion: 1, identity,
        canonical: { title: job.title, language: 'en', canonicalUrl: post.canonicalUrl }, artifacts: [],
        deliveries: [{ id: 'mastodon', adapter: 'social.mastodon', operation: 'publish', required: true,
          payload: { type: 'social.post', text: post.text, canonicalUrl: post.canonicalUrl, language: 'en', artifactIds: [] } }],
      });
      await outbox.enqueue(envelope);
    }
    const request = transport.fetch ?? globalThis.fetch;
    const result = await createPublishingClient({ ...transport, fetch: (url, init) => request(url, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(20_000),
    }) }).submit(envelope);
    if (result.outcome !== 'accepted') throw new Error('Platform capacity deferred Mastodon publication');
    publicationId = result.publicationId;
    await outbox.acknowledge(id, publicationId);
  }
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    if (attempt > 0) await sleep(5_000);
    const status = await readSocialPublication({ publicationId, transport });
    const delivery = status.deliveries.find(item => item.id === 'mastodon' && item.adapter === 'social.mastodon');
    if (!delivery) throw new Error('Mastodon delivery missing from platform status');
    if (delivery.state === 'verified') {
      const receipt = delivery;
      if (receipt?.provider !== 'social.mastodon' || typeof receipt.remoteId !== 'string' || !receipt.remoteId
        || typeof receipt.remoteUrl !== 'string' || !receipt.remoteUrl.startsWith('https://')) throw new Error('Invalid Mastodon receipt');
      return { status: previouslyAccepted ? 'reconciled' : 'published', id: receipt.remoteId, url: receipt.remoteUrl, cardStatus: 'pending' };
    }
    if (['failed', 'cancelled', 'dead_letter'].includes(delivery.state)) throw new Error('Platform Mastodon delivery requires recovery');
  }
  throw new Error('Platform Mastodon publication awaiting confirmation');
}
