import "dotenv/config";
import { Pool } from "pg";

export function createGatewayPool(): Pool {
  const connectionString = resolveConnectionString([
    process.env.STATE_STORE_DSN,
    process.env.DATABASE_URL,
  ]);
  if (!connectionString) {
    throw new Error("STATE_STORE_DSN or DATABASE_URL is required.");
  }

  return new Pool({ connectionString: applyHostOverrides(connectionString) });
}

function resolveConnectionString(
  candidates: Array<string | undefined>,
): string | null {
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return null;
}

function applyHostOverrides(connectionString: string): string {
  const hostOverride = process.env.POSTGRES_HOST;
  const portOverride = process.env.POSTGRES_PORT;
  if (!hostOverride && !portOverride) {
    return connectionString;
  }

  const parsed = new URL(connectionString);
  if (hostOverride) {
    parsed.hostname = hostOverride;
  }
  if (portOverride) {
    parsed.port = portOverride;
  }

  return parsed.toString();
}
