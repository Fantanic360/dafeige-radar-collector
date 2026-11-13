/**
 * RSS / Atom adapter.
 *
 * Covers: author blogs, newsletters, podcast feeds and any site that advertises a feed.
 * This is the cheapest high-trust source we have: the author's own machine publishes a
 * timestamped list, no rendering, no risk control.
 *
 * Feed discovery order: explicit override -> <link rel="alternate"> on the page ->
 * common well-known paths. We record which one worked so the binding can be pinned later.
 */
import { CollectError } from '../lib/core.mjs';
import { contentAttempt, emptyResult } from './base.mjs';
import { canonicalUrl, parsePublished } from '../lib/normalize.mjs';

const FEED_HINTS = ['/feed', '/rss', '/rss.xml', '/atom.xml', '/feed.xml', '/index.xml', '/feed/'];

function stripTags(input = '') {
  return String(input)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function firstTag(block, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
    const m = re.exec(block);
    if (m) return m[1].trim();
  }
  return null;
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const alternate = links.find((attrs) => /rel=["']alternate["']/i.test(attrs)) || links[0];
  if (!alternate) return null;
  const href = /href=["']([^"']+)["']/i.exec(alternate);
  return href ? href[1] : null;
}

/** Minimal, tolerant RSS/Atom parser. Deliberately regex-based: no dependency, no XXE. */
export function parseFeed(xml) {
  const isAtom = /<feed[\s>]/i.test(xml);
  const blocks = isAtom
    ? [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0])
    : [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);

  const channelTitle = stripTags(firstTag(xml, ['title']) || '');

  const items = blocks.map((block) => {
    const title = stripTags(firstTag(block, ['title']) || '');
    const link = isAtom ? atomLink(block) : stripTags(firstTag(block, ['link']) || '') || atomLink(block);
    const rawDate = firstTag(block, ['pubDate', 'published', 'updated', 'dc:date']);
    const guid = stripTags(firstTag(block, ['guid', 'id']) || '') || link;
    const content =
      firstTag(block, ['content:encoded', 'content', 'description', 'summary']) || '';
    const author = stripTags(firstTag(block, ['author', 'dc:creator', 'name']) || '');
    return {
      title,
      link,
      guid,
      rawDate,
      author,
      contentHtml: content,
      contentText: stripTags(content),
    };
  });

  return { isAtom, channelTitle, items };
}

async function discoverFeed(ctx, pageUrl) {
  const tried = [];
  let pageOk = false;
  try {
    const html = await ctx.http.text(pageUrl, { timeoutMs: 10_000 });
    pageOk = true;
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    for (const tag of links) {
      if (!/alternate/i.test(tag)) continue;
      if (!/application\/(rss|atom)\+xml/i.test(tag)) continue;
      const href = /href=["']([^"']+)["']/i.exec(tag);
      if (!href) continue;
      const resolved = new URL(href[1], pageUrl).toString();
      tried.push(resolved);
      return { feedUrl: resolved, tried, how: 'link-alternate' };
    }
  } catch (err) {
    tried.push(`page:${err.message}`);
  }

  // If the site itself is unreachable, guessing /feed, /rss ... just burns the round budget.
  if (!pageOk) return { feedUrl: null, tried, how: null, pageUnreachable: true };

  const base = new URL(pageUrl);
  for (const hint of FEED_HINTS) {
    const candidate = new URL(hint, base.origin).toString();
    tried.push(candidate);
    try {
      const text = await ctx.http.text(candidate, { timeoutMs: 8000 });
      if (/<rss[\s>]|<feed[\s>]/i.test(text)) {
        return { feedUrl: candidate, tried, how: 'well-known' };
      }
    } catch {
      /* keep trying */
    }
  }
  return { feedUrl: null, tried, how: null };
}

export const rssAdapter = {
  name: 'rss',
  requiresBrowser: false,
  supports(target) {
    return ['官网', '播客', 'Newsletter', '主站'].includes(target.platform) || Boolean(target.override?.feedUrl);
  },

  async inspect({ target, source, ctx, windowFrom, windowTo }) {
    const result = emptyResult(target, { windowFrom, windowTo });
    let feedUrl = target.override?.feedUrl || null;
    let discovery = null;

    if (!feedUrl) {
      discovery = await discoverFeed(ctx, target.url);
      feedUrl = discovery.feedUrl;
    }

    if (!feedUrl) {
      const unreachable = discovery?.pageUnreachable;
      throw new CollectError(
        unreachable ? '来源主页不可达，未尝试猜测订阅源路径' : '未发现 RSS/Atom 源',
        {
          status: unreachable ? 'retry' : 'blocked',
          stage: 'discover',
          code: unreachable ? 'SITE_UNREACHABLE' : 'NO_FEED',
          nextStep: unreachable
            ? '确认本机能否访问该站点（DNS/代理/站点下线），再决定是否改由其他执行者补采'
            : '为该来源指定 feedUrl（override），或改用浏览器读取列表页',
          details: { tried: discovery?.tried?.slice(0, 8) },
        },
      );
    }

    let xml;
    try {
      xml = await ctx.http.text(feedUrl, { timeoutMs: 12_000 });
    } catch (err) {
      throw new CollectError(`RSS 拉取失败：${err.message}`, {
        status: 'retry',
        stage: 'http',
        nextStep: '确认订阅源是否暂时不可用；连续失败时改为页面读取',
      });
    }

    const parsed = parseFeed(xml);
    if (!parsed.items.length) {
      throw new CollectError('订阅源未解析出任何条目（可能返回了 HTML 拦截页）', {
        status: 'retry',
        stage: 'parse',
        code: 'EMPTY_FEED',
        nextStep: '检查 feedUrl 是否被重定向到登录/验证页',
      });
    }

    const posts = [];
    const attempts = [];
    let oldest = null;
    let newest = null;

    for (const item of parsed.items) {
      if (!item.link) continue;
      const parsedDate = parsePublished(item.rawDate);
      const ms = parsedDate.publishedAt && parsedDate.publishedAt.includes('T')
        ? new Date(parsedDate.publishedAt).getTime()
        : null;
      if (ms) {
        if (!newest || ms > newest) newest = ms;
        if (!oldest || ms < oldest) oldest = ms;
      }
      if (ms === null || ms < new Date(windowFrom).getTime() || ms > new Date(windowTo).getTime()) continue;

      const postId = `${target.sourceId}-rss-${(item.guid || item.link).replace(/[^\w.-]+/g, '-').slice(-60)}`;
      const hasBody = item.contentText.length > 600;
      posts.push({
        id: postId,
        sourceId: target.sourceId,
        platform: target.platform,
        url: canonicalUrl(item.link),
        title: item.title,
        publishedAt: parsedDate.publishedAt,
        datePrecision: parsedDate.datePrecision,
        discoveredAt: ctx.nowIso(),
        evidence: hasBody ? 'fulltext' : 'metadata',
        evidenceUrl: feedUrl,
        evidenceNote: hasBody
          ? `订阅源 ${feedUrl} 自带正文（${item.contentText.length} 字），已按原文入库；作者字段=${item.author || '未标注'}。`
          : `订阅源 ${feedUrl} 仅提供摘要（${item.contentText.length} 字），正文未取得。`,
        platformPostId: item.guid,
        extra: { feedUrl, summaryText: item.contentText.slice(0, 500) },
      });

      if (!hasBody) {
        attempts.push(
          contentAttempt(postId, {
            status: 'retry',
            note: `RSS 只有摘要（${item.contentText.length} 字），需回原文抓取正文`,
            checkedAt: ctx.nowIso(),
          }),
        );
      }
    }

    result.status = 'success';
    result.pagesRead = 1;
    result.itemsRead = parsed.items.length;
    result.oldestSeenAt = oldest ? new Date(oldest).toISOString() : null;
    result.newestSeenAt = newest ? new Date(newest).toISOString() : null;
    result.posts = posts;
    result.contentAttempts = attempts;
    result.evidenceUrl = feedUrl;
    result.cursor = { feedUrl, lastGuid: parsed.items[0]?.guid || null };
    const truncated = parsed.items.length <= 3;
    result.note =
      `已读取订阅源 ${feedUrl}（${parsed.isAtom ? 'Atom' : 'RSS'}，共 ${parsed.items.length} 条，` +
      `最旧 ${result.oldestSeenAt || '未知'}）；窗口 ${windowFrom} → ${windowTo} 内 ${posts.length} 条。` +
      `${truncated ? '该源本身只输出极少条目，覆盖有限，不能据此判断“没有更新”。' : ''}` +
      `${discovery ? `源由 ${discovery.how} 发现。` : ''}仅覆盖该订阅源，不代表其他平台。`;
    return result;
  },

  async content({ post, ctx }) {
    try {
      const html = await ctx.http.text(post.url, { timeoutMs: 20_000 });
      const text = stripTags(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));
      if (text.length < 400) {
        return { status: 'retry', note: `原文正文过短（${text.length} 字），可能被拦截或需登录` };
      }
      const file = await ctx.saveEvidence(`${post.id}.txt`, text.slice(0, 200_000));
      return { status: 'verified', note: `已抓取原文正文 ${text.length} 字，存 ${file}`, evidence: 'fulltext', transcriptFile: file };
    } catch (err) {
      return { status: 'retry', note: `原文抓取失败：${err.message}` };
    }
  },
};

export default rssAdapter;
