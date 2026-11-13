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
import { CollectError, beijingDate, beijingHour, createClock, ensureDir, shortHash, writeJsonAtomic } from './core.mjs';
import { activeSources, buildTargets, DEFAULT_PATHS, loadJsonConfig } from './config.mjs';
import { createHttpClient } from './http.mjs';
import { IdempotencyStore, RunLedger } from './ledger.mjs';
import { canonicalUrl, postIdFor } from './normalize.mjs';
import { isEditionRound, planContentQueue, planRound } from './policy.mjs';
import { FileLock, LeaseManager, StateStore } from './state.mjs';
import { mergeStates, SiteClient } from './site-client.mjs';
import { resolveAdapter } from '../adapters/registry.mjs';
import { validateResult } from '../adapters/base.mjs';

const HOUR = 3600_000;

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
  async resolveTargets(remoteSources = []) {
    const baseTargets = buildTargets(this.sourcesDoc, this.adapterDoc, this.extraDoc);
    if (!remoteSources.length) return baseTargets;

    // The site is the system of record for profile URLs. Use its profile list when it is
    // available, but never let it add a source that config does not consider active.
    const byId = new Map(remoteSources.map((s) => [s.id, s]));
    const merged = [];
    for (const t of baseTargets) {
      const remote = byId.get(t.sourceId);
      if (!remote) continue;
      const remoteProfiles = (remote.profiles || []).filter((p) => p.status === 'verified' && p.url);
      const match = remoteProfiles.find((p) => p.url === t.url);
      if (match) merged.push({ ...t, label: match.label || t.label });
    }
    // Any remote profile that config is missing (newly verified by another agent).
    const seen = new Set(merged.map((t) => t.url));
    for (const s of remoteSources) {
      if (s.directoryStatus === 'removed' || s.enabled === false) continue;
      const cfg = activeSources(this.sourcesDoc).find((x) => x.id === s.id);
      if (!cfg) continue;
      for (const p of (s.profiles || []).filter((x) => x.status === 'verified' && x.url)) {
        if (seen.has(p.url)) continue;
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
    const due = planContentQueue({ posts, now: new Date(this.clock.now()), cap });
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
      done.push({ postId: post.id, ...attempt });
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
  async runOnce({ dryRun = false, onlySourceIds = null, cap = null, force = false } = {}) {
    this.lock.acquire();
    const runId = `run_${beijingDate(this.clock.now()).replace(/-/g, '')}_${new Date(this.clock.now()).toISOString().slice(11, 16).replace(':', '')}_${shortHash(this.clock.nowIso(), 6)}`;
    const evidenceDir = ensureDir(path.join(this.evidenceRoot, runId));
    const ledger = new RunLedger(this.stateDir, {
      runId,
      meta: { edition: isEditionRound(this.clock.now(), { editionHour: this.policy?.schedule?.editionHour }), mode: this.site.mode },
    });

    const reclaimed = this.lease.reclaimExpired();
    if (reclaimed.length) ledger.event('lease.reclaimed', { count: reclaimed.length });

    try {
      this.log?.info('读取站点队列', { mode: this.site.mode, base: this.site.mode === 'editorial' ? this.site.editorialBase : this.site.publicBase });
      const queue = await this.site.fetchQueue().catch((err) => {
        this.log?.warn('无法读取站点队列，退回本地状态', { error: err.message });
        ledger.error({ stage: 'queue', message: err.message });
        return { mode: 'offline', states: {}, posts: {}, sources: [] };
      });

      const remoteSources = queue.sources?.length ? queue.sources : [];
      const targets = await this.resolveTargets(remoteSources);
      const states = mergeStates(this.store.allTargets(), queue.states || {});
      const edition = isEditionRound(this.clock.now(), { editionHour: this.policy?.schedule?.editionHour });
      const effectiveCap = cap ?? (edition ? (this.policy?.budget?.editionCap || 100) : (this.policy?.budget?.offEditionCap || 8));

      const plan = planRound({ targets, states, now: new Date(this.clock.now()), cap: effectiveCap, onlySourceIds, ignoreDue: force });
      ledger.set('plan', { edition, cap: effectiveCap, considered: plan.considered, selected: plan.selected.length, deferred: plan.deferred.length });
      ledger.count('planned', plan.selected.length);
      this.log?.info('本轮计划', { edition, considered: plan.considered, selected: plan.selected.length, cap: effectiveCap });

      const observations = [];
      const newPosts = [];
      const contentAttempts = [];
      // Per-host failure guard: if a platform is down for this network, stop burning the
      // round budget on it and say so explicitly instead of timing out 8 times.
      const hostFailures = new Map();

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
        if ((hostFailures.get(host) || 0) >= 2) {
          const obs = {
            sourceId: target.sourceId,
            platform: target.platform,
            url: target.url,
            checkedAt: this.clock.nowIso(),
            windowFrom: this.windowFor(target, states, new Date(this.clock.now())).windowFrom,
            windowTo: this.clock.nowIso(),
            status: 'retry',
            note: `本轮该主机（${host}）已连续失败 2 次，跳过剩余目标以保留预算；未做任何读取，不据此判断有无更新。`,
            evidenceUrl: target.url,
            skippedByBreaker: true,
          };
          observations.push(obs);
          this.store.applyObservation(obs);
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
          cursor: result.cursor || undefined,
          adapter: outcome.adapter,
          pagesRead: result.pagesRead,
          itemsRead: result.itemsRead,
          oldestSeenAt: result.oldestSeenAt,
          newestSeenAt: result.newestSeenAt,
        };
        observations.push(obs);
        this.store.applyObservation(obs);

        for (const post of result.posts || []) {
          const normalized = {
            id: post.id || postIdFor({ sourceId: post.sourceId, platform: post.platform, platformPostId: post.platformPostId, url: post.url }),
            sourceId: post.sourceId || target.sourceId,
            platform: post.platform || target.platform,
            url: canonicalUrl(post.url),
            title: post.title || '',
            publishedAt: post.publishedAt ?? null,
            discoveredAt: post.discoveredAt || this.clock.nowIso(),
            evidence: post.evidence || 'metadata',
            evidenceUrl: post.evidenceUrl,
            evidenceNote: post.evidenceNote || '',
            duration: post.duration ?? undefined,
            platformPostId: post.platformPostId,
            extra: post.extra,
          };
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
          this.store.applyContentAttempt(attempt.postId, attempt);
          contentAttempts.push(attempt);
        }

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

      const contentDone = await this.runContentQueue({
        states,
        posts: this.store.data.posts,
        runCtx: { runId, evidenceDir },
        cap: this.policy?.budget?.contentCap || 4,
      });
      for (const c of contentDone) {
        contentAttempts.push({ postId: c.postId, checkedAt: this.clock.nowIso(), status: c.status, note: c.note });
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

      let pushResult = { skipped: true, reason: 'dry-run' };
      if (!dryRun && this.site.canWrite && payload.observations.length) {
        const key = IdempotencyStore.keyFor('collection', {
          obs: payload.observations.map((o) => `${o.sourceId}|${o.platform}|${o.status}|${o.windowTo}`),
          posts: payload.posts.map((p) => p.id),
        });
        if (this.idempotency.has(key)) {
          pushResult = { skipped: true, reason: 'identical payload already pushed', key };
          ledger.event('push.idempotent-skip', { key });
        } else {
          try {
            const res = await this.site.pushCollection(payload, { idempotencyKey: key });
            this.idempotency.remember(key, { runId, count: payload.observations.length });
            ledger.count('pushed');
            pushResult = { ok: true, response: res };
            this.store.data.meta.lastPushAt = this.clock.nowIso();
          } catch (err) {
            ledger.count('pushFailed');
            ledger.error({ stage: 'push', message: err.message });
            pushResult = { ok: false, error: err.message };
          }
        }
      } else if (dryRun) {
        pushResult = { skipped: true, reason: 'dry-run 未写生产' };
      } else if (!this.site.canWrite) {
        pushResult = { skipped: true, reason: '未配置采编端凭据；结果包已生成，待维护者合并' };
      }

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
      if (local.status !== 'success') continue;
      const remote = states[id];
      const ok = Boolean(remote) && remote.checkedAt &&
        Math.abs(new Date(remote.checkedAt) - new Date(local.checkedAt)) < 6 * HOUR;
      checks.push({
        targetId: id,
        localCheckedAt: local.checkedAt,
        remoteCheckedAt: remote?.checkedAt || null,
        ok,
        note: ok ? '公开镜像已反映本次检查时间' : '公开镜像尚未反映本次检查（可能未同步或未推送）',
      });
    }

    const localPosts = Object.values(this.store.data.posts);
    const postChecks = localPosts.slice(0, 50).map((p) => ({
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
        states: states.length,
        posts: posts.length,
        localStates: Object.keys(localStates).length,
      },
      targetChecks: checks,
      postChecks,
    };
  }
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
    coveredFrom: o.windowFrom,
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
      repositoryUrl: null,
      commitSha: null,
      patchFile: null,
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
