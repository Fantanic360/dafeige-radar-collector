/**
 * POST /api/collection/lease
 *   { action: 'claim' | 'heartbeat' | 'release', targetIds: string[], owner: string, ttlMs?: number }
 *
 * 与现有 /api/collection 共用鉴权；不新开权限，也不在响应里回传任何凭据。
 */
import { claimLease, heartbeatLease, releaseLease, validTtl } from '../../../../lib/lease.ts';

// The host must bind its real authorization and D1 accessors. No assumed process.env.DB.
export function createLeaseHandler({ authorize, getDb }: {
  authorize: (request: Request) => Promise<boolean>;
  getDb: (request: Request) => Promise<D1Database>;
}) {
return async function handleLease(request: Request) {
  if (!await authorize(request)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const owner = body?.owner || request.headers.get('x-radar-owner');
  const action = body?.action;
  const targetIds: string[] = Array.isArray(body?.targetIds) ? body.targetIds : [];

  if (typeof owner !== 'string' || !owner.trim() || owner.length > 128 || !action || targetIds.length === 0 || targetIds.length > 100 || targetIds.some((id) => typeof id !== 'string' || !id || id.length > 1000)) {
    return Response.json({ error: 'owner, action, targetIds are required' }, { status: 400 });
  }
  if (!['claim', 'heartbeat', 'release'].includes(action)) {
    return Response.json({ error: 'unknown action' }, { status: 400 });
  }

  try { validTtl(body.ttlMs); } catch { return Response.json({ error: 'invalid ttlMs' }, { status: 400 }); }
  const db = await getDb(request);
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
};
}

// Safe template default. Replace only after binding and testing the existing Site auth.
export async function POST() {
  return Response.json({ error: 'Lease route requires Site authorization and D1 integration' }, { status: 503 });
}
