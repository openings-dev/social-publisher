import { JOB_ID_PATTERN, OPENINGS_ORIGIN } from '../config/constants.mjs';

export function isValidJobId(value) {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value);
}

export function assertValidJobId(value) {
  if (!isValidJobId(value)) {
    throw new Error('Invalid job ID');
  }
  return value;
}

export function buildCanonicalJobUrl(jobId, origin = OPENINGS_ORIGIN) {
  return `${origin.replace(/\/$/, '')}/jobs/${assertValidJobId(jobId)}`;
}
