import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadEnvironment } from '../../config/src/index.js';
import { createDatabase } from './index.js';

const env = loadEnvironment();
const { db, pool } = createDatabase(env.DATABASE_URL);
await migrate(db, { migrationsFolder: 'migrations' });
await pool.end();
