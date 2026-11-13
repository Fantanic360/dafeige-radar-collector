import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileLock, LeaseManager, LockError, StateStore } from '../../src/lib/state.mjs';

function tmp(prefix = 'radar-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('StateStore persists atomically and reloads', () => {
  const dir = tmp();
  const store = new StateStore(dir);
  store.upsertPost({ id: 'p1', sourceId: 's', platform: 'B站', url: 'https://x/1', title: 't' });
  store.applyObservation({
    sourceId: 's',
    platform: 'B站',
    url: 'https://x/1',
    status: 'success',
    checkedAt: '2026-11-13T12:00:00.000Z',
    windowFrom: '2026-11-06T00:00:00.000Z',
    windowTo: '2026-11-13T12:00:00.000Z',
    note: 'ok',
  });
  store.save();

  const reloaded = new StateStore(dir);
  assert.ok(reloaded.hasPost('p1'));
  const state = reloaded.getTarget('s::https%3A%2F%2Fx%2F1');
  assert.equal(state.status, 'success');
  assert.equal(state.lastSuccessfulAt, '2026-11-13T12:00:00.000Z');
});

test('upsertPost keeps first-seen and content cursor but refreshes metadata', () => {
  const dir = tmp();
  const store = new StateStore(dir);
  store.upsertPost({ id: 'p1', title: 'v1', discoveredAt: '2026-11-01T00:00:00.000Z' });
  store.applyContentAttempt('p1', { status: 'retry', checkedAt: '2026-11-02T00:00:00.000Z' });
  const before = store.data.posts.p1;
  assert.equal(before.contentFailCount, 1);

  store.upsertPost({ id: 'p1', title: 'v2', discoveredAt: '2026-11-09T00:00:00.000Z' });
  const after = store.data.posts.p1;
  assert.equal(after.title, 'v2');
  assert.equal(after.firstSeenAt, '2026-11-01T00:00:00.000Z');
  assert.equal(after.contentFailCount, 1, 'metadata refresh must not reset content retries');
});

test('FileLock refuses a second live holder and can be released', () => {
  const dir = tmp();
  const file = path.join(dir, '.run.lock');
  const a = new FileLock(file).acquire();
  assert.throws(() => new FileLock(file).acquire(), LockError);
  a.release();
  const b = new FileLock(file).acquire();
  b.release();
});

test('FileLock takes over a stale lock from a dead pid', () => {
  const dir = tmp();
  const file = path.join(dir, '.run.lock');
  // pid 999999 is not running; the lock must be reclaimed instead of wedging the schedule.
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
  const lock = new FileLock(file).acquire();
  assert.equal(lock.held, true);
  lock.release();
});

test('LeaseManager prevents double-claim and supports expiry reclaim', () => {
  const dir = tmp();
  const leases = new LeaseManager(path.join(dir, 'leases.json'), { defaultTtlMs: 50 });
  const first = leases.acquire('t1', { owner: 1 });
  assert.equal(first.ok, true);

  const second = leases.acquire('t1', { owner: 2 });
  assert.equal(second.ok, false);
  assert.equal(second.holder.owner, 1);

  const same = leases.acquire('t1', { owner: 1 });
  assert.equal(same.ok, true, 'same owner can renew');

  const reclaimed = leases.reclaimExpired(Date.now() + 1000);
  assert.equal(reclaimed.length, 1);
  const third = leases.acquire('t1', { owner: 3 });
  assert.equal(third.ok, true);
});

test('summary counts due work without counting blocked targets', () => {
  const dir = tmp();
  const store = new StateStore(dir);
  store.applyObservation({ sourceId: 'a', platform: 'B站', url: 'https://a', status: 'success', checkedAt: new Date(Date.now() - 5 * 3600_000).toISOString(), note: 'ok', windowTo: new Date().toISOString() });
  store.applyObservation({ sourceId: 'b', platform: '抖音', url: 'https://b', status: 'blocked', checkedAt: new Date().toISOString(), note: 'login' });
  const summary = store.summary();
  assert.equal(summary.targets, 2);
  assert.equal(summary.success, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.due, 1);
});
