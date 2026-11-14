/**
 * Gated-platform adapters: 抖音 / 小红书 / 微博 / X / 微信公众号.
 *
 * These are the platforms the handoff is most explicit about: opening a profile and
 * reading a nickname is *not* a list read, and "search returned nothing" is not
 * "no new content". So each adapter does a real attempt through the browser tier, then
 * classifies precisely *why* it could not produce a list, with a concrete next step.
 *
 * A blocked result is a valid, useful result. A fabricated success is not.
 */
import { CollectError } from '../lib/core.mjs';
import { emptyResult, quickProbe } from './base.mjs';
import { canonicalUrl, parseChineseRelative, parsePublished } from '../lib/normalize.mjs';

const LOGIN_HINTS = /扫码登录|登录后查看|请先登录|登录抖音|登录小红书|立即登录|手机号登录|验证码登录|Sign in to X|Log in/;
const RISK_HINTS = /安全验证|人机验证|滑动验证|访问频繁|访问异常|出错了|验证码|滑块|captcha|Something went wrong|Rate limit/i;

/**
 * Anchors that look like posts but are not this author's posts: recommendation rails,
 * "猜你喜欢" cards, search suggestions. Douyin/Xiaohongshu link these with these markers.
 */
const RECOMMEND_HINTS = /source=Baid|is_recommend|from=recommend|recommend=1|enter_from=others_homepage/;

/** The profile header proves the page rendered *someone's* profile, not that the grid did. */
const GRID_HINTS = /(作品|笔记|视频|帖子|动态)\s*\d+|TA的视频|全部作品/;

const URL_LOGIN_HINTS = /website-login|\/login|passport|signin|sso|error_code=|error_msg=/i;

function classify(pageText, itemCount, datedCount, pageUrl = '') {
  // A browser-level error page is a network failure, not a layout change.
  if (/^chrome-error:|^about:blank$/.test(pageUrl)) {
    return { status: 'retry', code: 'NETWORK', why: `无法加载页面（浏览器错误页 ${pageUrl}），目标站点不可达` };
  }
  if (itemCount === 0) {
    if (URL_LOGIN_HINTS.test(pageUrl) || RISK_HINTS.test(pageText)) {
      return {
        status: 'blocked',
        code: 'RISK_CONTROL',
        why: `被重定向到登录/风控页（${pageUrl.split('?')[0]}），未取得作品列表`,
      };
    }
    if (LOGIN_HINTS.test(pageText)) return { status: 'blocked', code: 'LOGIN_REQUIRED', why: '页面要求登录后才展示作品列表' };
    return { status: 'retry', code: 'EMPTY_LIST', why: '页面已打开但没有可解析的作品卡片（可能改版或懒加载未触发）' };
  }
  if (datedCount === 0) {
    // Without any publish date we cannot claim window coverage, and undated anchors are
    // usually recommendation cards rather than the author's own grid.
    return {
      status: 'blocked',
      code: 'NO_DATES',
      why: `解析到 ${itemCount} 个候选入口但没有任何可用发布时间，无法判定列表覆盖`,
    };
  }
  return null;
}

/**
 * @param {object} spec
 * @param {string} spec.name
 * @param {RegExp} spec.match
 * @param {string} spec.itemSelector DOM selector hint used inside the page script
 * @param {RegExp} spec.hrefPattern
 * @param {(text:string)=>string} [spec.normalizeUrl]
 */
function makeGatedAdapter(spec) {
  return {
    name: spec.name,
    requiresBrowser: true,
    supports(target) {
      return spec.match.test(target.url || '') || spec.platforms?.includes(target.platform);
    },

    async inspect({ target, ctx, windowFrom, windowTo }) {
      const result = emptyResult(target, { windowFrom, windowTo });
      const browser = await ctx.getBrowser();
      const landed = await browser.goto(target.url, { settleMs: 1800, timeoutMs: 20_000 });
      // A chrome-error page means DNS/proxy/TLS failure. Do not spend 20s screenshotting it.
      if (!landed || /^chrome-error:/.test(landed)) {
        throw new CollectError(`目标站点不可达（${landed || 'no url'}）`, {
          status: 'retry',
          stage: 'network',
          code: 'NETWORK',
          nextStep: '确认本机能否访问该域名（代理/地区限制），再决定是否交给其他执行者',
        });
      }

      const script = `(() => {
        const hrefRe = new RegExp(${JSON.stringify(spec.hrefPattern)});
        const anchors = [...document.querySelectorAll(${JSON.stringify(spec.itemSelector)})];
        const seen = new Set();
        const items = [];
        const dateRe = /(\\d+\\s*(秒|分钟|小时|天)前|刚刚|昨天|前天|\\d{1,2}-\\d{1,2}|\\d{4}-\\d{1,2}-\\d{1,2})/;
        const recRe = new RegExp(${JSON.stringify(RECOMMEND_HINTS.source)}, 'i');
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          if (!hrefRe.test(href)) continue;
          if (recRe.test(href)) continue;
          if (seen.has(href)) continue;
          seen.add(href);

          // Walk up until the container holds a plausible card, but never swallow the
          // whole page (that is how you end up with the profile name as every "title").
          let box = a;
          for (let i = 0; i < 4 && box.parentElement; i += 1) {
            const len = (box.innerText || '').length;
            if (len > 40 && len < 400) break;
            box = box.parentElement;
          }
          const lines = ((box.innerText || a.innerText || '').split('\\n') || [])
            .map(s => s.replace(/\\s+/g, ' ').trim())
            .filter(Boolean);

          const attrTitle = (a.getAttribute('aria-label') || a.getAttribute('title') || '').trim();
          const img = a.querySelector('img');
          const altTitle = (img && img.getAttribute('alt') || '').trim();
          const textTitle = lines.find(s => s.length >= 8 && !dateRe.test(s) && !/^(置顶|关注|私信|分享)$/.test(s)) || '';
          const title = (attrTitle || altTitle || textTitle || '').slice(0, 160);
          const dateLine = lines.find(s => dateRe.test(s)) || '';
          items.push({ href, title, lines: lines.slice(0, 8), dateLine });
        }
        return {
          items: items.slice(0, 40),
          url: location.href,
          title: document.title,
          bodyText: document.body ? document.body.innerText.slice(0, 1200) : '',
        };
      })()`;

      let snap;
      try {
        snap = await browser.session.evaluate(script, { timeoutMs: 20_000 });
      } catch (err) {
        throw new CollectError(`页面脚本执行失败：${err.message}`, {
          status: 'retry',
          stage: 'extract',
          nextStep: '确认浏览器可用后重试',
        });
      }

      const items = snap.items || [];
      const dated = items.filter((i) => i.dateLine);
      const verdict = classify(snap.bodyText || '', items.length, dated.length, snap.url);
      if (verdict) {
        try {
          await browser.screenshot(`${ctx.evidenceDir}/.${spec.name}_blocked.png`);
          await ctx.saveEvidence(
            `${spec.name}_blocked.txt`,
            `${snap.url}\n${snap.title}\n\n${snap.bodyText}\n\n候选入口 ${items.length} 个，其中有日期 ${dated.length} 个：\n` +
              items.slice(0, 10).map((i) => `- ${i.href} | ${i.title}`).join('\n'),
          );
        } catch {
          /* best effort */
        }
        throw new CollectError(`${verdict.why}（${snap.url}）`, {
          status: verdict.status,
          stage: 'extract',
          code: verdict.code,
          nextStep:
            verdict.code === 'LOGIN_REQUIRED'
              ? '需要该平台的已授权登录会话才能读列表；由有账号授权的执行者补采，或改用同作者已核实平台'
              : verdict.code === 'RISK_CONTROL'
                ? '停止自动重试，改由人工/授权浏览器处理，并记录失败时间与阶段'
                : '检查页面结构是否改版；必要时补充选择器',
          details: { pageTitle: snap.title, pageSnippet: snap.bodyText.slice(0, 200) },
        });
      }

      const posts = [];
      let newest = null;
      let oldest = null;
      for (const item of items) {
        if (!item.title) continue; // navigation/avatar anchors are not posts
        const url = new URL(item.href, snap.url).toString();
        const relText = item.dateLine || '';
        const rel = parseChineseRelative(relText, new Date(ctx.nowIso()));
        const parsed = rel.publishedAt ? rel : parsePublished(relText);
        const ms = parsed.publishedAt && parsed.publishedAt.includes('T') ? new Date(parsed.publishedAt).getTime() : null;
        if (ms) {
          if (!newest || ms > newest) newest = ms;
          if (!oldest || ms < oldest) oldest = ms;
        }
        posts.push({
          id: `${target.sourceId}-${spec.name}-${url.split('/').pop()}`,
          sourceId: target.sourceId,
          platform: target.platform,
          url: canonicalUrl(url),
          title: item.title,
          publishedAt: parsed.publishedAt,
          datePrecision: parsed.datePrecision,
          discoveredAt: ctx.nowIso(),
          evidence: 'metadata',
          evidenceUrl: snap.url,
          evidenceNote: `列表页标签“${relText || '无日期'}”为平台相对时间，仅作线索；${
            parsed.datePrecision === 'relative' ? '相对时间不可作为原作者精确发布时间，' : ''
          }绝对时间需进一步打开原作核对。`,
          platformPostId: url.split('/').pop(),
          extra: { listLabel: relText || null },
        });
      }

      const inWindow = posts.filter((p) => {
        if (!p.publishedAt) return true; // unknown dates stay visible, never silently dropped
        const ms = p.publishedAt.includes('T') ? new Date(p.publishedAt).getTime() : new Date(`${p.publishedAt}T00:00:00+08:00`).getTime();
        return ms >= new Date(windowFrom).getTime() - 86400_000 && ms <= new Date(windowTo).getTime() + 86400_000;
      });

      result.status = 'retry';
      result.pagesRead = 1;
      result.itemsRead = items.length;
      result.oldestSeenAt = oldest ? new Date(oldest).toISOString() : null;
      result.newestSeenAt = newest ? new Date(newest).toISOString() : null;
      // DOM cards do not yet verify original owner, canonical title and exact date.
      // Keep them as leads, never as admissible collection.posts.
      result.posts = [];
      result.leads = inWindow;
      if (inWindow.length) await ctx.saveEvidence(`${target.sourceId}-${spec.name}-leads.json`, JSON.stringify(inWindow, null, 2));
      result.evidenceUrl = target.url;
      result.note =
        `浏览器实际渲染个人主页并解析到 ${items.length} 个作品入口，窗口内 ${inWindow.length} 条。` +
        `列表时间多为平台相对标签，未冒充精确发布时间；正文未取得。` +
        `只证明本账号该列表的可见条目；原作身份与日期仍需逐条核实，线索不写入作品记录，成功游标不推进。`;
      if (!inWindow.length) {
        result.note = `已渲染个人主页并解析 ${items.length} 个作品入口，当前日期/列表边界证据不足以判断窗口 ${windowFrom} → ${windowTo} 的更新情况；成功游标不推进。`;
      }
      return result;
    },

    async content() {
      return {
        status: 'blocked',
        note: '该平台正文需要登录态或专用接口；本轮只做列表线索，不生成正文结论。',
      };
    },
  };
}

export const douyinAdapter = makeGatedAdapter({
  name: 'douyin',
  match: /douyin\.com\/(user|share\/user)/,
  platforms: ['抖音'],
  itemSelector: 'a[href*="/video/"]',
  hrefPattern: '/video/\\d+',
});

export const xiaohongshuAdapter = makeGatedAdapter({
  name: 'xiaohongshu',
  match: /xiaohongshu\.com\/user\/profile/,
  platforms: ['小红书'],
  itemSelector: 'a[href*="/explore/"], a[href*="/discovery/item/"]',
  hrefPattern: '/(explore|discovery\\/item)/',
});

export const weiboAdapter = makeGatedAdapter({
  name: 'weibo',
  match: /weibo\.com|weibo\.cn/,
  platforms: ['微博'],
  itemSelector: 'a[href*="weibo.com/"][href*="/"]',
  hrefPattern: 'weibo\\.com/\\d+/[A-Za-z0-9]+',
});

/**
 * X additionally gets a cheap pre-flight: if the host is unreachable from this network,
 * fail in ~2s instead of letting a renderer hang for two minutes.
 */
const xBase = makeGatedAdapter({
  name: 'x',
  match: /(^https?:\/\/)(www\.)?(x|twitter)\.com\//,
  platforms: ['X'],
  itemSelector: 'a[href*="/status/"]',
  hrefPattern: '/status/\\d+',
});

export const xAdapter = {
  ...xBase,
  async inspect(args) {
    try {
      await quickProbe(args.ctx, 'https://x.com/robots.txt', { timeoutMs: 7000, label: 'x.com' });
    } catch (err) {
      throw new CollectError(`X 主机不可达：${err.message}`, {
        status: 'retry',
        stage: 'network',
        code: 'X_UNREACHABLE',
        nextStep: '本机网络无法访问 x.com；改用已授权的 X 接口或由可访问地区的执行者补采',
      });
    }
    return xBase.inspect(args);
  },
};


/** 微信公众号: no public list endpoint exists without an authorised interface. */
export const wechatAdapter = {
  name: 'wechat',
  requiresBrowser: true,
  supports(target) {
    return target.platform === '微信公众号' || /mp\.weixin\.qq\.com/.test(target.url || '');
  },
  async inspect({ target, ctx, windowFrom, windowTo }) {
    if (/mp\.weixin\.qq\.com\/s\//.test(target.url || '')) {
      const html = await ctx.http.text(target.url, { timeoutMs: 20_000 }).catch(() => '');
      if (/该内容已被发布者删除|此内容因违规无法查看|环境异常/.test(html)) {
        throw new CollectError('公众号原文不可访问（已删除/违规/环境异常）', {
          status: 'blocked',
          stage: 'http',
          code: 'WECHAT_UNAVAILABLE',
          nextStep: '改用同作者其他平台或转载核对，不据标题推断内容',
        });
      }
    }
    throw new CollectError('缺少公众号列表接口（需要 ghid 与已授权接口）', {
      status: 'blocked',
      stage: 'discover',
      code: 'NO_LIST_API',
      nextStep: '申请/接入已授权的公众号接口，或由有登录态的执行者人工补采；二维码只能证明身份，不能当作品列表',
    });
  },
  async content() {
    return { status: 'blocked', note: '公众号正文需要已授权接口或人工打开原文。' };
  },
};

export default { douyinAdapter, xiaohongshuAdapter, weiboAdapter, xAdapter, wechatAdapter };

