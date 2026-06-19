import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../db/schema.js';

type DbClient = ReturnType<typeof drizzle<typeof schema>>;

let cached: DbClient | null = null;

/**
 * Singleton Drizzle client over the @neondatabase/serverless HTTP driver.
 * Cold-start friendly: the HTTP driver is connectionless, so there is no
 * pool to manage or close. Safe to call repeatedly from a serverless
 * invocation; the same instance is reused for the lifetime of the
 * instance.
 */
export function getDb(): DbClient {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const sql = neon(url);
  cached = drizzle({ client: sql, schema });
  return cached;
}

/**
 * Expose the raw neon() SQL template for one-shot scripts (preflight,
 * db-smoke) that want to run raw SQL without going through Drizzle.
 */
export function getRawSql(): NeonQueryFunction<false, false> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return neon(url);
}

/**
 * Reset the cached client. For tests that mutate process.env.
 */
export function resetDbCache(): void {
  cached = null;
}

/**
 * No-op for API symmetry with connection-pooled clients. The HTTP driver
 * is connectionless; nothing to close. Documented so nobody tries to
 * add pooling later.
 */
export function closeDb(): void {
  /* no-op */
}