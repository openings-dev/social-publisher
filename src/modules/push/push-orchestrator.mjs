import { validatePushState } from './push-state.mjs';

const RETRY_DELAY_MS = 100 * 1000;
const MAX_DAILY_PUSHES = 2;
const DAILY_LIMIT_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function isoDay(value) {
  return DAILY_LIMIT_DAY.format(new Date(value));
}

function replaceIntent(state, jobId, update) {
  return {
    ...state,
    intents: state.intents.map((intent) => (intent.jobId === jobId ? update(intent) : intent)),
  };
}

function terminalForExpiredAmbiguity(intent, now) {
  const firstAttempt = intent.firstSubmittedAt ?? intent.updatedAt ?? intent.createdAt;
  const expiresAt = Date.parse(firstAttempt) + (30 * 24 * 60 * 60 * 1000);
  if (Date.parse(now) <= expiresAt) return intent;
  return {
    ...intent,
    status: 'failed',
    updatedAt: now,
    result: { code: 'reconciliation_required', providerStatus: 'uncertain' },
  };
}

export function preparePushSubmission(state, currentSnapshot, { now = new Date().toISOString() } = {}) {
  validatePushState(state);
  let next = structuredClone(state);
  if (!next.enabled) return { state: next, intent: null, reason: 'disabled' };
  if (next.paused) return { state: next, intent: null, reason: 'paused' };

  const activeSubmission = next.intents.find(({ status }) => status === 'submitting');
  if (activeSubmission) return { state: next, intent: activeSubmission, reason: 'resume' };

  next.intents = next.intents.map((intent) => (
    intent.status === 'uncertain' ? terminalForExpiredAmbiguity(intent, now) : intent
  ));

  const sentToday = next.intents.filter((intent) => (
    ['submitting', 'accepted', 'uncertain'].includes(intent.status)
      && intent.updatedAt
      && isoDay(intent.updatedAt) === isoDay(now)
  )).length;
  const dailyCap = Math.min(next.policy.dailyCap, MAX_DAILY_PUSHES);
  if (sentToday >= dailyCap) return { state: validatePushState(next), intent: null, reason: 'daily_cap' };

  const maximumAgeMs = next.policy.maxAgeHours * 60 * 60 * 1000;
  next.intents = next.intents.map((intent) => (
    ['pending', 'retryable'].includes(intent.status)
      && Date.parse(now) - Date.parse(intent.createdAt) > maximumAgeMs
      ? { ...intent, status: 'skipped_stale', updatedAt: now }
      : intent
  ));

  const candidate = next.intents.find((intent) => {
    if (!['pending', 'retryable', 'uncertain'].includes(intent.status)) return false;
    if (!currentSnapshot.jobsById.has(intent.jobId)) return false;
    if (intent.retryAfter && Date.parse(intent.retryAfter) > Date.parse(now)) return false;
    if (intent.status === 'uncertain' && intent.updatedAt
      && Date.parse(now) - Date.parse(intent.updatedAt) < RETRY_DELAY_MS) return false;
    return intent.attempts < 3;
  });
  if (!candidate) return { state: validatePushState(next), intent: null, reason: 'up_to_date' };

  next = replaceIntent(next, candidate.jobId, (intent) => ({
    ...intent,
    status: 'submitting',
    attempts: intent.attempts + 1,
    firstSubmittedAt: intent.firstSubmittedAt ?? now,
    updatedAt: now,
    retryAfter: null,
  }));
  next = validatePushState(next);
  return { state: next, intent: next.intents.find(({ jobId }) => jobId === candidate.jobId), reason: 'ready' };
}

export function applyPushResult(state, jobId, result, { now = new Date().toISOString() } = {}) {
  validatePushState(state);
  const current = state.intents.find((intent) => intent.jobId === jobId);
  if (!current || current.status !== 'submitting') throw new Error('Push result requires a submitting intent');

  let paused = state.paused;
  let update;
  if (result.status === 'accepted') {
    update = { status: 'accepted', result: { notificationId: result.notificationId, providerStatus: 'accepted' } };
  } else if (result.status === 'no_recipients') {
    update = { status: 'failed', result: { code: 'no_recipients', providerStatus: 'no_recipients' } };
  } else if (result.status === 'retryable') {
    update = {
      status: current.attempts >= 3 ? 'failed' : 'retryable',
      retryAfter: new Date(Date.parse(now) + (result.retryAfterSeconds * 1000)).toISOString(),
      result: { code: current.attempts >= 3 ? 'provider_retry_exhausted' : result.code },
    };
  } else if (result.status === 'uncertain') {
    update = {
      status: current.attempts >= 3 ? 'failed' : 'uncertain',
      result: { code: current.attempts >= 3 ? 'reconciliation_required' : result.code, providerStatus: 'uncertain' },
    };
  } else {
    update = { status: 'failed', result: { code: result.code } };
    if (result.code === 'authentication' || result.code === 'invalid_request') paused = { at: now, code: result.code };
  }

  const next = replaceIntent(state, jobId, (intent) => ({
    ...intent,
    ...update,
    updatedAt: now,
  }));
  return validatePushState({ ...next, paused });
}
