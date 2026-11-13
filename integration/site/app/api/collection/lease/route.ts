/**
 * POST /api/collection/lease
 *   { action: 'claim' | 'heartbeat' | 'release', targetIds: string[], owner: string, ttlMs?: number }
 *
 * 与现有 /api/collection 共用鉴权；不新开权限，也不在响应里回传任何凭据。
 */
import { claimLease, heartbeatLease, releaseLease } from '@/lib/lease';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const owner = body?.owner || request.headers.get('x-radar-owner');
  const action = body?.action;
  const targetIds: string[] = Array.isArray(body?.targetIds) ? body.targetIds : [];

  if (!owner || !action || targetIds.length === 0) {
    return Response.json({ error: 'owner, action, targetIds are required' }, { status: 400 });
  }
  if (!['claim', 'heartbeat', 'release'].includes(action)) {
    return Response.json({ error: 'unknown action' }, { status: 400 });
  }

  const db = (process.env as unknown as { DB: D1Database }).DB;
  const granted: string[] = [];
  const denied: Array<{ targetId: string; holder: unknown }> = [];

  for (const targetId of targetIds) {
    if (action === 'claim') {
      const res = await claimLease(db, targetId, owner, body.ttlMs);
      if (res.ok) granted.push(targetId);
      else denied.push({ targetId, holder: res.holder });
    } else if (action === 'heartbeat') {
      if (await heartbeatLease(db, targetId, owner, body.ttlMs)) granted.push(targetId);
      else denied.push({ targetId, holder: null });
    } else {
      if (await releaseLease(db, targetId, owner)) granted.push(targetId);
      else denied.push({ targetId, holder: null });
    }
  }

  return Response.json({ action, granted, denied }, { status: denied.length && action === 'claim' ? 409 : 200 });
}
