/**
 * Scheduling policy.
 *
 * This is the part that decides "what should happen at 08:00 vs 10:00", and it is the
 * difference between a queue that looks alive and one that actually covers the roster.
 *
 * Rules (from the site contract, 08_站点接入约定.md):
 *  - success  -> target becomes due again 4h later
 *  - failure  -> retry backoff 2/4/8/16/24h, capped at 24h, cursor never advances
 *  - blocked / identity_pending -> leaves the auto queue, surfaces as needsAttention
 *  - outside the 10:00 edition run, at most 8 due targets per round
 *  - the 10:00 edition run must cover every enabled source
 */

export const BACKOFF_HOURS = [2, 4, 8, 16, 24];
export const SUCCESS_RE_DUE_HOURS = 4;
export const DEFAULT_EDITION_HOUR = 10;
export const DEFAULT_OFF_EDITION_CAP = 8;

export function backoffHours(failCount) {
  const idx = Math.max(0, Math.min(failCount - 1, BACKOFF_HOURS.length - 1));
  return BACKOFF_HOURS[idx];
}

const HOUR = 3600_000;

/**
 * Apply an observation outcome to a target state.
 * Pure function: same inputs -> same output, which is what makes the tests meaningful.
 *
 * @param {object} prev previous state (may be empty)
 * @param {object} obs  {status, checkedAt, windowFrom, windowTo, note, evidenceUrl, cursor}
 * @returns {object} next state
 */
export function reduceTargetState(prev = {}, obs) {
  const checkedAt = obs.checkedAt || new Date().toISOString();
  const base = {
    ...prev,
    checkedAt,
    note: obs.note ?? prev.note ?? '',
    evidenceUrl: obs.evidenceUrl ?? prev.evidenceUrl,
    url: obs.url ?? prev.url,
    sourceId: obs.sourceId ?? prev.sourceId,
    platform: obs.platform ?? prev.platform,
  };

  switch (obs.status) {
    case 'success': {
      const failCount = 0;
      return {
        ...base,
        status: 'success',
        needsAttention: false,
        pendingFrom: null,
        failCount,
        windowFrom: obs.windowFrom ?? prev.windowFrom,
        windowTo: obs.windowTo ?? checkedAt,
        lastSuccessfulAt: checkedAt,
        lastSuccessWindowTo: obs.windowTo ?? checkedAt,
        nextDueAt: new Date(new Date(checkedAt).getTime() + SUCCESS_RE_DUE_HOURS * HOUR).toISOString(),
        cursor: obs.cursor ?? prev.cursor,
      };
    }
    case 'blocked':
    case 'identity_pending': {
      return {
        ...base,
        status: obs.status,
        failCount: (prev.failCount || 0) + 1,
        // Deliberately no nextDueAt: the auto queue must stop hammering a blocked entry.
        nextDueAt: null,
        needsAttention: true,
        pendingFrom: prev.pendingFrom || obs.windowFrom || prev.lastSuccessWindowTo || null,
        lastFailureAt: checkedAt,
      };
    }
    case 'retry':
    default: {
      const failCount = (prev.failCount || 0) + 1;
      const code = obs.failureCode || null;
      // Same cause failing three times in a row is not a transient blip: retrying it every
      // 24h just burns the round budget and hides the gap behind a reassuring "retry".
      // Escalate to blocked/needsAttention so it shows up as work for a human.
      const sameCause = Boolean(code) && code === (prev.lastFailureCode || null);
      const sameCauseCount = sameCause ? (prev.sameCauseCount || 1) + 1 : (code ? 1 : 0);
      if (code && sameCauseCount >= (obs.escalateAfter ?? 3)) {
        return {
          ...base,
          status: 'blocked',
          failCount,
          needsAttention: true,
          lastFailureAt: checkedAt,
          lastFailureCode: code,
          sameCauseCount,
          lastSuccessfulAt: prev.lastSuccessfulAt,
          lastSuccessWindowTo: prev.lastSuccessWindowTo,
          nextDueAt: null,
          escalatedFrom: 'retry',
          note: `${base.note}｜同一原因连续失败 ${sameCauseCount} 次（${code}），已停止自动重试，转为待处理。`,
        };
      }
      return {
        ...base,
        status: 'retry',
        failCount,
        pendingFrom: prev.pendingFrom || obs.windowFrom || prev.lastSuccessWindowTo || null,
        lastFailureAt: checkedAt,
        lastFailureCode: code,
        sameCauseCount,
        // Success cursor is preserved on purpose: a failed run must never look like progress.
        lastSuccessfulAt: prev.lastSuccessfulAt,
        lastSuccessWindowTo: prev.lastSuccessWindowTo,
        nextDueAt: new Date(new Date(checkedAt).getTime() + backoffHours(failCount) * HOUR).toISOString(),
      };
    }
  }
}

/**
 * How many targets may this round carry?
 *
 * The default for supplementary rounds stays at 8, but an explicit `--cap` has to win:
 * with 70 targets re-duing every 4h, "the edition round is the only full sweep" plus a
 * hard 8 ceiling makes the backlog mathematically impossible to clear.
 *
 * A ceiling still applies (40) so a typo cannot turn a 22:00 supplementary round into a
 * two-hour marathon.
 */
export function resolveRoundCap({ edition = false, cap = null, policy = null, targetCount = 0 } = {}) {
  if (edition) return Math.max(1, targetCount);
  const wanted = Number.isFinite(cap) && cap > 0 ? cap : policy?.budget?.offEditionCap ?? DEFAULT_OFF_EDITION_CAP;
  const ceiling = policy?.budget?.hardOffEditionCap ?? 40;
  return Math.max(1, Math.min(wanted, ceiling));
}

/**
 * Decide whether this round is an edition (10:00) round.
 * The operator runs the job at 08/10/12/14/16/18/20/22 Beijing time; only 10:00 is the
 * full-coverage edition run.
 */
export function isEditionRound(date, { editionHour = DEFAULT_EDITION_HOUR } = {}) {
  if (!date || !Number.isFinite(new Date(date).getTime())) return false;
  const beijing = new Date(new Date(date).getTime() + 8 * HOUR);
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  const target = editionHour * 60;
  return minutes === target;
}

/**
 * Build the ordered work list for one round.
 *
 * @param {object} params
 * @param {Array} params.targets  [{id, sourceId, platform, url, primary, adapter, mode}]
 * @param {Object} params.states  id -> state
 * @param {Date} params.now
 * @param {number} [params.cap]   max targets this round
 * @param {string[]} [params.onlySourceIds]
 * @param {boolean} [params.includeNeedsAttention]
 */
export function planRound({ targets, states = {}, now = new Date(), cap = DEFAULT_OFF_EDITION_CAP, onlySourceIds = null, includeNeedsAttention = false, ignoreDue = false }) {
  const nowMs = new Date(now).getTime();
  const eligible = targets.filter((t) => {
    if (onlySourceIds && !onlySourceIds.includes(t.sourceId)) return false;
    const st = states[t.id];
    if (!st) return true; // never inspected -> due now
    if (!includeNeedsAttention && (st.needsAttention || st.status === 'blocked' || st.status === 'identity_pending')) {
      return false;
    }
    if (!ignoreDue && st.nextDueAt && new Date(st.nextDueAt).getTime() > nowMs) return false;
    return true;
  });

  // Primary platforms first: a source's main channel is where a new release appears first.
  const scored = eligible.map((t, index) => {
    const st = states[t.id] || {};
    const dueAt = st.nextDueAt ? new Date(st.nextDueAt).getTime() : 0;
    return {
      target: t,
      index,
      overdueMs: nowMs - dueAt,
      neverChecked: !st.checkedAt,
      primary: t.primary ? 1 : 0,
    };
  });

  scored.sort((a, b) => {
    if (a.neverChecked !== b.neverChecked) return a.neverChecked ? -1 : 1;
    if (a.primary !== b.primary) return b.primary - a.primary;
    if (a.overdueMs !== b.overdueMs) return b.overdueMs - a.overdueMs;
    return a.index - b.index;
  });

  // Platform fairness: if one platform dominates the head of the queue, interleave so a
  // single flaky platform cannot starve the rest of the roster.
  const byPlatform = new Map();
  for (const item of scored) {
    const p = item.target.platform || 'unknown';
    if (!byPlatform.has(p)) byPlatform.set(p, []);
    byPlatform.get(p).push(item);
  }
  const lanes = [...byPlatform.values()];
  const interleaved = [];
  let added = true;
  while (added) {
    added = false;
    for (const lane of lanes) {
      const next = lane.shift();
      if (next) {
        interleaved.push(next);
        added = true;
      }
    }
  }

  const selected = interleaved.slice(0, Math.max(0, cap));
  return {
    selected: selected.map((s) => s.target),
    deferred: interleaved.slice(selected.length).map((s) => s.target),
    considered: eligible.length,
  };
}

/**
 * Content (fulltext/transcript) queue selection.
 * Metadata discovery makes the content attempt due immediately; failures back off.
 */
export function planContentQueue({ posts = {}, now = new Date(), cap = 4 }) {
  const nowMs = new Date(now).getTime();
  const due = [];
  for (const [id, p] of Object.entries(posts)) {
    if (p.contentStatus === 'verified' || p.contentStatus === 'blocked') continue;
    const at = p.nextContentAttemptAt ? new Date(p.nextContentAttemptAt).getTime() : 0;
    if (at > nowMs) continue;
    due.push({ id, ...p, overdueMs: nowMs - at });
  }
  due.sort((a, b) => b.overdueMs - a.overdueMs);
  return due.slice(0, cap);
}

/** Content retry: same 2/4/8/16/24h ladder, blocked stops the clock. */
export function reduceContentState(prev = {}, attempt) {
  const checkedAt = attempt.checkedAt || new Date().toISOString();
  const failCount = (prev.contentFailCount || 0) + (attempt.status === 'verified' ? 0 : 1);
  if (attempt.status === 'verified') {
    return {
      ...prev,
      contentStatus: 'verified',
      contentFailCount: 0,
      nextContentAttemptAt: null,
      contentCheckedAt: checkedAt,
      contentNote: attempt.note || '',
      evidence: attempt.evidence || prev.evidence,
    };
  }
  if (attempt.status === 'blocked') {
    return {
      ...prev,
      contentStatus: 'blocked',
      contentFailCount: failCount,
      nextContentAttemptAt: null,
      contentCheckedAt: checkedAt,
      contentNote: attempt.note || '',
      contentNeedsAttention: true,
    };
  }
  return {
    ...prev,
    contentStatus: 'retry',
    contentFailCount: failCount,
    nextContentAttemptAt: new Date(new Date(checkedAt).getTime() + backoffHours(failCount) * HOUR).toISOString(),
    contentCheckedAt: checkedAt,
    contentNote: attempt.note || '',
  };
}
