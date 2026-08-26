const REMOTE_MARKERS = Object.freeze([
  'remote',
  'global',
  'worldwide',
  'anywhere',
  '远程',
  '遠程',
  'リモート',
  '원격',
  '재택',
]);

function valuesForRemoteDetection(job) {
  return [job?.country, job?.region, ...(Array.isArray(job?.tags) ? job.tags : [])]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLocaleLowerCase('en-US'))
    .filter(Boolean);
}

function isRemoteJob(job) {
  return valuesForRemoteDetection(job).some((value) => REMOTE_MARKERS.some(
    (marker) => value === marker || value.includes(marker),
  ));
}

function discoveryHashtags(job, post) {
  const candidates = [
    ...String(post.hashtags ?? '').split(/\s+/u),
    '#Hiring',
    ...(isRemoteJob(job) ? ['#RemoteJobs'] : []),
  ];
  const seen = new Set();
  return candidates.filter((hashtag) => {
    if (!/^#[\p{L}\p{N}]+$/u.test(hashtag)) return false;
    const key = hashtag.toLocaleLowerCase('en-US');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4).join(' ');
}

export function formatInstagramCaption(job, post) {
  if (typeof post?.title !== 'string' || post.title.trim() === '') {
    throw new Error('Instagram caption requires a job title');
  }
  if (typeof post?.canonicalUrl !== 'string' || post.canonicalUrl.trim() === '') {
    throw new Error('Instagram caption requires a canonical URL');
  }
  return [
    'New opening on openings.dev',
    post.title,
    [post.metadataLine, post.salaryLine].filter(Boolean).join('\n'),
    `Open the full role:\n${post.canonicalUrl}`,
    'Know someone who fits? Tag them below.',
    'Follow @openingshq for more jobs from public communities.',
    discoveryHashtags(job, post),
  ].filter(Boolean).join('\n\n');
}

