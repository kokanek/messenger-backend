import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import type { Logger } from "pino";

// Applies migrations/NNN_description.sql files in order, each in its own transaction,
// and records them in schema_migrations (backend spec, section 11.3).
// The advisory lock means two copies of a service starting together can't both migrate.
export async function runMigrations(pool: Pool, directory: string, lockId: number, logger: Logger): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockId]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const applied = new Set(
      (await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
    );
    const files = (await readdir(directory)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(directory, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        logger.info({ migration: file }, "migration applied");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch(() => {});
    client.release();
  }
}
