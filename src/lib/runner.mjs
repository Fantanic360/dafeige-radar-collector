/**
 * The runner: turns config + remote state into one bounded, resumable working session.
 *
 * Guarantees this file is responsible for:
 *  - a round never runs two workers on the same target (lease)
 *  - a killed process leaves recoverable state (atomic writes, lease TTL, ledger)
 *  - one flaky target cannot consume the whole budget (per-target timeout + breaker)
 *  - the emitted payload is replay-safe (idempotency key + stable ids)
 *  - evidence is written to disk before the payload references it
 */
import fs from 'node:fs';
import path from 'node:path';
import { CollectError, beijingDate, createClock, ensureDir, readJson, shortHash, writeJsonAtomic } from './core.mjs';
import { execFileSync } from 'node:child_process';
import { activeSources, buildTargets, DEFAULT_PATHS, loadJsonConfig, PKG_ROOT } from './config.mjs';
import { createHttpClient } from './http.mjs';
import { IdempotencyStore, RunLedger } from './ledger.mjs';
import { canonicalUrl, postIdFor, sanitizePostId } from './normalize.mjs';
import { isEditionRound, planContentQueue, planRound } from './policy.mjs';
import { FileLock, LeaseManager, StateStore } from './state.mjs';
import { mergeStates, SiteClient } from './site-client.mjs';
import { resolveAdapter } from '../adapters/registry.mjs';
import { validateResult } from '../adapters/base.mjs';

const HOUR = 3600_000;

/** Where this build came from; null when the checkout has no git metadata. */
let repoCache = null;
export function repoInfo() {
  if (repoCache) return repoCache;
  let sha = null;
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PKG_ROOT, encoding: 'utf8' }).trim();
  } catch {
    sha = null;
  }
  const cfg = readJson(path.join(DEFAULT_PATHS.config, 'repo.json'), null);
  repoCache = {
    url: process.env.RADAR_REPO_URL || cfg?.url || null,
    sha,
  };
  return repoCache;
}

export class Runner {
  constructor({ env, logger, clock = createClock(), rootDir, configDir = null }) {
    this.env = env;
    this.log = logger;
    this.clock = clock;
    this.rootDir = rootDir;
    this.stateDir = path.join(rootDir, 'state');
    this.evidenceRoot = path.join(rootDir, 'evidence');
    const dir = configDir || DEFAULT_PATHS.config;

    const policyDoc = loadJsonConfig('policy.json', { dir });
    const sourcesDoc = loadJsonConfig('sources.json', { dir });
    const adapterDoc = loadJsonConfig('adapters.json', { fallback: { overrides: {} }, dir });
    const extraDoc = loadJsonConfig('targets.extra.json', { fallback: { targets: [] }, dir });

    this.policy = policyDoc;
    this.sourcesDoc = sourcesDoc;
    this.adapterDoc = adapterDoc;
    this.extraDoc = extraDoc;

    ensureDir(this.stateDir);
    ensureDir(this.evidenceRoot);

    this.store = new StateStore(this.stateDir);
    this.lease = new LeaseManager(path.join(this.stateDir, 'leases.json'), {
      defaultTtlMs: policyDoc?.lease?.ttlMs || 600_000,
    });
    this.idempotency = new IdempotencyStore(path.join(this.stateDir, 'idempotency.json'));
    this.lock = new FileLock(path.join(this.stateDir, '.run.lock'));
    this.http = createHttpClient({
      timeoutMs: env.timeoutMs,
      logger,
      breaker: undefined,
    });
    this.site = new SiteClient({ env, http: this.http, getBrowser: () => this.getBrowser(), logger });
    this.browser = null;
    this.aborted = false;
  }

  /** Lazy, single browser instance per process. */
  async getBrowser() {
    if (!this.env.browserTier) {
      throw new CollectError('浏览器层已禁用（RADAR_BROWSER_TIER=0）', {
        status: 'blocked',
        stage: 'launch',
        code: 'BROWSER_DISABLED',
        nextStep: '设置 RADAR_BROWSER_TIER=1 后重跑',
      });
    }
    if (this.browser) return this.browser;
    const { default: Browser } = await import('../browser/cdp.mjs');
    this.browser = await Browser.launch({ headless: true });
    this.log?.info('浏览器已启动', { version: this.browser.version });
    return this.browser;
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  /** Resolve the working set: config targets, upgraded with live profiles from the mirror. */
  async resolveTargets(remoteSources = null) {
    const baseTargets = buildTargets(this.sourcesDoc, this.adapterDoc, this.extraDoc);
    if (!Array.isArray(remoteSources)) return baseTargets;

    // The site is the system of record for profile URLs. Use its profile list when it is
    // available, but never let it add a source that config does not consider active.
    const activeRemote = remoteSources.filter(s => s.enabled === true && s.directoryStatus !== 'removed');
    const byId = new Map(activeRemote.map((s) => [s.id, s]));
    const merged = [];
    for (const t of baseTargets) {
      const remote = byId.get(t.sourceId);
      if (!remote) continue;
      const remoteProfiles = (remote.profiles || []).filter((p) => p.status === 'verified' && p.url);
      const match = remoteProfiles.find((p) => p.url === t.url);
      if (match) merged.push({ ...t, label: match.label || t.label });
    }
    // Any remote profile that config is missing (newly verified by another agent).
    const seen = new Set(merged.map((t) => t.id));
    for (const s of activeRemote) {
      if (s.directoryStatus === 'removed' || s.enabled === false) continue;
      const cfg = activeSources(this.sourcesDoc).find((x) => x.id === s.id) || {};
      for (const p of (s.profiles || []).filter((x) => x.status === 'verified' && x.url)) {
        if (seen.has(`${s.id}::${encodeURIComponent(p.url)}`)) continue;
        merged.push({
          id: `${s.id}::${encodeURIComponent(p.url)}`,
          sourceId: s.id,
          sourceName: s.name,
          platform: p.platform,
          label: p.label || p.platform,
          url: p.url,
          primary: (s.primaryPlatforms || []).includes(p.platform),
          entityType: s.entityType || cfg.entityType,
          category: s.category,
          override: this.adapterDoc.overrides?.[`${s.id}|${p.platform}`] || null,
          fromRemote: true,
        });
      }
    }
    return merged;
  }

  windowFor(target, states, now) {
    const st = states[target.id] || {};
    if (st.pendingFrom && Number.isFinite(Date.parse(st.pendingFrom)) && Date.parse(st.pendingFrom) < now.getTime()) {
      return { windowFrom: new Date(st.pendingFrom).toISOString(), windowTo: now.toISOString() };
    }
    // Overlap the previous success window by 30 minutes: cheap insurance against clock
    // skew and late-appearing items, and duplicates are removed by post id anyway.
    const fromBase =
      st.lastSuccessWindowTo && new Date(st.lastSuccessWindowTo).getTime() < now.getTime()
        ? new Date(new Date(st.lastSuccessWindowTo).getTime() - 0.5 * HOUR)
        : new Date(now.getTime() - (this.policy?.window?.initialDays || 7) * 24 * HOUR);
    return { windowFrom: fromBase.toISOString(), windowTo: new Date(now).toISOString() };
  }

  /** Run one target under lease + timeout, returning a normalised result. */
  async runTarget(target, states, runCtx) {
    const { runId, evidenceDir } = runCtx;
    const adapterInfo = resolveAdapter(target);
    if (!adapterInfo.adapter) {
      return {
        target,
        result: {
          status: 'identity_pending',
          note: '没有为该作者×平台绑定适配器，未做任何读取。',
          evidenceUrl: target.url,
          pagesRead: 0,
          itemsRead: 0,
          posts: [],
          contentAttempts: [],
          ...this.windowFor(target, states, new Date(this.clock.now())),
        },
      };
    }

    const lease = this.lease.acquire(target.id, { runId, ttlMs: this.policy?.lease?.ttlMs || 600_000 });
    if (!lease.ok) {
      return {
        target,
        skipped: true,
        reason: `目标被其他执行者持有租约（owner=${lease.holder?.owner}，到期 ${new Date(lease.holder?.expiresAt).toISOString()}）`,
      };
    }

    const { windowFrom, windowTo } = this.windowFor(target, states, new Date(this.clock.now()));
    const heartbeat = setInterval(() => this.lease.heartbeat(target.id, process.pid), this.policy?.lease?.heartbeatMs || 30_000);
    heartbeat.unref?.();

    const ctx = {
      http: this.http,
      getBrowser: () => this.getBrowser(),
      nowIso: () => this.clock.nowIso(),
      env: this.env,
      policy: this.policy,
      log: this.log,
      evidenceDir,
      saveEvidence: async (name, content) => {
        const safe = name.replace(/[^\w.-]+/g, '_');
        const file = path.join(evidenceDir, safe);
        await fs.promises.writeFile(file, content, 'utf8');
        return path.relative(this.rootDir, file);
      },
    };

    const timeoutMs = this.policy?.budget?.perTargetTimeoutMs || 180_000;
    let result;
    try {
      result = await withTimeout(
        adapterInfo.adapter.inspect({ target, source: this.sourcesDoc.sources.find((s) => s.id === target.sourceId), ctx, ...{ windowFrom, windowTo } }),
        timeoutMs,
        () => {
          throw new CollectError(`适配器超时（>${Math.round(timeoutMs / 1000)}s）`, {
            status: 'retry',
            stage: 'timeout',
            code: 'TARGET_TIMEOUT',
            nextStep: '缩小读取范围或检查平台是否整体变慢',
          });
        },
      );
    } catch (err) {
      const collectErr = err instanceof CollectError
        ? err
        : new CollectError(err?.message || String(err), { status: 'retry', stage: 'adapter', nextStep: '查看日志定位适配器异常' });
      // A timed-out browser target usually means the renderer is wedged. Throw the whole
      // browser away instead of letting the next target inherit a stuck tab.
      if (collectErr.stage === 'timeout' && this.browser) {
        this.log?.warn('目标超时，重置浏览器实例');
        await this.close().catch(() => {});
      }
      result = {
        status: collectErr.status,
        note: collectErr.toNote(),
        evidenceUrl: target.url,
        pagesRead: 0,
        itemsRead: 0,
        posts: [],
        contentAttempts: [],
        windowFrom,
        windowTo,
        failure: { stage: collectErr.stage, code: collectErr.code, retryable: collectErr.retryable },
      };
    } finally {
      clearInterval(heartbeat);
      this.lease.release(target.id, process.pid);
    }

    const checked = validateResult(result, target);
    return { target, result: checked.result, adapter: adapterInfo.adapter.name, adapterReason: adapterInfo.reason };
  }

  async runContentQueue({ states, posts, runCtx, cap }) {
    const eligiblePosts = this.activeSourceIds ? Object.fromEntries(Object.entries(posts).filter(([, p]) => this.activeSourceIds.has(p.sourceId))) : posts;
    const due = planContentQueue({ posts: eligiblePosts, now: new Date(this.clock.now()), cap });
    const done = [];
    for (const post of due) {
      if (this.aborted) break;
      const target = { id: `${post.sourceId}::${post.url}`, sourceId: post.sourceId, platform: post.platform, url: post.url };
      const { adapter } = resolveAdapter({ ...target, platform: post.platform });
      if (!adapter?.content) continue;
      const ctx = {
        http: this.http,
        getBrowser: () => this.getBrowser(),
        nowIso: () => this.clock.nowIso(),
        env: this.env,
        evidenceDir: runCtx.evidenceDir,
        saveEvidence: async (name, content) => {
          const safe = name.replace(/[^\w.-]+/g, '_');
          const file = path.join(runCtx.evidenceDir, safe);
          await fs.promises.writeFile(file, content, 'utf8');
          return path.relative(this.rootDir, file);
        },
      };
      let attempt;
      try {
        attempt = await withTimeout(adapter.content({ post, ctx }), 90_000, () => {
          throw new CollectError('正文补采超时', { status: 'retry', stage: 'timeout' });
        });
      } catch (err) {
        attempt = { status: 'retry', note: `正文补采异常：${err.message}` };
      }
      this.store.applyContentAttempt(post.id, { ...attempt, checkedAt: this.clock.nowIso() });
      this.store.save();
      done.push({ postId: post.id, ...attempt, checkedAt: this.clock.nowIso() });
    }
    return done;
  }

  /**
   * One session.
   * @param {object} opts
   * @param {boolean} [opts.dryRun] plan and read, never POST
   * @param {string[]} [opts.onlySourceIds]
   * @param {number} [opts.cap] override target cap
   */
  async runOnce({ dryRun = false, onlySourceIds = null, cap = null, force = false, scheduledFor = null } = {}) {
    if (scheduledFor && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(scheduledFor)) throw new Error('scheduledFor 必须是带时区的原计划执行时刻');
    this.lock.acquire();
    const runId = `run_${this.clock.nowIso().replace(/[-:.]/g, '')}_${shortHash(this.clock.nowIso(), 6)}`;
    const evidenceDir = ensureDir(path.join(this.evidenceRoot, runId));
    const ledger = new RunLedger(this.stateDir, {
      runId,
      meta: { edition: isEditionRound(scheduledFor, { editionHour: this.policy?.schedule?.editionHour }), scheduledFor, mode: this.site.mode },
    });

    const reclaimed = this.lease.reclaimExpired();
    if (reclaimed.length) ledger.event('lease.reclaimed', { count: reclaimed.length });

    try {
      if (!dryRun && this.site.canWrite) {
        for (const pending of this.store.data.meta.pendingCollectionBatches || []) {
          const replay = await this.site.pushCollection(pending.payload, { idempotencyKey: pending.key });
          if (replay?.ok !== true) throw new Error('待重放批次未获明确成功，保留outbox并停止');
          const replayQueue = await this.site.fetchQueue();
          if (!batchApplied(pending.payload, replayQueue)) throw new Error('待重放批次未通过回读，保留outbox并停止');
          this.idempotency.remember(pending.key, { runId: pending.payload.runId });
        }
        this.store.data.meta.pendingCollectionBatches = [];
        this.store.save();
      }
      this.log?.info('读取站点队列', { mode: this.site.mode, base: this.site.mode === 'editorial' ? this.site.editorialBase : this.site.publicBase });
      const queue = await this.site.fetchQueue().catch((err) => {
        this.log?.warn('无法读取站点队列，退回本地状态', { error: err.message });
        ledger.error({ stage: 'queue', message: err.message });
        // An unavailable live roster must not silently revive removed local targets.
        throw new CollectError('无法读取实时采编队列，停止本轮以保留原状态', { status: 'retry', stage: 'queue' });
      });

      const remoteSources = Array.isArray(queue.sources) ? queue.sources : null;
      this.activeSourceIds = remoteSources ? new Set(remoteSources.filter(s => s.enabled === true && s.directoryStatus !== 'removed').map(s => s.id)) : null;
      const targets = await this.resolveTargets(remoteSources);
      const states = mergeStates(this.store.allTargets(), queue.states || {});
      this.store.data.targets = states;
      this.store.data.posts = mergeRemotePosts(this.store.data.posts, queue.posts || {});
      const edition = isEditionRound(scheduledFor, { editionHour: this.policy?.schedule?.editionHour });
      const effectiveCap = edition ? targets.length : Math.min(cap ?? 8, 8);

      const plan = planRound({ targets, states, now: new Date(this.clock.now()), cap: effectiveCap, onlySourceIds, ignoreDue: force || edition });
      ledger.set('needsAttention', queue.needsAttention || []);
      ledger.set('plan', { edition, cap: effectiveCap, considered: plan.considered, selected: plan.selected.length, deferred: plan.deferred.length });
      ledger.count('planned', plan.selected.length);
      this.log?.info('本轮计划', { edition, considered: plan.considered, selected: plan.selected.length, cap: effectiveCap });

      const observations = [];
      const newPosts = [];
      const contentAttempts = [];
      const sent = { observations: 0, posts: 0, contentAttempts: 0 };
      let pushResult = { skipped: true, reason: dryRun ? 'dry-run 未写生产' : '未配置采编端凭据；结果包已生成，待维护者合并' };
      let pushFailed = false;
      const flushBatch = async () => {
        if (dryRun || !this.site.canWrite || pushFailed) return;
        const batch = {
          runId,
          generatedAt: this.clock.nowIso(),
          observations: observations.slice(sent.observations),
          posts: dedupeById(newPosts.slice(sent.posts)),
          contentAttempts: contentAttempts.slice(sent.contentAttempts),
        };
        if (!batch.observations.length && !batch.posts.length && !batch.contentAttempts.length) return;
        const key = IdempotencyStore.keyFor('collection', { observations: batch.observations, posts: batch.posts, contentAttempts: batch.contentAttempts });
        // Durable before sending: a crash or ambiguous network result is replayable.
        this.store.data.meta.pendingCollectionBatches = [{ key, payload: batch }];
        this.store.save();
        try {
          const res = await this.site.pushCollection(batch, { idempotencyKey: key });
          if (res?.ok !== true) throw new Error('采编接口未明确确认保存成功');
          const confirmed = await this.site.fetchQueue();
          if (!batchApplied(batch, confirmed)) throw new Error('采编批次回读未确认，保留outbox');
          this.idempotency.remember(key, { runId });
          sent.observations = observations.length;
          sent.posts = newPosts.length;
          sent.contentAttempts = contentAttempts.length;
          this.store.data.meta.pendingCollectionBatches = [];
          this.store.data.meta.lastPushAt = this.clock.nowIso();
          this.store.save();
          ledger.count('pushed');
          pushResult = { ok: true, response: res };
        } catch (err) {
          pushFailed = true;
          pushResult = { ok: false, error: err.message, outboxPreserved: true };
          ledger.count('pushFailed');
          ledger.error({ stage: 'push', message: err.message });
        }
      };
      // Per-host failure guard: if a platform is down for this network, stop burning the
      // round budget on it and say so explicitly instead of timing out 8 times.
      const hostFailures = new Map();
      const hostBotBlocks = new Set();

      for (const [idx, target] of plan.selected.entries()) {
        if (this.aborted) {
          this.log?.warn('收到中断信号，保留已完成进度');
          break;
        }
        const host = (() => {
          try {
            return new URL(target.url).host;
          } catch {
            return 'unknown';
          }
        })();
        if (hostBotBlocks.has(host) || (hostFailures.get(host) || 0) >= 2) {
          const obs = {
            sourceId: target.sourceId,
            platform: target.platform,
            url: target.url,
            checkedAt: this.clock.nowIso(),
            windowFrom: this.windowFor(target, states, new Date(this.clock.now())).windowFrom,
            windowTo: this.clock.nowIso(),
            status: 'retry',
            note: `本轮该主机（${host}）${hostBotBlocks.has(host) ? '已明确返回人机验证，停止同站其他入口' : '已连续失败 2 次，跳过剩余目标以保留预算'}；未做任何读取，不据此判断有无更新。`,
            evidenceUrl: target.url,
            skippedByBreaker: true,
          };
          // A skipped target is not an actual new check. Keep its original checkedAt.
          ledger.count('skippedByBreaker');
          ledger.event('target.host-breaker', { targetId: target.id, host });
          continue;
        }

        this.log?.info(`开始目标 ${idx + 1}/${plan.selected.length}`, { target: `${target.sourceId}/${target.platform}`, adapter: resolveAdapter(target).adapter?.name });
        const startedAt = Date.now();
        const outcome = await this.runTarget(target, states, { runId, evidenceDir });
        if (outcome.skipped) {
          this.log?.warn('跳过（租约被占用）', { target: target.id, reason: outcome.reason });
          ledger.event('target.skipped', { targetId: target.id, reason: outcome.reason });
          continue;
        }

        const { result } = outcome;
        if (['RISK_CONTROL', 'CAPTCHA', 'BOT_DETECTED'].includes(result.failure?.code)) hostBotBlocks.add(host);
        if (result.status === 'success') hostFailures.set(host, 0);
        else hostFailures.set(host, (hostFailures.get(host) || 0) + 1);
        const obs = {
          sourceId: target.sourceId,
          platform: target.platform,
          url: target.url,
          checkedAt: this.clock.nowIso(),
          windowFrom: result.windowFrom,
          windowTo: result.windowTo,
          status: result.status,
          note: result.note,
          evidenceUrl: result.evidenceUrl,
          failureCode: result.failure?.code || null,
          cursor: result.cursor || undefined,
          adapter: outcome.adapter,
          pagesRead: result.pagesRead,
          itemsRead: result.itemsRead,
          oldestSeenAt: result.oldestSeenAt,
          newestSeenAt: result.newestSeenAt,
        };
        observations.push(obs);
        this.store.applyObservation(obs);
        this.store.save();

        const postIdMap = new Map();
        const priorContentStates = new Map();
        for (const post of result.posts || []) {
          const existing = Object.values(this.store.data.posts).find(p => canonicalUrl(p.url) === canonicalUrl(post.url));
          const normalized = {
            id: existing?.id || (post.id ? sanitizePostId(post.id) : postIdFor({ sourceId: post.sourceId, platform: post.platform, platformPostId: post.platformPostId, url: post.url })),
            sourceId: post.sourceId || target.sourceId,
            platform: post.platform || target.platform,
            url: canonicalUrl(post.url),
            title: post.title || '',
            publishedAt: post.publishedAt ?? null,
            discoveredAt: existing?.discoveredAt || post.discoveredAt || this.clock.nowIso(),
            evidence: existing?.evidence && post.evidence === 'metadata' ? existing.evidence : post.evidence || 'metadata',
            evidenceUrl: existing?.evidence !== 'metadata' && post.evidence === 'metadata' ? existing?.evidenceUrl || post.evidenceUrl : post.evidenceUrl,
            evidenceNote: existing?.evidence !== 'metadata' && post.evidence === 'metadata' ? existing?.evidenceNote || post.evidenceNote || '' : post.evidenceNote || '',
            duration: post.duration ?? undefined,
            platformPostId: post.platformPostId,
            extra: post.extra,
          };
          if (post.id) postIdMap.set(post.id, normalized.id);
          if (existing) priorContentStates.set(normalized.id, existing);
          const existed = this.store.hasPost(normalized.id);
          this.store.upsertPost(normalized);
          if (!existed) {
            newPosts.push(normalized);
            ledger.count('newPosts');
          }
          // Only push a post the site has not stored yet, or whose evidence was upgraded.
          if (!queue.posts?.[normalized.id] || (queue.posts[normalized.id].evidence !== normalized.evidence && normalized.evidence !== 'metadata')) {
            newPosts.push(normalized);
          }
        }

        for (const attempt of result.contentAttempts || []) {
          if (!attempt?.postId) continue;
          const mappedAttempt = { ...attempt, postId: postIdMap.get(attempt.postId) || sanitizePostId(attempt.postId) };
          const prior = priorContentStates.get(mappedAttempt.postId);
          if (mappedAttempt.status !== 'verified' && prior && (['verified', 'blocked'].includes(prior.contentStatus) || Date.parse(prior.nextContentAttemptAt) > Date.parse(mappedAttempt.checkedAt))) continue;
          this.store.applyContentAttempt(mappedAttempt.postId, mappedAttempt);
          contentAttempts.push(mappedAttempt);
        }
        this.store.save();

        await flushBatch();
        if (pushFailed) break;

        ledger.target({
          durationMs: Date.now() - startedAt,
          targetId: target.id,
          sourceId: target.sourceId,
          platform: target.platform,
          adapter: outcome.adapter,
          status: result.status,
          itemsRead: result.itemsRead,
          posts: (result.posts || []).length,
          note: result.note.slice(0, 300),
          failure: result.failure || null,
        });
        this.log?.info('目标完成', {
          target: `${target.sourceId}/${target.platform}`,
          status: result.status,
          items: result.itemsRead,
          posts: (result.posts || []).length,
        });
      }

      const contentDone = pushFailed ? [] : await this.runContentQueue({
        states,
        posts: this.store.data.posts,
        runCtx: { runId, evidenceDir },
        cap: this.policy?.budget?.contentCap || 4,
      });
      for (const c of contentDone) {
        contentAttempts.push({ postId: c.postId, checkedAt: c.checkedAt, status: c.status, note: c.note, evidence: c.evidence });
        if (c.status === 'verified' && ['fulltext', 'transcript', 'visual'].includes(c.evidence)) {
          const stored = this.store.data.posts[c.postId];
          newPosts.push({ ...stored, evidence: c.evidence, evidenceNote: c.note, extra: { ...stored.extra, evidenceFile: c.transcriptFile || c.evidenceFile } });
        }
        if (c.status === 'verified') ledger.count('contentVerified');
        if (c.status === 'blocked') ledger.count('contentBlocked');
      }

      const payload = {
        version: '2026-11-14.1',
        runId,
        generatedAt: this.clock.nowIso(),
        observations,
        posts: dedupeById(newPosts),
        contentAttempts,
      };

      const payloadFile = path.join(evidenceDir, 'payload.json');
      writeJsonAtomic(payloadFile, payload);

      const exchange = toExchangeResult({ runId, payload, targets, mode: queue.mode });
      writeJsonAtomic(path.join(evidenceDir, 'result.json'), exchange);
      await flushBatch();

      const summary = this.store.summary(new Date(this.clock.now()));
      this.store.data.meta.runCount += 1;
      this.store.data.meta.lastRunAt = this.clock.nowIso();
      this.store.data.meta.lastRunId = runId;
      this.store.save();

      ledger.set('result', { push: pushResult, summary });
      const file = ledger.finish({ note: `${observations.length} 个目标、${payload.posts.length} 条原作、推送=${JSON.stringify(pushResult).slice(0, 80)}` });

      return { runId, evidenceDir, ledgerFile: file, payload, summary, pushResult, plan };
    } finally {
      this.lock.release();
    }
  }

  /** Public-mirror read-back: proves what the site actually serves after a push. */
  async verify({ runId = null } = {}) {
    const data = await this.site.readData();
    if (!data || !data.schemaVersion) {
      throw new CollectError('公开镜像未返回有效数据', {
        status: 'retry',
        stage: 'verify',
        nextStep: '确认公开站点可访问',
      });
    }
    const states = indexByIdLocal(data.collection?.states || []);
    const posts = indexByIdLocal(data.collection?.posts || []);
    const sources = data.sources || [];

    const localStates = this.store.allTargets();
    const checks = [];
    for (const [id, local] of Object.entries(localStates)) {
      const remote = states[id];
      const ok = Boolean(remote) && remote.checkedAt && Date.parse(remote.checkedAt) === Date.parse(local.checkedAt) && remote.status === local.status && (local.status !== 'success' || remote.lastSuccessWindowTo === local.lastSuccessWindowTo || remote.windowTo === local.windowTo);
      checks.push({
        targetId: id,
        localCheckedAt: local.checkedAt,
        remoteCheckedAt: remote?.checkedAt || null,
        ok,
        note: ok ? '公开镜像已反映本次检查时间' : '公开镜像尚未反映本次检查（可能未同步或未推送）',
      });
    }

    const localPosts = Object.values(this.store.data.posts);
    const postChecks = localPosts.map((p) => ({
      postId: p.id,
      present: Boolean(posts[p.id]),
      remotePublishedAt: posts[p.id]?.publishedAt || null,
      localPublishedAt: p.publishedAt,
      match: posts[p.id] ? posts[p.id].publishedAt === p.publishedAt : false,
    }));

    return {
      verifiedAt: new Date().toISOString(),
      schemaVersion: data.schemaVersion,
      sourceExportedAt: data.sourceExportedAt,
      counts: {
        sources: sources.length,
        states: Object.keys(states).length,
        posts: Object.keys(posts).length,
        localStates: Object.keys(localStates).length,
      },
      targetChecks: checks,
      postChecks,
    };
  }
}

export function mergeRemotePosts(local = {}, remote = {}) {
  const merged = { ...local };
  for (const [id, post] of Object.entries(remote)) {
    const previous = merged[id] || {};
    const remoteAt = Date.parse(post.contentCheckedAt || post.updatedAt || 0) || 0;
    const localAt = Date.parse(previous.contentCheckedAt || previous.updatedAt || 0) || 0;
    merged[id] = remoteAt >= localAt ? { ...previous, ...post } : { ...post, ...previous };
  }
  return merged;
}

export function batchApplied(batch, queue) {
  const states = Array.isArray(queue.states) ? indexByIdLocal(queue.states) : queue.states || {};
  const posts = Array.isArray(queue.posts) ? indexByIdLocal(queue.posts) : queue.posts || {};
  return (batch.observations || []).every(obs => {
    const remote = states[`${obs.sourceId}::${encodeURIComponent(obs.url)}`];
    return remote && Date.parse(remote.checkedAt) >= Date.parse(obs.checkedAt);
  }) && (batch.posts || []).every(post => {
    const remote = posts[post.id];
    return remote && remote.publishedAt === post.publishedAt && (post.evidence === 'metadata' || remote.evidence === post.evidence);
  }) && (batch.contentAttempts || []).every(attempt => {
    const remote = posts[attempt.postId];
    return remote && Date.parse(remote.contentCheckedAt) >= Date.parse(attempt.checkedAt);
  });
}

function indexByIdLocal(list) {
  const map = {};
  for (const item of list) if (item?.id) map[item.id] = item;
  return map;
}

function dedupeById(list) {
  const map = new Map();
  for (const item of list) map.set(item.id, { ...(map.get(item.id) || {}), ...item });
  return [...map.values()];
}

export function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } catch (err) {
        reject(err);
      }
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Map the internal payload onto the 04_返回格式说明 exchange shape. */
export function toExchangeResult({ runId, payload, targets, mode }) {
  const inspections = payload.observations.map((o) => ({
    sourceId: o.sourceId,
    platform: o.platform,
    profileUrl: o.url,
    checkedAt: o.checkedAt,
    requestedFrom: o.windowFrom,
    requestedTo: o.windowTo,
    // A failed read covered nothing. Only a success may claim a covered interval.
    coveredFrom: o.status === 'success' ? o.windowFrom : null,
    coveredTo: o.status === 'success' ? o.windowTo : null,
    status: o.status,
    pagesRead: o.pagesRead ?? 0,
    itemsRead: o.itemsRead ?? 0,
    oldestSeenAt: o.oldestSeenAt ?? null,
    newestSeenAt: o.newestSeenAt ?? null,
    pinnedHandling: '置顶项按发布时间过滤，未计入窗口新增',
    reason: o.note,
    nextStep: o.status === 'success' ? '' : '见 note 中的阶段与下一步',
    evidence: [],
  }));
  const posts = payload.posts.map((p) => ({
    sourceId: p.sourceId,
    platform: p.platform,
    platformPostId: p.platformPostId || null,
    originalUrl: p.url,
    title: p.title,
    publishedAt: p.publishedAt,
    datePrecision: p.publishedAt && String(p.publishedAt).includes('T') ? 'second' : p.publishedAt ? 'date' : 'unknown',
    publicationEvidence: p.evidenceUrl,
    discoveredAt: p.discoveredAt,
    durationSeconds: p.duration ?? null,
    contentEvidence: p.evidence,
    actualReadScope: p.evidenceNote,
    transcriptFile: p.extra?.transcriptFile || null,
    evidenceFiles: p.extra?.transcriptFile ? [p.extra.transcriptFile] : [],
  }));
  return {
    generatedAt: new Date().toISOString(),
    runId,
    mode,
    scope: `${targets.length} configured targets`,
    profiles: [],
    profileGaps: [],
    inspections,
    posts,
    recommendations: [],
    engineeringDeliverables: {
      taskCode: 'F/P0-adapters',
      repositoryUrl: repoInfo().url,
      commitSha: repoInfo().sha,
      patchFile: 'integration/site/APPLY.md',
      setupFile: 'docs/RUNBOOK.md',
      testsFile: 'test/',
      realRunEvidenceFiles: [`evidence/${runId}/result.json`, `evidence/${runId}/payload.json`],
      dependencies: [],
      knownLimits: '抖音/小红书/微博/公众号仍需已授权登录态；B站列表依赖渲染层。',
      secretScanPassed: null,
    },
    raw: { observationCount: payload.observations.length, contentAttempts: payload.contentAttempts.length },
  };
}
