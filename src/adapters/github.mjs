/**
 * GitHub adapter.
 *
 * The signal that matters for these authors is an actual release, not a `git push`:
 * release notes are first-party text with a real timestamp and are safe to quote.
 *
 * Two modes:
 *  - `repos: ["owner/name"]` pinned in config -> watch only those (precise, low noise)
 *  - otherwise -> list the account's recently pushed repos, then read their releases
 */
import { CollectError } from '../lib/core.mjs';
import { emptyResult } from './base.mjs';
import { canonicalUrl, parsePublished } from '../lib/normalize.mjs';

const API = 'https://api.github.com';

export function loginFromUrl(url) {
  const m = String(url).match(/github\.com\/([^/?#]+)/i);
  return m ? m[1] : null;
}

function headers(ctx) {
  const h = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (ctx.env?.githubToken) h.authorization = `Bearer ${ctx.env.githubToken}`;
  return h;
}

async function reposFor(ctx, login, override) {
  if (Array.isArray(override?.repos) && override.repos.length) return override.repos;
  const list = await ctx.http.json(`${API}/users/${login}/repos?per_page=20&sort=pushed`, {
    headers: headers(ctx),
  });
  if (!Array.isArray(list)) {
    throw new CollectError('GitHub 仓库列表返回异常', {
      status: 'retry',
      stage: 'api',
      nextStep: '检查是否触发未认证速率限制（60/h）',
    });
  }
  return list.filter((r) => !r.fork && !r.archived).slice(0, 8).map((r) => r.full_name);
}

export const githubAdapter = {
  name: 'github',
  requiresBrowser: false,
  supports(target) {
    return target.platform === 'GitHub' || /github\.com/i.test(target.url || '');
  },

  async inspect({ target, ctx, windowFrom, windowTo }) {
    const result = emptyResult(target, { windowFrom, windowTo });
    const login = loginFromUrl(target.url);
    if (!login) {
      throw new CollectError('无法解析 GitHub 账号名', {
        status: 'identity_pending',
        stage: 'parse',
        nextStep: '确认主页 URL 为 github.com/<login>',
      });
    }

    const repos = await reposFor(ctx, login, target.override);
    const posts = [];
    let newest = null;
    let oldest = null;
    let releaseCount = 0;

    for (const fullName of repos) {
      let releases;
      try {
        releases = await ctx.http.json(`${API}/repos/${fullName}/releases?per_page=5`, {
          headers: headers(ctx),
        });
      } catch (err) {
        continue; // a single repo 404/permission issue must not fail the account
      }
      if (!Array.isArray(releases)) continue;
      releaseCount += releases.length;

      for (const rel of releases) {
        const parsed = parsePublished(rel.published_at);
        const ms = parsed.publishedAt ? new Date(parsed.publishedAt).getTime() : null;
        if (!ms) continue;
        if (!newest || ms > newest) newest = ms;
        if (!oldest || ms < oldest) oldest = ms;
        if (ms < new Date(windowFrom).getTime() || ms > new Date(windowTo).getTime()) continue;

        const body = String(rel.body || '');
        posts.push({
          id: `${target.sourceId}-github-${fullName.replace('/', '-')}-${rel.tag_name}`,
          sourceId: target.sourceId,
          platform: 'GitHub',
          url: canonicalUrl(rel.html_url),
          title: rel.name || rel.tag_name,
          publishedAt: parsed.publishedAt,
          datePrecision: 'second',
          discoveredAt: ctx.nowIso(),
          evidence: body.length > 400 ? 'fulltext' : 'metadata',
          evidenceUrl: `${API}/repos/${fullName}/releases`,
          evidenceNote: `GitHub 官方 API published_at=${rel.published_at}（=${parsed.publishedAt}）；${
            body.length > 400 ? `完整发布说明 ${body.length} 字已读` : `发布说明仅 ${body.length} 字`
          }。仓库 ${fullName}，tag ${rel.tag_name}。`,
          platformPostId: `${fullName}@${rel.tag_name}`,
          extra: { repo: fullName, tag: rel.tag_name, bodyChars: body.length, body: body.slice(0, 2000) },
        });
      }
    }

    result.status = 'success';
    result.pagesRead = repos.length;
    result.itemsRead = releaseCount;
    result.oldestSeenAt = oldest ? new Date(oldest).toISOString() : null;
    result.newestSeenAt = newest ? new Date(newest).toISOString() : null;
    result.posts = posts;
    result.evidenceUrl = `https://github.com/${login}`;
    result.cursor = { login, repos };
    result.note =
      `已读 GitHub 账号 ${login} 的 ${repos.length} 个公开仓库、共 ${releaseCount} 条 release，` +
      `窗口 ${windowFrom} → ${windowTo} 内 ${posts.length} 条。GitHub 只反映代码发布，不等于该作者的视频/文章更新。`;
    return result;
  },

  async content({ post, ctx }) {
    const body = post.extra?.body;
    if (body && body.length > 400) {
      const file = await ctx.saveEvidence(`${post.id}.md`, body);
      return { status: 'verified', note: `发布说明已入库（${body.length} 字）`, evidence: 'fulltext', transcriptFile: file };
    }
    return { status: 'blocked', note: '该 release 没有正文说明，仅有 tag 元数据；不做内容推荐。' };
  },
};

export default githubAdapter;
