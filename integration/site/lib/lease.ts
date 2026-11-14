/**
 * 目标租约。语义与采集器 src/lib/state.mjs 的 LeaseManager 一致：
 * 领取 -> 定期心跳 -> 释放；过期可被他人接管。
 *
 * 所有时间同时存 ISO 字符串（可读）与 epoch ms（可比较），避免 D1 上的字符串比较陷阱。
 */
export type LeaseOwner = string;

export interface LeaseRow {
  target_id: string;
  owner: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: number;
}

const TTL_MS = 10 * 60_000;

export function validTtl(ttlMs: number = TTL_MS): number {
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 60_000) throw new Error('ttlMs must be 1000..1800000');
  return ttlMs;
}

export async function claimLease(
  db: D1Database,
  targetId: string,
  owner: LeaseOwner,
  ttlMs: number = TTL_MS,
): Promise<{ ok: boolean; holder?: LeaseRow }> {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  validTtl(ttlMs);
  const result = await db
    .prepare(
      `INSERT INTO collection_leases (target_id, owner, acquired_at, heartbeat_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(target_id) DO UPDATE SET
         owner = excluded.owner,
         acquired_at = excluded.acquired_at,
         heartbeat_at = excluded.heartbeat_at,
         expires_at = excluded.expires_at
       WHERE collection_leases.expires_at <= ? OR collection_leases.owner = excluded.owner`,
    )
    .bind(targetId, owner, iso, iso, now + ttlMs, now)
    .run();
  if ((result.meta?.changes ?? 0) > 0) return { ok: true };
  const holder = await db.prepare('SELECT * FROM collection_leases WHERE target_id = ?').bind(targetId).first<LeaseRow>();
  return { ok: false, ...(holder ? { holder } : {}) };
}

export async function heartbeatLease(db: D1Database, targetId: string, owner: LeaseOwner, ttlMs = TTL_MS) {
  const now = Date.now();
  validTtl(ttlMs);
  const res = await db
    .prepare('UPDATE collection_leases SET heartbeat_at = ?, expires_at = ? WHERE target_id = ? AND owner = ? AND expires_at > ?')
    .bind(new Date(now).toISOString(), now + ttlMs, targetId, owner, now)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function releaseLease(db: D1Database, targetId: string, owner: LeaseOwner) {
  const res = await db
    .prepare('DELETE FROM collection_leases WHERE target_id = ? AND owner = ?')
    .bind(targetId, owner)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function reclaimExpired(db: D1Database, now = Date.now()) {
  const res = await db.prepare('DELETE FROM collection_leases WHERE expires_at <= ?').bind(now).run();
  return res.meta?.changes ?? 0;
}

/**
 * POST /api/collection 的守卫：请求里声明的每个目标都必须由调用方持有租约。
 * 缺失、过期或不属于 owner 的租约都拒绝；兼容老客户端的策略由站点接线决定。
 */
export async function assertLeases(db: D1Database, observations: Array<{ sourceId: string; url?: string }>, owner: string) {
  const now = Date.now();
  const missing: string[] = [];
  for (const obs of observations) {
    if (!obs.url) { missing.push(`${obs.sourceId}::missing-url`); continue; }
    const targetId = `${obs.sourceId}::${encodeURIComponent(obs.url)}`;
    const row = await db
      .prepare('SELECT owner, expires_at FROM collection_leases WHERE target_id = ?')
      .bind(targetId)
      .first<{ owner: string; expires_at: number }>();
    if (!row || row.expires_at <= now || row.owner !== owner) missing.push(targetId);
  }
  return { ok: missing.length === 0, conflicts: missing };
}
