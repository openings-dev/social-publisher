import { sha256 } from '../../shared/hash.mjs';

const EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
});

export function toPlatformShadowEnvelope({ job, socialPost, artifacts }) {
  if (!job || job.issueState !== 'open') {
    throw new Error('Platform preparation requires an open job');
  }
  if (typeof job.id !== 'string' || typeof job.title !== 'string' || typeof job.description !== 'string'
    || typeof job.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(job.contentHash)) {
    throw new Error('Platform job metadata is invalid');
  }
  if (!socialPost || typeof socialPost.text !== 'string' || socialPost.text.trim() === ''
    || typeof socialPost.canonicalUrl !== 'string'
    || socialPost.canonicalUrl !== `https://openings.dev/jobs/${job.id}`) {
    throw new Error('Platform social post is invalid');
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error('Platform opening requires verified social media');
  }
  const platformArtifacts = artifacts.map((artifact) => {
    const extension = EXTENSIONS[artifact.mediaType];
    if (!extension || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.byteSize) || artifact.byteSize <= 0) {
      throw new Error('Platform opening artifact metadata is invalid');
    }
    return Object.freeze({
      id: `media-${artifact.sha256}`,
      storage: 'r2-temporary',
      sha256: artifact.sha256,
      byteSize: artifact.byteSize,
      mediaType: artifact.mediaType,
      locator: `temporary/openings/${job.id}/${artifact.sha256}.${extension}`,
    });
  });
  const revision = `sha256:${job.contentHash}`;
  const entity = Object.freeze({
    schemaVersion: 1,
    tenant: 'openings',
    kind: 'job',
    id: job.id,
    revision,
    canonicalPath: `/jobs/${job.id}`,
    title: job.title,
    summary: job.description,
    status: 'active',
    contentSha256: sha256(JSON.stringify(job)),
    content: { ...job },
  });
  return Object.freeze({
    schemaVersion: 1,
    identity: Object.freeze({
      tenant: 'openings',
      sourceType: 'job',
      sourceId: job.id,
      revision,
      idempotencyKey: `openings:job:${job.id}:${revision}`,
    }),
    canonical: Object.freeze({
      title: job.title,
      summary: job.description,
      canonicalUrl: socialPost.canonicalUrl,
      language: 'en',
    }),
    artifacts: platformArtifacts,
    deliveries: Object.freeze([
      Object.freeze({
        id: 'web', adapter: 'web.r2', operation: 'publish', required: true,
        payload: { type: 'web.page', route: entity.canonicalPath, entity },
      }),
      Object.freeze({
        id: 'social', adapter: 'social.shadow', operation: 'compare', required: false,
        dependsOn: [{ deliveryId: 'web', state: 'succeeded' }],
        payload: {
          type: 'social.post',
          text: socialPost.text,
          artifactIds: platformArtifacts.map(({ id }) => id),
        },
      }),
    ]),
  });
}
