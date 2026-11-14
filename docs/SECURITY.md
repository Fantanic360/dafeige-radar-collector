# 安全与证据边界（SECURITY）

## 1. 凭据

- 只从环境变量读取：`RADAR_EDITORIAL_TOKEN`、`GITHUB_TOKEN`。
- Site 凭据只在当前任务内存和进程环境中使用，不写 `.env` 或任何持久文件；只发送到对应采编 origin 的 `OAI-Sites-Authorization` 请求头。
- 公开镜像无凭据；认证请求禁止跨来源跳转，禁止浏览器脚本回退。
- 不写日志、不写状态文件、不进 payload；`doctor` 只输出 `true/false`。
- 浏览器层使用**独立临时 profile**（`/tmp/radar-cdp-*`），进程结束即删；不读取、不导出任何 Cookie。
- `.gitignore` 排除 `.env`、`state/`、`evidence/`；`scripts/selfcheck.mjs` 会在提交前扫描常见令牌、私钥、签名 URL 与 B站 Cookie 形态。

## 2. 抓取伦理与边界

- 不绕过登录、验证码、人机校验，不更换指纹、代理或网络路径规避平台或执行环境限制。明确出现人机验证后停止该站点自动探测。
- 不把「打不开」写成「没有更新」，不把「搜索无结果」写成「没有账号」。
- 频控：同主机并发 2、最小间隔 350ms，429 时按 `Retry-After` 退避，连续失败熔断。
- 引用内容按原文标注来源 URL 与读取时间；转述与原文不混。

## 3. 证据文件

失败时写出（已脱敏）：

```
evidence/<runId>/
  result.json          交换格式结果（含每目标 status / 覆盖区间 / 原因 / 下一步）
  payload.json         准备写回站点的载荷
  <platform>_blocked.txt   页面标题 + 可见文本 + 候选入口清单
  .<platform>_blocked.png  截图（点号开头，避免被当成正式交付物）
  <postId>.srt/.txt/.md    字幕或正文（仅在真正取得时）
```

这些目录默认不入库；交接时按需挑选，且必须先跑一次脱敏检查：

```bash
grep -rInE "gh[pousr]_[A-Za-z0-9]{20,}|SESSDATA=|buvid3=|X-Amz-Signature|BEGIN .*PRIVATE KEY" evidence/ || echo "clean"
```

## 4. 已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 页面为空或访问受限 | 无法证明列表覆盖 | 区分加载失败与明确人机验证；后者停止，不探测同站替代路径 |
| 代理/地区限制 | X、YouTube 不可达 | 6–7 秒快速探测后返回 retry，不烧整轮预算 |
| 本地状态被误删 | 未推送工作可能丢失 | 已入库内容可从采编恢复；未推送载荷和证据须先核对再清理 |
| 并发跑两份 | 重复推送 | 同机单实例锁；跨机需完成 integration/site 的真实接线与验收 |
| 磁盘写满 | 运行失败 | 证据按 runId 分目录，便于按天清理；`logs/` 也建议定期轮转 |
