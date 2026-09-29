import type { Db } from './db.js';
import { migrations } from './migrations.js';

/** Applies pending migrations in order. Returns the versions applied. */
export async function migrate(db: Db): Promise<number[]> {
  await db.query(`create table if not exists schema_migrations (
    version int primary key, name text not null, applied_at timestamptz not null default now())`);
  const { rows } = await db.query<{ version: number }>('select version from schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  const done: number[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    await db.tx(async (q) => {
      for (const stmt of splitStatements(m.sql)) await q.query(stmt);
      await q.query('insert into schema_migrations (version, name) values ($1, $2)', [m.version, m.name]);
    });
    done.push(m.version);
  }
  return done;
}

/** True when every known migration has been applied (readiness check). */
export async function migrationsCurrent(db: Db): Promise<boolean> {
  const latest = migrations.at(-1)?.version ?? 0;
  const { rows } = await db.query<{ v: number | null }>('select max(version) as v from schema_migrations');
  return (rows[0]?.v ?? 0) >= latest;
}

// Migrations contain no functions or string literals with semicolons, so a plain split is safe.
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
