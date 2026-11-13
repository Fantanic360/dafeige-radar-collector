/**
 * Site client.
 *
 * Two distinct back ends, because the deployment has two:
 *  - **editorial** (`RADAR_EDITORIAL_BASE` + token): the write API described in
 *    08_站点接入约定.md (/api/collection, /api/source-profiles, /api/context, /api/ingest).
 *  - **public mirror** (`RADAR_PUBLIC_BASE`): `/api/data` only, but it already contains
 *    `collection.states` and `collection.posts`, which is enough to plan a round and to
 *    verify a push afterwards.
 *
 * Both sit behind Cloudflare, and a bare Node `fetch` gets a 403 challenge page from some
 * networks. So every request has a browser fallback: same-origin `fetch` executed inside a
 * rendered page. That keeps the collector working on a normal home network without asking
 * anyone for a cookie.
 */
import { CollectError } from './core.mjs';

export class SiteClient {
  constructor({ env, http, getBrowser = null, logger = null }) {
    this.env = env;
    this.http = http;
    this.getBrowser = getBrowser;
    this.log = logger;
    this.publicBase = (env.publicBase || '').replace(/\/$/, '');
    this.editorialBase = (env.editorialBase || '').replace(/\/$/, '');
    this.token = env.editorialToken || '';
    this.authHeader = env.authHeader || 'authorization';
    this.browserOrigin = this.editorialBase || this.publicBase;
    this.mode = this.editorialBase && this.token ? 'editorial' : 'mirror';
    this.degraded = false;
  }

  get canWrite() {
    return this.mode === 'editorial';
  }

  url(path, base = null) {
    const b = base || (this.mode === 'editorial' ? this.editorialBase : this.publicBase);
    return `${b}${path.startsWith('/') ? path : `/${path}`}`;
  }

  headers(extra = {}) {
    const h = { accept: 'application/json', ...extra };
    if (this.token) h[this.authHeader] = this.token.startsWith('Bearer ') ? this.token : `Bearer ${this.token}`;
    return h;
  }

  /** Plain HTTP first; fall back to executing the request inside the rendered page. */
  async request(path, { method = 'GET', body = null, base = null, headers = {}, idempotencyKey = null } = {}) {
    const target = this.url(path, base);
    const h = this.headers({ ...headers, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) });
    if (body) h['content-type'] = 'application/json';

    try {
      const res = await this.http.request(target, {
        method,
        headers: h,
        body: body ? JSON.stringify(body) : undefined,
        timeoutMs: 30_000,
      });
      const text = await res.text();
      return { ok: true, status: res.status, body: this.#parse(text), raw: text, via: 'http' };
    } catch (err) {
      const status = err.details?.status;
      const lookBlocked = status === 403 || status === 503 || err.code === 'NETWORK' || err.code === 'TIMEOUT';
      if (!lookBlocked || !this.getBrowser) throw err;
      if (this.log) this.log.warn('站点直连失败，改用浏览器同源请求', { path, status: status ?? err.code });
      return this.requestViaBrowser(target, { method, body, headers: h, idempotencyKey });
    }
  }

  #parse(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { __raw: text.slice(0, 500) };
    }
  }

  async requestViaBrowser(target, { method = 'GET', body = null, headers = {} } = {}) {
    if (!this.getBrowser) {
      throw new CollectError('需要浏览器回退但浏览器层未启用', {
        status: 'retry',
        stage: 'network',
        nextStep: '设置 RADAR_BROWSER_TIER=1 或允许直连本站',
      });
    }
    this.degraded = true;
    const browser = await this.getBrowser();
    const origin = new URL(target).origin;
    const current = await browser.session.evaluate('location.origin').catch(() => null);
    if (current !== origin) {
      await browser.goto(this.browserOrigin || origin, { settleMs: 1500 });
    }

    const script = `(async () => {
      try {
        const res = await fetch(${JSON.stringify(target)}, {
          method: ${JSON.stringify(method)},
          headers: ${JSON.stringify(headers)},
          ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text };
      } catch (e) {
        return { ok: false, status: 0, text: 'ERR ' + (e && e.message) };
      }
    })()`;

    const out = await browser.session.evaluate(script, { awaitPromise: true, timeoutMs: 45_000 });
    const parsed = this.#parse(out.text);
    if (!out.ok) {
      throw new CollectError(`站点请求失败（浏览器回退）：HTTP ${out.status} ${String(out.text).slice(0, 160)}`, {
        status: out.status === 401 || out.status === 403 ? 'blocked' : 'retry',
        stage: 'http',
        code: `HTTP_${out.status}`,
        nextStep: out.status === 403 ? '检查 Cloudflare 访问策略或凭据' : '稍后重试',
      });
    }
    return { ok: true, status: out.status, body: parsed, raw: out.text, via: 'browser' };
  }

  /** Queue + states. Editorial returns live queue; mirror derives it from the snapshot. */
  async fetchQueue() {
    if (this.mode === 'editorial') {
      const res = await this.request('/api/collection');
      const body = res.body || {};
      return {
        mode: 'editorial',
        states: indexById(body.states || body.targets || []),
        posts: indexById(body.posts || []),
        needsAttention: body.needsAttention || [],
        pendingPosts: body.pendingPosts || [],
        blockedPosts: body.blockedPosts || [],
        fetchedAt: new Date().toISOString(),
      };
    }

    const data = await this.readData();
    const states = (data?.collection?.states || []).map((s) => ({ ...s, id: s.id || `${s.sourceId}::${encodeURIComponent(s.url)}` }));
    const posts = data?.collection?.posts || [];
    return {
      mode: 'mirror',
      states: indexById(states),
      posts: indexById(posts),
      needsAttention: states.filter((s) => s.status === 'blocked' || s.status === 'identity_pending'),
      pendingPosts: posts.filter((p) => p.contentStatus && p.contentStatus !== 'verified'),
      blockedPosts: posts.filter((p) => p.contentStatus === 'blocked'),
      sources: data?.sources || [],
      fetchedAt: new Date().toISOString(),
    };
  }

  /** Public snapshot. Used for planning and for post-push verification. */
  async readData({ date = null } = {}) {
    const path = date ? `/api/data?date=${encodeURIComponent(date)}` : '/api/data';
    const res = await this.request(path, { base: this.publicBase });
    return res.body;
  }

  /**
   * Push one batch: observations + posts + contentAttempts.
   * Sent as a single request so the site's transactional validation either accepts the
   * whole batch or none of it.
   */
  async pushCollection(payload, { idempotencyKey = null } = {}) {
    if (!this.canWrite) {
      throw new CollectError('未配置采编端地址或凭据，只生成本地结果包', {
        status: 'retry',
        stage: 'config',
        code: 'READ_ONLY',
        nextStep: '设置 RADAR_EDITORIAL_BASE 与 RADAR_EDITORIAL_TOKEN 后重试 push',
      });
    }
    const res = await this.request('/api/collection', {
      method: 'POST',
      body: payload,
      idempotencyKey,
    });
    return res.body;
  }

  async pushSourceProfiles(payload) {
    if (!this.canWrite) {
      throw new CollectError('未配置采编端；profile 更新只写本地文件', {
        status: 'retry',
        stage: 'config',
        code: 'READ_ONLY',
      });
    }
    const res = await this.request('/api/source-profiles', { method: 'POST', body: payload });
    return res.body;
  }

  async health() {
    const out = { mode: this.mode, publicBase: this.publicBase, editorialBase: this.editorialBase || null, checks: {} };
    try {
      const data = await this.readData();
      out.checks.public = { ok: Boolean(data?.schemaVersion), schemaVersion: data?.schemaVersion, sources: data?.sources?.length ?? 0 };
    } catch (err) {
      out.checks.public = { ok: false, error: err.message };
    }
    if (this.mode === 'editorial') {
      try {
        const q = await this.fetchQueue();
        out.checks.editorial = { ok: true, states: Object.keys(q.states).length };
      } catch (err) {
        out.checks.editorial = { ok: false, error: err.message };
      }
    }
    return out;
  }
}

export function indexById(list = []) {
  const map = {};
  for (const item of list) {
    if (!item) continue;
    const id = item.id || (item.sourceId && item.url ? `${item.sourceId}::${encodeURIComponent(item.url)}` : null);
    if (id) map[id] = { ...item, id };
  }
  return map;
}

/**
 * Merge local state with the site's state. The site wins on anything it knows (it is the
 * system of record); local wins on work the site has never seen.
 */
export function mergeStates(localStates = {}, remoteStates = {}) {
  const out = { ...remoteStates };
  for (const [id, local] of Object.entries(localStates)) {
    const remote = out[id];
    if (!remote) {
      out[id] = local;
      continue;
    }
    const remoteAt = remote.checkedAt ? new Date(remote.checkedAt).getTime() : 0;
    const localAt = local.checkedAt ? new Date(local.checkedAt).getTime() : 0;
    out[id] = { ...local, ...remote, ...(localAt > remoteAt ? { localAhead: true } : {}) };
  }
  return out;
}
