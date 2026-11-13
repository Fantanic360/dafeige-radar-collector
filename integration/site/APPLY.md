# 站点侧补丁：目标租约 / 运行账本 / 幂等（E5）

**这份补丁没有直接改生产代码。** 本 Agent 没有该 Sites 项目的写入权限，也没有源码 checkout；下面是按 `08_站点接入约定.md` 记录的目录结构写好的可粘贴模块 + D1 迁移 + 接线步骤，由有权限的维护者复核后落地。

## 为什么需要

现在的 `/api/collection` 能拒绝旧状态和重复原链，但**没有目标领取/心跳**。如果同时有两个执行者（定时任务 + 手工会话、或未来多 Agent），会出现：

1. 两个执行者检查同一目标 → 重复请求平台 → 更容易触发风控；
2. 一快一慢，慢的用旧结果覆盖新的 `checkedAt`；
3. 语音/推送在重试时重复调用供应商。

这三件事在单执行者时不会发生，所以不是「已发生的事故」，是**已知的并发缺口**。

## 改动清单

| 文件 | 作用 |
|---|---|
| `migrations/0001_collection_leases.sql` | 三张表：`collection_leases`、`run_ledger`、`idempotency_keys` |
| `lib/lease.ts` | 领取 / 续租 / 释放 / 回收过期（纯 SQL，无外部依赖） |
| `lib/idempotency.ts` | 请求级幂等：同 key 只落一次，回放时返回首次结果 |
| `app/api/collection/lease/route.ts` | `POST /api/collection/lease`：`claim` / `heartbeat` / `release` |
| `app/api/collection/route.ts`（改动） | 在 POST 前校验租约；写入后写账本 |
| `lib/collection.mjs`（改动） | `collectionInstructions` 增加 `lease` 说明，供外部 Agent 读到 |

## 接线 5 步

1. **迁移**：`wrangler d1 execute <DB> --file migrations/0001_collection_leases.sql`（先备份）。
2. **新增路由**：把 `app/api/collection/lease/route.ts` 放到同名路径；它复用现有鉴权中间件，不新开权限。
3. **POST 校验**：在现有 `app/api/collection/route.ts` 的 POST 开头插入：

```ts
const owner = request.headers.get('x-radar-owner');
const leaseOk = owner ? await assertLease(env.DB, body, owner) : true; // 未带 owner 时保持旧行为
if (!leaseOk) return json({ error: 'target lease held by another worker' }, { status: 409 });
```

4. **写账本**：在写入成功后调用 `recordRun(env.DB, { runId, counts })`；失败也写一条，`status='failed'`。
5. **回读**：`GET /api/data` 已经是公开快照，无需改动；`collection.states[].checkedAt` 会被 `verify` 用来核对。

## 验收（照做，别口头宣布）

- [ ] 两个进程同时 `claim` 同一 `targetId`：只有第一个拿到 `200`，第二个 `409` 且带 `holder`。
- [ ] 领取后不续租，10 分钟后第二个进程可 `claim` 成功（过期回收）。
- [ ] 带 `idempotency-key` 重复 POST 同一载荷：第二次返回首次结果，数据库不新增行。
- [ ] 写入失败时 `run_ledger` 有 `status='failed'` 记录，且 `collection.states` 的 `lastSuccessfulAt` 未变。
- [ ] 公开 `/api/data` 不出现 `owner`、令牌、内部队列字段。

## 回滚

只删新增路由与三张表即可；`POST` 校验在 `owner` 头缺失时是放行路径，所以老客户端不受影响。建议先在 staging 环境跑一遍上面 5 条验收。

## 与采集器的对应关系

采集器这边已经在本地实现了同样的语义（`src/lib/state.mjs` 的 `LeaseManager` + `IdempotencyStore`），所以：

- 现在：单机多进程安全，跨机不安全；
- 打了这个补丁：跨机也安全，`x-radar-owner` 由采集器的 `runId` 填充即可。

两边的 TTL 建议一致：租约 10 分钟，心跳 30 秒。
