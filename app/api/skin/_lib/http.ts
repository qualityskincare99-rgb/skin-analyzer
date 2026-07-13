/**
 * HTTP plumbing shared by every /api/skin route: CORS (storefront-domain
 * allowlist, spec §10), JSON responses, and uniform error handling.
 */

import { assertServerEnv } from './env';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function allowedOrigins(): string[] {
  // Deliberately optional here: corsHeaders runs inside error paths too, and a
  // missing env must surface as a clear 500 (assertServerEnv), not a throw
  // while building the error response itself.
  return (process.env.SHOPIFY_STOREFRONT_ORIGIN ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Echo the Origin back only when it's on the storefront allowlist. */
export function corsHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  const origin = req.headers.get('origin');
  if (origin && allowedOrigins().includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'authorization, content-type';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return headers;
}

/** Shared preflight handler: `export const OPTIONS = preflight` in each route. */
export function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(req) },
  });
}

export async function readJson<T>(req: Request, opts: { optional?: boolean } = {}): Promise<T> {
  const text = await req.text();
  if (!text) {
    if (opts.optional) return {} as T;
    throw new ApiError(400, 'JSON body required');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, 'invalid JSON body');
  }
}

/** Wraps a handler: env sanity check, ApiError → status, anything else → 500. */
export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      assertServerEnv();
      return await fn(req);
    } catch (err) {
      if (err instanceof ApiError) return json(req, err.status, { error: err.message });
      console.error('[skin-api]', err);
      return json(req, 500, { error: 'internal_error' });
    }
  };
}
