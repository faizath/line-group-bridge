import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/**
 * Minimal database surface shared by the PostgreSQL pool and the embedded PGlite
 * engine (dev/tests). Inside `tx`, only the passed `Queryable` may be used:
 * PGlite has a single connection, so querying the outer `Db` would deadlock.
 */
export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'pg' | 'pglite';
}

// int8 (count(*), sums, bigint columns) and numeric as JS numbers; values stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

class PgDb implements Db {
  readonly kind = 'pg' as const;
  constructor(private pool: pg.Pool) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pool.query(sql, params);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const q: Queryable = {
      async query<R>(sql: string, params: unknown[] = []) {
        const r = await client.query(sql, params);
        return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
      },
    };
    try {
      await client.query('begin');
      const out = await fn(q);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  constructor(private lite: PGlite) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.lite.query<T>(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }

  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.lite.transaction(async (tx) =>
      fn({
        async query<R>(sql: string, params: unknown[] = []) {
          const r = await tx.query<R>(sql, params);
          return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
        },
      }),
    );
  }

  close(): Promise<void> {
    return this.lite.close();
  }
}

/**
 * `postgres://…` → pooled PostgreSQL. `pglite://memory` or `pglite:///path` → embedded
 * PGlite (single process only; for development, tests and tiny deployments).
 */
export async function openDb(url: string): Promise<Db> {
  if (url.startsWith('pglite:')) {
    const path = url.replace(/^pglite:(\/\/)?/, '');
    const lite = path === 'memory' || path === '' ? await PGlite.create() : await PGlite.create(path);
    return new PgliteDb(lite);
  }
  return new PgDb(new pg.Pool({ connectionString: url, max: 20 }));
}
