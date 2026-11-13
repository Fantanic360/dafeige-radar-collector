#!/usr/bin/env node
/**
 * Zero-dependency Chrome DevTools Protocol driver.
 *
 * Why this exists: several target platforms (B站 space lists, 抖音, 小红书) gate their
 * list endpoints behind browser fingerprint / risk-control checks that no amount of
 * plain HTTP headers satisfy. A real renderer is the only legitimate way in, and the
 * handoff explicitly allows using an authorised browser -- but not bypassing auth.
 *
 * Design constraints:
 *  - no npm dependencies (Node >= 20: global fetch + global WebSocket are enough)
 *  - one browser process per run, reused across targets, killed on exit
 *  - every operation has a hard timeout; a crashed renderer is detected and surfaced
 *  - never reads or exports cookies/credentials
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bind-and-release to find a port nothing else is holding. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const DEFAULT_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export class BrowserUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BrowserUnavailableError';
    this.code = 'BROWSER_UNAVAILABLE';
    this.details = details;
  }
}

export function findChrome() {
  for (const candidate of DEFAULT_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

class CdpSession {
  constructor(ws, { onEvent } = {}) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.lastCrash = null;
    this.onEvent = onEvent;
    ws.addEventListener('message', (ev) => this.#handle(ev));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  async #handle(ev) {
    let raw = ev.data;
    if (typeof raw !== 'string') {
      raw = raw instanceof Blob ? await raw.text() : Buffer.from(raw).toString('utf8');
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Inspector.targetCrashed') this.lastCrash = Date.now();
    if (this.onEvent) this.onEvent(msg);
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error('CDP session closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async evaluate(expression, { awaitPromise = false, timeoutMs = 30_000 } = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true, userGesture: true },
      timeoutMs,
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`page script failed: ${d.exception?.description || d.text}`);
    }
    return res.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export class Browser {
  constructor(proc, session, { userDataDir, headless = true } = {}) {
    this.proc = proc;
    this.session = session;
    this.userDataDir = userDataDir;
    this.headless = headless;
    this.disposed = false;
  }

  static async launch(options = {}) {
    const {
      headless = true,
      userDataDir,
      timeoutMs = 35_000,
      width = 1440,
      height = 1000,
      extraArgs = [],
    } = options;

    const chrome = findChrome();
    if (!chrome) {
      throw new BrowserUnavailableError('no Chrome/Chromium binary found', {
        searched: DEFAULT_CANDIDATES,
        hint: 'set CHROME_PATH or run without the browser tier',
      });
    }

    const dir = userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'radar-cdp-'));
    let port;
    try {
      port = await pickFreePort();
    } catch {
      port = 9400 + Math.floor(Math.random() * 400);
    }
    const args = [
      headless ? '--headless=new' : '--headless=old',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--mute-audio',
      `--window-size=${width},${height}`,
      '--lang=zh-CN',
      ...extraArgs,
      'about:blank',
    ];

    const proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrChunks = [];
    proc.stderr.on('data', (b) => {
      if (stderrChunks.length < 40) stderrChunks.push(b.toString());
    });
    proc.on('error', () => {});

    let version = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1500),
        });
        if (r.ok) {
          version = await r.json();
          break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(150);
    }

    if (!version) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      throw new BrowserUnavailableError('Chrome did not expose a debugging port in time', {
        chrome,
        stderr: stderrChunks.join('').slice(0, 1200),
      });
    }

    const tab = await (
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
    ).json();

    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket open timeout')), 10_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP websocket error'));
      });
    });

    const session = new CdpSession(ws);
    await session.send('Page.enable').catch(() => {});
    await session.send('Runtime.enable').catch(() => {});
    await session.send('Network.enable').catch(() => {});

    const browser = new Browser(proc, session, { userDataDir: dir, headless });
    browser.port = port;
    browser.version = version.Browser;
    return browser;
  }

  /**
   * Navigate, then wait for the document to settle.
   *
   * `Page.navigate` can hang for a long time behind bot-protection interstitials, so a
   * navigate timeout is not treated as a hard failure: we fall back to polling
   * `document.readyState` and the current URL. Callers decide whether the landing page
   * is acceptable (see `waitFor`).
   */
  async goto(url, { timeoutMs = 30_000, settleMs = 1200 } = {}) {
    const wantOrigin = new URL(url).origin;

    try {
      await this.session.send('Page.navigate', { url }, Math.min(timeoutMs, 15_000));
    } catch (err) {
      if (!/timeout/i.test(err.message)) throw err;
    }

    const deadline = Date.now() + timeoutMs;
    let href = null;

    // 1) Wait until the document actually belongs to the requested origin. Without this
    //    check we can race the navigation and end up evaluating against about:blank.
    while (Date.now() < deadline) {
      try {
        href = await this.session.evaluate('location.href', { timeoutMs: 6000 });
      } catch {
        href = null;
      }
      if (href && href.startsWith(wantOrigin)) break;
      await sleep(300);
    }

    // 2) Then wait for the document to finish parsing.
    while (Date.now() < deadline) {
      let ready = null;
      try {
        ready = await this.session.evaluate('document.readyState', { timeoutMs: 6000 });
      } catch {
        ready = null;
      }
      if (ready === 'complete' || ready === 'interactive') break;
      await sleep(300);
    }

    if (settleMs) await sleep(settleMs);
    return href || url;
  }

  /** Poll a page expression until it returns truthy or the budget runs out. */
  async waitFor(expression, { timeoutMs = 20_000, intervalMs = 400 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.session.evaluate(expression, { timeoutMs: 8000 });
        if (last) return last;
      } catch (err) {
        last = undefined;
        if (this.session.lastCrash) break;
      }
      await sleep(intervalMs);
    }
    return last;
  }

  /** Scroll to trigger lazy loading; returns scrollHeight. */
  async scrollToBottom(rounds = 3, pauseMs = 800) {
    let height = 0;
    for (let i = 0; i < rounds; i += 1) {
      height = await this.session.evaluate(
        'window.scrollTo(0, document.body.scrollHeight); document.body.scrollHeight',
      );
      await sleep(pauseMs);
    }
    return height;
  }

  /** PNG screenshot written to disk; used as failure evidence, never as a success prop. */
  async screenshot(file) {
    try {
      const res = await this.session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20_000);
      fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
      return file;
    } catch {
      return null;
    }
  }

  async close() {
    if (this.disposed) return;
    this.disposed = true;
    this.session.close();
    try {
      this.proc.kill('SIGTERM');
      await sleep(150);
      if (!this.proc.killed) this.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    if (this.userDataDir && this.userDataDir.includes('radar-cdp-')) {
      try {
        fs.rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export default Browser;
