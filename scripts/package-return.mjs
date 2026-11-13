#!/usr/bin/env node
/**
 * 打包回传包。
 *
 *   node scripts/package-return.mjs [--out <dir>] [--run <runId>]
 *
 * 产物结构（刻意扁平，方便对方直接看）：
 *   00_先读这里.md
 *   result.json            04 交换格式（取最近一次运行的结果）
 *   method.md              方法与边界
 *   CHANGES.md             改动说明
 *   code/                  采集器源码（不含 state/evidence/日志/密钥）
 *   evidence/<runId>/      最近一次真实运行的证据
 *   acceptance/            容量与账本汇总
 *   secret-scan.txt
 *   checksums.sha256
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const outDir = path.resolve(argOf('out', path.join(ROOT, '..', 'return-package')));
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const pkgName = `dafeige-agent-return-${stamp}`;
const pkgDir = path.join(outDir, pkgName);

function copyTree(from, to, skip = new Set()) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst, skip);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function latestRun() {
  const dir = path.join(ROOT, 'evidence');
  if (!fs.existsSync(dir)) return null;
  const runs = fs.readdirSync(dir).filter((d) => d.startsWith('run_'));
  if (!runs.length) return null;
  runs.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return runs[0];
}

const runId = argOf('run', latestRun());
if (!runId) {
  console.error('没有可打包的运行结果：先跑 node src/cli.mjs run --force --cap 100');
  process.exit(2);
}

fs.rmSync(pkgDir, { recursive: true, force: true });
fs.mkdirSync(pkgDir, { recursive: true });

/* code */
copyTree(ROOT, path.join(pkgDir, 'code', 'dafeige-radar-collector'), new Set(['state', 'evidence', 'logs', 'node_modules', '.git', '.DS_Store']));

/* evidence: every run in this session, so the reader can compare rounds */
const evRoot = path.join(ROOT, 'evidence');
const runIds = fs.readdirSync(evRoot).filter((d) => d.startsWith('run_'));
let pick = null;
let pickSize = -1;
for (const id of runIds) {
  const src = path.join(evRoot, id);
  if (!fs.statSync(src).isDirectory()) continue;
  const dst = path.join(pkgDir, 'evidence', id);
  fs.mkdirSync(dst, { recursive: true });
  let posts = 0;
  for (const f of fs.readdirSync(src)) {
    const from = path.join(src, f);
    if (!fs.statSync(from).isFile()) continue;
    if (f.startsWith('.') && !f.endsWith('.png')) continue; // keep screenshots, drop temp
    fs.copyFileSync(from, path.join(dst, f));
  }
  const payloadFile = path.join(src, 'payload.json');
  if (fs.existsSync(payloadFile)) {
    try {
      posts = JSON.parse(fs.readFileSync(payloadFile, 'utf8')).posts?.length || 0;
    } catch {
      posts = 0;
    }
  }
  if (posts > pickSize) {
    pickSize = posts;
    pick = src;
  }
}

/* result.json: the round with the most coverage */
if (pick) {
  const runResult = path.join(pick, 'result.json');
  if (fs.existsSync(runResult)) fs.copyFileSync(runResult, path.join(pkgDir, 'result.json'));
}

/* docs + intro */
for (const f of ['00_先读这里.md']) {
  const src = path.join(outDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pkgDir, f));
}
for (const f of ['CHANGES.md']) {
  const src = path.join(ROOT, 'docs', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(pkgDir, f));
}

/* acceptance tables from ledger */
const ledgerDir = path.join(ROOT, 'state', 'runs');
fs.mkdirSync(path.join(pkgDir, 'acceptance'), { recursive: true });
if (fs.existsSync(ledgerDir)) {
  const rows = fs
    .readdirSync(ledgerDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(ledgerDir, f), 'utf8')))
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

  const table = [
    ['startedAt', 'endedAt', 'edition', 'planned', 'attempted', 'success', 'retry', 'blocked', 'newPosts', 'durationMs', 'push'],
    ...rows.map((r) => [
      r.startedAt,
      r.endedAt,
      r.edition ? '10点轮' : '补采',
      r.counts?.planned ?? '',
      r.counts?.attempted ?? '',
      r.counts?.success ?? '',
      r.counts?.retry ?? '',
      r.counts?.blocked ?? '',
      r.counts?.newPosts ?? '',
      r.durationMs ?? '',
      r.result?.push?.skipped ? `skip(${r.result.push.reason})` : r.result?.push?.ok ? 'ok' : 'fail',
    ]),
  ].map((line) => line.join('\t'));

  fs.writeFileSync(path.join(pkgDir, 'acceptance', 'runs.tsv'), `${table.join('\n')}\n`);

  const perTarget = [];
  for (const r of rows) {
    for (const t of r.targets || []) {
      perTarget.push([
        t.platform,
        t.adapter,
        t.status,
        t.durationMs ?? '',
        t.itemsRead ?? '',
        t.posts ?? '',
        (t.failure?.code || '').slice(0, 40),
      ].join('\t'));
    }
  }
  fs.writeFileSync(
    path.join(pkgDir, 'acceptance', 'targets.tsv'),
    `platform\tadapter\tstatus\tdurationMs\titemsRead\tposts\tfailureCode\n${perTarget.join('\n')}\n`,
  );

  const byAdapter = new Map();
  for (const r of rows) {
    for (const t of r.targets || []) {
      const key = t.adapter;
      const cur = byAdapter.get(key) || { n: 0, ms: 0, ok: 0 };
      cur.n += 1;
      cur.ms += Number(t.durationMs) || 0;
      if (t.status === 'success') cur.ok += 1;
      byAdapter.set(key, cur);
    }
  }
  const summary = [...byAdapter.entries()]
    .map(([adapter, s]) => `${adapter}\t${s.n}\t${s.ok}\t${Math.round(s.ms / s.n)}ms`)
    .join('\n');
  fs.writeFileSync(path.join(pkgDir, 'acceptance', 'adapter-timing.tsv'), `adapter\ttargets\tsuccess\tavgMs\n${summary}\n`);
}

/* secret scan */
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'selfcheck.mjs')], { encoding: 'utf8' });
  fs.writeFileSync(path.join(pkgDir, 'secret-scan.txt'), out);
} catch (err) {
  fs.writeFileSync(path.join(pkgDir, 'secret-scan.txt'), `selfcheck 未通过：\n${err.stdout || ''}${err.stderr || ''}`);
}

/* method.md */
const methodSrc = path.join(outDir, 'method.md');
if (fs.existsSync(methodSrc)) fs.copyFileSync(methodSrc, path.join(pkgDir, 'method.md'));

/* git provenance */
try {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
  fs.writeFileSync(
    path.join(pkgDir, 'code', 'git-commit.txt'),
    `repository: ${remote}\ncommit: ${sha}\nshort: ${sha.slice(0, 7)}\nsubject: ${subject}\n`,
  );
} catch {
  /* no git metadata: leave it out rather than inventing a sha */
}

/* checksums */
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
})(pkgDir);
const sums = files
  .filter((f) => !f.endsWith('checksums.sha256'))
  .map((f) => `${sha256(f)}  ${path.relative(pkgDir, f)}`)
  .join('\n');
fs.writeFileSync(path.join(pkgDir, 'checksums.sha256'), `${sums}\n`);

/* zip */
const zipPath = path.join(outDir, `${pkgName}.zip`);
fs.rmSync(zipPath, { force: true });
execFileSync('zip', ['-qr', zipPath, pkgName], { cwd: outDir });
const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
process.stdout.write(`打包完成：${zipPath}（${size} MB，${files.length} 个文件）\n`);
