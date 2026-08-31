/**
 * Migration runner. Applies files in migrations/ in lexical order exactly
 * once, inside a transaction, recording a checksum so an already-applied file
 * cannot be silently edited underneath the database.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from './pool.js';
import { loadEnv } from '../config/env.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/**
 * Advisory lock id for the migration runner. Any constant works as long as it
 * is stable; this is the low 63 bits of sha256('portage.migrations').
 */
const MIGRATION_LOCK_ID = 8_242_119_573_301_884_417n;

export async function migrate(databaseUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const db = await createPool(databaseUrl, { max: 2 });
  const applied: string[] = [];
  try {
    // Serialize concurrent runners. Two deploys landing together would
    // otherwise both see a migration as unapplied and both try to run it —
    // the second failing on a duplicate object, mid-transaction.
    // The lock is session-scoped and released in the finally block.
    await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID.toString()]);

    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    bytea NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();
    const { rows } = await db.query<{ filename: string; checksum: Buffer }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const seen = new Map(rows.map((r) => [r.filename, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest();
      const previous = seen.get(file);

      if (previous) {
        if (!previous.equals(checksum)) {
          throw new Error(
            `Migration ${file} was modified after being applied. ` +
            'Write a new migration instead of editing history.',
          );
        }
        continue;
      }

      await db.transaction(async (tx) => {
        await tx.query(sql);
        await tx.query(
          'INSERT INTO schema_migrations(filename, checksum) VALUES ($1, $2)',
          [file, checksum],
        );
      });
      applied.push(file);
    }
    return applied;
  } finally {
    // Best-effort unlock; closing the pool would release it anyway, but an
    // explicit release keeps the lock table clean if the pool is reused.
    try {
      await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID.toString()]);
    } catch {
      /* connection already gone */
    }
    await db.close();
  }
}

/**
 * Rolls back applied migrations down to (and including) the given number.
 * Each NNN_name.sql may have a matching NNN_name.down.sql; a migration
 * without one cannot be rolled back and stops the run rather than leaving
 * the schema half-reverted.
 */
export async function rollback(
  databaseUrl: string,
  toExclusive: number,
  dir = MIGRATIONS_DIR,
): Promise<string[]> {
  const db = await createPool(databaseUrl, { max: 2 });
  const reverted: string[] = [];
  try {
    await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID.toString()]);

    const { rows } = await db.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename DESC',
    );

    for (const { filename } of rows) {
      const num = Number(filename.slice(0, 3));
      if (!Number.isInteger(num) || num <= toExclusive) break;

      const downFile = filename.replace(/\.sql$/, '.down.sql');
      let sql: string;
      try {
        sql = await readFile(join(dir, downFile), 'utf8');
      } catch {
        throw new Error(
          `Cannot roll back ${filename}: ${downFile} does not exist. ` +
          'Write the down-migration before rolling back.',
        );
      }

      await db.transaction(async (tx) => {
        await tx.query(sql);
        await tx.query('DELETE FROM schema_migrations WHERE filename = $1', [filename]);
      });
      reverted.push(filename);
    }
    return reverted;
  } finally {
    try {
      await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID.toString()]);
    } catch {
      /* connection already gone */
    }
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) {
  const env = loadEnv();
  migrate(env.databaseUrl)
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
