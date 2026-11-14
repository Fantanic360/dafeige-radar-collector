/**
 * 小宇宙 (Xiaoyuzhou) adapter.
 *
 * Podcast pages are server-rendered with a `__NEXT_DATA__` blob that contains the episode
 * list with real ISO timestamps and the full show notes. That makes this a genuine
 * fulltext-capable source for the two podcast sources on the roster.
 */
import { CollectError } from '../lib/core.mjs';
import { emptyResult } from './base.mjs';
import { canonicalUrl, parsePublished } from '../lib/normalize.mjs';

function extractNextData(html) {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function collectEpisodes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) collectEpisodes(n, out);
    return out;
  }
  const looksLikeEpisode =
    node.eid ||
    (node.title && (node.pubDate || node.publishedAt) && (node.podcast || node.enclosure || node.duration));
  if (looksLikeEpisode && (node.eid || node.title)) out.push(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectEpisodes(value, out);
  }
  return out;
}

export const xiaoyuzhouAdapter = {
  name: 'xiaoyuzhou',
  requiresBrowser: false,
  supports(target) {
    return /xiaoyuzhoufm\.com/.test(target.url || '') || target.platform === '小宇宙';
  },

  async inspect({ target, ctx, windowFrom, windowTo }) {
    const result = emptyResult(target, { windowFrom, windowTo });
    const html = await ctx.http.text(target.url, { timeoutMs: 25_000 });
    const data = extractNextData(html);
    if (!data) {
      throw new CollectError('小宇宙页面未包含 __NEXT_DATA__（可能改版或返回拦截页）', {
        status: 'retry',
        stage: 'parse',
        code: 'NO_NEXT_DATA',
        nextStep: '改用浏览器渲染后解析，或改用该播客的 RSS',
      });
    }

    const episodes = collectEpisodes(data);
    const dedup = new Map();
    for (const ep of episodes) {
      const key = ep.eid || ep.title;
      if (!dedup.has(key)) dedup.set(key, ep);
    }
    const list = [...dedup.values()];
    if (!list.length) {
      throw new CollectError('页面结构中没有解析到单集列表', {
        status: 'retry',
        stage: 'parse',
        code: 'EMPTY_EPISODES',
        nextStep: '检查 __NEXT_DATA__ 结构变化',
      });
    }

    const posts = [];
    const attempts = [];
    let oldest = null;
    let newest = null;
    for (const ep of list) {
      const parsed = parsePublished(ep.pubDate || ep.publishedAt);
      const ms = parsed.publishedAt && parsed.publishedAt.includes('T') ? new Date(parsed.publishedAt).getTime() : null;
      if (ms) {
        if (!newest || ms > newest) newest = ms;
        if (!oldest || ms < oldest) oldest = ms;
      }
      if (!ms || ms < new Date(windowFrom).getTime() || ms > new Date(windowTo).getTime()) continue;

      const url = ep.eid ? `https://www.xiaoyuzhoufm.com/episode/${ep.eid}` : target.url;
      const notes = ep.description || ep.showNotes || '';
      const postId = `${target.sourceId}-xiaoyuzhou-${ep.eid || ep.title.slice(0, 20)}`;
      posts.push({
        id: postId,
        sourceId: target.sourceId,
        platform: '小宇宙',
        url: canonicalUrl(url),
        title: ep.title,
        publishedAt: parsed.publishedAt,
        datePrecision: parsed.datePrecision,
        discoveredAt: ctx.nowIso(),
        evidence: 'metadata',
        evidenceUrl: target.url,
        evidenceNote: `小宇宙页面 __NEXT_DATA__ 中的 pubDate=${ep.pubDate || ep.publishedAt}；节目简介 ${notes.length} 字。简介是作者自述，不等于整集音频已听。`,
        duration: Number(ep.duration) || null,
        platformPostId: ep.eid || null,
        extra: { showNotes: notes.slice(0, 4000) },
      });
      {
        attempts.push({
          postId,
          checkedAt: ctx.nowIso(),
          status: 'retry',
          note: `取得节目简介 ${notes.length} 字，整集音频未转录；简介不作为已读正文。`,
        });
      }
    }

    result.status = oldest !== null && oldest <= new Date(windowFrom).getTime() && list.every(ep => parsePublished(ep.pubDate || ep.publishedAt).publishedAt?.includes('T')) ? 'success' : 'retry';
    result.pagesRead = 1;
    result.itemsRead = list.length;
    result.oldestSeenAt = oldest ? new Date(oldest).toISOString() : null;
    result.newestSeenAt = newest ? new Date(newest).toISOString() : null;
    result.posts = posts;
    result.contentAttempts = attempts;
    result.evidenceUrl = target.url;
    result.cursor = { lastEid: list[0]?.eid || null, totalEpisodes: list.length };
    result.note =
      `已解析小宇宙播客页 ${list.length} 个单集（最旧 ${result.oldestSeenAt || '未知'}），` +
      `窗口内 ${posts.length} 条。发布时间取自页面结构化数据，非相对标签。` +
      `本记录只覆盖该播客页，音频正文需另行转录。${result.status === 'retry' ? '当前列表未证明覆盖声明窗口，成功游标不推进。' : ''}`;
    return result;
  },

  async content({ post, ctx }) {
    const notes = post.extra?.showNotes || '';
    if (notes.length > 400) {
      const file = await ctx.saveEvidence(`${post.id}.md`, `# ${post.title}\n\n${notes}\n`);
      return { status: 'retry', note: `节目简介 ${notes.length} 字已保存于 ${file}；不是音频转录，继续等待原片/可靠转写。`, evidence: 'metadata', evidenceFile: file };
    }
    return { status: 'blocked', note: '缺少节目简介正文；整集音频需授权转录后才能判定内容。' };
  },
};

export default xiaoyuzhouAdapter;
