/**
 * 请求级幂等：同一个 key 只真正执行一次，重放返回首次响应。
 * 用在 /api/collection、/api/ingest、/api/broadcast（音频/推送最贵的三个入口）。
 */
export async function withIdempotency<T>(
  db: D1Database,
  key: string | null,
  scope: 'collection' | 'ingest' | 'broadcast',
  runId: string | null,
  run: () => Promise<T>,
): Promise<{ replayed: boolean; value: T | unknown }> {
  if (!key) return { replayed: false, value: await run() };
  const scopedKey = `${scope}:${key}`;
  const claimed = await db
    .prepare('INSERT OR IGNORE INTO idempotency_keys (key, scope, run_id, created_at, response) VALUES (?, ?, ?, ?, NULL)')
    .bind(scopedKey, scope, runId, new Date().toISOString())
    .run();
  if ((claimed.meta?.changes ?? 0) > 0) {
    // Keep the reservation after an exception: a timed-out side effect may have succeeded.
    // A human must reconcile an unknown outcome before this key can be released.
    const value = await run();
    await db.prepare('UPDATE idempotency_keys SET response = ? WHERE key = ?')
      .bind(JSON.stringify(value) ?? 'null', scopedKey).run();
    return { replayed: false, value };
  }
  const hit = await db
    .prepare('SELECT response FROM idempotency_keys WHERE key = ?')
    .bind(scopedKey)
    .first<{ response: string }>();
  if (hit?.response) {
    try {
      return { replayed: true, value: JSON.parse(hit.response) };
    } catch {
      return { replayed: true, value: null };
    }
  }

  const error = new Error('Idempotency key is in progress or requires outcome reconciliation');
  Object.assign(error, { code: 'IDEMPOTENCY_IN_PROGRESS', status: 409 });
  throw error;
}

export async function recordRun(
  db: D1Database,
  input: {
    runId: string;
    startedAt: string;
    endedAt?: string;
    edition?: boolean;
    status: 'running' | 'ok' | 'partial' | 'failed';
    planned?: number;
    success?: number;
    blocked?: number;
    newPosts?: number;
    note?: string;
  },
) {
  await db
    .prepare(
      `INSERT INTO run_ledger (run_id, started_at, ended_at, edition, status, planned, success, blocked, new_posts, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         ended_at = excluded.ended_at,
         status = excluded.status,
         success = excluded.success,
         blocked = excluded.blocked,
         new_posts = excluded.new_posts,
         note = excluded.note`,
    )
    .bind(
      input.runId,
      input.startedAt,
      input.endedAt ?? null,
      input.edition ? 1 : 0,
      input.status,
      input.planned ?? 0,
      input.success ?? 0,
      input.blocked ?? 0,
      input.newPosts ?? 0,
      input.note ?? null,
    )
    .run();
}
