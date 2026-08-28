import { sha256 } from '../../shared/hash.mjs';
import { assertValidJobId } from '../../shared/job-id.mjs';

export const SOCIAL_THEMES = Object.freeze([
  Object.freeze({ id: 'mint', accent: '#b0ec9c', soft: '#ddf7d4' }),
  Object.freeze({ id: 'butter', accent: '#f3dda6', soft: '#fbf3d9' }),
  Object.freeze({ id: 'powder_blue', accent: '#cadcf4', soft: '#e8f0fa' }),
  Object.freeze({ id: 'soft_grape', accent: '#d9c9ee', soft: '#efe8f7' }),
  Object.freeze({ id: 'apricot', accent: '#f2c8ae', soft: '#fae9de' }),
  Object.freeze({ id: 'sage', accent: '#cfe7dc', soft: '#e9f4ef' }),
]);

export function resolveSocialTheme(jobId) {
  assertValidJobId(jobId);
  const index = Number.parseInt(sha256(jobId).slice(0, 8), 16) % SOCIAL_THEMES.length;
  return SOCIAL_THEMES[index];
}
