# 适配器说明（ADAPTERS）

## 共同接口

```js
{
  name: 'bilibili',
  requiresBrowser: true,
  supports(target) -> boolean,
  async inspect({ target, source, ctx, windowFrom, windowTo }) -> Result,
  async content({ post, ctx }) -> { status, note, evidence?, transcriptFile? }   // 可选
}
```

`ctx` 提供：`http`（带超时/退避/熔断）、`getBrowser()`（懒启动）、`nowIso()`、`env`、`policy`、`log`、`saveEvidence(name, content)`。

`Result` 必须包含：`status`、`note`、`windowFrom/To`、`pagesRead`、`itemsRead`、`posts[]`、`contentAttempts[]`、`evidenceUrl`、`cursor`。`validateResult()` 会在运行时兜底，返回值不合契约时降级为 `retry` 并写明原因——而不是把脏数据写进库。

## B站

两段式，缺一不可：

1. **渲染层**拿列表（`space.bilibili.com/<mid>/video`，失败回退移动端 `m.bilibili.com/space/<mid>`）。
   服务端 API `/x/space/wbi/arc/search` 即使正确做 WBI 签名也会返回 `-352 风控校验失败`，实测无解，所以不走它。
2. **官方 API** 拿精确时间与身份：`/x/web-interface/view`（`pubdate`、`owner.mid`、`duration`）、`/x/player/v2`（字幕轨、章节）。

- `owner.mid` 与目标主页不一致 → 视为转载，丢弃，不归属作者。
- 字幕轨为空 → `contentAttempt: blocked`，原因写清「官方字幕为空、章节 N 个」，不假装读过。
- 列表卡片里的「5小时前」只作线索，绝不写成 `publishedAt`。

## 抖音 / 小红书 / 微博 / X

同一套「受控平台」逻辑，共享 `gated.mjs`：

1. 渲染个人主页；
2. 提取候选入口（过滤 `source=Baid` / `is_recommend` 这类推荐位链接——它们不是作者作品）；
3. 产不出日期就不许声称覆盖 → `blocked / NO_DATES`；
4. 被重定向到登录页或出现风控文案 → `blocked / RISK_CONTROL` 或 `LOGIN_REQUIRED`；
5. 失败一律落截图 + 页面文本，供人工复核。

这条规则是踩过坑的：早期版本把抖音「推荐」卡片当成作者作品，产出了 8 条完全无关的「新作」。宁可写 blocked。

## 微信公众号

没有公开列表接口。适配器只做两件事：

- 单篇原文可达性探测（被删/违规/环境异常会明说）；
- 明确返回「缺少 ghid 与已授权接口」。

二维码只能证明身份，永远不能当作品列表。

## RSS / Atom

- 解析器是正则实现，不引第三方 XML 库，不做外部实体展开（无 XXE 面）。
- 源发现顺序：`config` 里写死 → 页面 `<link rel="alternate">` → 常见路径。
- 源只输出 1–3 条时，`note` 会注明「覆盖有限，不能据此判断没有更新」。

## GitHub

- 优先按 `config/adapters.json` 里 pin 的仓库读 releases；未 pin 则取账号最近 push 的 8 个非 fork 仓库。
- 有正文（>400 字）记 `fulltext`，否则 `metadata`。
- 匿名限额 60 次/小时；有 `GITHUB_TOKEN` 时自动带上。

## 小宇宙

页面 `__NEXT_DATA__` 里同时有单集列表、精确 `pubDate` 和节目简介。简介 >400 字记 `fulltext`，但会注明「简介不等于整集音频已听」。

## YouTube

频道页解析 `channelId` → 官方频道 RSS。RSS 只给元数据，字幕需要另外的合法渠道，因此 `content` 直接返回 blocked。

## 新增一个平台

1. 在 `src/adapters/` 建文件，实现 `inspect`（必须能回答「读到了什么、读到哪、为什么没读到」）；
2. 在 `registry.mjs` 注册并补 `PLATFORM_DEFAULTS`；
3. 加一个 `test/unit` 用例覆盖它的时间/去重边界；
4. 用 `--only <sourceId> --force --dry-run` 跑一次真实目标，把 `result.json` 作为证据留在交接包里。

不要为了「看起来支持」而写一个只返回 success 的空适配器——那正是交接包里批评的做法。
