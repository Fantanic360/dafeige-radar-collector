/**
 * Shared primitives: errors, clock, ids, structured logging.
 *
 * Everything here is deliberately dependency-free so the collector can run on a bare
 * Node install (the operator is a working director, not a build engineer).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ errors ---- */

/** A failure we can explain to the operator and to the site's retry policy. */
export class CollectError extends Error {
  /**
   * @param {string} message human readable, goes into observation.note
   * @param {object} [opts]
   * @param {'blocked'|'retry'|'identity_pending'} [opts.status] contract status
   * @param {string} [opts.stage] where it broke: launch|navigate|extract|api|parse|policy
   * @param {boolean} [opts.retryable]
   * @param {string} [opts.nextStep] what a human/agent should do next
   * @param {string} [opts.code]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'CollectError';
    this.status = opts.status || 'retry';
    this.stage = opts.stage || 'unknown';
    this.retryable = opts.retryable ?? this.status === 'retry';
    this.nextStep = opts.nextStep || '';
    this.code = opts.code || '';
    this.details = opts.details || {};
  }

  toNote() {
    const bits = [this.message];
    if (this.stage) bits.push(`阶段=${this.stage}`);
    if (this.code) bits.push(`代码=${this.code}`);
    if (this.nextStep) bits.push(`下一步=${this.nextStep}`);
    return bits.join('；');
  }
}

/* ------------------------------------------------------------------- clock ---- */

export const TZ = 'Asia/Shanghai';

/** Injection point so tests never depend on wall-clock time. */
export function createClock({ now = () => new Date() } = {}) {
  return {
    now,
    nowIso: () => new Date(now()).toISOString(),
    ms: () => new Date(now()).getTime(),
  };
}

export const clock = createClock();

/** ISO-8601 in Beijing time, used for human-facing notes. */
export function beijingIso(date = new Date()) {
  const d = new Date(date);
  const shifted = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

export function beijingDate(date = new Date()) {
  return beijingIso(date).slice(0, 10);
}

/** Hour of day in Beijing (0-23), used by the run-budget policy. */
export function beijingHour(date = new Date()) {
  const d = new Date(new Date(date).getTime() + 8 * 3600 * 1000);
  return d.getUTCHours();
}

export function addHours(date, hours) {
  return new Date(new Date(date).getTime() + hours * 3600 * 1000);
}

export function minutesBetween(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

/* --------------------------------------------------------------------- ids ---- */

export function sha1(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex');
}

export function shortHash(input, len = 10) {
  return sha1(input).slice(0, len);
}

export function uuid() {
  return crypto.randomUUID();
}

/** The site's target key: `sourceId::encodeURIComponent(profileUrl)`. */
export function targetIdFor(sourceId, url) {
  return `${sourceId}::${encodeURIComponent(url)}`;
}

/* ----------------------------------------------------------------- logging ---- */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', sink = process.stderr, json = false } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const entry = { ts: new Date().toISOString(), level: lvl, msg, ...fields };
    if (json) {
      sink.write(`${JSON.stringify(entry)}\n`);
    } else {
      const extras = Object.entries(fields || {})
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      sink.write(`${entry.ts.slice(11, 19)} ${lvl.toUpperCase().padEnd(5)} ${msg}${extras ? ` ${extras}` : ''}\n`);
    }
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (base) => createLogger({ level, sink, json }).withBase?.(base) || createLogger({ level, sink, json }),
  };
}

/** Write JSON atomically: tmp file in the same dir, fsync, rename. */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------------------------------------------------------------- hash map ---- */

/** Stable stringify so hashes don't depend on key order. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
