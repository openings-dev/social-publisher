import { isValidJobId } from '../../shared/job-id.mjs';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function isPublicGithubIssueUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'github.com'
      && /\/issues\/\d+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function isEligibleNewJob(job, previousGeneratedAt, publications) {
  if (!job || !isValidJobId(job.id) || job.issueState !== 'open' || job.sourceType !== 'github-issue') {
    return false;
  }
  if (typeof job.title !== 'string' || job.title.trim() === '' || typeof job.repository !== 'string' || job.repository.trim() === '') {
    return false;
  }
  if (!HASH_PATTERN.test(job.contentHash) || !isPublicGithubIssueUrl(job.url)) {
    return false;
  }
  const createdAt = Date.parse(job.createdAt);
  const boundary = Date.parse(previousGeneratedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(boundary) || createdAt <= boundary) {
    return false;
  }
  const existing = publications?.jobs?.[job.id];
  if (existing?.completedAt || existing?.intentionallySkippedAt || existing?.status === 'completed') {
    return false;
  }
  return true;
}
