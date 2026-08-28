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

export async function migrate(databaseUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const db = await createPool(databaseUrl, { max: 2 });
  const applied: string[] = [];
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    bytea NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
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
