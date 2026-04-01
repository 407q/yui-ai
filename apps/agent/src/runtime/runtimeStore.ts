import { existsSync } from "node:fs";
import type { Pool } from "pg";
import pg from "pg";

const { Pool: PgPool } = pg;

export interface RuntimeSessionRegistryRecord {
  sessionId: string;
  sdkSessionId: string;
  updatedAt: Date;
}

export interface UpsertRuntimeTaskSnapshotInput {
  taskId: string;
  sessionId: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  bootstrapMode: "create" | "resume";
  sendAndWaitCount: number;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  resultJson: Record<string, unknown> | null;
  toolEventsJson: Record<string, unknown>[] | null;
  errorJson: Record<string, unknown> | null;
}

export interface RuntimeTaskSnapshotRecord {
  taskId: string;
  sessionId: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  bootstrapMode: "create" | "resume";
  sendAndWaitCount: number;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  resultJson: Record<string, unknown> | null;
  toolEventsJson: Record<string, unknown>[] | null;
  errorJson: Record<string, unknown> | null;
}

export interface RuntimeSessionRegistryStore {
  ping(): Promise<void>;
  upsertSession(input: {
    sessionId: string;
    sdkSessionId: string;
    updatedAt: Date;
  }): Promise<void>;
  getSession(sessionId: string): Promise<RuntimeSessionRegistryRecord | null>;
  listSessions(limit?: number): Promise<RuntimeSessionRegistryRecord[]>;
  getTaskSnapshot(taskId: string): Promise<RuntimeTaskSnapshotRecord | null>;
  markRunningTasksFailedOnStartup(details: {
    runtimeInstanceId: string;
  }): Promise<void>;
  upsertTaskSnapshot(input: UpsertRuntimeTaskSnapshotInput): Promise<void>;
}

class InMemoryRuntimeSessionRegistryStore implements RuntimeSessionRegistryStore {
  private readonly sessions = new Map<string, RuntimeSessionRegistryRecord>();

  async ping(): Promise<void> {}

  async upsertSession(input: {
    sessionId: string;
    sdkSessionId: string;
    updatedAt: Date;
  }): Promise<void> {
    this.sessions.set(input.sessionId, {
      sessionId: input.sessionId,
      sdkSessionId: input.sdkSessionId,
      updatedAt: input.updatedAt,
    });
  }

  async getSession(sessionId: string): Promise<RuntimeSessionRegistryRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listSessions(limit = 200): Promise<RuntimeSessionRegistryRecord[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 2000);
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, boundedLimit);
  }

  async getTaskSnapshot(_taskId: string): Promise<RuntimeTaskSnapshotRecord | null> {
    return null;
  }

  async markRunningTasksFailedOnStartup(_details: {
    runtimeInstanceId: string;
  }): Promise<void> {}

  async upsertTaskSnapshot(_input: UpsertRuntimeTaskSnapshotInput): Promise<void> {}
}

class PostgresRuntimeSessionRegistryStore implements RuntimeSessionRegistryStore {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async upsertSession(input: {
    sessionId: string;
    sdkSessionId: string;
    updatedAt: Date;
  }): Promise<void> {
    try {
      await this.pool.query(
        `
        INSERT INTO runtime_sessions (
          session_id,
          sdk_session_id,
          updated_at
        )
        VALUES ($1, $2, $3)
        ON CONFLICT (session_id)
        DO UPDATE
        SET
          sdk_session_id = EXCLUDED.sdk_session_id,
          updated_at = EXCLUDED.updated_at
        `,
        [input.sessionId, input.sdkSessionId, input.updatedAt],
      );
    } catch (error) {
      if (isMissingTableError(error)) {
        return;
      }
      throw error;
    }
  }

  async getSession(sessionId: string): Promise<RuntimeSessionRegistryRecord | null> {
    let rows:
      | Array<{
          session_id: string;
          sdk_session_id: string;
          updated_at: Date;
        }>
      | undefined;
    try {
      ({ rows } = await this.pool.query<{
        session_id: string;
        sdk_session_id: string;
        updated_at: Date;
      }>(
        `
        SELECT
          session_id,
          sdk_session_id,
          updated_at
        FROM runtime_sessions
        WHERE session_id = $1
        `,
        [sessionId],
      ));
    } catch (error) {
      if (isMissingTableError(error)) {
        return null;
      }
      throw error;
    }
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      sessionId: row.session_id,
      sdkSessionId: row.sdk_session_id,
      updatedAt: row.updated_at,
    };
  }

  async listSessions(limit = 200): Promise<RuntimeSessionRegistryRecord[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 2000);
    let rows:
      | Array<{
          session_id: string;
          sdk_session_id: string;
          updated_at: Date;
        }>
      | undefined;
    try {
      ({ rows } = await this.pool.query<{
        session_id: string;
        sdk_session_id: string;
        updated_at: Date;
      }>(
        `
        SELECT
          session_id,
          sdk_session_id,
          updated_at
        FROM runtime_sessions
        ORDER BY updated_at DESC
        LIMIT $1
        `,
        [boundedLimit],
      ));
    } catch (error) {
      if (isMissingTableError(error)) {
        return [];
      }
      throw error;
    }
    return rows.map((row) => ({
      sessionId: row.session_id,
      sdkSessionId: row.sdk_session_id,
      updatedAt: row.updated_at,
    }));
  }

  async getTaskSnapshot(taskId: string): Promise<RuntimeTaskSnapshotRecord | null> {
    let rows:
      | Array<{
          task_id: string;
          session_id: string;
          status: "queued" | "running" | "completed" | "failed" | "canceled";
          bootstrap_mode: "create" | "resume";
          send_and_wait_count: number;
          started_at: Date;
          updated_at: Date;
          completed_at: Date | null;
          result_json: Record<string, unknown> | null;
          tool_events_json: Record<string, unknown>[] | null;
          error_json: Record<string, unknown> | null;
        }>
      | undefined;
    try {
      ({ rows } = await this.pool.query<{
        task_id: string;
        session_id: string;
        status: "queued" | "running" | "completed" | "failed" | "canceled";
        bootstrap_mode: "create" | "resume";
        send_and_wait_count: number;
        started_at: Date;
        updated_at: Date;
        completed_at: Date | null;
        result_json: Record<string, unknown> | null;
        tool_events_json: Record<string, unknown>[] | null;
        error_json: Record<string, unknown> | null;
      }>(
        `
        SELECT
          task_id,
          session_id,
          status,
          bootstrap_mode,
          send_and_wait_count,
          started_at,
          updated_at,
          completed_at,
          result_json,
          tool_events_json,
          error_json
        FROM runtime_task_snapshots
        WHERE task_id = $1
        `,
        [taskId],
      ));
    } catch (error) {
      if (isMissingTableError(error)) {
        return null;
      }
      throw error;
    }
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      taskId: row.task_id,
      sessionId: row.session_id,
      status: row.status,
      bootstrapMode: row.bootstrap_mode,
      sendAndWaitCount: row.send_and_wait_count,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      resultJson: row.result_json,
      toolEventsJson: row.tool_events_json,
      errorJson: row.error_json,
    };
  }

  async markRunningTasksFailedOnStartup(details: {
    runtimeInstanceId: string;
  }): Promise<void> {
    try {
      await this.pool.query(
        `
        UPDATE runtime_task_snapshots
        SET
          status = 'failed',
          updated_at = NOW(),
          completed_at = COALESCE(completed_at, NOW()),
          error_json = jsonb_build_object(
            'code', 'runtime_restarted',
            'message', 'Task state was recovered after runtime restart.',
            'runtime_instance_id', $1::text
          )
        WHERE status IN ('queued', 'running')
        `,
        [details.runtimeInstanceId],
      );
    } catch (error) {
      if (isMissingTableError(error)) {
        return;
      }
      throw error;
    }
  }

  async upsertTaskSnapshot(input: UpsertRuntimeTaskSnapshotInput): Promise<void> {
    try {
      await this.pool.query(
        `
        INSERT INTO runtime_task_snapshots (
          task_id,
          session_id,
          status,
          bootstrap_mode,
          send_and_wait_count,
          started_at,
          updated_at,
          completed_at,
          result_json,
          tool_events_json,
          error_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)
        ON CONFLICT (task_id)
        DO UPDATE
        SET
          session_id = EXCLUDED.session_id,
          status = EXCLUDED.status,
          bootstrap_mode = EXCLUDED.bootstrap_mode,
          send_and_wait_count = EXCLUDED.send_and_wait_count,
          started_at = EXCLUDED.started_at,
          updated_at = EXCLUDED.updated_at,
          completed_at = EXCLUDED.completed_at,
          result_json = EXCLUDED.result_json,
          tool_events_json = EXCLUDED.tool_events_json,
          error_json = EXCLUDED.error_json
        `,
        [
          input.taskId,
          input.sessionId,
          input.status,
          input.bootstrapMode,
          input.sendAndWaitCount,
          input.startedAt,
          input.updatedAt,
          input.completedAt,
          input.resultJson ? JSON.stringify(input.resultJson) : null,
          input.toolEventsJson ? JSON.stringify(input.toolEventsJson) : null,
          input.errorJson ? JSON.stringify(input.errorJson) : null,
        ],
      );
    } catch (error) {
      if (isMissingTableError(error)) {
        return;
      }
      throw error;
    }
  }
}

let defaultStore: RuntimeSessionRegistryStore | null = null;
let defaultPool: Pool | null = null;

export function createDefaultRuntimeSessionRegistryStore(): RuntimeSessionRegistryStore {
  if (defaultStore) {
    return defaultStore;
  }

  const connectionString = resolveStateStoreDsn();
  if (!connectionString) {
    defaultStore = new InMemoryRuntimeSessionRegistryStore();
    return defaultStore;
  }

  const resolved = applyHostOverrides(connectionString);
  const udsConfig = resolvePostgresUnixSocketConfig();
  const pool = udsConfig
    ? new PgPool({
        connectionString: resolved,
        host: udsConfig.host,
        port: udsConfig.port,
      })
    : new PgPool({
        connectionString: resolved,
      });
  defaultPool = pool;
  defaultStore = new PostgresRuntimeSessionRegistryStore(pool);
  return defaultStore;
}

export async function closeDefaultRuntimeSessionRegistryStore(): Promise<void> {
  if (!defaultPool) {
    defaultStore = null;
    return;
  }
  await defaultPool.end();
  defaultPool = null;
  defaultStore = null;
}

function resolveStateStoreDsn(): string | null {
  const candidates = [process.env.STATE_STORE_DSN, process.env.DATABASE_URL];
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

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "42P01";
}
