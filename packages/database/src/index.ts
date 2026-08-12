import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export function createDatabase(url: string): { db: Database; pool: Pool } {
  const pool = new Pool({
    connectionString: url,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    ssl: url.includes('sslmode=require') ? { rejectUnauthorized: true } : undefined,
  });
  return { db: drizzle(pool, { schema }), pool };
}
export * from './schema.js';
