import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKOFF_HOURS,
  backoffHours,
  isEditionRound,
  planContentQueue,
  planRound,
  reduceContentState,
  reduceTargetState,
} from '../../src/lib/policy.mjs';

const HOUR = 3600_000;
const base = '2026-11-13T12:00:00.000Z';

test('backoff ladder is 2/4/8/16/24 and caps at 24', () => {
  assert.deepEqual(BACKOFF_HOURS, [2, 4, 8, 16, 24]);
  assert.equal(backoffHours(1), 2);
  assert.equal(backoffHours(3), 8);
  assert.equal(backoffHours(5), 24);
  assert.equal(backoffHours(99), 24);
});

test('success re-dues after 4 hours and advances the success cursor', () => {
  const next = reduceTargetState({}, {
    status: 'success',
    checkedAt: base,
    windowFrom: '2026-11-06T12:00:00.000Z',
    windowTo: base,
    note: 'ok',
  });
  assert.equal(next.status, 'success');
  assert.equal(next.failCount, 0);
  assert.equal(next.lastSuccessfulAt, base);
  assert.equal(new Date(next.nextDueAt).getTime() - new Date(base).getTime(), 4 * HOUR);
});

test('failure backs off and NEVER moves the success cursor', () => {
  const first = reduceTargetState(
    { status: 'success', lastSuccessfulAt: '2026-11-13T06:00:00.000Z', lastSuccessWindowTo: '2026-11-13T06:00:00.000Z' },
    { status: 'retry', checkedAt: base, note: 'timeout' },
  );
  assert.equal(first.status, 'retry');
  assert.equal(first.failCount, 1);
  assert.equal(new Date(first.nextDueAt).getTime() - new Date(base).getTime(), 2 * HOUR);
  assert.equal(first.lastSuccessfulAt, '2026-11-13T06:00:00.000Z');

  const second = reduceTargetState(first, { status: 'retry', checkedAt: base, note: 'again' });
  assert.equal(second.failCount, 2);
  assert.equal(new Date(second.nextDueAt).getTime() - new Date(base).getTime(), 4 * HOUR);
});

test('blocked leaves the auto queue and raises needsAttention', () => {
  const next = reduceTargetState({ failCount: 2 }, { status: 'blocked', checkedAt: base, note: 'login wall' });
  assert.equal(next.status, 'blocked');
  assert.equal(next.nextDueAt, null);
  assert.equal(next.needsAttention, true);
});

test('edition round detection uses Beijing 10:00 with tolerance', () => {
  assert.equal(isEditionRound(new Date('2026-11-13T02:00:00Z')), true); // 10:00 +08
  assert.equal(isEditionRound(new Date('2026-11-13T02:40:00Z')), true); // within tolerance
  assert.equal(isEditionRound(new Date('2026-11-13T04:00:00Z')), false); // 12:00 +08
  assert.equal(isEditionRound(new Date('2026-11-13T00:00:00Z')), false); // 08:00 +08
});

const targets = [
  { id: 'a::1', sourceId: 'a', platform: 'B站', url: 'u1', primary: true },
  { id: 'b::1', sourceId: 'b', platform: '抖音', url: 'u2', primary: false },
  { id: 'c::1', sourceId: 'c', platform: 'B站', url: 'u3', primary: false },
  { id: 'd::1', sourceId: 'd', platform: 'GitHub', url: 'u4', primary: false },
];

test('planRound respects the cap and never returns more work than allowed', () => {
  const plan = planRound({ targets, states: {}, now: new Date(base), cap: 2 });
  assert.equal(plan.selected.length, 2);
  assert.equal(plan.deferred.length, 2);
});

test('planRound skips targets whose nextDueAt is in the future, unless forced', () => {
  const states = { 'a::1': { nextDueAt: new Date(Date.now() + 3600_000).toISOString() } };
  const plan = planRound({ targets, states, now: new Date(), cap: 10 });
  assert.equal(plan.selected.some((t) => t.id === 'a::1'), false);
  const forced = planRound({ targets, states, now: new Date(), cap: 10, ignoreDue: true });
  assert.equal(forced.selected.some((t) => t.id === 'a::1'), true);
});

test('planRound excludes blocked targets from the auto queue', () => {
  const states = { 'b::1': { status: 'blocked', needsAttention: true, nextDueAt: null } };
  const plan = planRound({ targets, states, now: new Date(), cap: 10 });
  assert.equal(plan.selected.some((t) => t.id === 'b::1'), false);
});

test('planRound interleaves platforms so one lane cannot starve the rest', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `x${i}::1`,
    sourceId: `x${i}`,
    platform: i < 8 ? 'B站' : 'GitHub',
    url: `u${i}`,
    primary: false,
  }));
  const plan = planRound({ targets: many, states: {}, now: new Date(), cap: 4 });
  const platforms = plan.selected.map((t) => t.platform);
  assert.ok(platforms.includes('GitHub'), `expected a GitHub lane in the first 4, got ${platforms.join(',')}`);
});

test('content queue: due immediately, verified/blocked never re-queued', () => {
  const now = new Date(base);
  const posts = {
    p1: { contentStatus: 'pending', nextContentAttemptAt: base },
    p2: { contentStatus: 'verified', nextContentAttemptAt: base },
    p3: { contentStatus: 'blocked', nextContentAttemptAt: base },
    p4: { contentStatus: 'retry', nextContentAttemptAt: new Date(new Date(base).getTime() + HOUR).toISOString() },
  };
  const due = planContentQueue({ posts, now, cap: 10 });
  assert.deepEqual(due.map((d) => d.id), ['p1']);
});

test('content failure backs off; blocked stops the clock', () => {
  const retry = reduceContentState({}, { status: 'retry', checkedAt: base });
  assert.equal(retry.contentStatus, 'retry');
  assert.equal(retry.contentFailCount, 1);
  assert.equal(new Date(retry.nextContentAttemptAt).getTime() - new Date(base).getTime(), 2 * HOUR);

  const blocked = reduceContentState(retry, { status: 'blocked', checkedAt: base });
  assert.equal(blocked.contentStatus, 'blocked');
  assert.equal(blocked.nextContentAttemptAt, null);

  const verified = reduceContentState(retry, { status: 'verified', checkedAt: base, evidence: 'transcript' });
  assert.equal(verified.contentStatus, 'verified');
  assert.equal(verified.contentFailCount, 0);
});
