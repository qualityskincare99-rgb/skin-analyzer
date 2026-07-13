/**
 * Session tokens (spec §10): short-TTL HS256 JWTs carrying a `session_id`
 * claim. `role: 'authenticated'` is included so that in production — where
 * SESSION_JWT_SECRET is the Supabase JWT secret — the same token passes the
 * RLS policies for direct client reads.
 */

import { SignJWT, jwtVerify } from 'jose';
import { requiredEnv } from './env';
import { ApiError } from './http';

const SESSION_TTL = '30m';

function secret(): Uint8Array {
  return new TextEncoder().encode(requiredEnv('SESSION_JWT_SECRET'));
}

export async function signSessionToken(sessionId: string): Promise<string> {
  return new SignJWT({ session_id: sessionId, role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secret());
}

/** Extracts and verifies the Bearer token; the session id comes ONLY from the
 *  signed claim, never from a request body. */
export async function requireSession(req: Request): Promise<string> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
  if (!token) throw new ApiError(401, 'missing bearer token');
  try {
    const { payload } = await jwtVerify(token, secret());
    const sessionId = payload.session_id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('no session_id claim');
    return sessionId;
  } catch {
    throw new ApiError(401, 'invalid or expired session token');
  }
}
