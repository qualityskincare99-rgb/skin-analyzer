/**
 * POST /api/skin/consent — record granular consent (spec §10, §12).
 * Required before /analyze: no image is touched without a consent row.
 */

import { createHash } from 'node:crypto';
import { ApiError, handle, json, preflight, readJson } from '../_lib/http';
import { getRepo } from '../_lib/deps';
import { requireSession } from '../_lib/auth';
import { requiredEnv } from '../_lib/env';
import type { ConsentScope } from '@/lib/db/repo';

const ALLOWED_SCOPES: ConsentScope[] = ['image_analysis', 'store_results', 'marketing'];

export const OPTIONS = preflight;

export const POST = handle(async (req) => {
  const sessionId = await requireSession(req);
  const body = await readJson<{ scope?: unknown }>(req);

  const scope = body.scope;
  if (!Array.isArray(scope) || scope.length === 0 || scope.some(s => !ALLOWED_SCOPES.includes(s)))
    throw new ApiError(400, `scope must be a non-empty array from: ${ALLOWED_SCOPES.join(', ')}`);

  // Hashed, never raw (spec §9). Keyed with the server secret so the hash
  // can't be reversed by rainbow-tabling public IP ranges.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ipHash = ip
    ? createHash('sha256').update(`${requiredEnv('SESSION_JWT_SECRET')}:${ip}`).digest('hex')
    : undefined;

  const repo = getRepo();
  const row = await repo.recordConsent({ sessionId, scope: scope as ConsentScope[], ipHash });

  const session = await repo.getSession(sessionId);
  if (session?.state === 'INIT') await repo.updateSessionState(sessionId, 'CAPTURE');

  return json(req, 201, { consentId: row.id, scope: row.scope, grantedAt: row.granted_at });
});
