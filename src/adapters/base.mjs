import { CollectError } from '../lib/core.mjs';
/**
 * Adapter contract.
 *
 * An adapter answers one question: "what did this specific platform profile publish
 * inside the declared window, and how far did I actually get?"
 *
 * Hard rules encoded in the shape below:
 *  - `status: 'success'` means the *list* for the declared window was covered. It never
 *    implies the full text of every item was read (that is `posts[].evidence`).
 *  - a failure must carry `stage` + `nextStep`; "受限" alone is not a report.
 *  - adapters must not invent items. If the platform blocks us, return blocked.
 */

export const VALID_STATUS = new Set(['success', 'retry', 'blocked', 'identity_pending']);

export function emptyResult(target, { windowFrom, windowTo, note = '' } = {}) {
  return {
    status: 'retry',
    note,
    evidenceUrl: target.url,
    windowFrom,
    windowTo,
    pagesRead: 0,
    itemsRead: 0,
    oldestSeenAt: null,
    newestSeenAt: null,
    posts: [],
    contentAttempts: [],
    cursor: null,
  };
}

/** Normalise an adapter return value and fail loudly on contract violations. */
export function validateResult(result, target) {
  const problems = [];
  if (!result || typeof result !== 'object') problems.push('adapter 未返回对象');
  if (result && !VALID_STATUS.has(result.status)) problems.push(`非法 status: ${result?.status}`);
  if (result && typeof result.note !== 'string') problems.push('note 必须是字符串');
  if (result && !Array.isArray(result.posts)) problems.push('posts 必须是数组');
  for (const post of result?.posts || []) {
    if (!post.title || !post.url || !post.publishedAt) problems.push('作品缺少标题/原链/原始日期，应保留为线索');
    if (post.publishedAt && post.publishedAt.includes('T') && (!/(Z|[+-]\d{2}:\d{2})$/.test(post.publishedAt) || !Number.isFinite(Date.parse(post.publishedAt)))) problems.push('精确发布日期必须有真实时区');
    if (post.datePrecision === 'relative' || post.yearInferred) problems.push('相对时间或推测年份不能成为原始发布日期');
    if (post.publishedAt?.includes('T') && result.windowTo && Date.parse(post.publishedAt) > Date.parse(result.windowTo)) problems.push('未来发布日期不能作为当前已发布作品');
  }
  if (result && result.status === 'success' && result.itemsRead === 0 && !result.note.includes('无新')) {
    problems.push('success 但 itemsRead=0 且未说明“无新”');
  }
  if (problems.length) {
    return {
      ok: false,
      result: {
        ...emptyResult(target, { windowFrom: result?.windowFrom, windowTo: result?.windowTo }),
        status: 'retry',
        note: `适配器返回值不合契约：${problems.join('；')}`,
      },
      problems,
    };
  }
  return { ok: true, result, problems: [] };
}

/**
 * Reachability probe with a hard outer deadline.
 *
 * Node's fetch abort does not always cancel DNS resolution, so a 6s timeout can stretch to
 * a minute. A race guarantees the caller gets control back in time to spend the budget on
 * a platform that actually works.
 */
export async function quickProbe(ctx, url, { timeoutMs = 8000, label = url } = {}) {
  let timer;
  const race = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CollectError(`${label} 探测超时（>${timeoutMs}ms）`, { status: 'retry', stage: 'network', code: 'PROBE_TIMEOUT' })), timeoutMs);
  });
  try {
    await Promise.race([ctx.http.request(url, { timeoutMs, retries: 0 }), race]);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/** Build a contentAttempt record for a post whose body could not be obtained. */
export function contentAttempt(postId, { status, note, checkedAt = new Date().toISOString(), evidence }) {
  return { postId, checkedAt, status, note, evidence };
}
