/**
 * Run ledger + idempotency.
 *
 * Two failure modes this exists to prevent:
 *  1. "It ran" becomes unverifiable folklore. Every run writes a machine-readable record
 *     (and a JSONL event stream) so a 3-day acceptance table can be produced from files
 *     instead of memory.
 *  2. Retrying a push duplicates rows / double-bills a voice generation. Payloads get a
 *     stable idempotency key; the key is persisted before the request and confirmed after.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, sha1, stableStringify, uuid, writeJsonAtomic } from './core.mjs';

export class RunLedger {
  constructor(rootDir, { runId = uuid(), meta = {} } = {}) {
    this.dir = ensureDir(path.join(rootDir, 'runs'));
    this.eventsFile = path.join(rootDir, 'events.jsonl');
    this.runId = runId;
    this.record = {
      runId,
      startedAt: new Date().toISOString(),
      endedAt: null,
      ...meta,
      counts: {
        planned: 0,
        attempted: 0,
        success: 0,
        retry: 0,
        blocked: 0,
        identityPending: 0,
        newPosts: 0,
        contentVerified: 0,
        contentBlocked: 0,
        skippedByBreaker: 0,
        pushed: 0,
        pushFailed: 0,
      },
      targets: [],
      errors: [],
    };
  }

  set(key, value) {
    this.record[key] = value;
    return this;
  }

  event(type, payload = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), runId: this.runId, type, ...payload });
    try {
      fs.appendFileSync(this.eventsFile, `${line}\n`);
    } catch {
      /* event stream is best-effort; the JSON record is authoritative */
    }
  }

  count(key, delta = 1) {
    this.record.counts[key] = (this.record.counts[key] || 0) + delta;
  }

  target(entry) {
    this.record.targets.push(entry);
    this.count('attempted');
    this.count(entry.status === 'success' ? 'success' : entry.status === 'blocked' ? 'blocked' : entry.status === 'identity_pending' ? 'identityPending' : 'retry');
  }

  error(entry) {
    this.record.errors.push({ at: new Date().toISOString(), ...entry });
    this.event('error', entry);
  }

  finish({ note } = {}) {
    this.record.endedAt = new Date().toISOString();
    this.record.durationMs = new Date(this.record.endedAt) - new Date(this.record.startedAt);
    if (note) this.record.note = note;
    const file = path.join(this.dir, `${this.record.startedAt.replace(/[:.]/g, '-')}_${this.runId.slice(0, 8)}.json`);
    writeJsonAtomic(file, this.record);
    this.event('run.finished', { counts: this.record.counts, file: path.basename(file) });
    return file;
  }

  static listRuns(rootDir, limit = 20) {
    const dir = path.join(rootDir, 'runs');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => ({ file: path.join(dir, f), ...readJson(path.join(dir, f), {}) }));
  }
}

/**
 * Idempotency store, kept deliberately small: it only needs to survive a retry window,
 * not all of history (the site dedupes by original link anyway).
 */
export class IdempotencyStore {
  constructor(file, { capacity = 2000 } = {}) {
    this.file = file;
    this.capacity = capacity;
    this.data = readJson(file, { keys: {} }) || { keys: {} };
  }

  static keyFor(scope, payload) {
    return `${scope}:${sha1(stableStringify(payload)).slice(0, 24)}`;
  }

  has(key) {
    return Boolean(this.data.keys[key]);
  }

  remember(key, meta = {}) {
    this.data.keys[key] = { at: new Date().toISOString(), ...meta };
    const keys = Object.keys(this.data.keys);
    if (keys.length > this.capacity) {
      const sorted = keys.sort((a, b) => new Date(this.data.keys[a].at) - new Date(this.data.keys[b].at));
      for (const k of sorted.slice(0, keys.length - this.capacity)) delete this.data.keys[k];
    }
    writeJsonAtomic(this.file, this.data);
    return key;
  }

  forget(key) {
    if (this.data.keys[key]) {
      delete this.data.keys[key];
      writeJsonAtomic(this.file, this.data);
    }
  }

  snapshot() {
    return { size: Object.keys(this.data.keys).length, capacity: this.capacity };
  }
}
