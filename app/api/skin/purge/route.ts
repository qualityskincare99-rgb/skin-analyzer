/**
 * GET /api/skin/purge — the scheduled retention sweep (spec §12).
 *
 * Invoked by Vercel Cron (see vercel.json) and runnable by hand with
 * `npm run purge`. Not a storefront route: no session token, no CORS grant,
 * no OPTIONS handler. The only key that opens it is CRON_SECRET.
 *
 * Fails closed. With CRON_SECRET unset the endpoint answers 401 to everyone,
 * including Vercel — an unauthenticated endpoint that deletes customer data
 * is worse than a purge that visibly never runs.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError, handle, json } from '../_lib/http';
import { getRepo } from '../_lib/deps';
import { runRetentionPurge } from '@/lib/privacy/purge';

// Deleting storage objects for a backlog of sessions is not a 10-second job.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/** Constant-time compare over fixed-width digests, so the comparison tells an
 *  attacker nothing about the secret's length or its leading bytes. */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export const GET = handle(async (req) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) throw new ApiError(401, 'unauthorized');

  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!presented || !secretMatches(presented, expected)) throw new ApiError(401, 'unauthorized');

  const limit = Number(new URL(req.url).searchParams.get('limit') ?? '') || undefined;
  const report = await runRetentionPurge(getRepo(), { limit });

  // Loud in the function log either way: a purge that silently does nothing
  // looks exactly like a purge that is working.
  console.log('[skin-api] purge', JSON.stringify(report));

  // 207 when some sessions failed: the sweep ran, the result is partial, and
  // a monitor should be able to tell that apart from a clean run.
  return json(req, report.failed.length > 0 ? 207 : 200, report);
});
