/**
 * YouTube adapter.
 *
 * Public channel RSS (`/feeds/videos.xml?channel_id=...`) is the cheapest correct list:
 * real timestamps, no key. The only work is resolving `@handle` -> channel id, which we
 * do by reading the channel page once and caching the result in state.
 *
 * When the network cannot reach YouTube, that is reported as a retry with the actual
 * exception — never as "no new videos".
 */
import { CollectError } from '../lib/core.mjs';
import { emptyResult, quickProbe } from './base.mjs';
import { canonicalUrl, parsePublished } from '../lib/normalize.mjs';
import { parseFeed } from './rss.mjs';

const CHANNEL_ID_RE = /"channelId":"(UC[\w-]{20,})"/;

export const youtubeAdapter = {
  name: 'youtube',
  requiresBrowser: false,
  supports(target) {
    return /youtube\.com|youtu\.be/.test(target.url || '') || target.platform === 'YouTube';
  },

  async inspect({ target, ctx, windowFrom, windowTo }) {
    const result = emptyResult(target, { windowFrom, windowTo });
    let channelId = target.override?.channelId || null;

    if (!channelId) {
      // Cheap reachability probe first: an unreachable host should cost 6s, not 60s.
      await quickProbe(ctx, 'https://www.youtube.com/', { timeoutMs: 7000, label: 'youtube.com' }).catch((err) => {
        throw new CollectError(`YouTube 不可达：${err.message}`, {
          status: 'retry',
          stage: 'network',
          code: 'YT_UNREACHABLE',
          nextStep: '本机网络无法访问 youtube.com；由可访问地区的执行者补采，或改用该账号其他平台',
        });
      });
      const html = await ctx.http.text(target.url, { timeoutMs: 25_000 }).catch((err) => {
        throw new CollectError(`无法打开 YouTube 频道页：${err.message}`, {
          status: 'retry',
          stage: 'network',
          code: 'YT_UNREACHABLE',
          nextStep: '确认网络可达；若持续不可达，改由具备该地区访问能力的执行者补采',
        });
      });
      const m = CHANNEL_ID_RE.exec(html);
      channelId = m ? m[1] : null;
    }

    if (!channelId) {
      throw new CollectError('未能从频道页解析 channelId', {
        status: 'retry',
        stage: 'parse',
        code: 'NO_CHANNEL_ID',
        nextStep: '在 config/adapters.json 中为该来源写死 channelId（UC 开头）',
      });
    }

    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const xml = await ctx.http.text(feedUrl).catch((err) => {
      throw new CollectError(`频道 RSS 拉取失败：${err.message}`, {
        status: 'retry',
        stage: 'http',
        code: 'YT_FEED_FAIL',
        nextStep: '稍后重试；RSS 通常无需登录',
      });
    });

    const parsed = parseFeed(xml);
    const posts = [];
    let oldest = null;
    let newest = null;
    for (const item of parsed.items) {
      const parsedDate = parsePublished(item.rawDate);
      const ms = parsedDate.publishedAt ? new Date(parsedDate.publishedAt).getTime() : null;
      if (!ms) continue;
      if (!newest || ms > newest) newest = ms;
      if (!oldest || ms < oldest) oldest = ms;
      if (ms < new Date(windowFrom).getTime() || ms > new Date(windowTo).getTime()) continue;
      const videoId = (/v=([\w-]+)/.exec(item.link || '') || [])[1] || item.guid;
      posts.push({
        id: `${target.sourceId}-youtube-${videoId}`,
        sourceId: target.sourceId,
        platform: 'YouTube',
        url: canonicalUrl(item.link),
        title: item.title,
        publishedAt: parsedDate.publishedAt,
        datePrecision: 'second',
        discoveredAt: ctx.nowIso(),
        evidence: 'metadata',
        evidenceUrl: feedUrl,
        evidenceNote: `官方频道 RSS 的 published 字段；仅元数据，字幕/转录未取得。`,
        platformPostId: videoId,
        extra: { channelId },
      });
    }

    result.status = 'success';
    result.pagesRead = 1;
    result.itemsRead = parsed.items.length;
    result.oldestSeenAt = oldest ? new Date(oldest).toISOString() : null;
    result.newestSeenAt = newest ? new Date(newest).toISOString() : null;
    result.posts = posts;
    result.evidenceUrl = feedUrl;
    result.cursor = { channelId, feedUrl };
    result.note = `已读取 YouTube 频道 RSS（${parsed.items.length} 条，channelId=${channelId}），窗口内 ${posts.length} 条。仅元数据，未取得字幕。`;
    return result;
  },

  async content() {
    return { status: 'blocked', note: 'YouTube 字幕需要官方字幕或授权转录；本轮未取得。' };
  },
};

export default youtubeAdapter;
