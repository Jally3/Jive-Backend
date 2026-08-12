import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from '../../packages/database/src/index.js';
let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;
describe.skipIf(!process.env.RUN_TESTCONTAINERS)('database schema', () => {
  let context: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    context = createDatabase(container.getConnectionUri());
    await migrate(context.db, { migrationsFolder: 'migrations' });
  });
  afterAll(async () => {
    await context.pool.end();
    await container?.stop();
  });
  it('installs required trigram index', async () => {
    const result = await context.pool.query(
      "select indexname from pg_indexes where indexname='videos_normalized_title_trgm_idx'",
    );
    expect(result.rowCount).toBe(1);
  });
});
