import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalUrl,
  cuesToSrt,
  extractPostId,
  formatDuration,
  parseChineseRelative,
  parseDuration,
  parsePublished,
  platformSlug,
  postIdFor,
  srtTimestamp,
} from '../../src/lib/normalize.mjs';

test('parsePublished keeps an explicit timezone and marks second precision', () => {
  const r = parsePublished('2026-11-13T10:30:00Z');
  assert.equal(r.publishedAt, '2026-11-13T10:30:00.000Z');
  assert.equal(r.datePrecision, 'second');
});

test('parsePublished treats a naked ISO string as Beijing wall clock', () => {
  const r = parsePublished('2026-11-13T18:30:00');
  assert.equal(r.publishedAt, '2026-11-13T10:30:00.000Z');
  assert.equal(r.datePrecision, 'minute');
});

test('parsePublished never invents a time for a date-only value', () => {
  const r = parsePublished('2026-11-13');
  assert.equal(r.publishedAt, '2026-11-13');
  assert.equal(r.datePrecision, 'date');
});

test('parsePublished returns null (unknown) instead of guessing', () => {
  assert.deepEqual(parsePublished(''), { publishedAt: null, datePrecision: 'unknown' });
  assert.deepEqual(parsePublished(null), { publishedAt: null, datePrecision: 'unknown' });
  assert.deepEqual(parsePublished('昨天下午'), { publishedAt: null, datePrecision: 'unknown' });
});

test('parsePublished converts unix seconds', () => {
  const r = parsePublished(1794565800);
  assert.equal(r.publishedAt, new Date(1794565800 * 1000).toISOString());
  assert.equal(r.datePrecision, 'second');
});

test('parsePublished handles RFC 822 feed dates', () => {
  const r = parsePublished('Thu, 13 Nov 2026 18:30:00 +0800');
  assert.equal(r.publishedAt, '2026-11-13T10:30:00.000Z');
});

test('parseChineseRelative is flagged relative, never exact', () => {
  const now = new Date('2026-11-14T00:00:00+08:00');
  const r = parseChineseRelative('5小时前', now);
  assert.equal(r.datePrecision, 'relative');
  assert.equal(r.publishedAt, new Date(now.getTime() - 5 * 3600_000).toISOString());
});

test('parseChineseRelative keeps month-day as date precision and infers year backwards', () => {
  const now = new Date('2026-11-14T00:00:00+08:00');
  const r = parseChineseRelative('10-29', now);
  assert.equal(r.datePrecision, 'date');
  assert.equal(r.publishedAt, '2026-10-29');
  const future = parseChineseRelative('12-25', now);
  assert.equal(future.publishedAt, '2025-12-25');
  assert.equal(future.yearInferred, true);
});

test('canonicalUrl strips tracking params but keeps identity', () => {
  const out = canonicalUrl('https://www.bilibili.com/video/BV12oWi6VEzP/?spm_id_from=333.1387&vd_source=abc');
  assert.equal(out, 'https://www.bilibili.com/video/BV12oWi6VEzP');
});

test('extractPostId understands the platforms we actually collect', () => {
  assert.equal(extractPostId('https://www.bilibili.com/video/BV12oWi6VEzP/', 'B站'), 'BV12oWi6VEzP');
  assert.equal(extractPostId('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'YouTube'), 'dQw4w9WgXcQ');
  assert.equal(extractPostId('https://www.douyin.com/video/7620317293033082155', '抖音'), '7620317293033082155');
  assert.equal(extractPostId('https://mp.weixin.qq.com/s/ToplAo9NHP356Fu-hbYlsg', '微信公众号'), 'ToplAo9NHP356Fu-hbYlsg');
});

test('postIdFor is stable across runs and never collides on source', () => {
  const a = postIdFor({ sourceId: 'ksr', platform: 'B站', platformPostId: 'BV12oWi6VEzP' });
  const b = postIdFor({ sourceId: 'ksr', platform: 'B站', platformPostId: 'BV12oWi6VEzP' });
  const c = postIdFor({ sourceId: 'qiuzhi', platform: 'B站', platformPostId: 'BV12oWi6VEzP' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^ksr-bilibili-BV12oWi6VEzP$/);
});

test('platform slug mapping covers roster platforms', () => {
  assert.equal(platformSlug('B站'), 'bilibili');
  assert.equal(platformSlug('微信公众号'), 'wechat');
  assert.equal(platformSlug('小宇宙'), 'xiaoyuzhou');
});

test('duration helpers round-trip', () => {
  assert.equal(parseDuration('27:20'), 1640);
  assert.equal(parseDuration('1:02:33'), 3753);
  assert.equal(parseDuration('oops'), null);
  assert.equal(formatDuration(1640), '27:20');
  assert.equal(formatDuration(3753), '1:02:33');
});

test('srt conversion produces monotonic, valid cues', () => {
  assert.equal(srtTimestamp(0), '00:00:00,000');
  assert.equal(srtTimestamp(3661.5), '01:01:01,500');
  const srt = cuesToSrt([
    { from: 3.2, to: 5.4, content: '第二句' },
    { from: 0.5, to: 2.0, content: '第一句' },
  ]);
  const lines = srt.trim().split('\n');
  assert.equal(lines[0], '1');
  assert.equal(lines[1], '00:00:00,500 --> 00:00:02,000');
  assert.equal(lines[2], '第一句');
  assert.ok(srt.indexOf('第一句') < srt.indexOf('第二句'));
});
