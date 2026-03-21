import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import type { Pool } from "pg";
import { createStatePool } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

const CREATE_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export async function runMigrations(
  pool: Pool,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  await pool.query(CREATE_MIGRATIONS_TABLE_SQL);

  const migrationNames = await listMigrationFiles(migrationsDir);
  if (migrationNames.length === 0) {
    return [];
  }

  const applied = await fetchAppliedMigrationSet(pool);
  const pending = migrationNames.filter((name) => !applied.has(name));
  if (pending.length === 0) {
    return [];
  }

  const client = await pool.connect();
  const executed: string[] = [];
  try {
    for (const migrationName of pending) {
      const migrationPath = path.join(migrationsDir, migrationName);
      const sql = await fs.readFile(migrationPath, "utf8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (migration_name) VALUES ($1)",
          [migrationName],
        );
        await client.query("COMMIT");
        executed.push(migrationName);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }

  return executed;
}

async function listMigrationFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.startsWith(".") &&
        /^\d+_.*\.sql$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function fetchAppliedMigrationSet(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{
    migration_name: string;
  }>("SELECT migration_name FROM schema_migrations");
  return new Set(rows.map((row) => row.migration_name));
}

async function main(): Promise<void> {
  const pool = createStatePool();
  try {
    const executed = await runMigrations(pool);
    if (executed.length === 0) {
      console.log("[db:migrate] no pending migrations.");
      return;
    }

    console.log(
      `[db:migrate] applied migrations: ${executed.join(", ")}`,
    );
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error("[db:migrate] failed:", error);
    process.exit(1);
  });
}
