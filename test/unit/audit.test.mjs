import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditSnapshot,
  broadcastIntegrity,
  capacityReport,
  dateIntegrity,
  directoryIntegrity,
  editionCoverage,
  escalationCandidates,
  freshnessReport,
  leakScan,
} from '../../src/lib/audit.mjs';

const NOW = new Date('2026-11-14T16:00:00.000Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();

function snapshot(overrides = {}) {
  return {
    schemaVersion: 3,
    edition: { date: '2026-11-14', primaryIds: ['a1'], checks: [{ sourceId: 's1', status: 'updated' }] },
    articles: [
      { id: 'a1', sourceId: 's1', title: 'ok', publishedAt: hoursAgo(2), addedAt: hoursAgo(2) },
    ],
    sources: [
      { id: 's1', name: 'A', enabled: true, directoryStatus: 'active' },
      { id: 'gone', name: 'B', enabled: false, directoryStatus: 'removed' },
    ],
    checks: [],
    broadcasts: [],
    collection: {
      states: [{ sourceId: 's1', platform: 'B站', status: 'success', checkedAt: hoursAgo(1), nextDueAt: hoursAgo(-3) }],
      posts: [],
    },
    ...overrides,
  };
}

test('freshness separates blocked targets from actionable backlog', () => {
  const data = snapshot({
    collection: {
      states: [
        { sourceId: 'a', platform: 'B站', status: 'success', checkedAt: hoursAgo(1), nextDueAt: hoursAgo(-3) },
        { sourceId: 'b', platform: '抖音', status: 'success', checkedAt: hoursAgo(10), nextDueAt: hoursAgo(6) },
        { sourceId: 'c', platform: '小红书', status: 'blocked', checkedAt: hoursAgo(30), nextDueAt: null },
      ],
      posts: [],
    },
  });
  const r = freshnessReport(data, { now: NOW, staleAfterHours: 6 });
  assert.equal(r.total, 3);
  assert.equal(r.actionable, 2, 'blocked target is not part of the actionable backlog');
  assert.equal(r.stale, 1);
  assert.equal(r.overdue, 1);
  assert.equal(r.worst[0].sourceId, 'b');
});

test('capacity report detects the deficit the live site is in', () => {
  const states = Array.from({ length: 61 }, (_, i) => ({
    sourceId: `s${i}`,
    platform: 'B站',
    status: 'success',
    checkedAt: hoursAgo(5),
    nextDueAt: hoursAgo(1),
  }));
  const r = capacityReport({ collection: { states, posts: [] } }, { roundsPerDay: 7, cap: 8, editionCap: 100, reDueHours: 4 });
  assert.equal(r.actionable, 61);
  assert.equal(r.checksPerDay, 156);
  assert.equal(r.checksNeededPerDay, 366);
  assert.equal(r.verdict, 'structural-deficit');
  assert.match(r.suggestion, /38/);
});

test('capacity report passes when the cadence is wide enough', () => {
  const r = capacityReport(
    { collection: { states: [{ sourceId: 'a', status: 'success' }], posts: [] } },
    { roundsPerDay: 7, cap: 8, editionCap: 100, reDueHours: 24 },
  );
  assert.equal(r.verdict, 'sustainable');
});

test('escalation flags same-cause retry loops', () => {
  const data = snapshot({
    collection: {
      states: [
        { sourceId: 'x', platform: '抖音', status: 'retry', failCount: 4 },
        { sourceId: 'y', platform: '抖音', status: 'retry', failCount: 1 },
      ],
      posts: [],
    },
  });
  const r = escalationCandidates(data);
  assert.equal(r.length, 1);
  assert.equal(r[0].sourceId, 'x');
});

test('date integrity catches future dates and unmarked nulls', () => {
  const data = snapshot({
    articles: [
      { id: 'ok', publishedAt: hoursAgo(1) },
      { id: 'future', publishedAt: '2026-11-20T00:00:00.000Z' },
      { id: 'null-no-marker', publishedAt: null },
      { id: 'null-marked', publishedAt: null, publicationStatus: 'undated-reference' },
    ],
  });
  const r = dateIntegrity(data, { now: NOW });
  assert.deepEqual(r.future.map((f) => f.id), ['future']);
  assert.deepEqual(r.undatedWithoutMarker.map((f) => f.id), ['null-no-marker']);
});

test('directory integrity separates history from active re-publishing', () => {
  const data = snapshot({
    articles: [
      { id: 'new', sourceId: 'gone', publishedAt: hoursAgo(1), addedAt: hoursAgo(2) },
      { id: 'old', sourceId: 'gone', publishedAt: hoursAgo(300), addedAt: hoursAgo(300) },
    ],
  });
  const r = directoryIntegrity(data);
  assert.equal(r.articlesFromRemoved, 2);
  assert.equal(r.recentlyAddedFromRemoved.length, 1, 'only the recent one is suspicious');
});

test('edition coverage finds missing and duplicated checks', () => {
  const data = snapshot({
    sources: [
      { id: 's1', enabled: true },
      { id: 's2', enabled: true },
      { id: 's3', enabled: false },
    ],
    edition: { checks: [{ sourceId: 's1', status: 'updated' }, { sourceId: 's1', status: 'partial' }] },
  });
  const r = editionCoverage(data);
  assert.deepEqual(r.missing, ['s2']);
  assert.deepEqual(r.duplicated, ['s1']);
});

test('broadcast integrity flags duplicate audio and missing segments', () => {
  const data = snapshot({
    broadcasts: [
      { date: '2026-11-14', audioUrl: '/a.mp3', duration: 100, segments: [] },
      { date: '2026-11-14', audioUrl: '/b.mp3', duration: 100 },
      { date: '2026-11-13', audioUrl: '/c.mp3', duration: 90, segments: [{ start: 0 }] },
    ],
  });
  const r = broadcastIntegrity(data);
  assert.equal(r.total, 3);
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.withoutSegments, 2);
});

test('leak scan stays quiet on clean data and shouts on a token', () => {
  assert.equal(leakScan(snapshot()).ok, true);
  // Assembled at runtime so this fixture never trips the repo's own secret scanner.
  const fakeToken = `ghp_${'a'.repeat(30)}`;
  const dirty = snapshot({ articles: [{ id: 'x', evidenceNote: `token ${fakeToken}` }] });
  const r = leakScan(dirty);
  assert.equal(r.ok, false);
  assert.ok(r.hits.includes('github token'));
});

test('auditSnapshot turns the live-site symptoms into P0/P1 problems', () => {
  const states = Array.from({ length: 61 }, (_, i) => ({
    sourceId: `s${i}`,
    platform: 'B站',
    status: 'success',
    checkedAt: hoursAgo(12),
    nextDueAt: hoursAgo(8),
  }));
  const data = snapshot({
    sources: [{ id: 's0', enabled: true, directoryStatus: 'active' }],
    edition: { date: '2026-11-14', primaryIds: [], checks: [] },
    articles: [{ id: 'a1', sourceId: 's0', publishedAt: hoursAgo(3), addedAt: hoursAgo(1) }],
    collection: { states, posts: [] },
    broadcasts: [{ date: '2026-11-14', audioUrl: '/a.mp3', duration: 10 }],
  });
  const report = auditSnapshot(data, { now: NOW, staleAfterHours: 6 });
  const codes = report.problems.map((p) => p.code);
  assert.ok(codes.includes('BACKLOG'));
  assert.ok(codes.includes('CAPACITY_DEFICIT'));
  assert.ok(codes.includes('EDITION_GAP'));
  assert.ok(codes.includes('AUDIO_NO_SEGMENTS'));
  assert.equal(report.freshness.stale, 61);
});
