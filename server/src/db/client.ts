import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error(err, 'Unexpected error on idle PostgreSQL client');
});

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;

  logger.debug({ query: text, duration, rows: result.rowCount }, 'db query');

  return result;
}

export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

export { pool };
