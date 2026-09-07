import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createArtifactUploader, createFileOutbox, createLocalProducer, createPublishingClient,
  prepareArtifactReference, stagePlatformHandoff, uploadPlatformHandoff,
  buildSignedHeaders,
} from '@trebla/publishing';
import { formatSocialPost } from '../render/format-job.mjs';
import { preparePlatformHandoff } from './platform-envelope.mjs';
import { sha256 } from '../../shared/hash.mjs';

async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

export async function prepareSocialPublication({ job, mediaPath, outboxDirectory }) {
  const filePath = resolve(mediaPath);
  const artifact = await prepareArtifactReference({
    id: 'social-card', filePath, storage: 'r2-temporary',
    locator: hash => `temporary/openings/social/${hash}.png`,
    mediaType: 'image/png', allowedMediaTypes: ['image/png'], maxByteSize: 5 * 1024 * 1024,
  });
  const legacy = preparePlatformHandoff({
    job, socialPost: formatSocialPost(job), artifacts: [{ ...artifact, filePath }],
  });
  // The data pipeline owns web entities. Shadow intake must never overwrite them.
  const delivery = { ...legacy.envelope.deliveries[1] };
  delete delivery.dependsOn;
  const revision = `sha256:${sha256(JSON.stringify({
    canonical: legacy.envelope.canonical, artifacts: legacy.envelope.artifacts, delivery,
  }))}`;
  const envelope = {
    ...legacy.envelope,
    identity: { ...legacy.envelope.identity, sourceType: 'social-shadow', revision,
      idempotencyKey: `openings:social-shadow:${job.id}:${revision}` },
    deliveries: [delivery],
  };
  const handoff = { envelope, uploads: legacy.uploads };
  const directory = resolve(outboxDirectory, sha256(envelope.identity.idempotencyKey));
  const path = resolve(directory, 'handoff.json');
  await stagePlatformHandoff(handoff, createLocalProducer({ outbox: createFileOutbox(directory) }));
  await saveJson(path, handoff);
  return { path, handoff };
}

function validateTransport(transport) {
  if (!transport?.baseUrl || !transport.clientId || !transport.secret) {
    throw new Error('Publishing endpoint and credentials are required');
  }
  const endpoint = new URL(transport.baseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('Publishing endpoint must be a plain HTTPS origin');
  }
}

export async function readSocialPublication({ publicationId, transport }) {
  validateTransport(transport);
  if (typeof publicationId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(publicationId)) throw new Error('Invalid publication ID');
  const path = `/v1/publications/${publicationId}`;
  const headers = await buildSignedHeaders({
    clientId: transport.clientId, secret: transport.secret, method: 'GET', path,
    tenant: 'openings', timestamp: new Date().toISOString(), nonce: randomUUID(), body: '',
  });
  const response = await (transport.fetch ?? fetch)(`${new URL(transport.baseUrl).origin}${path}`, {
    method: 'GET', headers, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Publication status returned HTTP ${response.status}`);
  const value = await response.json();
  if (value?.publicationId !== publicationId || !Array.isArray(value.deliveries)) throw new Error('Invalid publication status');
  return value;
}

export async function submitSocialPublication({ path, transport }) {
  validateTransport(transport);
  const handoff = JSON.parse(await readFile(path, 'utf8'));
  const id = sha256(handoff.envelope.identity.idempotencyKey);
  const directory = dirname(resolve(path));
  if (resolve(directory, '..', id) !== directory) throw new Error('Handoff directory does not match identity');
  // Retry after acceptance performs no upload and no second intake request.
  try {
    const receipt = JSON.parse(await readFile(resolve(directory, 'accepted', `${id}.json`), 'utf8'));
    if (typeof receipt.publicationId !== 'string' || !receipt.publicationId) throw new Error('Invalid acceptance receipt');
    return { outcome: 'already-accepted', publicationId: receipt.publicationId };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (handoff.envelope.identity.tenant !== 'openings'
    || handoff.envelope.identity.sourceType !== 'social-shadow'
    || handoff.envelope.deliveries.length !== 1
    || handoff.envelope.deliveries[0].adapter !== 'social.shadow') {
    throw new Error('Only one Openings shadow delivery is allowed');
  }
  const outbox = createFileOutbox(directory);
  const producer = createLocalProducer({ outbox });
  await stagePlatformHandoff(handoff, producer);
  const upload = await uploadPlatformHandoff(handoff, createArtifactUploader(transport));
  if (upload.outcome !== 'available') return upload;
  // Submit exactly this handoff, never drain unrelated or unuploaded entries.
  const result = await createPublishingClient(transport).submit(handoff.envelope);
  if (result.outcome === 'accepted') await outbox.acknowledge(id, result.publicationId);
  return result;
}
