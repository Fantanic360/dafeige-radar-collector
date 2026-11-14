/**
 * Snapshot audit.
 *
 * Reads the public `/api/data` mirror and answers the questions a maintainer actually
 * asks after a week of running: is the roster still being checked, is anything silently
 * rotting, did a rule get violated without anyone noticing.
 *
 * This exists because "队列上线了" and "每天都在检查" are different claims, and only the
 * second one is checkable. Every check below is a pure function over the snapshot so it can
 * be run in CI, in a review, or by the next agent.
 */

const HOUR_MS = 3600_000;

const toDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** 4xx/5xx are already excluded upstream; this is about semantic freshness. */
export function freshnessReport(data, { now = new Date(), staleAfterHours = 6 } = {}) {
  const states = data?.collection?.states || [];
  const rows = states.map((s) => {
    const checked = toDate(s.checkedAt);
    return {
      sourceId: s.sourceId,
      platform: s.platform,
      status: s.status,
      failCount: s.failCount || 0,
      checkedAt: s.checkedAt || null,
      hoursSinceCheck: checked ? Math.round(((now - checked) / HOUR_MS) * 10) / 10 : null,
      nextDueAt: s.nextDueAt || null,
      overdueHours:
        s.nextDueAt && toDate(s.nextDueAt) < now
          ? Math.round(((now - toDate(s.nextDueAt)) / HOUR_MS) * 10) / 10
          : 0,
    };
  });

  const actionable = rows.filter((r) => !['blocked', 'identity_pending'].includes(r.status));
  const stale = actionable.filter((r) => (r.hoursSinceCheck ?? 999) >= staleAfterHours);
  const overdue = actionable.filter((r) => r.overdueHours > 0);

  return {
    total: rows.length,
    actionable: actionable.length,
    stale: stale.length,
    overdue: overdue.length,
    worst: [...actionable].sort((a, b) => (b.hoursSinceCheck ?? 999) - (a.hoursSinceCheck ?? 999)).slice(0, 10),
    bucket: {
      under4h: actionable.filter((r) => (r.hoursSinceCheck ?? 999) < 4).length,
      between4and8h: actionable.filter((r) => (r.hoursSinceCheck ?? 999) >= 4 && (r.hoursSinceCheck ?? 999) < 8).length,
      over8h: actionable.filter((r) => (r.hoursSinceCheck ?? 999) >= 8).length,
    },
    rows,
  };
}

/**
 * Is the declared cadence actually serviceable?
 *
 * success re-dues after `reDueHours`; each round can only carry `cap` targets. If the
 * product of rounds-per-day and cap is below roster*24/reDueHours, the queue is in
 * structural deficit and backlog grows no matter how healthy each individual run looks.
 */
export function capacityReport(data, { roundsPerDay = 7, cap = 8, editionCap = 100, reDueHours = 4 } = {}) {
  const states = data?.collection?.states || [];
  const actionable = states.filter((s) => !['blocked', 'identity_pending'].includes(s.status)).length;
  const checksPerDay = roundsPerDay * cap + editionCap;
  const checksNeeded = Math.ceil((actionable * 24) / reDueHours);
  return {
    actionable,
    reDueHours,
    checksPerDay,
    checksNeededPerDay: checksNeeded,
    deficit: checksNeeded - checksPerDay,
    verdict: checksPerDay >= checksNeeded ? 'sustainable' : 'structural-deficit',
    suggestion:
      checksPerDay >= checksNeeded
        ? '当前节奏能维持声明的重到期周期。'
        : `按 ${reDueHours}h 重到期，每天需要 ≈${checksNeeded} 次检查，实际只有 ${checksPerDay} 次。` +
          `要么把非出刊轮容量提到 ≥${Math.ceil((checksNeeded - editionCap) / roundsPerDay)}，` +
          `要么把 success 重到期放宽到 ≥${Math.ceil((actionable * 24) / checksPerDay)}h，` +
          `要么按主/次平台分层。`,
  };
}

/** Targets that keep failing for the same reason should be blocked, not retried forever. */
export function escalationCandidates(data, { threshold = 3 } = {}) {
  return (data?.collection?.states || [])
    .filter((s) => s.status === 'retry' && (s.failCount || 0) >= threshold)
    .map((s) => ({
      sourceId: s.sourceId,
      platform: s.platform,
      failCount: s.failCount,
      note: (s.note || '').slice(0, 160),
      hint: '同一原因反复失败，应转 blocked/needsAttention，否则会持续占用轮次预算',
    }));
}

/** Date integrity: no future dates, no silent nulls without an explicit marker. */
export function dateIntegrity(data, { now = new Date() } = {}) {
  const articles = data?.articles || [];
  const future = [];
  const undated = [];
  const badPrecision = [];
  for (const a of articles) {
    if (!a.publishedAt) {
      if (a.publicationStatus !== 'undated-reference') {
        undated.push({ id: a.id, title: (a.title || '').slice(0, 40), hasMarker: false });
      }
      continue;
    }
    const d = toDate(a.publishedAt);
    if (!d) {
      badPrecision.push({ id: a.id, publishedAt: a.publishedAt });
      continue;
    }
    if (d > now) future.push({ id: a.id, publishedAt: a.publishedAt });
  }
  return { total: articles.length, future, undatedWithoutMarker: undated, unparsable: badPrecision };
}

/** Removed/disabled sources must keep history but must not look like live authors. */
export function directoryIntegrity(data) {
  const sources = data?.sources || [];
  const byId = new Map(sources.map((s) => [s.id, s]));
  const removedIds = new Set(sources.filter((s) => s.directoryStatus === 'removed').map((s) => s.id));
  const enabledIds = new Set(sources.filter((s) => s.enabled).map((s) => s.id));

  const fromRemoved = (data?.articles || []).filter((a) => removedIds.has(a.sourceId));
  const fromDisabled = (data?.articles || []).filter(
    (a) => byId.has(a.sourceId) && !enabledIds.has(a.sourceId) && !removedIds.has(a.sourceId),
  );
  const edition = data?.edition || {};
  const primary = new Set(edition.primaryIds || []);
  const removedInPrimary = [...primary].filter((id) => {
    const article = (data?.articles || []).find((a) => a.id === id);
    return article && removedIds.has(article.sourceId);
  });

  return {
    enabled: enabledIds.size,
    removed: removedIds.size,
    articlesFromRemoved: fromRemoved.length,
    articlesFromDisabled: fromDisabled.length,
    removedSourceIds: [...new Set(fromRemoved.map((a) => a.sourceId))],
    recentlyAddedFromRemoved: fromRemoved
      .filter((a) => a.addedAt && new Date(a.addedAt) > new Date(Date.now() - 48 * HOUR_MS))
      .map((a) => ({ id: a.id, sourceId: a.sourceId, addedAt: a.addedAt })),
    removedArticleInPrimary: removedInPrimary,
  };
}

/** Every enabled source must have exactly one check in the current edition. */
export function editionCoverage(data) {
  const sources = data?.sources || [];
  const enabled = sources.filter((s) => s.enabled).map((s) => s.id);
  const checks = data?.edition?.checks || [];
  const checkedIds = new Set(checks.map((c) => c.sourceId));
  const missing = enabled.filter((id) => !checkedIds.has(id));
  const duplicated = [...checkedIds].filter((id) => checks.filter((c) => c.sourceId === id).length > 1);
  const statuses = {};
  for (const c of checks) statuses[c.status] = (statuses[c.status] || 0) + 1;
  return { enabled: enabled.length, checks: checks.length, missing, duplicated, statuses };
}

/** Voice briefs: one per edition, with a duration and (ideally) jumpable segments. */
export function broadcastIntegrity(data) {
  const broadcasts = data?.broadcasts || [];
  const byDate = new Map();
  for (const b of broadcasts) {
    const key = b.date;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(b);
  }
  const duplicates = [...byDate.entries()].filter(([, list]) => list.length > 1).map(([date, list]) => ({
    date,
    count: list.length,
    audioUrls: list.map((b) => b.audioUrl),
  }));
  const missingSegments = broadcasts.filter((b) => !Array.isArray(b.segments) || b.segments.length === 0);
  const missingDuration = broadcasts.filter((b) => !b.duration);
  const missingAudio = broadcasts.filter((b) => !b.audioUrl);
  return {
    total: broadcasts.length,
    duplicates,
    withoutSegments: missingSegments.length,
    withoutDuration: missingDuration.length,
    withoutAudio: missingAudio.length,
  };
}

/** Anything credential-shaped must never appear in a public mirror. */
export function leakScan(data) {
  const text = JSON.stringify(data);
  const patterns = [
    [/gh[pousr]_[A-Za-z0-9]{20,}/, 'github token'],
    [/sk-[A-Za-z0-9]{20,}/, 'api key'],
    [/SESSDATA=[A-Za-z0-9%]{10,}/, 'bilibili cookie'],
    [/buvid3=[A-Za-z0-9-]{10,}/, 'bilibili cookie'],
    [/X-Amz-Signature=[A-Za-z0-9%]{20,}/, 'signed url'],
    [/"authorization"\s*:\s*"[^"]{8,}"/i, 'authorization header'],
    [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'jwt'],
  ];
  const hits = [];
  for (const [re, label] of patterns) if (re.test(text)) hits.push(label);
  return { ok: hits.length === 0, hits, bytes: text.length };
}

/** One call, one report. */
export function auditSnapshot(data, options = {}) {
  const now = options.now || new Date();
  const freshness = freshnessReport(data, { now, staleAfterHours: options.staleAfterHours ?? 6 });
  const capacity = capacityReport(data, options.capacity || {});
  const escalation = escalationCandidates(data, options.escalation || {});
  const dates = dateIntegrity(data, { now });
  const directory = directoryIntegrity(data);
  const coverage = editionCoverage(data);
  const broadcasts = broadcastIntegrity(data);
  const leaks = leakScan(data);

  const problems = [];
  const push = (level, code, message) => problems.push({ level, code, message });

  if (freshness.overdue > 0) {
    push('P0', 'BACKLOG', `${freshness.overdue}/${freshness.actionable} 个可检查目标已过期，最久 ${freshness.worst[0]?.hoursSinceCheck ?? '?'}h 未检查`);
  }
  if (capacity.verdict !== 'sustainable') push('P0', 'CAPACITY_DEFICIT', capacity.suggestion);
  if (escalation.length) push('P1', 'RETRY_LOOP', `${escalation.length} 个目标同因失败 ≥3 次仍是 retry，应转 blocked：${escalation.map((e) => `${e.sourceId}/${e.platform}`).join('、')}`);
  if (dates.future.length) push('P1', 'FUTURE_DATE', `${dates.future.length} 篇文章发布时间在未来`);
  if (dates.undatedWithoutMarker.length) push('P2', 'UNDATED_NO_MARKER', `${dates.undatedWithoutMarker.length} 篇文章无发布时间且未标 undated-reference`);
  if (directory.recentlyAddedFromRemoved.length) push('P2', 'REMOVED_SOURCE_ACTIVE', `${directory.recentlyAddedFromRemoved.length} 篇近期新增文章来自 directoryStatus=removed 的来源，需确认是"历史引用"还是"变相恢复"`);
  if (coverage.missing.length) push('P1', 'EDITION_GAP', `当日出刊漏掉 ${coverage.missing.length} 个启用来源：${coverage.missing.slice(0, 6).join('、')}`);
  if (coverage.duplicated.length) push('P2', 'EDITION_DUP', `${coverage.duplicated.length} 个来源在同一期有重复 check`);
  if (broadcasts.duplicates.length) push('P1', 'AUDIO_DUP', `${broadcasts.duplicates.length} 天存在多条语音播报（可能重复生成/计费）`);
  if (broadcasts.withoutSegments > 0) push('P2', 'AUDIO_NO_SEGMENTS', `${broadcasts.withoutSegments} 条语音没有时间片段，页面只能整段播放`);
  if (!leaks.ok) push('P0', 'SECRET_LEAK', `公开镜像出现疑似凭据：${leaks.hits.join('、')}`);

  return {
    auditedAt: now.toISOString(),
    schemaVersion: data?.schemaVersion ?? null,
    editionDate: data?.edition?.date ?? null,
    counts: {
      sources: data?.sources?.length ?? 0,
      articles: data?.articles?.length ?? 0,
      checks: data?.checks?.length ?? 0,
      states: data?.collection?.states?.length ?? 0,
      posts: data?.collection?.posts?.length ?? 0,
      broadcasts: data?.broadcasts?.length ?? 0,
    },
    freshness: { ...freshness, rows: undefined },
    capacity,
    escalation,
    dates,
    directory,
    coverage,
    broadcasts,
    leaks: { ok: leaks.ok, hits: leaks.hits, bytes: leaks.bytes },
    problems,
  };
}

/** Human-readable rendering for the CLI. */
export function formatAudit(report) {
  const lines = [];
  const lv = { P0: '🔴', P1: '🟠', P2: '🟡' };
  lines.push(`快照审计 ${report.auditedAt}  schema=v${report.schemaVersion}  期号=${report.editionDate}`);
  lines.push(
    `来源 ${report.counts.sources} · 文章 ${report.counts.articles} · 状态 ${report.counts.states} · 原作 ${report.counts.posts} · 语音 ${report.counts.broadcasts}`,
  );
  lines.push('');
  lines.push(`新鲜度：<4h ${report.freshness.bucket.under4h} · 4-8h ${report.freshness.bucket.between4and8h} · >8h ${report.freshness.bucket.over8h} · 过期 ${report.freshness.overdue}`);
  lines.push(`容量：每天可检查 ${report.capacity.checksPerDay} 次 / 需要 ${report.capacity.checksNeededPerDay} 次 → ${report.capacity.verdict === 'sustainable' ? '可持续' : '结构性赤字'}`);
  lines.push('');
  if (!report.problems.length) {
    lines.push('没有发现阻断性问题。');
  } else {
    for (const p of report.problems) lines.push(`${lv[p.level] || '•'} [${p.level}] ${p.code}  ${p.message}`);
  }
  if (report.freshness.worst?.length) {
    lines.push('');
    lines.push('最久未检查：');
    for (const r of report.freshness.worst.slice(0, 8)) {
      lines.push(`  ${String(r.hoursSinceCheck ?? '?').padStart(6)}h  ${r.sourceId}/${r.platform}  ${r.status}  fail=${r.failCount}`);
    }
  }
  return lines.join('\n');
}
