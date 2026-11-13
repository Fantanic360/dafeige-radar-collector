/**
 * Adapter registry + binding rules.
 *
 * Binding precedence: explicit override in config/adapters.json -> platform default ->
 * URL heuristic. The resolution is logged so "which adapter produced this record" is
 * never a guess.
 */
import bilibiliAdapter from './bilibili.mjs';
import githubAdapter from './github.mjs';
import rssAdapter from './rss.mjs';
import youtubeAdapter from './youtube.mjs';
import xiaoyuzhouAdapter from './xiaoyuzhou.mjs';
import { douyinAdapter, wechatAdapter, weiboAdapter, xAdapter, xiaohongshuAdapter } from './gated.mjs';

export const ADAPTERS = {
  bilibili: bilibiliAdapter,
  github: githubAdapter,
  rss: rssAdapter,
  youtube: youtubeAdapter,
  xiaoyuzhou: xiaoyuzhouAdapter,
  douyin: douyinAdapter,
  xiaohongshu: xiaohongshuAdapter,
  weibo: weiboAdapter,
  x: xAdapter,
  wechat: wechatAdapter,
};

const PLATFORM_DEFAULTS = {
  'B站': 'bilibili',
  GitHub: 'github',
  '官网': 'rss',
  '播客': 'rss',
  Newsletter: 'rss',
  '主站': 'rss',
  YouTube: 'youtube',
  '小宇宙': 'xiaoyuzhou',
  '抖音': 'douyin',
  '小红书': 'xiaohongshu',
  '微博': 'weibo',
  X: 'x',
  '微信公众号': 'wechat',
};

export function resolveAdapter(target) {
  if (target.override?.adapter && ADAPTERS[target.override.adapter]) {
    return { adapter: ADAPTERS[target.override.adapter], reason: 'override' };
  }
  const byPlatform = PLATFORM_DEFAULTS[target.platform];
  if (byPlatform) return { adapter: ADAPTERS[byPlatform], reason: 'platform' };

  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    if (adapter.supports?.(target)) return { adapter, reason: `url:${name}` };
  }
  return { adapter: null, reason: 'unbound' };
}

export function adapterInventory(targets) {
  const counts = {};
  const unbound = [];
  for (const t of targets) {
    const { adapter, reason } = resolveAdapter(t);
    const key = adapter ? `${adapter.name} (${reason})` : 'UNBOUND';
    counts[key] = (counts[key] || 0) + 1;
    if (!adapter) unbound.push(t.id);
  }
  return { counts, unbound };
}
