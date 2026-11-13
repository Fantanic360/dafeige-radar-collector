/**
 * Configuration loading and validation.
 *
 * Nothing here reads a secret from disk by default: credentials come from the environment
 * only, and `doctor` reports presence as booleans — never values.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, readJson } from './core.mjs';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const DEFAULT_PATHS = {
  config: path.join(PKG_ROOT, 'config'),
  state: process.env.RADAR_STATE_DIR || path.join(PKG_ROOT, 'state'),
  evidence: process.env.RADAR_EVIDENCE_DIR || path.join(PKG_ROOT, 'evidence'),
};

export function loadJsonConfig(name, { fallback = null, dir = null } = {}) {
  const file = path.join(dir || DEFAULT_PATHS.config, name);
  const value = readJson(file, null);
  if (value === null && fallback === null) {
    throw new Error(`缺少配置文件：${file}`);
  }
  return value ?? fallback;
}

/** Environment contract. Only names with `_TOKEN`/`_KEY` are treated as secret. */
export function loadEnv(env = process.env) {
  return {
    publicBase: env.RADAR_PUBLIC_BASE || 'https://director-ai-radar-open.frank345.chatgpt.site',
    editorialBase: env.RADAR_EDITORIAL_BASE || '',
    editorialToken: env.RADAR_EDITORIAL_TOKEN || '',
    githubToken: env.GITHUB_TOKEN || '',
    chromePath: env.CHROME_PATH || '',
    logLevel: env.RADAR_LOG_LEVEL || 'info',
    dryRun: env.RADAR_DRY_RUN === '1',
    maxTargetsPerRound: env.RADAR_MAX_TARGETS ? Number(env.RADAR_MAX_TARGETS) : null,
    maxContentPerRound: env.RADAR_MAX_CONTENT ? Number(env.RADAR_MAX_CONTENT) : 4,
    browserTier: env.RADAR_BROWSER_TIER !== '0',
    timeoutMs: env.RADAR_TIMEOUT_MS ? Number(env.RADAR_TIMEOUT_MS) : 25_000,
  };
}

const REQUIRED_SOURCE_FIELDS = ['id', 'name', 'enabled'];

export function validateSources(doc) {
  const problems = [];
  if (!doc || !Array.isArray(doc.sources)) {
    return { ok: false, problems: ['sources.json 缺少 sources 数组'] };
  }
  const seen = new Set();
  doc.sources.forEach((s, i) => {
    for (const f of REQUIRED_SOURCE_FIELDS) {
      if (s[f] === undefined) problems.push(`sources[${i}] 缺少字段 ${f}`);
    }
    if (s.id) {
      if (seen.has(s.id)) problems.push(`sourceId 重复：${s.id}`);
      seen.add(s.id);
    }
    if (s.profiles && !Array.isArray(s.profiles)) problems.push(`${s.id}.profiles 必须是数组`);
  });
  return { ok: problems.length === 0, problems };
}

/** Only enabled, non-removed, non-organization-exempt sources are collected. */
export function activeSources(doc) {
  return (doc.sources || []).filter(
    (s) => s.enabled !== false && s.directoryStatus !== 'removed' && s.directoryStatus !== 'candidate',
  );
}

/**
 * Expand sources into per-profile targets. Target ids must match the site's key format
 * exactly (`sourceId::encodeURIComponent(url)`) or state writes land on a different row.
 */
export function buildTargets(sourceDoc, adapterDoc = { overrides: {} }, extraDoc = null) {
  const targets = [];
  const overrides = adapterDoc?.overrides || {};
  for (const source of activeSources(sourceDoc)) {
    const profiles = (source.profiles || []).filter((p) => p.status === 'verified' && p.url);
    const primary = new Set(source.primaryPlatforms || []);
    for (const p of profiles) {
      const override = overrides[`${source.id}|${p.platform}`] || overrides[`${source.id}|${p.url}`] || null;
      targets.push({
        id: `${source.id}::${encodeURIComponent(p.url)}`,
        sourceId: source.id,
        sourceName: source.name,
        platform: p.platform,
        label: p.label || p.platform,
        url: p.url,
        primary: primary.has(p.platform),
        entityType: source.entityType || 'person',
        category: source.category,
        override,
      });
    }
  }

  // Collector-only additions (verified homepage exists, but the site has no profile row).
  const seen = new Set(targets.map((t) => t.id));
  for (const extra of extraDoc?.targets || []) {
    const source = (sourceDoc.sources || []).find((s) => s.id === extra.sourceId);
    if (!source) continue;
    const id = `${extra.sourceId}::${encodeURIComponent(extra.url)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    targets.push({
      id,
      sourceId: extra.sourceId,
      sourceName: source.name,
      platform: extra.platform,
      label: extra.label || extra.platform,
      url: extra.url,
      primary: Boolean(extra.primary),
      entityType: source.entityType || 'person',
      category: source.category,
      override: overrides[`${extra.sourceId}|${extra.platform}`] || null,
      extraTarget: true,
      extraReason: extra.reason || null,
    });
  }
  return targets;
}

export function ensureRuntimeDirs({ stateDir = DEFAULT_PATHS.state, evidenceDir = DEFAULT_PATHS.evidence } = {}) {
  ensureDir(stateDir);
  ensureDir(evidenceDir);
  return { stateDir, evidenceDir };
}

export function configExists() {
  return fs.existsSync(path.join(DEFAULT_PATHS.config, 'sources.json'));
}
