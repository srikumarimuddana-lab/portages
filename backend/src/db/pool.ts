/**
 * Database access.
 *
 * The Sql interface exists so business logic can be unit-tested without a
 * live database, and so the driver is swappable. Only parameterized queries
 * are exposed — there is deliberately no method that accepts an interpolated
 * string, which is what makes SQL injection structurally impossible rather
 * than a code-review checklist item.
 */

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export interface Sql {
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
  /** Runs fn inside a transaction; rolls back on any throw. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

/**
 * Creates a pg-backed Sql. `pg` is the one runtime dependency of this module;
 * everything else in src/ is standard library only.
 *
 * Pool sizing note: serverless platforms open a connection per invocation and
 * will exhaust Postgres. Behind Vercel/Lambda, point DATABASE_URL at a pooler
 * (PgBouncer, Supabase pooler, RDS Proxy) rather than raising max here.
 */
export async function createPool(databaseUrl: string, opts: { max?: number } = {}): Promise<Sql & { close(): Promise<void> }> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Fail fast rather than hanging a request thread forever.
    statement_timeout: 15_000,
    query_timeout: 15_000,
  });

  const wrap = (client: { query: Function }): Sql => ({
    async query(text, params = []) {
      const res: any = await client.query(text, params as unknown[]);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
    },
    async transaction(fn) {
      // Nested transaction: reuse the same client, no new BEGIN.
      return fn(wrap(client));
    },
  });

  return {
    async query(text, params = []) {
      const res: any = await pool.query(text, params as unknown[]);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
