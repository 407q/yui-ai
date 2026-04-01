import "dotenv/config";
import { existsSync } from "node:fs";
import { Pool } from "pg";

export function createGatewayPool(): Pool {
  const connectionString = resolveConnectionString([
    process.env.STATE_STORE_DSN,
    process.env.DATABASE_URL,
  ]);
  if (!connectionString) {
    throw new Error("STATE_STORE_DSN or DATABASE_URL is required.");
  }

  const resolved = applyHostOverrides(connectionString);
  const udsConfig = resolvePostgresUnixSocketConfig();
  if (udsConfig) {
    return new Pool({
      connectionString: resolved,
      host: udsConfig.host,
      port: udsConfig.port,
    });
  }
  return new Pool({ connectionString: resolved });
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
  const parsed = new URL(connectionString);
  const normalizedHost = parsed.hostname.toLowerCase();
  const hostOverride =
    process.env.POSTGRES_HOST ?? resolveAutoHostOverride(normalizedHost);
  const portOverride =
    process.env.POSTGRES_PORT ?? resolveAutoPortOverride(normalizedHost, parsed.port);
  if (!hostOverride && !portOverride) {
    return connectionString;
  }

  if (hostOverride) {
    parsed.hostname = hostOverride;
  }
  if (portOverride) {
    parsed.port = portOverride;
  }

  return parsed.toString();
}

function resolveAutoHostOverride(hostname: string): string | undefined {
  if (isRunningInContainer()) {
    return undefined;
  }
  if (hostname === "postgres") {
    return "127.0.0.1";
  }
  return undefined;
}

function resolveAutoPortOverride(
  hostname: string,
  explicitPort: string,
): string | undefined {
  if (isRunningInContainer()) {
    return undefined;
  }
  if (hostname === "postgres" && (explicitPort.length === 0 || explicitPort === "5432")) {
    return "55432";
  }
  return undefined;
}

function isRunningInContainer(): boolean {
  return existsSync("/.dockerenv");
}

function resolvePostgresUnixSocketConfig():
  | { host: string; port: number }
  | undefined {
  if ((process.env.INTERNAL_CONNECTION_MODE ?? "").toLowerCase() !== "uds") {
    return undefined;
  }
  const host = resolvePostgresSocketHost();
  const portRaw = process.env.POSTGRES_SOCKET_PORT ?? "5432";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    return undefined;
  }
  return {
    host,
    port,
  };
}

function resolvePostgresSocketHost(): string {
  const candidates = isRunningInContainer()
    ? [
        process.env.DB_SOCKET_MOUNT_PATH,
        process.env.POSTGRES_SOCKET_PATH,
        process.env.POSTGRES_SOCKET_DIR,
      ]
    : [
        process.env.POSTGRES_SOCKET_PATH,
        process.env.POSTGRES_SOCKET_DIR,
        process.env.DB_SOCKET_MOUNT_PATH,
      ];
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return "/tmp/postgres-socket";
}
