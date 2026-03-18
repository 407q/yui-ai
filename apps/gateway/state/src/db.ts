import "dotenv/config";
import { Pool } from "pg";

export function createStatePool(): Pool {
  const connectionString = process.env.STATE_STORE_DSN ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("STATE_STORE_DSN or DATABASE_URL is required.");
  }

  return new Pool({ connectionString });
}

export function createMemoryPool(): Pool {
  const connectionString =
    process.env.MEMORY_STORE_DSN ??
    process.env.STATE_STORE_DSN ??
    process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "MEMORY_STORE_DSN or STATE_STORE_DSN or DATABASE_URL is required.",
    );
  }

  return new Pool({ connectionString });
}
