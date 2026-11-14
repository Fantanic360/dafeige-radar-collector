/**
 * End-to-end: real Runner + real HTTP client + real state/ledger, mocked site.
 *
 * No browser is involved, so this runs in CI and on a laptop in under a second while
 * still exercising the parts that actually break: URL building, payload shape, cursor
 * handling, idempotent push, and the state file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../../src/lib/core.mjs';
import { Runner } from '../../src/lib/runner.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>测试频道</title>
  <item>
    <title>窗口内的新作品</title>
    <link>http://example.test/post/1</link>
    <guid>post-1</guid>
    <pubDate>DATE_IN_WINDOW</pubDate>
    <description><![CDATA[${'正文'.repeat(500)}]]></description>
  </item>
  <item>
    <title>窗口外的旧作品</title>
    <link>http://example.test/post/0</link>
    <guid>post-0</guid>
    <pubDate>Mon, 01 Jan 2024 00:00:00 +0800</pubDate>
    <description>old</description>
  </item>
</channel></rss>`;

function startMockSite() {
  const received = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/data' || url.pathname === '/api/context' || (url.pathname === '/api/collection' && req.method === 'GET')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          schemaVersion: 3,
          states: received.flatMap((r) => r.observations || []).map((o) => ({ ...o, id: `${o.sourceId}::${encodeURIComponent(o.url)}` })),
          posts: received.flatMap(r => r.posts || []).map(post => ({ ...post, contentCheckedAt: received.flatMap(r => r.contentAttempts || []).filter(a => a.postId === post.id).at(-1)?.checkedAt })),
          collection: { states: received.flatMap((r) => r.observations || []).map((o) => ({ ...o, id: `${o.sourceId}::${encodeURIComponent(o.url)}` })), posts: [] },
          sources: [
            {
              id: 't1',
              name: '测试源',
              enabled: true,
              directoryStatus: 'active',
              entityType: 'person',
              primaryPlatforms: ['官网'],
              profiles: [{ platform: '官网', label: '官网', url: `http://127.0.0.1:${server.address().port}/site`, status: 'verified' }],
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname === '/api/collection' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        received.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (url.pathname === '/feed.xml') {
      const inWindow = new Date(Date.now() - 3600_000).toUTCString();
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(FEED.replace('DATE_IN_WINDOW', inWindow));
      return;
    }
    if (url.pathname === '/site') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>ok</body></html>');
      return;
    }
    res.writeHead(404).end('nope');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received }));
  });
}

function writeConfig(dir, base) {
  fs.writeFileSync(
    path.join(dir, 'sources.json'),
    JSON.stringify({
      version: 'test',
      sources: [
        {
          id: 't1',
          name: '测试源',
          enabled: true,
          directoryStatus: 'active',
          entityType: 'person',
          primaryPlatforms: ['官网'],
          profiles: [{ platform: '官网', label: '官网', url: `${base}/site`, status: 'verified' }],
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({
    schedule: { editionHour: 10, editionToleranceMinutes: 45 },
    budget: { offEditionCap: 8, editionCap: 100, contentCap: 2, runBudgetMs: 60000, perTargetTimeoutMs: 15000 },
    lease: { ttlMs: 60000, heartbeatMs: 5000 },
    window: { initialDays: 7 },
  }));
  fs.writeFileSync(path.join(dir, 'adapters.json'), JSON.stringify({
    overrides: { 't1|官网': { adapter: 'rss', feedUrl: `${base}/feed.xml` } },
  }));
  fs.writeFileSync(path.join(dir, 'targets.extra.json'), JSON.stringify({ targets: [] }));
}

test('runner: collects a feed, persists state, and pushes an idempotent payload', async () => {
  const { server, received } = await startMockSite();
  const base = `http://127.0.0.1:${server.address().port}`;
  const configDir = tmp('radar-cfg-');
  const rootDir = tmp('radar-root-');
  writeConfig(configDir, base);

  const env = {
    publicBase: base,
    editorialBase: base,
    editorialToken: 'test-token',
    browserTier: false,
    timeoutMs: 8000,
    logLevel: 'error',
  };
  const log = createLogger({ level: 'error' });

  const runner = new Runner({ env, logger: log, rootDir, configDir });
  try {
    const out = await runner.runOnce({ dryRun: false });
    assert.equal(out.payload.observations.length, 1, 'one target inspected');
    const obs = out.payload.observations[0];
    assert.equal(obs.status, 'success');
    assert.match(obs.note, /窗口/);
    assert.equal(out.payload.posts.length, 1, 'only the in-window post is emitted');
    const post = out.payload.posts[0];
    assert.equal(post.title, '窗口内的新作品');
    assert.match(post.publishedAt, /T.*Z$/, 'exact timestamp with timezone');

    assert.equal(received.length, 1, 'push reached the site once');
    assert.ok(received[0].observations[0].url.endsWith('/site'));

    const state = JSON.parse(fs.readFileSync(path.join(rootDir, 'state', 'state.json'), 'utf8'));
    const key = `t1::${encodeURIComponent(`${base}/site`)}`;
    assert.equal(state.targets[key].status, 'success');
    assert.ok(state.targets[key].nextDueAt, 'success schedules a re-due time');

    // Second identical round: the same post must not be re-pushed as a new discovery.
    const second = await runner.runOnce({ dryRun: false, force: true });
    assert.equal(second.payload.posts.length, 0, 'no duplicate post rows on re-run');
  } finally {
    await runner.close();
    server.close();
  }
});

test('runner: reports a blocked target without touching the success cursor', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/data')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ schemaVersion: 3, collection: { states: [], posts: [] }, sources: [{ id:'t1', name:'测试源', enabled:true, directoryStatus:'active', profiles:[{platform:'官网',status:'verified',url:`http://127.0.0.1:${server.address().port}/site`}] }] }));
      return;
    }
    res.writeHead(500).end('boom');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const configDir = tmp('radar-cfg2-');
  const rootDir = tmp('radar-root2-');
  writeConfig(configDir, base);
  // Point the override at a feed the mock server refuses.
  fs.writeFileSync(path.join(configDir, 'adapters.json'), JSON.stringify({
    overrides: { 't1|官网': { adapter: 'rss', feedUrl: `${base}/api/collection` } },
  }));

  const runner = new Runner({
    env: { publicBase: base, editorialBase: '', editorialToken: '', browserTier: false, timeoutMs: 5000, logLevel: 'error' },
    logger: createLogger({ level: 'error' }),
    rootDir,
    configDir,
  });
  try {
    const out = await runner.runOnce({ dryRun: true });
    const obs = out.payload.observations[0];
    assert.ok(['retry', 'blocked'].includes(obs.status), `expected retry/blocked, got ${obs.status}`);
    const state = JSON.parse(fs.readFileSync(path.join(rootDir, 'state', 'state.json'), 'utf8'));
    const s = Object.values(state.targets)[0];
    assert.equal(s.lastSuccessfulAt, undefined, 'a failed run must not create a success record');
    assert.ok(s.nextDueAt, 'failure schedules a retry');
  } finally {
    await runner.close();
    server.close();
  }
});

test('runner flushes each completed target and preserves a failed batch for replay', async () => {
  const configDir=tmp('radar-batch-cfg-'), rootDir=tmp('radar-batch-root-');
  writeConfig(configDir,'http://127.0.0.1:1');
  const runner=new Runner({env:{publicBase:'http://127.0.0.1:1',browserTier:false},logger:createLogger({level:'error'}),rootDir,configDir});
  const sources=['t1','t2','t3'].map(id=>({id,name:id,enabled:true,profiles:[{platform:'官网',status:'verified',url:`https://example.test/${id}`}]}));
  let writes=0, reads=0;
  const applied={};
  runner.site={mode:'editorial',canWrite:true,fetchQueue:async()=>({sources,states:applied,posts:{}}),pushCollection:async payload=>{ writes++; assert.equal(payload.observations.length,1); if(writes===2) throw new Error('simulated unavailable'); for(const o of payload.observations)applied[`${o.sourceId}::${encodeURIComponent(o.url)}`]=o; return {ok:true}; }};
  runner.runTarget=async target=>{reads++;return {target,result:{status:'success',note:'已核列表',windowFrom:'2026-11-13T00:00:00Z',windowTo:'2026-11-14T00:00:00Z',pagesRead:1,itemsRead:1,posts:[],contentAttempts:[]}};};
  const out=await runner.runOnce({scheduledFor:'2026-11-14T08:00:00+08:00'});
  assert.equal(reads,2,'stops before a third target after write failure');
  assert.equal(writes,2,'writes immediately after each target');
  assert.equal(out.pushResult.ok,false);
  const saved=JSON.parse(fs.readFileSync(path.join(rootDir,'state/state.json'),'utf8'));
  assert.equal(saved.meta.pendingCollectionBatches.length,1);
  assert.equal(saved.meta.pendingCollectionBatches[0].payload.observations[0].sourceId,'t2');
});
