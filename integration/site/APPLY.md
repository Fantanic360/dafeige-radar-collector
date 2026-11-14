# 站点租约与幂等补丁：待生产接线

状态：**模板已修复并通过离线并发测试，尚未部署。不能直接复制后宣称跨机安全。**

2026-11-14 复核修正了原版的三个问题：租约原先先 SELECT 再无条件 UPSERT，两个执行者可能都成功；幂等键原先在副作用之后才写入，会重复执行；路由原先假定 process.env.DB 且没有实际鉴权调用。

## 已实现

- `lib/lease.ts` 用单条条件 UPSERT 领取，只有到期或同 owner 能写入；心跳不能复活已过期租约。
- `assertLeases` 对缺失、过期和其他 owner 的租约都拒绝。
- `lib/idempotency.ts` 在副作用前原子预留带 scope 的 key。并发请求返回冲突；发生异常保留预留，待核对实际结果后人工处理，不自动重做未知结果的配音或写入。
- `app/api/collection/lease/route.ts` 提供 `createLeaseHandler({authorize,getDb})`，鉴权在解析请求与访问数据库之前。模板默认 POST 返回 503，防止未接线即启用。
- D1 迁移只新增三张表。当前采集器仍只使用本地租约，尚未调用本站领取/心跳/释放路由。

## 接线前必须确认

1. 使用本站实际鉴权函数及 Worker D1 binding 获取方式；不能假设环境变量是 D1 对象。将 handler 绑定到既有受保护路由。
2. 将 `assertLeases(db, body.observations, owner)` 放到 collection 写入前，并检查返回值 `.ok`。只有明确迁移策略时才能兼容无 owner 客户端；无 owner 放行不能称作全面并发互斥。
3. 采集器同步实现远端领取、心跳、释放；应在发布结果之前一直持有有效租约。本地文件锁不能替代跨主机租约。
4. `withIdempotency` 包裹实际事务/副作用，并把 `IDEMPOTENCY_IN_PROGRESS` 映射为 HTTP 409。预留键卡住时先核验已提交结果，不能盲目删键重试。
5. 不把内部 owner、凭据、账本字段导出到公开镜像。

示例（函数名称须替换为本站已有实现）：

```ts
export const POST = createLeaseHandler({
  authorize: request => existingSiteAuthorization(request),
  getDb: request => existingSiteDatabase(request),
});

const leaseResult = await assertLeases(db, body.observations, owner);
if (!leaseResult.ok) return Response.json({ error: 'lease conflict' }, { status: 409 });
```

## 验收

离线模块验证：Node 24 执行 `node --test test/unit/site-integration.test.mjs`，使用内存 SQLite，不调用外网。

生产接线后仍需验证：并发 claim 只有一个成功；过期后接管；缺失租约不能写入；重复 key 只执行一次；失败结果有账本；公开镜像不出现内部字段；旧任务按迁移策略继续工作。通过前保持模板禁用，不创建第二套定时任务。
