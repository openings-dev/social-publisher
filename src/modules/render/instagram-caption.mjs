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
const ONSITE_MARKERS = Object.freeze([
  'onsite',
  'on-site',
  'on site',
  'in office',
  'office-based',
  'hybrid',
  'presencial',
  'híbrido',
  'hibrido',
  '线下',
  '線下',
  '现场',
  '現場',
  'オンサイト',
  '出社',
  'オフィス',
  '오프라인',
  '현장',
  '출근',
  '하이브리드',
]);

function valuesForLocationDetection(job) {
  return [job?.title, job?.country, job?.region, ...(Array.isArray(job?.tags) ? job.tags : [])]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLocaleLowerCase('en-US'))
    .filter(Boolean);
}

function isRemoteJob(job) {
  const values = valuesForLocationDetection(job);
  const hasMarker = (markers) => values.some((value) => markers.some(
    (marker) => value === marker || value.includes(marker),
  ));
  return !hasMarker(ONSITE_MARKERS) && hasMarker(REMOTE_MARKERS);
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
