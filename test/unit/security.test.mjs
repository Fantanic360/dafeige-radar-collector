import test from 'node:test';
import assert from 'node:assert/strict';
import { SiteClient, collectionWritePayload } from '../../src/lib/site-client.mjs';
import { createHttpClient } from '../../src/lib/http.mjs';
import { loadEnv } from '../../src/lib/config.mjs';

test('site token is sent only to editorial origin with the Sites header', async () => {
  const calls = [];
  const http = { request: async (url, options) => { calls.push({ url, ...options }); return new Response('{}'); } };
  const site = new SiteClient({ env: { editorialBase: 'https://editor.test', publicBase: 'https://public.test', editorialToken: 'audit-token' }, http });
  await site.request('/api/collection');
  await site.readData();
  assert.equal(calls[0].headers['OAI-Sites-Authorization'], 'Bearer audit-token');
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].allowedOrigin, 'https://editor.test');
  assert.equal(calls[1].headers['OAI-Sites-Authorization'], undefined);
  await assert.rejects(site.request('/api/data', { base: 'https://other.test' }), { code: 'ORIGIN_MISMATCH' });
  assert.equal(loadEnv({}).authHeader, 'OAI-Sites-Authorization');
});

test('authenticated failures cannot inject credentials into page scripts', async () => {
  let browserCalls = 0;
  const err = Object.assign(new Error('offline'), { code: 'NETWORK' });
  const site = new SiteClient({ env: { editorialBase: 'https://editor.test', publicBase: 'https://public.test', editorialToken: 'audit-token' }, http: { request: async () => { throw err; } }, getBrowser: async () => { browserCalls += 1; } });
  await assert.rejects(site.request('/api/context'), /offline/);
  await assert.rejects(site.requestViaBrowser('https://editor.test/api/context', { headers: { 'OAI-Sites-Authorization': 'Bearer audit-token' } }), { code: 'CREDENTIAL_BROWSER_FALLBACK' });
  assert.equal(browserCalls, 0);
});

test('HTTP rejects sensitive cross-origin redirects before a second request', async () => {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), ...init }); return new Response('', { status: 302, headers: { location: 'https://outside.test/collect' } }); };
  try {
    const client = createHttpClient({ retries: 0 });
    await assert.rejects(client.request('https://editor.test/api/context', { headers: { 'OAI-Sites-Authorization': 'Bearer audit-token' } }), { code: 'UNSAFE_REDIRECT' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, 'manual');
  } finally { globalThis.fetch = saved; }
});

test('HTTP allows same-origin redirect and enforces allowedOrigin for public requests', async () => {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), ...init });
    return calls.length === 1 ? new Response('', { status: 307, headers: { location: '/new' } }) : new Response('{}');
  };
  try {
    const client = createHttpClient({ retries: 0 });
    await client.request('https://editor.test/old', { headers: { 'OAI-Sites-Authorization': 'Bearer audit-token' }, allowedOrigin: 'https://editor.test' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'https://editor.test/new');
    assert.equal(calls[1].headers['OAI-Sites-Authorization'], 'Bearer audit-token');
    await assert.rejects(client.request('https://outside.test/a', { allowedOrigin: 'https://editor.test' }), { code: 'ORIGIN_MISMATCH' });
  } finally { globalThis.fetch = saved; }
});

test('editorial queue includes canonical context and complete queue fields', async () => {
  const site = new SiteClient({ env: { editorialBase: 'https://editor.test', publicBase: 'https://public.test', editorialToken: 'audit-token' }, http: { request: async (url) => new Response(JSON.stringify(url.endsWith('/api/context') ? { sources: [{ id: 'new-source' }], editorial: { collection: {} } } : { states: [], posts: [], due: [{ id: 'due' }], targets: [{ id: 'target' }], pendingPosts: [{ id: 'post' }] })) } });
  const q = await site.fetchQueue();
  assert.equal(q.sources[0].id, 'new-source');
  assert.equal(q.due[0].id, 'due');
  assert.equal(q.pendingPosts[0].id, 'post');
});

test('collection writes project the strict contract and preserve local audit payload', async () => {
  const payload = { runId: 'audit-run', observations: [{ sourceId: 's', platform: 'B站', status: 'retry', note: 'real error', adapter: 'bili', pagesRead: 1 }], posts: [{ id: 'p', sourceId: 's', platform: 'B站', url: 'https://source.test/p', title: 'title', publishedAt: '2026-11-13', discoveredAt: '2026-11-14T00:00:00Z', evidence: 'metadata', extra: { body: 'audit only' }, platformPostId: 'raw' }], contentAttempts: [{ postId: 'p', status: 'retry', note: 'missing body', evidence: 'metadata', transcriptFile: '/local/file' }] };
  const before = JSON.stringify(payload);
  const projected = collectionWritePayload(payload);
  assert.deepEqual(Object.keys(projected).sort(), ['contentAttempts', 'observations', 'posts']);
  assert.equal(projected.posts[0].extra, undefined);
  assert.equal(projected.observations[0].adapter, undefined);
  assert.equal(projected.contentAttempts[0].transcriptFile, undefined);
  assert.equal(JSON.stringify(payload), before);
  let sent;
  const site = new SiteClient({ env: { editorialBase: 'https://editor.test', publicBase: 'https://public.test', editorialToken: 'audit-token' }, http: { request: async (_url, options) => { sent = JSON.parse(options.body); return new Response('{}'); } } });
  await site.pushCollection(payload);
  assert.deepEqual(sent, projected);
});
