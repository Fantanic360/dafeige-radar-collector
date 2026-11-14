/**
 * HTTP client with the properties a scheduled collector actually needs:
 * hard timeouts, bounded retries, honouring Retry-After, per-host rate limits and a
 * circuit breaker so one dead platform cannot burn the whole run budget.
 *
 * No dependencies: Node 20+ ships fetch/AbortSignal.
 */
import { CollectError } from './core.mjs';

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Token-bucket-ish limiter: at most `concurrency` in flight, `minIntervalMs` between starts. */
export class HostLimiter {
  constructor({ minIntervalMs = 350, concurrency = 2 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.concurrency = concurrency;
    this.state = new Map();
  }

  #bucket(host) {
    if (!this.state.has(host)) {
      this.state.set(host, { lastStart: 0, active: 0, waiters: [] });
    }
    return this.state.get(host);
  }

  async acquire(host) {
    const b = this.#bucket(host);
    if (b.active >= this.concurrency) {
      await new Promise((resolve) => b.waiters.push(resolve));
    }
    b.active += 1;
    const wait = b.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    b.lastStart = Date.now();
  }

  release(host) {
    const b = this.#bucket(host);
    b.active = Math.max(0, b.active - 1);
    const next = b.waiters.shift();
    if (next) next();
  }
}

export class CircuitBreaker {
  constructor({ failureThreshold = 4, cooldownMs = 5 * 60_000, now = () => Date.now() } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.hosts = new Map();
  }

  #h(host) {
    if (!this.hosts.has(host)) this.hosts.set(host, { failures: 0, openUntil: 0 });
    return this.hosts.get(host);
  }

  isOpen(host) {
    const h = this.#h(host);
    return h.openUntil > this.now();
  }

  recordSuccess(host) {
    const h = this.#h(host);
    h.failures = 0;
    h.openUntil = 0;
  }

  recordFailure(host) {
    const h = this.#h(host);
    h.failures += 1;
    if (h.failures >= this.failureThreshold) {
      h.openUntil = this.now() + this.cooldownMs;
    }
  }

  snapshot() {
    return [...this.hosts.entries()].map(([host, s]) => ({ host, ...s }));
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/**
 * @param {object} opts
 * @param {number} [opts.timeoutMs] per-attempt timeout
 * @param {number} [opts.retries] retry count for retryable failures
 * @param {HostLimiter} [opts.limiter]
 * @param {CircuitBreaker} [opts.breaker]
 */
export function createHttpClient(opts = {}) {
  const {
    timeoutMs = 20_000,
    retries = 2,
    limiter = new HostLimiter(),
    breaker = new CircuitBreaker(),
    userAgent = DEFAULT_UA,
    logger = null,
  } = opts;

  async function request(url, { method = 'GET', headers = {}, body, signal, attemptTimeoutMs, timeoutMs: requestTimeoutMs, retries: requestRetries = retries, allowedOrigin = null } = {}) {
    const host = new URL(url).host;
    if (allowedOrigin && new URL(url).origin !== allowedOrigin) {
      throw new CollectError('请求地址不在授权来源范围内', { status: 'blocked', stage: 'security', code: 'ORIGIN_MISMATCH' });
    }
    const sensitive = Object.keys(headers).some((name) => /authorization|cookie|token|api[-_]?key|secret/i.test(name));
    if (breaker.isOpen(host)) {
      throw new CollectError(`主机熔断中：${host}`, {
        status: 'retry',
        stage: 'circuit',
        code: 'CIRCUIT_OPEN',
        nextStep: '等待冷却后重试，或先检查该平台是否整体不可用',
      });
    }

    let lastErr = null;
    for (let attempt = 0; attempt <= requestRetries; attempt += 1) {
      await limiter.acquire(host);
      try {
        const timeout = AbortSignal.timeout(attemptTimeoutMs || requestTimeoutMs || timeoutMs);
        const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const requestHeaders = {
          'user-agent': userAgent,
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
          ...headers,
        };
        let redirectUrl = new URL(url);
        let res;
        for (let hop = 0; hop <= 5; hop += 1) {
          res = await fetch(redirectUrl, {
          method,
          headers: requestHeaders,
          body,
          signal: composed,
          redirect: 'manual',
          });
          if (![301, 302, 303, 307, 308].includes(res.status)) break;
          const location = res.headers.get('location');
          if (!location) break;
          const next = new URL(location, redirectUrl);
          const crossOrigin = next.origin !== redirectUrl.origin;
          await res.body?.cancel();
          if (!['https:', 'http:'].includes(next.protocol) || next.username || next.password ||
              (allowedOrigin && next.origin !== allowedOrigin) ||
              (crossOrigin && (sensitive || body != null || !['GET', 'HEAD'].includes(method.toUpperCase())))) {
            throw new CollectError('已拒绝跨来源重定向；认证信息和请求内容未转发', {
              status: 'blocked', stage: 'security', code: 'UNSAFE_REDIRECT',
            });
          }
          if (hop === 5) throw new CollectError('重定向次数超出限制', { status: 'retry', stage: 'http', code: 'REDIRECT_LIMIT' });
          redirectUrl = next;
        }

        if (!res.ok) {
          const retryAfter = res.headers.get('retry-after');
          const text = await res.text().catch(() => '');
          const truncated = sensitive ? '[authenticated response omitted]' : text.slice(0, 300).replace(/\s+/g, ' ');
          breaker.recordFailure(host);
          if (isRetryableStatus(res.status) && attempt < requestRetries) {
            const waitMs = retryAfter
              ? Math.min(Number(retryAfter) * 1000 || 2000, 30_000)
              : 500 * 2 ** attempt + Math.random() * 250;
            if (logger) logger.warn('http retry', { host, status: res.status, waitMs: Math.round(waitMs) });
            await sleep(waitMs);
            continue;
          }
          throw new CollectError(`HTTP ${res.status} ${url}`, {
            status: res.status === 401 || res.status === 403 ? 'blocked' : 'retry',
            stage: 'http',
            code: `HTTP_${res.status}`,
            nextStep:
              res.status === 429
                ? '降低频率后重试'
                : res.status === 403
                  ? '需要授权会话或改用已授权入口'
                  : '稍后重试',
            details: { status: res.status, body: truncated },
          });
        }

        breaker.recordSuccess(host);
        return res;
      } catch (err) {
        lastErr = err;
        if (err instanceof CollectError) {
          if (!err.retryable || attempt >= requestRetries) throw err;
        } else {
          breaker.recordFailure(host);
          const aborted = err.name === 'TimeoutError' || /aborted/i.test(err.message);
          if (attempt >= requestRetries) {
            throw new CollectError(aborted ? `请求超时：${host}` : `网络失败：${err.message}`, {
              status: 'retry',
              stage: aborted ? 'timeout' : 'network',
              code: aborted ? 'TIMEOUT' : 'NETWORK',
              nextStep: '确认网络可达后重试',
            });
          }
        }
        await sleep(400 * 2 ** attempt + Math.random() * 300);
      } finally {
        limiter.release(host);
      }
    }
    throw lastErr;
  }

  async function json(url, options = {}) {
    const res = await request(url, {
      ...options,
      headers: { accept: 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new CollectError(`返回不是 JSON：${url}`, {
        status: 'retry',
        stage: 'parse',
        code: 'BAD_JSON',
        details: { sample: text.slice(0, 200) },
      });
    }
  }

  async function text(url, options = {}) {
    const res = await request(url, options);
    return res.text();
  }

  return { request, json, text, limiter, breaker };
}
