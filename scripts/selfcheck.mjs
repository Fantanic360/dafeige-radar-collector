#!/usr/bin/env node
/**
 * selfcheck: the one command to run before shipping or after touching code.
 *
 *   1. syntax-check every ESM file we own
 *   2. validate config (source ids, target keys, duplicate sources)
 *   3. secret scan (tokens, keys, cookies, signed URLs) over tracked text files
 *   4. run unit + e2e tests
 *
 * Exits non-zero on the first hard failure so CI can gate on it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
};

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'state', 'evidence', 'logs'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/* 1. syntax */
const files = walk(ROOT).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
let syntaxOk = true;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    syntaxOk = false;
    record(`syntax ${path.relative(ROOT, file)}`, false, (res.stderr || '').split('\n')[0]);
  }
}
record(`syntax (${files.length} files)`, syntaxOk);

/* 2. config */
try {
  const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/sources.json'), 'utf8'));
  const ids = new Set();
  let dup = 0;
  let missingProfile = 0;
  for (const s of sources.sources) {
    if (ids.has(s.id)) dup += 1;
    ids.add(s.id);
    if (!Array.isArray(s.profiles)) missingProfile += 1;
  }
  record('config sources', dup === 0 && missingProfile === 0, `${sources.sources.length} sources, ${dup} dup, ${missingProfile} bad`);
} catch (err) {
  record('config sources', false, err.message);
}

/* 3. secret scan */
const PATTERNS = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub fine-grained token'],
  [/sk-[A-Za-z0-9]{20,}/, 'OpenAI-style key'],
  [/AKIA[0-9A-Z]{16}/, 'AWS key id'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bSESSDATA=[^;\s"']+/, 'B站 cookie'],
  [/\bbuvid3=[^;\s"']+/, 'B站 cookie'],
  [/(?:X-Amz-Signature|Signature)=[A-Za-z0-9%]{20,}/, 'signed URL'],
  [/(?:api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{12,}["']/i, 'inline credential'],
];
const scanTargets = walk(ROOT).filter((f) => /\.(mjs|js|json|md|yml|yaml|plist|service|timer|example|txt)$/.test(f));
const hits = [];
for (const file of scanTargets) {
  const text = fs.readFileSync(file, 'utf8');
  for (const [re, label] of PATTERNS) {
    if (re.test(text)) hits.push(`${path.relative(ROOT, file)}: ${label}`);
  }
}
record(`secret scan (${scanTargets.length} files)`, hits.length === 0, hits.slice(0, 5).join(' | '));

/* 4. tests */
const test = spawnSync(process.execPath, ['--test', 'test/unit', 'test/e2e'], {
  cwd: ROOT,
  encoding: 'utf8',
  shell: false,
});
const testOut = `${test.stdout || ''}${test.stderr || ''}`;
const passMatch = /# pass (\d+)/.exec(testOut);
const failMatch = /# fail (\d+)/.exec(testOut);
record('tests', test.status === 0, `pass=${passMatch?.[1] ?? '?'} fail=${failMatch?.[1] ?? '?'}`);
if (test.status !== 0) process.stdout.write(`${testOut.split('\n').slice(-25).join('\n')}\n`);

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
