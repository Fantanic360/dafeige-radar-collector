#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   radar-collect doctor              environment / config / reachability report
 *   radar-collect plan                what the next round would do, without doing it
 *   radar-collect run [--dry-run]     execute one round
 *   radar-collect verify              read the public mirror back
 *   radar-collect history             list recent run ledgers
 *   radar-collect inventory           adapter binding table per target
 *
 * Exit codes: 0 ok, 1 partial failure, 2 configuration/environment error, 130 interrupted.
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createLogger, beijingIso, readJson } from './lib/core.mjs';
import { configExists, DEFAULT_PATHS, loadEnv, loadJsonConfig, validateSources, buildTargets } from './lib/config.mjs';
import { createHttpClient } from './lib/http.mjs';
import { SiteClient } from './lib/site-client.mjs';
import { adapterInventory, resolveAdapter } from './adapters/registry.mjs';
import { isEditionRound, planRound } from './lib/policy.mjs';
import { Runner } from './lib/runner.mjs';
import { Browser, findChrome } from './browser/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function usage() {
  return `大飞哥每日大报 · 采集引擎

用法:
  node src/cli.mjs doctor                环境/配置/连通性检查
  node src/cli.mjs plan [--only a,b]     只看本轮会做什么
  node src/cli.mjs run [--dry-run]       执行一轮
  node src/cli.mjs verify                回读公开镜像
  node src/cli.mjs inventory             每个目标的适配器绑定
  node src/cli.mjs history [--limit 10]  最近运行账本

环境变量:
  RADAR_PUBLIC_BASE      公开阅读台地址
  RADAR_EDITORIAL_BASE   采编端地址（可写）
  RADAR_EDITORIAL_TOKEN  采编端令牌（只从环境读取，不落盘）
  RADAR_BROWSER_TIER     1/0 是否启用浏览器层
  RADAR_DRY_RUN          1 等价于 --dry-run
  RADAR_STATE_DIR        状态目录（默认 ./state）
`;
}

async function cmdDoctor(env, log) {
  const report = {
    at: beijingIso(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    root: ROOT,
    config: {},
    browser: {},
    network: {},
    secrets: {},
  };

  report.config.sourcesExists = configExists();
  if (report.config.sourcesExists) {
    const doc = loadJsonConfig('sources.json');
    const v = validateSources(doc);
    report.config.sourcesValid = v.ok;
    report.config.problems = v.problems;
    report.config.sources = doc.sources.length;
    report.config.enabled = doc.sources.filter((s) => s.enabled).length;
    const targets = buildTargets(
      doc,
      loadJsonConfig('adapters.json', { fallback: { overrides: {} } }),
      loadJsonConfig('targets.extra.json', { fallback: { targets: [] } }),
    );
    report.config.targets = targets.length;
    const inv = adapterInventory(targets);
    report.config.adapterBindings = inv.counts;
    report.config.unboundTargets = inv.unbound;
  }

  report.browser.chromePath = findChrome();
  let browser = null;
  if (env.browserTier && report.browser.chromePath) {
    try {
      browser = await Browser.launch({ timeoutMs: 25_000 });
      report.browser.ok = true;
      report.browser.version = browser.version;
    } catch (err) {
      report.browser.ok = false;
      report.browser.error = err.message;
    }
  } else {
    report.browser.ok = false;
    report.browser.note = env.browserTier ? '未找到 Chrome/Chromium' : '浏览器层被禁用';
  }

  const http = createHttpClient({ timeoutMs: 15_000, retries: 1 });
  const site = new SiteClient({ env, http, getBrowser: browser ? async () => browser : null });
  report.network.site = await site.health();
  if (browser) await browser.close();

  report.secrets = {
    editorialToken: Boolean(env.editorialToken),
    githubToken: Boolean(env.githubToken),
    note: '只报告是否存在，不输出值',
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const fatal = !report.config.sourcesValid || report.config.problems?.length;
  return fatal ? 2 : 0;
}

async function cmdPlan(env, log, args) {
  const sourcesDoc = loadJsonConfig('sources.json');
  const adapterDoc = loadJsonConfig('adapters.json', { fallback: { overrides: {} } });
  const extraDoc = loadJsonConfig('targets.extra.json', { fallback: { targets: [] } });
  const targets = buildTargets(sourcesDoc, adapterDoc, extraDoc);
  const stateDir = path.join(ROOT, 'state');
  const state = readJson(path.join(stateDir, 'state.json'), { targets: {} }) || { targets: {} };

  const edition = isEditionRound(new Date(), { editionHour: 10 });
  const cap = edition ? 100 : 8;
  const only = args.only ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const plan = planRound({ targets, states: state.targets || {}, now: new Date(), cap, onlySourceIds: only });

  const rows = plan.selected.map((t, i) => {
    const { adapter, reason } = resolveAdapter(t);
    const st = state.targets?.[t.id] || {};
    return {
      n: i + 1,
      target: `${t.sourceId} / ${t.platform}`,
      adapter: adapter ? `${adapter.name}${adapter.requiresBrowser ? ' (browser)' : ''}` : 'UNBOUND',
      binding: reason,
      lastStatus: st.status || 'never',
      nextDueAt: st.nextDueAt || null,
      primary: t.primary,
    };
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        at: beijingIso(),
        edition,
        cap,
        considered: plan.considered,
        selected: plan.selected.length,
        deferred: plan.deferred.length,
        planned: rows,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function cmdRun(env, log, args) {
  const dryRun = Boolean(args['dry-run']) || env.dryRun;
  const force = Boolean(args.force);
  const cap = args.cap ? Number(args.cap) : null;
  const only = args.only ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const runner = new Runner({ env, logger: log, rootDir: ROOT });

  const onSignal = async (sig) => {
    if (runner.aborted) return;
    runner.aborted = true;
    log.warn(`收到 ${sig}，完成当前目标后退出`);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  try {
    const out = await runner.runOnce({ dryRun, onlySourceIds: only, force, cap });
    log.info('本轮结束', {
      runId: out.runId,
      targets: out.payload.observations.length,
      posts: out.payload.posts.length,
      push: out.pushResult.skipped ? `skipped(${out.pushResult.reason})` : 'ok',
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          runId: out.runId,
          evidenceDir: path.relative(ROOT, out.evidenceDir),
          ledger: path.relative(ROOT, out.ledgerFile),
          summary: out.summary,
          pushResult: out.pushResult,
          counts: out.payload.observations.length,
        },
        null,
        2,
      )}\n`,
    );
    return runner.aborted ? 130 : 0;
  } finally {
    await runner.close();
  }
}

async function cmdVerify(env, log) {
  const runner = new Runner({ env, logger: log, rootDir: ROOT });
  try {
    const out = await runner.verify();
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    const failed = out.targetChecks.filter((c) => !c.ok).length;
    return failed ? 1 : 0;
  } finally {
    await runner.close();
  }
}

function cmdInventory(env, log) {
  const sourcesDoc = loadJsonConfig('sources.json');
  const adapterDoc = loadJsonConfig('adapters.json', { fallback: { overrides: {} } });
  const extraDoc = loadJsonConfig('targets.extra.json', { fallback: { targets: [] } });
  const targets = buildTargets(sourcesDoc, adapterDoc, extraDoc);
  const rows = targets.map((t) => {
    const { adapter, reason } = resolveAdapter(t);
    return {
      targetId: t.id,
      source: t.sourceName,
      platform: t.platform,
      primary: t.primary,
      adapter: adapter?.name || 'UNBOUND',
      binding: reason,
      requiresBrowser: Boolean(adapter?.requiresBrowser),
    };
  });
  const inv = adapterInventory(targets);
  process.stdout.write(`${JSON.stringify({ totals: inv.counts, unbound: inv.unbound, targets: rows }, null, 2)}\n`);
  return 0;
}

function cmdHistory(env, log, args, RunLedger) {
  const runs = RunLedger.listRuns(path.join(ROOT, 'state'), Number(args.limit) || 10);
  process.stdout.write(
    `${JSON.stringify(
      runs.map((r) => ({
        file: path.basename(r.file),
        runId: r.runId,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        edition: r.edition,
        planned: r.plan?.selected,
        counts: r.counts,
        push: r.result?.push,
      })),
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  const env = loadEnv();
  const log = createLogger({ level: args.verbose ? 'debug' : env.logLevel });

  if (cmd === 'help' || args.help) {
    process.stdout.write(usage());
    return 0;
  }

  if (cmd === 'history') {
    const { RunLedger } = await import('./lib/ledger.mjs');
    return cmdHistory(env, log, args, RunLedger);
  }

  switch (cmd) {
    case 'doctor':
      return cmdDoctor(env, log);
    case 'plan':
      return cmdPlan(env, log, args);
    case 'run':
      return cmdRun(env, log, args);
    case 'verify':
      return cmdVerify(env, log);
    case 'inventory':
      return cmdInventory(env, log);
    default:
      process.stderr.write(`未知命令：${cmd}\n\n${usage()}`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`失败：${err?.stack || err}\n`);
    process.exit(2);
  });
