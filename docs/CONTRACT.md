# 与站点的契约（CONTRACT）

本文件是**代码实际发送的内容**的说明，不是愿望清单。字段名与 `08_站点接入约定.md` 对齐。

## 1. 两种后端

| 模式 | 触发条件 | 能做什么 |
|---|---|---|
| `editorial` | `RADAR_EDITORIAL_BASE` + `RADAR_EDITORIAL_TOKEN` | GET 队列、POST 观测/作品/正文尝试、POST 来源资料 |
| `mirror`（默认） | 只有 `RADAR_PUBLIC_BASE` | 只读 `/api/data`；用其中的 `collection.states` 当队列，产出本地结果包 |

公开镜像已经包含 `collection.states` 和 `collection.posts`，所以**没有写权限也能正确排期**——这对交接场景很重要：外部 Agent 先交资料，不直接写生产。

## 2. 目标键

```
targetId = `${sourceId}::${encodeURIComponent(profileUrl)}`
```

与站点 `collection.states[].id` 完全一致。写错一个字符，状态就会写到另一行，所以有单测盯着。

## 3. 观测 observations

```json
{
  "sourceId": "ksr",
  "platform": "B站",
  "url": "https://space.bilibili.com/1848018",
  "checkedAt": "2026-11-13T16:30:56.989Z",
  "windowFrom": "2026-11-06T16:30:56.989Z",
  "windowTo": "2026-11-13T16:30:56.989Z",
  "status": "success | retry | blocked | identity_pending",
  "note": "人话 + 阶段 + 下一步",
  "evidenceUrl": "https://space.bilibili.com/1848018/video",
  "cursor": { "lastBvid": "BV12oWi6VEzP", "mid": "1848018" }
}
```

- `success`：**只**表示声明窗口内的列表已覆盖。
- `blocked` / `identity_pending`：不再自动重试，进 `needsAttention`。
- `retry`：按 2/4/8/16/24 小时退避，成功游标保持不变。

本地额外字段（`adapter`、`pagesRead`、`itemsRead`、`oldestSeenAt`、`newestSeenAt`）写在 `result.json` 的 `inspections` 里，便于审计；不进入站点核心字段。

## 4. 作品 posts

```json
{
  "id": "ksr-bilibili-BV12oWi6VEzP",
  "sourceId": "ksr",
  "platform": "B站",
  "url": "https://www.bilibili.com/video/BV12oWi6VEzP",
  "title": "新人入坑必看！原来AI视频还能这样做？",
  "publishedAt": "2026-11-13T10:30:00.000Z",
  "discoveredAt": "2026-11-13T16:30:56.989Z",
  "evidence": "metadata | fulltext | transcript | visual",
  "evidenceUrl": "https://api.bilibili.com/x/web-interface/view?bvid=BV12oWi6VEzP",
  "evidenceNote": "官方 view 接口 pubdate…；列表标签仅作参考",
  "duration": 1640
}
```

- `id` 由 `sourceId + platform + platformPostId` 决定，跨运行稳定（重跑不新增重复行）。
- `publishedAt` 只能是「带时区精确时刻」或「日期」或 `null`，三者之外没有第四种。
- `evidence` 升级只升不降：`metadata → fulltext/transcript`。

## 5. 正文尝试 contentAttempts

```json
{ "postId": "ksr-bilibili-BV12oWi6VEzP", "checkedAt": "...", "status": "verified|retry|blocked", "note": "官方字幕轨为空；章节 0 个…" }
```

元数据刷新**不会**重置正文失败计数（有单测）。

## 6. 幂等

推送前计算：

```
key = sha1(stableStringify({ obs: [sourceId|platform|status|windowTo...], posts: [id...] }))
```

- 写进 `state/idempotency.json` 后才发送，成功后保留；同载荷重放直接跳过。
- 同时作为 `idempotency-key` 请求头发给站点，给服务端留出二次去重的机会。

## 7. 回读校验

`verify` 读公开 `/api/data`，逐目标比对：

- 站点 `collection.states[].checkedAt` 与本地是否在 6 小时内一致（推送是否落地）；
- 本地每篇作品的 `publishedAt` 是否与站点一致（时间没有被改写）。

不一致不会被「修掉」，只会被报告——因为改写时间正是这个系统最怕的错误。
