/** POST /api/skin/session — create a session, return its signed token (spec §10). */

import { handle, json, preflight, readJson } from '../_lib/http';
import { getRepo } from '../_lib/deps';
import { signSessionToken } from '../_lib/auth';

export const OPTIONS = preflight;

export const POST = handle(async (req) => {
  const body = await readJson<{ shopifyCustomerId?: string }>(req, { optional: true });
  const session = await getRepo().createSession({
    shopifyCustomerId: typeof body.shopifyCustomerId === 'string' ? body.shopifyCustomerId : undefined,
  });
  const token = await signSessionToken(session.id);
  return json(req, 201, { sessionId: session.id, token, state: session.state });
});
