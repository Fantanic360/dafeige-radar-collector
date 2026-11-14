import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { claimLease, assertLeases, heartbeatLease } from '../../integration/site/lib/lease.ts';
import { withIdempotency } from '../../integration/site/lib/idempotency.ts';
import { POST, createLeaseHandler } from '../../integration/site/app/api/collection/lease/route.ts';

function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync(new URL('../../integration/site/migrations/0001_collection_leases.sql', import.meta.url), 'utf8'));
  return { sql, prepare(query) { return { bind(...args) { return { async run() { await Promise.resolve(); const r = sql.prepare(query).run(...args); return { meta: { changes: Number(r.changes) } }; }, async first() { await Promise.resolve(); return sql.prepare(query).get(...args) || null; } }; } }; } };
}

test('atomic lease claim gives exactly one winner and guard requires a live owned lease', async () => {
  const db = database();
  const id = 's::https%3A%2F%2Fsource.test';
  const out = await Promise.all([claimLease(db, id, 'worker-a'), claimLease(db, id, 'worker-b')]);
  assert.equal(out.filter((r) => r.ok).length, 1);
  const owner = out[0].ok ? 'worker-a' : 'worker-b';
  assert.equal((await assertLeases(db, [{ sourceId: 's', url: 'https://source.test' }], owner)).ok, true);
  assert.equal((await assertLeases(db, [{ sourceId: 's', url: 'https://missing.test' }], owner)).ok, false);
  db.sql.prepare('UPDATE collection_leases SET expires_at = 0').run();
  assert.equal(await heartbeatLease(db, id, owner), false);
  assert.equal((await assertLeases(db, [{ sourceId: 's', url: 'https://source.test' }], owner)).ok, false);
  db.sql.close();
});

test('idempotency claims before side effects and does not replay an uncertain outcome', async () => {
  const db = database();
  let calls = 0;
  const results = await Promise.allSettled([1, 2].map(() => withIdempotency(db, 'same-key', 'collection', 'r1', async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return { ok: true }; })));
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const replay = await withIdempotency(db, 'same-key', 'collection', 'r2', async () => { calls += 1; });
  assert.equal(replay.replayed, true);
  await assert.rejects(withIdempotency(db, 'uncertain', 'broadcast', 'r3', async () => { throw new Error('unknown outcome'); }));
  await assert.rejects(withIdempotency(db, 'uncertain', 'broadcast', 'r4', async () => { calls += 1; }), { code: 'IDEMPOTENCY_IN_PROGRESS' });
  assert.equal(calls, 1);
  db.sql.close();
});

test('lease route is fail-closed until wired and authenticates before accessing storage', async () => {
  assert.equal((await POST()).status, 503);
  let touched = false;
  const handler = createLeaseHandler({ authorize: async () => false, getDb: async () => { touched = true; } });
  const response = await handler(new Request('https://site.test/api/collection/lease', { method: 'POST', body: '{}' }));
  assert.equal(response.status, 401);
  assert.equal(touched, false);
});
