/** Fail-loud env access. Server-only values; none of these reach the client. */

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

/** Throws early with a clear message instead of failing obscurely mid-request. */
export function assertServerEnv(): void {
  requiredEnv('SESSION_JWT_SECRET');
  requiredEnv('SHOPIFY_STOREFRONT_ORIGIN');
}
