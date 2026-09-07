import { buildCanonicalJobUrl } from '../../shared/job-id.mjs';

const MAX_POST_GRAPHEMES = 300;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const PERIOD_LABELS = Object.freeze({
  hour: 'hour',
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
});
const STACK_HASHTAGS = new Map([
  ['android', 'Android'],
  ['angular', 'Angular'],
  ['aws', 'AWS'],
  ['azure', 'Azure'],
  ['django', 'Django'],
  ['docker', 'Docker'],
  ['flutter', 'Flutter'],
  ['go', 'Go'],
  ['golang', 'Go'],
  ['graphql', 'GraphQL'],
  ['ios', 'iOS'],
  ['java', 'Java'],
  ['javascript', 'JavaScript'],
  ['kotlin', 'Kotlin'],
  ['kubernetes', 'Kubernetes'],
  ['laravel', 'Laravel'],
  ['nextjs', 'NextJS'],
  ['node', 'NodeJS'],
  ['nodejs', 'NodeJS'],
  ['php', 'PHP'],
  ['python', 'Python'],
  ['react', 'React'],
  ['reactnative', 'ReactNative'],
  ['ruby', 'Ruby'],
  ['rust', 'Rust'],
  ['swift', 'Swift'],
  ['terraform', 'Terraform'],
  ['typescript', 'TypeScript'],
  ['vue', 'Vue'],
  ['vuejs', 'VueJS'],
]);
const UNKNOWN_VALUES = new Set(['', 'unknown', 'n/a', 'na', 'not specified', 'não informado']);

function graphemes(value) {
  return [...segmenter.segment(String(value))].map((entry) => entry.segment);
}

export function countGraphemes(value) {
  return graphemes(value).length;
}

function truncateGraphemes(value, limit) {
  const parts = graphemes(value);
  if (parts.length <= limit) {
    return value;
  }
  if (limit <= 1) {
    return '…';
  }
  return `${parts.slice(0, limit - 1).join('')}…`;
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function formatMoney(value, currency) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value).replace(/\s+/g, '');
  } catch {
    return null;
  }
}

export function formatSalary(salary) {
  if (!salary || typeof salary.currency !== 'string' || !PERIOD_LABELS[salary.period]) {
    return null;
  }
  const minimum = isPositiveNumber(salary.min) ? salary.min : null;
  const maximum = isPositiveNumber(salary.max) ? salary.max : null;
  if (minimum === null && maximum === null) {
    return null;
  }
  if (minimum !== null && maximum !== null && minimum > maximum) {
    return null;
  }
  const period = PERIOD_LABELS[salary.period];
  const formattedMinimum = minimum === null ? null : formatMoney(minimum, salary.currency);
  const formattedMaximum = maximum === null ? null : formatMoney(maximum, salary.currency);
  if ((minimum !== null && !formattedMinimum) || (maximum !== null && !formattedMaximum)) {
    return null;
  }
  if (formattedMinimum && formattedMaximum) {
    if (minimum === maximum) {
      return `${formattedMinimum}/${period}`;
    }
    return `${formattedMinimum}–${formattedMaximum}/${period}`;
  }
  if (formattedMinimum) {
    return `From ${formattedMinimum}/${period}`;
  }
  return `Up to ${formattedMaximum}/${period}`;
}

function usableValue(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return UNKNOWN_VALUES.has(trimmed.toLowerCase()) ? null : trimmed;
}

function formatMetadataLine(job) {
  const values = [usableValue(job.community?.name), usableValue(job.country), usableValue(job.region)];
  const seen = new Set();
  const unique = values.filter((value) => {
    if (!value) {
      return false;
    }
    const key = value.toLocaleLowerCase('en-US');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return unique.length > 0 ? unique.join(' · ') : null;
}

function normalizeStackKey(value) {
  return value.toLocaleLowerCase('en-US').replace(/[-_.\s]/g, '');
}

function selectStackHashtag(tags) {
  if (!Array.isArray(tags)) {
    return null;
  }
  for (const tag of tags) {
    if (typeof tag !== 'string') {
      continue;
    }
    const hashtag = STACK_HASHTAGS.get(normalizeStackKey(tag));
    if (hashtag && /^[\p{L}\p{N}]+$/u.test(hashtag)) {
      return `#${hashtag}`;
    }
  }
  return null;
}

function composePost({ title, metadataLine, salaryLine, canonicalUrl, hashtags }) {
  const paragraphs = [
    'New job on openings.dev',
    title,
    [metadataLine, salaryLine].filter(Boolean).join('\n'),
    `View the listing:\n${canonicalUrl}`,
    hashtags,
  ].filter(Boolean);
  return paragraphs.join('\n\n');
}

function fitPost(title, fields, maxGraphemes) {
  let metadataLine = fields.metadataLine;
  let salaryLine = fields.salaryLine;
  const minimumTitleLength = Math.min(24, countGraphemes(title));

  while (countGraphemes(composePost({
    ...fields,
    title: truncateGraphemes(title, minimumTitleLength),
    metadataLine,
    salaryLine,
  })) > maxGraphemes) {
    if (salaryLine) {
      salaryLine = null;
    } else if (metadataLine) {
      metadataLine = null;
    } else {
      break;
    }
  }

  let low = 1;
  let high = countGraphemes(title);
  let best = 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = composePost({
      ...fields,
      title: truncateGraphemes(title, middle),
      metadataLine,
      salaryLine,
    });
    if (countGraphemes(candidate) <= maxGraphemes) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const fittedTitle = truncateGraphemes(title, best);
  const text = composePost({ ...fields, title: fittedTitle, metadataLine, salaryLine });
  if (countGraphemes(text) > maxGraphemes) {
    throw new Error('Required social post content exceeds the provider limit');
  }
  return { text, title: fittedTitle, metadataLine, salaryLine };
}

export function formatSocialPost(job, { origin, maxGraphemes = MAX_POST_GRAPHEMES } = {}) {
  if (typeof job?.title !== 'string' || job.title.trim() === '') {
    throw new Error('Job title is required for social copy');
  }
  if (!Number.isInteger(maxGraphemes) || maxGraphemes < 1 || maxGraphemes > MAX_POST_GRAPHEMES) {
    throw new Error('maxGraphemes must be a positive integer within the provider limit');
  }
  const originalTitle = (job.socialTitle ?? job.title).trim();
  const canonicalUrl = buildCanonicalJobUrl(job.id, origin);
  const metadataLine = formatMetadataLine(job);
  const salaryLine = formatSalary(job.salary);
  const stackHashtag = selectStackHashtag(job.tags);
  const hashtags = ['#TechJobs', stackHashtag].filter(Boolean).join(' ');
  const fitted = fitPost(originalTitle, { metadataLine, salaryLine, canonicalUrl, hashtags }, maxGraphemes);
  return Object.freeze({
    ...fitted,
    canonicalUrl,
    hashtags,
  });
}
