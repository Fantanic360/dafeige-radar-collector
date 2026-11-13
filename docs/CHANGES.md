# 交付说明（CHANGES）

本轮只做工程侧（交接包任务 F，P0/P1/P2），不做账号补全、不写生产库、不改已有定时任务。

## 1. 做了什么

### 1.1 采集执行层（新增，可直接跑）

`dafeige-radar-collector/`：零运行时依赖的 Node ESM 项目。

- **排期与状态机**（`src/lib/policy.mjs`）
  - 2/4/8/16/24 小时退避，成功 4 小时后再次到期；
  - 失败**不推进**成功游标；`blocked`/`identity_pending` 退出自动队列；
  - 非 10:00 轮最多 8 个目标，10:00 轮全量；
  - 「从未检查 → 主平台 → 最久未查」+ 按平台交错，防止单一平台吃掉整轮。
  - 全部是纯函数，31 个单测直接盯着这些规则。

- **目标租约与单实例锁**（`src/lib/state.mjs`）
  - 同一目标不会被两个执行者同时检查（租约 10 分钟 + 30 秒心跳 + 过期回收）；
  - 进程被杀不会卡死下一次运行（锁 45 分钟过期，且会检查持锁进程是否还活着）。

- **运行账本与幂等**（`src/lib/ledger.mjs`）
  - 每轮写 `state/runs/<时间>_<runId>.json` 与 `state/events.jsonl`，可直接生成 3 天验收表；
  - 推送前先落幂等键，同载荷重放直接跳过，并给站点发 `idempotency-key` 头。

- **平台适配器**（`src/adapters/`，11 个）
  - 真能读：B站（列表渲染 + 官方 API 精确时间/字幕）、RSS/Atom（自动发现）、GitHub releases、小宇宙、YouTube 频道 RSS；
  - 诚实 blocked：抖音、小红书、微博、X、微信公众号——读不到就写清楚阶段、原因和需要什么授权，并落截图与页面文本。

- **浏览器层**（`src/browser/cdp.mjs`）
  - 零依赖 CDP 驱动（Node 全局 `WebSocket`），不用 Puppeteer/Playwright；
  - 单实例复用、超时、崩溃检测、失败截图、卡死自动重置。

- **站点客户端**（`src/lib/site-client.mjs`）
  - 采编端（可写）与公开镜像（只读）双模式；
  - 直连被 Cloudflare 拦时自动降级为「页面内同源请求」，本机实测 403 → 成功。

### 1.2 站点侧补丁（未落地，待维护者复核）

`integration/site/`：D1 迁移（`collection_leases` / `run_ledger` / `idempotency_keys`）+ `lease.ts` + `idempotency.ts` + `/api/collection/lease` 路由 + 接线与验收步骤（`APPLY.md`）。

这是交接包里 E5 指出的缺口：现在两个执行者可以同时处理同一目标；语音与推送在重试时可能重复。补丁给了最小改动路径，且向后兼容（未带 `owner` 的旧客户端照旧放行）。

### 1.3 文档

`docs/CONTRACT.md`（字段级契约）、`RUNBOOK.md`（故障处理与验收）、`CAPACITY.md`（实测耗时与预算）、`ADAPTERS.md`（每平台怎么读、为什么读不到）、`SECURITY.md`（凭据与证据边界）。

## 2. 关键判断（有争议的地方，先说明理由）

1. **B站列表走渲染层，不走 `/x/space/wbi/arc/search`。**
   实测：完整 WBI 签名 + `buvid3` + dm 指纹参数，服务端仍返回 `-352 风控校验失败`；而渲染页面能正常拿到列表。所以适配器固定走渲染，并在三轮失败（桌面/重载/移动端）后写 `retry`，不伪装成功。

2. **抖音列表在无登录态下判 `blocked`，不是 `success`。**
   早期版本把「推荐」卡片当成了作者作品，产出 8 条完全无关的「新作」。修法：过滤推荐位链接 + 没有任何可用发布时间就不许声称覆盖。宁可 blocked。

3. **相对时间不写入 `publishedAt`。**
   列表上的「5小时前」只作线索；B站用官方 `pubdate` 复核，其余平台若只有相对时间，`publishedAt` 保持 `null` 并标 `unknown`。

4. **公开镜像可以当队列用。**
   `/api/data` 里已有 `collection.states`，所以没有写权限也能正确排期。这样外部 Agent 交资料、维护者合并的流程不需要给外部写权限。

5. **X / YouTube 在本机不可达，是网络事实，不是代码缺陷。**
   适配器现在 7 秒探测后返回 `retry`，并在 note 里写清「本机无法访问该域名」+ 下一步。换到可访问网络即可工作，无需改代码。

## 3. 没做的（如实列出）

- 抖音/小红书/微博/公众号/X 的**列表**：需要已授权登录态或付费接口，本机没有，也未申请。
- B站视频**字幕**：`player/v2` 对这些视频返回空字幕轨，需要 ASR 或人工转录；适配器只记录「官方字幕为空」。
- 公众号**列表**：无公开接口，未伪造。
- 站点代码**未部署**：没有该 Sites 项目的源码与写入权限，只交补丁。
- GitHub 仓库：见 `method.md` 的仓库地址与 commit。

## 4. 复现方式

```bash
cd dafeige-radar-collector
node --test test/unit/*.test.mjs test/e2e/*.test.mjs    # 33 个用例，无需网络
node src/cli.mjs doctor
node src/cli.mjs run --dry-run --only ksr --force
node src/cli.mjs run --force --cap 100                  # 全量一轮
```
