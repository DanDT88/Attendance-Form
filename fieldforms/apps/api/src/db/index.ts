import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types.js';

// `date` columns as 'YYYY-MM-DD' strings. The default parser builds a Date at local midnight,
// which shifts the day whenever the server's zone differs from the data's.
pg.types.setTypeParser(1082, (v) => v);
// bigint counts as numbers. Every bigint here (counts, audit ids) stays far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = Kysely<Database>;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

export function createDb(connectionString: string): { db: Db; pool: pg.Pool } {
  const pool = createPool(connectionString);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}
