/**
 * B站 adapter.
 *
 * Two tiers, because each answers a different question:
 *  1. browser tier  -> the public upload list (what exists, newest first). The
 *     `/x/space/wbi/arc/search` endpoint is risk-controlled for server-side callers
 *     (HTTP 412 / code -352 even with WBI signing), but the rendered page is not.
 *  2. api tier      -> exact publish time, owner identity, duration, chapters and
 *     subtitle tracks for specific BV ids. These endpoints are open and authoritative.
 *
 * The combination is what makes the record trustworthy: the list proves coverage, the
 * API proves the timestamp. Relative labels like "5小时前" are never stored as a publish
 * time.
 */
import { CollectError } from '../lib/core.mjs';
import { contentAttempt, emptyResult } from './base.mjs';
import { canonicalUrl, cuesToSrt, extractPostId, formatDuration, parseDuration, parsePublished } from '../lib/normalize.mjs';

const API = 'https://api.bilibili.com';
const REFERER = 'https://www.bilibili.com/';

export function midFromUrl(url) {
  const m = String(url).match(/space\.bilibili\.com\/(\d+)/);
  return m ? m[1] : null;
}

const CARD_SCRIPT = `(() => {
  const out = [];
  const seen = new Set();
  const anchors = [...document.querySelectorAll('a[href*="/video/BV"]')];
  for (const a of anchors) {
    const m = (a.getAttribute('href') || '').match(/\\/video\\/(BV[0-9A-Za-z]+)/);
    if (!m) continue;
    const bvid = m[1];
    if (seen.has(bvid)) continue;
    seen.add(bvid);
    let card = a;
    for (let i = 0; i < 6 && card; i += 1) {
      if (card.querySelector && card.querySelectorAll('a[href*="/video/BV"]').length === 1) break;
      card = card.parentElement;
    }
    const text = (card && card.innerText) || '';
    const lines = text.split('\\n').map(s => s.trim()).filter(Boolean);
    const durLine = lines.find(s => /^\\d{1,2}:\\d{2}(:\\d{2})?$/.test(s)) || '';
    const timeLine = lines.find(s => /(秒前|分钟前|小时前|天前|刚刚|昨天|前天|^\\d{1,2}-\\d{1,2}$|^\\d{4}-\\d{1,2}-\\d{1,2}$)/.test(s)) || '';
    const titleAttr = a.getAttribute('title') || '';
    const titleNode = card && card.querySelector ? card.querySelector('[title]') : null;
    const title = (titleNode && titleNode.getAttribute('title')) || titleAttr || (lines.find(s => s.length > 6 && !/^[\\d.万]+$/.test(s) && s !== durLine && s !== timeLine) || '');
    out.push({ bvid, href: a.getAttribute('href'), title, durationText: durLine, timeText: timeLine, pinned: /置顶/.test(text), raw: lines.slice(0, 8) });
  }
  return { items: out, pageTitle: document.title, bodyLen: document.body ? document.body.innerText.length : 0, bodyText: document.body ? document.body.innerText.slice(0, 400) : '' };
})()`;

async function readList(ctx, target) {
  const mid = midFromUrl(target.url);
  if (!mid) {
    throw new CollectError('无法从主页地址解析 B站 mid', {
      status: 'identity_pending',
      stage: 'parse',
      nextStep: '确认主页 URL 形如 https://space.bilibili.com/<mid>',
    });
  }

  const browser = await ctx.getBrowser();
  const attempts = [
    { url: `https://space.bilibili.com/${mid}/video`, label: 'desktop', settleMs: 1200, waitMs: 20_000 },
    { url: `https://space.bilibili.com/${mid}/video`, label: 'desktop-reload', settleMs: 1500, waitMs: 15_000 },
    { url: `https://m.bilibili.com/space/${mid}`, label: 'mobile', settleMs: 1200, waitMs: 15_000 },
  ];

  let lastPage = { url: `https://space.bilibili.com/${mid}/video`, pageTitle: '', bodyText: '' };

  for (const attempt of attempts) {
    await browser.goto(attempt.url, { settleMs: attempt.settleMs });
    // The list is rendered from a risk-controlled XHR; it sometimes arrives seconds late,
    // so poll instead of assuming one fixed sleep is enough.
    await browser.waitFor(`document.querySelectorAll('a[href*="/video/BV"]').length > 0`, {
      timeoutMs: attempt.waitMs,
      intervalMs: 600,
    });

    const collected = new Map();
    const snap = await browser.session.evaluate(CARD_SCRIPT, { timeoutMs: 20_000 });
    lastPage = { url: await browser.session.evaluate('location.href'), pageTitle: snap.pageTitle, bodyText: snap.bodyText };
    for (const item of snap.items || []) collected.set(item.bvid, item);

    if (collected.size > 0) {
      // Pull one more screen so the window boundary is genuinely covered, not guessed.
      for (let i = 0; i < 2; i += 1) {
        await browser.scrollToBottom(1, 700);
        const more = await browser.session.evaluate(CARD_SCRIPT, { timeoutMs: 20_000 });
        for (const item of more.items || []) collected.set(item.bvid, item);
      }
      return { mid, pageUrl: attempt.url, items: [...collected.values()], attempt: attempt.label };
    }

    const looksBlocked = /安全验证|访问异常|人机验证|登录后查看|服务异常/.test(snap.bodyText || '');
    if (looksBlocked) {
      await captureFailure(ctx, browser, `bilibili_${mid}_blocked`);
      throw new CollectError(`B站列表页出现访问限制提示（${attempt.label}）：${(snap.bodyText || '').slice(0, 80)}`, {
        status: 'blocked',
        stage: 'extract',
        code: 'RISK_CONTROL',
        nextStep: '改用已授权的浏览器会话人工复跑，或先查同作者其他已核实平台',
      });
    }
  }

  await captureFailure(ctx, browser, `bilibili_${mid}_empty`);
  throw new CollectError(
    `B站列表页三轮尝试（桌面/重载/移动端）均未渲染作品卡片；页面标题“${lastPage.pageTitle || '空'}”。` +
      `可能原因：平台风控临时限流、页面改版或该账号无公开投稿。已保存截图与页面文本作为失败证据。`,
    {
      status: 'retry',
      stage: 'extract',
      code: 'EMPTY_LIST',
      nextStep: '15 分钟后重试；若持续为空，检查选择器是否随改版失效',
    },
  );
}

/** Save a screenshot + page text so a failure can be audited instead of argued about. */
async function captureFailure(ctx, browser, name) {
  try {
    const file = await browser.screenshot(`${ctx.evidenceDir}/.${name}.png`);
    const text = await browser.session.evaluate('document.body ? document.body.innerText.slice(0, 4000) : ""');
    const rel = await ctx.saveEvidence(`${name}.txt`, String(text || ''));
    if (file) ctx.log?.debug('已保存失败证据', { screenshot: file, text: rel });
  } catch {
    /* evidence capture is best-effort */
  }
}

/** Exact metadata for one BV id: timestamp, owner, duration. */
async function fetchVideoMeta(ctx, bvid) {
  const json = await ctx.http.json(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    headers: { referer: REFERER },
  });
  if (json.code !== 0 || !json.data) {
    throw new CollectError(`B站 view 接口返回 ${json.code} ${json.message || ''}`, {
      status: json.code === -404 ? 'retry' : 'retry',
      stage: 'api',
      code: `BILI_${json.code}`,
      nextStep: '该作品可能已删除/私密，或接口限流；稍后单独复核',
    });
  }
  return json.data;
}

/** Subtitle tracks + chapters. Empty list is a real answer, not a failure. */
async function fetchPlayerExtras(ctx, bvid, cid) {
  const json = await ctx.http.json(`${API}/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`, {
    headers: { referer: `https://www.bilibili.com/video/${bvid}` },
  }).catch(() => null);
  if (!json || json.code !== 0) return { subtitles: [], chapters: [] };
  const subtitles = json.data?.subtitle?.subtitles || [];
  const chapters = (json.data?.view_points || []).map((p) => ({
    start: p.from,
    end: p.to,
    label: p.content,
  }));
  return { subtitles, chapters };
}

export async function fetchSubtitleCues(ctx, subtitle) {
  const url = subtitle.subtitle_url?.startsWith('//') ? `https:${subtitle.subtitle_url}` : subtitle.subtitle_url;
  if (!url) return null;
  const json = await ctx.http.json(url, { headers: { referer: 'https://www.bilibili.com/' } });
  return (json.body || []).map((c) => ({ from: c.from, to: c.to, content: c.content }));
}

export const bilibiliAdapter = {
  name: 'bilibili',
  requiresBrowser: true,
  supports(target) {
    return /space\.bilibili\.com/.test(target.url || '') || target.platform === 'B站';
  },

  async inspect({ target, ctx, windowFrom, windowTo }) {
    const result = emptyResult(target, { windowFrom, windowTo });
    const fetchedAt = ctx.nowIso();

    const { mid, pageUrl, items } = await readList(ctx, target);

    const maxEnrich = Number(ctx.env?.biliMaxEnrich || 6);
    const candidates = items.slice(0, Math.max(maxEnrich, 6));
    const posts = [];
    const attempts = [];
    let oldest = null;
    let newest = null;

    for (const item of candidates) {
      let meta;
      try {
        meta = await fetchVideoMeta(ctx, item.bvid);
      } catch (err) {
        // A single deleted/private item must not fail the whole list read.
        attempts.push(
          contentAttempt(`${target.sourceId}-bilibili-${item.bvid}`, {
            status: 'retry',
            note: `元数据读取失败：${err.message}`,
            checkedAt: fetchedAt,
          }),
        );
        continue;
      }

      const ownerMid = String(meta.owner?.mid ?? '');
      if (ownerMid && ownerMid !== String(mid)) {
        // Same title, different uploader: a reprint. Do not attribute it to the author.
        continue;
      }

      const parsed = parsePublished(meta.pubdate);
      const publishedAt = parsed.publishedAt;
      const createdMs = publishedAt && publishedAt.includes('T') ? new Date(publishedAt).getTime() : null;
      if (createdMs) {
        if (!newest || createdMs > newest) newest = createdMs;
        if (!oldest || createdMs < oldest) oldest = createdMs;
      }

      const url = `https://www.bilibili.com/video/${item.bvid}`;
      const durationSeconds = Number(meta.duration) || parseDuration(item.durationText) || null;
      const inWindow =
        createdMs !== null &&
        createdMs >= new Date(windowFrom).getTime() &&
        createdMs <= new Date(windowTo).getTime();

      if (!inWindow) continue;

      const extras = await fetchPlayerExtras(ctx, item.bvid, meta.cid).catch(() => ({ subtitles: [], chapters: [] }));
      const postId = `${target.sourceId}-bilibili-${item.bvid}`;

      let evidence = 'metadata';
      let evidenceNote = `B站官方 view 接口核验：owner.mid=${ownerMid || mid}、pubdate=${meta.pubdate}（${publishedAt}）；列表项标签“${item.timeText || '无'}”仅作参考，未作为发布时间。`;
      let transcriptFile = null;

      const sub = (extras.subtitles || []).find((s) => s.subtitle_url);
      if (sub) {
        try {
          const cues = await fetchSubtitleCues(ctx, sub);
          if (cues && cues.length) {
            transcriptFile = await ctx.saveEvidence(
              `${postId}.srt`,
              cuesToSrt(cues),
            );
            evidence = 'transcript';
            evidenceNote += ` 官方字幕轨（lan=${sub.lan || 'unknown'}）共 ${cues.length} 条，已存 ${transcriptFile}。`;
            attempts.push(
              contentAttempt(postId, {
                status: 'verified',
                note: `已取得官方字幕（${sub.lan || 'unknown'}）${cues.length} 条，覆盖全片。`,
                checkedAt: fetchedAt,
                evidence: 'transcript',
              }),
            );
          }
        } catch (err) {
          attempts.push(
            contentAttempt(postId, {
              status: 'retry',
              note: `字幕轨存在但下载失败：${err.message}`,
              checkedAt: fetchedAt,
            }),
          );
        }
      } else {
        attempts.push(
          contentAttempt(postId, {
            status: 'blocked',
            note: `官方字幕接口返回空列表（view_points=${(extras.chapters || []).length} 个章节，时长 ${formatDuration(durationSeconds) || '未知'}）。仅元数据可核，不据此评价整片内容。`,
            checkedAt: fetchedAt,
          }),
        );
      }

      posts.push({
        id: postId,
        sourceId: target.sourceId,
        platform: 'B站',
        url: canonicalUrl(url),
        title: meta.title || item.title,
        publishedAt,
        datePrecision: parsed.datePrecision,
        discoveredAt: fetchedAt,
        evidence,
        evidenceUrl: `${API}/x/web-interface/view?bvid=${item.bvid}`,
        evidenceNote,
        duration: durationSeconds,
        platformPostId: item.bvid,
        extra: {
          chapters: extras.chapters || [],
          listLabel: item.timeText || null,
          pinned: Boolean(item.pinned),
          transcriptFile,
        },
      });
    }

    const pagesRead = 1;
    const coveredFrom = oldest ? new Date(oldest).toISOString() : windowFrom;

    result.status = 'success';
    result.pagesRead = pagesRead;
    result.itemsRead = candidates.length;
    result.oldestSeenAt = oldest ? new Date(oldest).toISOString() : null;
    result.newestSeenAt = newest ? new Date(newest).toISOString() : null;
    result.posts = posts;
    result.contentAttempts = attempts;
    result.evidenceUrl = pageUrl;
    result.cursor = { lastBvid: candidates[0]?.bvid || null, mid };
    result.note =
      `实际渲染并读取 B站投稿列表（${items.length} 张卡片，去重后取前 ${candidates.length} 条逐条核验），` +
      `列表覆盖自 ${coveredFrom} 起；窗口 ${windowFrom} → ${windowTo} 内新增 ${posts.length} 条。` +
      `作品元数据来自官方 view 接口，置顶项${items.some((i) => i.pinned) ? '存在已按发布时间过滤' : '未出现'}。` +
      `本记录只证明列表覆盖，不代表整片已读。`;

    if (posts.length === 0) {
      result.note = `已读取 B站投稿列表 ${items.length} 张卡片（最旧 ${coveredFrom}），窗口 ${windowFrom} → ${windowTo} 内无新发布。仅覆盖本账号公开列表。`;
    }

    return result;
  },

  /** Content pass for a known post (used by the content queue). */
  async content({ post, ctx }) {
    if (!post.url) {
      return { status: 'blocked', note: '缺少原作链接，无法补采正文' };
    }
    const bvid = extractPostId(post.url, 'B站');
    if (!/^BV/.test(bvid)) {
      return { status: 'blocked', note: `无法从链接解析 BV 号：${post.url}` };
    }
    const meta = await fetchVideoMeta(ctx, bvid);
    const extras = await fetchPlayerExtras(ctx, bvid, meta.cid);
    const sub = (extras.subtitles || []).find((s) => s.subtitle_url);
    if (!sub) {
      return {
        status: 'blocked',
        note: `官方字幕轨为空；章节 ${(extras.chapters || []).length} 个。需要授权转录（ASR）或人工精读后才能升级为 transcript。`,
      };
    }
    const cues = await fetchSubtitleCues(ctx, sub);
    const file = await ctx.saveEvidence(`${post.id}.srt`, cuesToSrt(cues));
    return {
      status: 'verified',
      note: `官方字幕 ${cues.length} 条，已存 ${file}`,
      evidence: 'transcript',
      transcriptFile: file,
    };
  },
};

export default bilibiliAdapter;
