# 运行手册（RUNBOOK）

面向每天都在跑这个任务的人。所有命令都在仓库根目录执行。

## 0. 一页速查

```bash
node src/cli.mjs doctor                 # 出问题先跑这个
node src/cli.mjs plan                   # 看这一轮打算做什么
node src/cli.mjs run                    # 跑一轮
node src/cli.mjs verify                 # 推送后回读公开镜像
node src/cli.mjs history --limit 5      # 最近几轮的账本
node --test test/unit/*.test.mjs        # 32 秒内确认逻辑没坏
```

退出码：`0` 正常、`1` 有目标未达标（可继续用）、`2` 配置/环境错误、`130` 被中断。

## 1. 首次部署

1. 装 Node ≥ 24；只在获准的独立执行环境使用浏览器层。
2. 运行时传入配置；本站服务凭据不得写入 `.env`、配置、日志或仓库：
   - `RADAR_PUBLIC_BASE`：公开阅读台（默认已填）。
   - `RADAR_EDITORIAL_BASE` / `RADAR_EDITORIAL_TOKEN`：**只有拿到写权限才填**；不填就是只读模式。
   - `GITHUB_TOKEN`：可选，只读公开仓库也能跑（匿名 60 次/小时）。
3. `node src/cli.mjs doctor`，确认：
   - `config.sourcesValid = true`，`unboundTargets = []`
   - `browser.ok = true`（若为 false，浏览器类平台会全部 blocked）
   - `network.site.checks.public.ok = true`
4. `node src/cli.mjs run --dry-run --only ksr` 做一次单点演练，看 `evidence/<runId>/result.json`。

## 2. 每轮会发生什么

1. 读站点队列（有凭据读采编端，否则读公开镜像的 `collection.states`）；
2. 与本地状态合并（站点为准，本地补站点没见过的工作）；
3. 按策略选目标：从未检查 → 主平台 → 最久未查，按平台交错，非 10:00 轮最多 8 个；
4. 逐目标：取租约 → 适配器读取 → 归一化 → 落状态 → 写证据；
5. 补采正文队列（默认 4 条/轮）；
6. 生成 `payload.json`（站点契约）与 `result.json`（对接包的交换格式）；
7. 有写权限且载荷未推过 → 推送；否则只落盘；
8. 写账本 `state/runs/*.json` 与 `state/events.jsonl`。

## 3. 常见故障

| 现象 | 判断 | 处理 |
|---|---|---|
| `LockError: 另一个采集进程正在运行` | 上一轮还在跑，或进程被杀留下锁 | 等；或确认无进程后删 `state/.run.lock`（超过 45 分钟会自动接管） |
| 某平台整轮 blocked | 登录墙 / 风控 / 网络不可达 | 看 `evidence/<runId>/*_blocked.txt` 与截图；需要授权会话就交给有账号的人补采，**不要**把 blocked 改成成功 |
| B站 `EMPTY_LIST` | 渲染层没拿到列表（限流或改版） | 15 分钟后重试；连续出现就检查 `CARD_SCRIPT` 选择器 |
| 站点 403 | Cloudflare 拦截直连 | 已内置浏览器同源回退；若仍失败，`doctor` 会显示 `via: browser` 是否生效 |
| 推送 401/403 | 令牌无效或无写权限 | 修令牌；不要用公开镜像地址当采编端 |
| `verify` 大量 `ok: false` | 推送没成功，或镜像还没同步 | 先看 `pushResult`，再等镜像同步（分钟级） |

## 4. 中断与恢复

- `Ctrl-C` / `SIGTERM`：做完当前目标、释放租约与锁、写账本后退出，退出码 130。
- `kill -9`：锁会在 45 分钟后过期；租约 10 分钟过期；下次运行自动接管，不会重复推进成功游标。
- 断网：本轮剩余目标标 retry 并按 2 小时起退避，不会把「没读到」写成「没有更新」。

## 5. 验收（交接包要求的 3 天表）

每轮结束后从账本直接生成：

```bash
node -e "
const {RunLedger}=await import('./src/lib/ledger.mjs');
for (const r of RunLedger.listRuns('./state', 30)) {
  console.log([r.startedAt, r.endedAt, r.edition?'10点轮':'补采', r.counts.planned, r.counts.success, r.counts.blocked, r.counts.newPosts].join('\t'));
}" --input-type=module
```

验收标准（做不到就如实写没做到）：
- 至少连续 3 天有记录，其中含 10:00 出刊轮与至少一次非 10:00 补采；
- 指定作者的新作在声明时限内被发现；
- 失败窗口不被跳过（`nextDueAt` 有值且到点会重试）；
- 10 点文章完成后只生成一次语音（由采编端保证，本仓库只保证不重复推送同一载荷）。

## 6. 改了配置之后

- 只改 `config/*.json`：不用重新部署，下一轮生效。
- 改代码：先 `node --test test/unit/*.test.mjs test/e2e/*.test.mjs`，再 `doctor`，再 `run --dry-run --only <一个来源>`。
- 新增来源：先确认 `sourceId` 与站点一致，再进 `config/sources.json`；站点侧没核实的账号不要写 `status: verified`。
