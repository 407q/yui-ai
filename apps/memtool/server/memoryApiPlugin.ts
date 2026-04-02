import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Pool } from "pg";
import type { Plugin } from "vite";

interface MemoryEntryListRow {
  memory_id: string;
  user_id: string;
  namespace: string;
  key: string;
  value_json: unknown;
  tags_json: unknown;
  is_system: boolean;
  updated_at: Date | string;
  inbound_links: number | string;
  outbound_links: number | string;
  total_count: number | string;
}

interface MemoryEntryRow {
  memory_id: string;
  user_id: string;
  namespace: string;
  key: string;
  value_json: unknown;
  tags_json: unknown;
  is_system: boolean;
  updated_at: Date | string;
}

interface MemoryInboundLinkRow {
  relation: string;
  created_at: Date | string;
  source_memory_id: string;
  source_user_id: string;
  source_namespace: string;
  source_key: string;
}

interface MemoryOutboundLinkRow {
  relation: string;
  created_at: Date | string;
  target_user_id: string;
  target_namespace: string;
  target_key: string;
  target_memory_id: string | null;
}

interface NamespaceSummaryRow {
  namespace: string;
  count: number | string;
  system_count: number | string;
  latest_updated_at: Date | string | null;
}

interface UpsertMemoryPayload {
  user_id: string;
  namespace: string;
  key: string;
  value_json: unknown;
  tags_json?: unknown;
  is_system?: unknown;
}

type ConnectNext = (error?: unknown) => void;

let pool: Pool | null = null;

export function memoryApiPlugin(): Plugin {
  const handler = createApiMiddleware();
  return {
    name: "memtool-memory-api",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

function createApiMiddleware() {
  return (req: IncomingMessage, res: ServerResponse, next: ConnectNext): void => {
    void handleApiRequest(req, res, next);
  };
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: ConnectNext,
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!requestUrl.pathname.startsWith("/api/")) {
    next();
    return;
  }

  try {
    if (req.method === "GET" && requestUrl.pathname === "/api/health") {
      const dbPool = resolvePool();
      await dbPool.query("SELECT 1");
      writeJson(res, 200, {
        status: "ok",
        database: "reachable",
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/memory/namespaces") {
      await handleListNamespaces(res);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/memory") {
      await handleListMemory(requestUrl, res);
      return;
    }

    if (req.method === "GET") {
      const detailMatch = requestUrl.pathname.match(/^\/api\/memory\/([^/]+)$/);
      if (detailMatch) {
        const memoryId = decodeURIComponent(detailMatch[1]);
        await handleGetMemory(memoryId, res);
        return;
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/memory/upsert") {
      await handleUpsertMemory(req, res);
      return;
    }

    if (req.method === "DELETE") {
      const detailMatch = requestUrl.pathname.match(/^\/api\/memory\/([^/]+)$/);
      if (detailMatch) {
        const memoryId = decodeURIComponent(detailMatch[1]);
        const force = parseBoolean(requestUrl.searchParams.get("force"), false);
        await handleDeleteMemory(memoryId, force, res);
        return;
      }
    }

    writeJson(res, 404, {
      error: "not_found",
      message: "Endpoint not found.",
    });
  } catch (error) {
    writeJson(res, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleListNamespaces(res: ServerResponse): Promise<void> {
  const dbPool = resolvePool();
  const { rows } = await dbPool.query<NamespaceSummaryRow>(
    `
    SELECT
      namespace,
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE is_system = true)::int AS system_count,
      MAX(updated_at) AS latest_updated_at
    FROM memory_entries
    GROUP BY namespace
    ORDER BY namespace ASC
    `,
  );

  writeJson(res, 200, {
    namespaces: rows.map((row) => ({
      namespace: row.namespace,
      count: toNumber(row.count),
      system_count: toNumber(row.system_count),
      latest_updated_at: toIsoStringOrNull(row.latest_updated_at),
    })),
  });
}

async function handleListMemory(
  requestUrl: URL,
  res: ServerResponse,
): Promise<void> {
  const dbPool = resolvePool();
  const search = requestUrl.searchParams.get("search")?.trim() ?? "";
  const namespace = requestUrl.searchParams.get("namespace")?.trim() ?? "";
  const userId = requestUrl.searchParams.get("userId")?.trim() ?? "";
  const includeSystem = parseBoolean(
    requestUrl.searchParams.get("includeSystem"),
    true,
  );
  const limit = clamp(
    parsePositiveInt(requestUrl.searchParams.get("limit"), 200),
    1,
    1000,
  );
  const offset = clamp(
    parsePositiveInt(requestUrl.searchParams.get("offset"), 0),
    0,
    1_000_000,
  );

  const where: string[] = [];
  const params: unknown[] = [];
  if (namespace.length > 0) {
    params.push(namespace);
    where.push(`me.namespace = $${params.length}`);
  }
  if (userId.length > 0) {
    params.push(userId);
    where.push(`me.user_id = $${params.length}`);
  }
  if (!includeSystem) {
    where.push(`me.is_system = false`);
  }
  if (search.length > 0) {
    params.push(`%${search}%`);
    where.push(
      `(
        me.user_id ILIKE $${params.length}
        OR me.namespace ILIKE $${params.length}
        OR me."key" ILIKE $${params.length}
        OR me.value_json::text ILIKE $${params.length}
        OR me.tags_json::text ILIKE $${params.length}
      )`,
    );
  }

  params.push(limit);
  const limitParam = `$${params.length}`;
  params.push(offset);
  const offsetParam = `$${params.length}`;
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const { rows } = await dbPool.query<MemoryEntryListRow>(
    `
    SELECT
      me.memory_id,
      me.user_id,
      me.namespace,
      me."key",
      me.value_json,
      me.tags_json,
      me.is_system,
      me.updated_at,
      (
        SELECT COUNT(*)
        FROM memory_links ml
        WHERE ml.target_user_id = me.user_id
          AND ml.target_namespace = me.namespace
          AND ml.target_key = me."key"
      )::int AS inbound_links,
      (
        SELECT COUNT(*)
        FROM memory_links ml
        WHERE ml.source_user_id = me.user_id
          AND ml.source_namespace = me.namespace
          AND ml.source_key = me."key"
      )::int AS outbound_links,
      COUNT(*) OVER()::int AS total_count
    FROM memory_entries me
    ${whereClause}
    ORDER BY me.updated_at DESC
    LIMIT ${limitParam}
    OFFSET ${offsetParam}
    `,
    params,
  );

  const total = rows.length > 0 ? toNumber(rows[0].total_count) : 0;
  writeJson(res, 200, {
    total,
    limit,
    offset,
    entries: rows.map((row) => normalizeEntry(row)),
  });
}

async function handleGetMemory(
  memoryId: string,
  res: ServerResponse,
): Promise<void> {
  const dbPool = resolvePool();
  const entryResult = await dbPool.query<MemoryEntryRow>(
    `
    SELECT
      memory_id,
      user_id,
      namespace,
      "key",
      value_json,
      tags_json,
      is_system,
      updated_at
    FROM memory_entries
    WHERE memory_id = $1
    LIMIT 1
    `,
    [memoryId],
  );
  const row = entryResult.rows[0];
  if (!row) {
    writeJson(res, 404, {
      error: "memory_not_found",
      message: "Memory entry is not found.",
    });
    return;
  }

  const inboundResult = await dbPool.query<MemoryInboundLinkRow>(
    `
    SELECT
      ml.relation,
      ml.created_at,
      ml.source_memory_id,
      ml.source_user_id,
      ml.source_namespace,
      ml.source_key
    FROM memory_links ml
    WHERE ml.target_user_id = $1
      AND ml.target_namespace = $2
      AND ml.target_key = $3
    ORDER BY ml.created_at DESC
    `,
    [row.user_id, row.namespace, row.key],
  );
  const outboundResult = await dbPool.query<MemoryOutboundLinkRow>(
    `
    SELECT
      ml.relation,
      ml.created_at,
      ml.target_user_id,
      ml.target_namespace,
      ml.target_key,
      mt.memory_id AS target_memory_id
    FROM memory_links ml
    LEFT JOIN memory_entries mt
      ON mt.user_id = ml.target_user_id
     AND mt.namespace = ml.target_namespace
     AND mt."key" = ml.target_key
    WHERE ml.source_user_id = $1
      AND ml.source_namespace = $2
      AND ml.source_key = $3
    ORDER BY ml.created_at DESC
    `,
    [row.user_id, row.namespace, row.key],
  );

  writeJson(res, 200, {
    entry: normalizeEntry({
      ...row,
      inbound_links: inboundResult.rows.length,
      outbound_links: outboundResult.rows.length,
      total_count: 1,
    }),
    inbound_links: inboundResult.rows.map((link) => ({
      relation: link.relation,
      created_at: toIsoString(link.created_at),
      source_memory_id: link.source_memory_id,
      source_user_id: link.source_user_id,
      source_namespace: link.source_namespace,
      source_key: link.source_key,
    })),
    outbound_links: outboundResult.rows.map((link) => ({
      relation: link.relation,
      created_at: toIsoString(link.created_at),
      target_user_id: link.target_user_id,
      target_namespace: link.target_namespace,
      target_key: link.target_key,
      target_memory_id: link.target_memory_id,
    })),
  });
}

async function handleUpsertMemory(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await parseJsonRequestBody(req)) as UpsertMemoryPayload;
  if (!body || typeof body !== "object") {
    writeJson(res, 400, {
      error: "invalid_payload",
      message: "Request body must be a JSON object.",
    });
    return;
  }

  const userId = normalizeNonEmptyString(body.user_id);
  const namespace = normalizeNonEmptyString(body.namespace);
  const key = normalizeNonEmptyString(body.key);
  if (!userId || !namespace || !key) {
    writeJson(res, 400, {
      error: "invalid_payload",
      message: "user_id, namespace and key are required.",
    });
    return;
  }

  if (body.value_json === undefined) {
    writeJson(res, 400, {
      error: "invalid_payload",
      message: "value_json is required.",
    });
    return;
  }

  const tagsJson = normalizeTags(body.tags_json);
  const isSystem = parseBooleanBody(body.is_system, false);
  const memoryId = `mem_${randomUUID()}`;
  const dbPool = resolvePool();
  const { rows } = await dbPool.query<MemoryEntryRow>(
    `
    INSERT INTO memory_entries (
      memory_id,
      user_id,
      namespace,
      "key",
      value_json,
      tags_json,
      is_system,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, NOW())
    ON CONFLICT (user_id, namespace, "key")
    DO UPDATE SET
      value_json = EXCLUDED.value_json,
      tags_json = EXCLUDED.tags_json,
      is_system = EXCLUDED.is_system,
      updated_at = NOW()
    RETURNING
      memory_id,
      user_id,
      namespace,
      "key",
      value_json,
      tags_json,
      is_system,
      updated_at
    `,
    [
      memoryId,
      userId,
      namespace,
      key,
      JSON.stringify(body.value_json),
      JSON.stringify(tagsJson),
      isSystem,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("failed to upsert memory entry");
  }

  writeJson(res, 200, {
    entry: normalizeEntry({
      ...row,
      inbound_links: 0,
      outbound_links: 0,
      total_count: 1,
    }),
  });
}

async function handleDeleteMemory(
  memoryId: string,
  force: boolean,
  res: ServerResponse,
): Promise<void> {
  const dbPool = resolvePool();
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const foundResult = await client.query<MemoryEntryRow>(
      `
      SELECT
        memory_id,
        user_id,
        namespace,
        "key",
        value_json,
        tags_json,
        is_system,
        updated_at
      FROM memory_entries
      WHERE memory_id = $1
      LIMIT 1
      `,
      [memoryId],
    );
    const found = foundResult.rows[0];
    if (!found) {
      await client.query("ROLLBACK");
      writeJson(res, 404, {
        error: "memory_not_found",
        message: "Memory entry is not found.",
      });
      return;
    }
    if (found.is_system && !force) {
      await client.query("ROLLBACK");
      writeJson(res, 400, {
        error: "system_memory_protected",
        message:
          "System memory entry deletion requires force=true.",
      });
      return;
    }

    await client.query(
      `
      DELETE FROM memory_links
      WHERE source_memory_id = $1
         OR (
           target_user_id = $2
           AND target_namespace = $3
           AND target_key = $4
         )
      `,
      [found.memory_id, found.user_id, found.namespace, found.key],
    );
    await client.query(
      `
      DELETE FROM memory_entries
      WHERE memory_id = $1
      `,
      [found.memory_id],
    );
    await client.query("COMMIT");
    writeJson(res, 200, {
      deleted: true,
      memory_id: found.memory_id,
      user_id: found.user_id,
      namespace: found.namespace,
      key: found.key,
      is_system: found.is_system,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function resolvePool(): Pool {
  if (pool) {
    return pool;
  }

  const connectionString = resolveConnectionString();
  const resolved = applyHostOverrides(connectionString);
  const uds = resolvePostgresUnixSocketConfig();
  pool = uds
    ? new Pool({
        connectionString: resolved,
        host: uds.host,
        port: uds.port,
      })
    : new Pool({
        connectionString: resolved,
      });
  return pool;
}

function resolveConnectionString(): string {
  const candidates = [
    process.env.MEMTOOL_DATABASE_URL,
    process.env.MEMORY_STORE_DSN,
    process.env.STATE_STORE_DSN,
    process.env.DATABASE_URL,
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  throw new Error(
    "MEMTOOL_DATABASE_URL or MEMORY_STORE_DSN or STATE_STORE_DSN or DATABASE_URL is required.",
  );
}

function applyHostOverrides(connectionString: string): string {
  const parsed = new URL(connectionString);
  const normalizedHost = parsed.hostname.toLowerCase();
  const hostOverride =
    process.env.POSTGRES_HOST ?? resolveAutoHostOverride(normalizedHost);
  const portOverride =
    process.env.POSTGRES_PORT ??
    resolveAutoPortOverride(normalizedHost, parsed.port);
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

function isRunningInContainer(): boolean {
  return existsSync("/.dockerenv");
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function parseJsonRequestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  const bodyText = Buffer.concat(chunks).toString("utf8").trim();
  if (bodyText.length === 0) {
    return null;
  }
  return JSON.parse(bodyText);
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

function parseBooleanBody(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return parseBoolean(value, fallback);
  }
  return fallback;
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim();
    if (normalized.length === 0) {
      continue;
    }
    tags.push(normalized);
  }
  return tags;
}

function normalizeEntry(
  row: MemoryEntryListRow | (MemoryEntryRow & { inbound_links: number; outbound_links: number; total_count: number }),
): Record<string, unknown> {
  return {
    memory_id: row.memory_id,
    user_id: row.user_id,
    namespace: row.namespace,
    key: row.key,
    value_json: row.value_json,
    tags_json: normalizeTags(row.tags_json),
    is_system: row.is_system,
    updated_at: toIsoString(row.updated_at),
    inbound_links: toNumber(row.inbound_links),
    outbound_links: toNumber(row.outbound_links),
  };
}

function toNumber(value: number | string): number {
  if (typeof value === "number") {
    return value;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return toIsoString(value);
}
