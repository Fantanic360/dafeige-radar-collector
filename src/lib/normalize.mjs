/**
 * Normalisation: dates, URLs, ids.
 *
 * The site contract is strict about time: an exact moment must carry a timezone, a
 * date-only value must say so, and an unknown value must stay null. Nothing here ever
 * invents 00:00 or reuses the crawl time as a publish time.
 */
import { sha1 } from './core.mjs';

const PLATFORM_SLUG = {
  'B站': 'bilibili',
  'bilibili': 'bilibili',
  'Bilibili': 'bilibili',
  '抖音': 'douyin',
  '小红书': 'xiaohongshu',
  '微博': 'weibo',
  '微信公众号': 'wechat',
  '小宇宙': 'xiaoyuzhou',
  'YouTube': 'youtube',
  'X': 'x',
  'GitHub': 'github',
  '官网': 'site',
  'Newsletter': 'newsletter',
  '播客': 'podcast',
  '主站': 'site',
};

export function platformSlug(platform) {
  return PLATFORM_SLUG[platform] || String(platform || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Strip tracking params and normalise host casing. Never rewrites platform ids. */
export function canonicalUrl(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const drop = [
    'spm_id_from', 'vd_source', 'share_source', 'share_medium', 'share_plat', 'share_session_id',
    'share_tag', 'timestamp', 'unique_k', 'from', 'seid', 'bbid', 'ts', 'utm_source', 'utm_medium',
    'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid', 'ref', 'ref_src',
  ];
  for (const key of drop) url.searchParams.delete(key);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

/** Extract a platform-stable post id from a URL. */
export function extractPostId(url, platform) {
  const u = canonicalUrl(url) || url || '';
  const slug = platformSlug(platform);
  try {
    const parsed = new URL(u);
    if (slug === 'bilibili') {
      const bv = parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
      if (bv) return bv[1];
      const av = parsed.pathname.match(/\/video\/av(\d+)/i);
      if (av) return `av${av[1]}`;
    }
    if (slug === 'youtube') {
      const v = parsed.searchParams.get('v');
      if (v) return v;
      const shorts = parsed.pathname.match(/\/(?:shorts|live)\/([\w-]{6,})/);
      if (shorts) return shorts[1];
      if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1);
    }
    if (slug === 'douyin') {
      const m = parsed.pathname.match(/\/video\/(\d+)/);
      if (m) return m[1];
    }
    if (slug === 'xiaohongshu') {
      const m = parsed.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{16,})/);
      if (m) return m[1];
    }
    if (slug === 'wechat') {
      const m = parsed.pathname.match(/\/s\/([\w-]+)/);
      if (m) return m[1];
    }
    if (slug === 'github') {
      const m = parsed.pathname.match(/\/releases\/tag\/(.+)$/);
      if (m) return `release-${m[1]}`;
    }
  } catch {
    /* fall through to hash */
  }
  return sha1(u).slice(0, 16);
}

/**
 * Stable post identity. The site dedupes on original link; we dedupe on
 * (source, platform, platform id) so a re-run never creates a second row.
 */
export function postIdFor({ sourceId, platform, platformPostId, url }) {
  const pid = platformPostId || extractPostId(url, platform);
  return `${sourceId}-${platformSlug(platform)}-${String(pid).replace(/[^\w.-]+/g, '-')}`;
}

/* ------------------------------------------------------------------- dates ---- */

const TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse any date-ish input into the contract shape.
 * @returns {{publishedAt: string|null, datePrecision: 'second'|'minute'|'date'|'unknown'}}
 */
export function parsePublished(raw, { assumeTimezone = '+08:00' } = {}) {
  if (raw === null || raw === undefined || raw === '') {
    return { publishedAt: null, datePrecision: 'unknown' };
  }

  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return { publishedAt: raw.toISOString(), datePrecision: 'second' };
  }

  if (typeof raw === 'number' || /^\d{10}$/.test(String(raw))) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      const ms = String(Math.trunc(n)).length === 13 ? n : n * 1000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return { publishedAt: d.toISOString(), datePrecision: 'second' };
    }
  }

  const s = String(raw).trim();

  // Full ISO with timezone.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return { publishedAt: d.toISOString(), datePrecision: s.includes(':') ? 'second' : 'minute' };
    }
  }

  // ISO without timezone -> treat as Beijing wall clock, but say so in precision.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) && !TZ_SUFFIX.test(s)) {
    const d = new Date(`${s}${assumeTimezone}`);
    if (!Number.isNaN(d.getTime())) {
      return { publishedAt: d.toISOString(), datePrecision: 'minute' };
    }
  }

  // Date only.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { publishedAt: s, datePrecision: 'date' };
  }

  // RFC 822 (RSS pubDate).
  const rfc = /^[A-Za-z]{3},?\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(:\d{2})?\s+([+-]\d{4}|GMT|UTC)/.exec(s);
  if (rfc) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return { publishedAt: d.toISOString(), datePrecision: 'second' };
  }

  const anyDate = new Date(s);
  if (!Number.isNaN(anyDate.getTime()) && /\d{4}/.test(s)) {
    const hasTime = /\d{1,2}:\d{2}/.test(s);
    return { publishedAt: anyDate.toISOString(), datePrecision: hasTime ? 'minute' : 'date' };
  }

  return { publishedAt: null, datePrecision: 'unknown' };
}

/**
 * Chinese relative timestamps as rendered in list views ("5小时前", "昨天", "10月29日").
 * These are only ever used as a *fallback*; the adapters prefer an exact API timestamp.
 */
export function parseChineseRelative(text, now = new Date()) {
  const s = String(text || '').trim();
  const base = new Date(now).getTime();
  let m;
  if ((m = /^(\d+)\s*秒前/.exec(s))) return { publishedAt: new Date(base - m[1] * 1000).toISOString(), datePrecision: 'relative' };
  if ((m = /^(\d+)\s*分钟前/.exec(s))) return { publishedAt: new Date(base - m[1] * 60_000).toISOString(), datePrecision: 'relative' };
  if ((m = /^(\d+)\s*小时前/.exec(s))) return { publishedAt: new Date(base - m[1] * 3600_000).toISOString(), datePrecision: 'relative' };
  if ((m = /^(\d+)\s*天前/.exec(s))) return { publishedAt: new Date(base - m[1] * 86400_000).toISOString(), datePrecision: 'relative' };
  if (s === '刚刚') return { publishedAt: new Date(base).toISOString(), datePrecision: 'relative' };
  if (s === '昨天') {
    const d = new Date(base - 86400_000);
    return { publishedAt: d.toISOString().slice(0, 10), datePrecision: 'date' };
  }
  if (s === '前天') {
    const d = new Date(base - 2 * 86400_000);
    return { publishedAt: d.toISOString().slice(0, 10), datePrecision: 'date' };
  }
  if ((m = /^(\d{1,2})-(\d{1,2})$/.exec(s))) {
    const nowD = new Date(base);
    const year = nowD.getMonth() + 1 < Number(m[1]) ? nowD.getFullYear() - 1 : nowD.getFullYear();
    return {
      publishedAt: `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`,
      datePrecision: 'date',
      yearInferred: true,
    };
  }
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    return { publishedAt: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, datePrecision: 'date' };
  }
  return { publishedAt: null, datePrecision: 'unknown' };
}

/** Parse "27:20" / "1:02:33" into seconds. */
export function parseDuration(text) {
  const s = String(text || '').trim();
  const parts = s.split(':').map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Seconds -> SRT timestamp. */
export function srtTimestamp(totalSeconds) {
  const ms = Math.round((totalSeconds % 1) * 1000);
  const t = Math.floor(totalSeconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Convert bilibili/JSON subtitle cues into SRT. */
export function cuesToSrt(cues = []) {
  return cues
    .filter((c) => Number.isFinite(c.from) && Number.isFinite(c.to))
    .sort((a, b) => a.from - b.from)
    .map((c, i) => `${i + 1}\n${srtTimestamp(c.from)} --> ${srtTimestamp(c.to)}\n${String(c.content || '').trim()}\n`)
    .join('\n');
}
