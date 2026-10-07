import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** Plain-SQL migrations, applied in filename order, each in its own transaction. */
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../migrations', import.meta.url));

export interface MigrateOptions {
  connectionString: string;
  dir?: string;
  /** If set, (re)sets the fieldforms_app role's password after migrating. */
  appPassword?: string;
  log?: (msg: string) => void;
}

export async function migrate(opts: MigrateOptions): Promise<string[]> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = opts.log ?? (() => {});
  const client = new pg.Client({ connectionString: opts.connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    // Serialise concurrent runners (two containers starting at once).
    await client.query('SELECT pg_advisory_lock(72_617_201)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was edited after it was applied. Add a new migration instead.`);
        }
        continue;
      }
      log(`applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
    if (opts.appPassword) {
      // Identifiers and literals cannot be bound parameters in ALTER ROLE; escape the literal.
      const literal = client.escapeLiteral(opts.appPassword);
      await client.query(`ALTER ROLE fieldforms_app WITH LOGIN PASSWORD ${literal}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(72_617_201)').catch(() => {});
    await client.end();
  }
  return applied;
}
