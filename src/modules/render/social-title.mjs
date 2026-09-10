function normalizeSourceTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return title && title.length <= 800 ? title : null;
}

export function resolveSocialTitle(job) {
  const title = normalizeSourceTitle(job.title);
  if (!title) return Object.freeze({ status: 'review_required', reason: 'social_title_review_required' });
  return Object.freeze({ status: 'ready', title, method: 'source' });
}

export function prepareSocialJob(job) {
  const resolved = resolveSocialTitle(job);
  if (resolved.status !== 'ready') {
    const error = new Error('Social title is invalid');
    error.code = 'social_title_review_required';
    throw error;
  }
  return Object.freeze({ ...job, socialTitle: resolved.title });
}
