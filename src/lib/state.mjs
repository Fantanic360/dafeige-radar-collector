/**
 * Local state: a single JSON document, atomic writes, a single-instance lock, and
 * per-target leases.
 *
 * Why local state at all when the site has a queue? Because the site is the system of
 * record for *results*, not for *work in progress*. If two runs overlap (manual run during
 * a scheduled run, crashed process, retried push) the collector must still behave:
 *  - one process at a time (lock),
 *  - one worker per target (lease),
 *  - no cursor movement on failure (reduceTargetState),
 *  - replay-safe payloads (idempotency keys, see ledger.mjs).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic, uuid } from './core.mjs';
import { reduceContentState, reduceTargetState } from './policy.mjs';

const STATE_VERSION = 1;

export class LockError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'LockError';
    this.code = 'LOCKED';
    this.details = details || {};
  }
}

/** OS-level advisory lock via exclusive file creation. */
export class FileLock {
  constructor(file, { staleMs = 45 * 60_000 } = {}) {
    this.file = file;
    this.staleMs = staleMs;
    this.held = false;
  }

  acquire() {
    ensureDir(path.dirname(this.file));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.file, 'wx');
        fs.writeSync(
          fd,
          JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }),
        );
        fs.closeSync(fd);
        this.held = true;
        return this;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const info = readJson(this.file, null);
        const age = info?.at ? Date.now() - new Date(info.at).getTime() : Infinity;
        const ownerAlive = info?.pid ? isProcessAlive(info.pid) : false;
        if (age > this.staleMs || !ownerAlive) {
          // Stale lock from a crashed run: take it over, but say so loudly.
          try {
            fs.unlinkSync(this.file);
          } catch {
            /* raced with another process; retry once */
          }
          continue;
        }
        throw new LockError('另一个采集进程正在运行', { holder: info, file: this.file });
      }
    }
    throw new LockError('无法取得运行锁', { file: this.file });
  }

  release() {
    if (!this.held) return;
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
    this.held = false;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Lease store: prevents two workers from inspecting the same target concurrently. */
export class LeaseManager {
  constructor(file, { defaultTtlMs = 10 * 60_000 } = {}) {
    this.file = file;
    this.defaultTtlMs = defaultTtlMs;
    this.leases = readJson(file, {}) || {};
  }

  #persist() {
    writeJsonAtomic(this.file, this.leases);
  }

  /** @returns {{ok: boolean, lease?: object, holder?: object}} */
  acquire(targetId, { owner = process.pid, ttlMs = this.defaultTtlMs, runId } = {}) {
    const now = Date.now();
    const existing = this.leases[targetId];
    if (existing && existing.expiresAt > now && existing.owner !== owner) {
      return { ok: false, holder: existing };
    }
    const lease = {
      targetId,
      owner,
      runId: runId || uuid(),
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + ttlMs,
    };
    this.leases[targetId] = lease;
    this.#persist();
    return { ok: true, lease };
  }

  heartbeat(targetId, owner, ttlMs = this.defaultTtlMs) {
    const lease = this.leases[targetId];
    if (!lease || lease.owner !== owner) return false;
    lease.heartbeatAt = Date.now();
    lease.expiresAt = Date.now() + ttlMs;
    this.#persist();
    return true;
  }

  release(targetId, owner) {
    const lease = this.leases[targetId];
    if (!lease || lease.owner !== owner) return false;
    delete this.leases[targetId];
    this.#persist();
    return true;
  }

  /** Drop leases whose holder stopped heartbeating (crash / kill -9). */
  reclaimExpired(now = Date.now()) {
    const reclaimed = [];
    for (const [id, lease] of Object.entries(this.leases)) {
      if (lease.expiresAt <= now) {
        reclaimed.push({ targetId: id, ...lease });
        delete this.leases[id];
      }
    }
    if (reclaimed.length) this.#persist();
    return reclaimed;
  }

  snapshot() {
    return { ...this.leases };
  }
}

export class StateStore {
  constructor(rootDir) {
    this.dir = rootDir;
    this.file = path.join(rootDir, 'state.json');
    ensureDir(rootDir);
    const raw = readJson(this.file, null);
    this.data = raw && raw.version === STATE_VERSION ? raw : this.#empty();
  }

  #empty() {
    return {
      version: STATE_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      targets: {},
      posts: {},
      meta: { runCount: 0, lastRunAt: null, lastPushAt: null, lastRunId: null },
    };
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.file, this.data);
  }

  getTarget(id) {
    return this.data.targets[id];
  }

  allTargets() {
    return this.data.targets;
  }

  /** Apply one observation and persist the resulting state. */
  applyObservation(obs) {
    const id = `${obs.sourceId}::${encodeURIComponent(obs.url)}`;
    const prev = this.data.targets[id] || {};
    this.data.targets[id] = reduceTargetState({ ...prev, id }, obs);
    return this.data.targets[id];
  }

  upsertPost(post) {
    const prev = this.data.posts[post.id] || {};
    this.data.posts[post.id] = {
      ...prev,
      ...post,
      firstSeenAt: prev.firstSeenAt || post.discoveredAt || new Date().toISOString(),
      contentStatus: prev.contentStatus || post.contentStatus || 'pending',
      contentFailCount: prev.contentFailCount || 0,
      nextContentAttemptAt: prev.nextContentAttemptAt || new Date().toISOString(),
    };
    return this.data.posts[post.id];
  }

  hasPost(id) {
    return Boolean(this.data.posts[id]);
  }

  applyContentAttempt(postId, attempt) {
    const prev = this.data.posts[postId];
    if (!prev) return null;
    this.data.posts[postId] = reduceContentState(prev, attempt);
    return this.data.posts[postId];
  }

  dueCount(now = new Date()) {
    const nowMs = now.getTime();
    return Object.values(this.data.targets).filter(
      (t) => !t.needsAttention && (!t.nextDueAt || new Date(t.nextDueAt).getTime() <= nowMs),
    ).length;
  }

  summary(now = new Date()) {
    const targets = Object.values(this.data.targets);
    const posts = Object.values(this.data.posts);
    return {
      targets: targets.length,
      success: targets.filter((t) => t.status === 'success').length,
      retry: targets.filter((t) => t.status === 'retry').length,
      blocked: targets.filter((t) => t.status === 'blocked' || t.status === 'identity_pending').length,
      due: this.dueCount(now),
      posts: posts.length,
      contentPending: posts.filter((p) => p.contentStatus !== 'verified' && p.contentStatus !== 'blocked').length,
      contentVerified: posts.filter((p) => p.contentStatus === 'verified').length,
    };
  }
}
