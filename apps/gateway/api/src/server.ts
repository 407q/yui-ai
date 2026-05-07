import "dotenv/config";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  HttpAgentRuntimeClient,
  type AgentRuntimeClient,
} from "./agent/runtimeClient.js";
import {
  createGatewaySummaryLoggerFromEnv,
  type GatewaySummaryLogger,
} from "./logging/summaryLogger.js";
import { createGatewayPool } from "./gateway/db.js";
import { GatewayApiError } from "./gateway/errors.js";
import {
  PostgresGatewayRepository,
  type GatewayRepository,
} from "./gateway/repository.js";
import { registerGatewayRoutes } from "./gateway/routes.js";
import { GatewayApiService } from "./gateway/service.js";
import { registerMcpRoutes } from "./mcp/routes.js";
import { McpToolService } from "./mcp/service.js";

interface BuildGatewayApiServerOptions {
  logger?: boolean;
  summaryLogger?: Pick<GatewaySummaryLogger, "log">;
  pool?: Pool;
  repository?: GatewayRepository;
  sessionIdleTimeoutSec?: number;
  containerSessionRoot?: string;
  containerCliTimeoutSec?: number;
  containerExecutionMode?: "host" | "docker_exec";
  agentContainerName?: string;
  containerDockerCliTimeoutSec?: number;
  dockerProjectRoot?: string;
  hostCliTimeoutSec?: number;
  hostHttpTimeoutSec?: number;
  hostCliAllowlist?: string[];
  hostCliEnvAllowlist?: string[];
  memoryNamespaceValidationMode?: "warn" | "enforce";
  ollamaApiKey?: string;
  ollamaWebSearchApiUrl?: string;
  agentRuntimeClient?: AgentRuntimeClient;
  agentRuntimeBaseUrl?: string;
  agentRuntimeTimeoutSec?: number;
  agentRuntimeSocketPath?: string;
  botInternalToken?: string;
  agentInternalToken?: string;
  agentRuntimeInternalToken?: string;
  gatewaySocketPath?: string;
}

export function buildGatewayApiServer(
  options: BuildGatewayApiServerOptions = {},
): FastifyInstance {
  const summaryLogger = options.summaryLogger ?? createGatewaySummaryLoggerFromEnv();
  const app = Fastify({
    logger: options.logger ?? false,
  });
  const requestStartedAtMs = new WeakMap<object, number>();

  const pool = options.pool ?? createGatewayPool();
  const repository = options.repository ?? new PostgresGatewayRepository(pool);
  const botInternalToken =
    options.botInternalToken ??
    process.env.BOT_TO_GATEWAY_INTERNAL_TOKEN ??
    process.env.GATEWAY_INTERNAL_TOKEN ??
    "";
  const agentInternalToken =
    options.agentInternalToken ??
    process.env.AGENT_TO_GATEWAY_INTERNAL_TOKEN ??
    process.env.GATEWAY_INTERNAL_TOKEN ??
    "";
  const agentRuntimeClient =
    options.agentRuntimeClient ??
    new HttpAgentRuntimeClient({
      baseUrl: options.agentRuntimeBaseUrl ?? resolveAgentRuntimeBaseUrl(),
      timeoutSec:
        options.agentRuntimeTimeoutSec ?? resolveAgentRuntimeTimeoutSec(),
      socketPath:
        options.agentRuntimeSocketPath ?? resolveAgentRuntimeSocketPath(),
      internalToken:
        options.agentRuntimeInternalToken ??
        process.env.GATEWAY_TO_AGENT_INTERNAL_TOKEN ??
        process.env.AGENT_INTERNAL_TOKEN,
      summaryLogger,
    });
  const service = new GatewayApiService(repository, {
    sessionIdleTimeoutSec:
      options.sessionIdleTimeoutSec ?? resolveSessionIdleTimeoutSec(),
    agentRuntimeClient,
  });
  const mcpService = new McpToolService(repository, {
    containerSessionRoot:
      options.containerSessionRoot ?? resolveContainerSessionRoot(),
    containerCliTimeoutSec:
      options.containerCliTimeoutSec ?? resolveContainerCliTimeoutSec(),
    containerExecutionMode:
      options.containerExecutionMode ?? resolveContainerExecutionMode(),
    agentContainerName: options.agentContainerName ?? resolveAgentContainerName(),
    containerDockerCliTimeoutSec:
      options.containerDockerCliTimeoutSec ?? resolveContainerDockerCliTimeoutSec(),
    dockerProjectRoot: options.dockerProjectRoot ?? resolveDockerProjectRoot(),
    hostCliTimeoutSec: options.hostCliTimeoutSec ?? resolveHostCliTimeoutSec(),
    hostHttpTimeoutSec:
      options.hostHttpTimeoutSec ?? resolveHostHttpTimeoutSec(),
    hostCliAllowlist: options.hostCliAllowlist ?? resolveHostCliAllowlist(),
    hostCliEnvAllowlist:
      options.hostCliEnvAllowlist ?? resolveHostCliEnvAllowlist(),
    memoryNamespaceValidationMode:
      options.memoryNamespaceValidationMode ??
      resolveMemoryNamespaceValidationMode(),
    ollamaApiKey: options.ollamaApiKey ?? process.env.OLLAMA_API_KEY,
    ollamaWebSearchApiUrl:
      options.ollamaWebSearchApiUrl ?? resolveOllamaWebSearchApiUrl(),
    discordBotToken: process.env.DISCORD_BOT_TOKEN,
    discordGuildId: process.env.DISCORD_GUILD_ID,
    discordApiBaseUrl: process.env.DISCORD_API_BASE_URL,
    summaryLogger,
  });

  if (!options.pool) {
    app.addHook("onClose", async () => {
      await pool.end();
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GatewayApiError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        details: error.details ?? null,
      });
    }

    requestLogError(error, summaryLogger);
    return reply.code(500).send({
      error: "internal_error",
      message: "Unexpected error occurred.",
    });
  });

  app.addHook("onRequest", async (request, reply) => {
    requestStartedAtMs.set(request.raw, Date.now());
    const requestPath = request.url.split("?")[0] ?? request.url;
    if (requestPath === "/health") {
      return;
    }

    const expectedToken = resolveExpectedInternalToken({
      requestPath,
      botInternalToken,
      agentInternalToken,
    });
    if (!expectedToken || expectedToken.length === 0) {
      return;
    }

    const header = request.headers["x-internal-token"];
    const providedToken = Array.isArray(header) ? header[0] : header;
    if (providedToken === expectedToken) {
      return;
    }

    return reply.code(401).send({
      error: "internal_auth_required",
      message: "Valid internal token is required.",
      details: {
        path: requestPath,
      },
    });
  });
  app.addHook("onResponse", async (request, reply) => {
    const requestPath = request.url.split("?")[0] ?? request.url;
    if (requestPath === "/health") {
      return;
    }
    const startedAtMs = requestStartedAtMs.get(request.raw) ?? Date.now();
    const traceId = extractTraceIdFromRequest(request);
    summaryLogger.log({
      hop: resolveHopFromPath(requestPath),
      event: "gateway.http.request",
      traceId,
      summary: `${request.method} ${requestPath}`,
      status: `${reply.statusCode}`,
      latencyMs: Date.now() - startedAtMs,
    });
  });

  void registerGatewayRoutes(app, service);
  void registerMcpRoutes(app, mcpService);
  return app;
}

async function main(): Promise<void> {
  const host = process.env.GATEWAY_API_HOST ?? "0.0.0.0";
  const port = parsePositiveInt(process.env.GATEWAY_API_PORT, 3800);
  const socketPath = resolveGatewayApiSocketPath();

  const summaryLogger = createGatewaySummaryLoggerFromEnv();
  const app = buildGatewayApiServer({
    summaryLogger,
  });
  if (socketPath) {
    cleanupStaleSocket(socketPath);
    await app.listen({ path: socketPath });
    summaryLogger.log({
      hop: "INT",
      event: "gateway.server.listen",
      traceId: "gateway-bootstrap",
      summary: `listening on socket ${socketPath}`,
      status: "ready",
    });
  } else {
    await app.listen({ host, port });
    summaryLogger.log({
      hop: "INT",
      event: "gateway.server.listen",
      traceId: "gateway-bootstrap",
      summary: `listening on ${host}:${port}`,
      status: "ready",
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    summaryLogger.log({
      hop: "INT",
      event: "gateway.server.shutdown",
      traceId: "gateway-bootstrap",
      summary: `received ${signal}`,
      status: "shutting_down",
    });
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      requestLogError(error, summaryLogger);
      process.exit(1);
    }
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

function resolveSessionIdleTimeoutSec(): number {
  const raw = process.env.SESSION_IDLE_TIMEOUT_SEC ?? process.env.BOT_IDLE_TIMEOUT_SEC;
  return parsePositiveInt(raw, 600);
}

function resolveContainerSessionRoot(): string {
  return process.env.CONTAINER_SESSION_ROOT ?? "/agent/session";
}

function resolveContainerCliTimeoutSec(): number {
  return parsePositiveInt(process.env.CONTAINER_CLI_TIMEOUT_SEC, 60);
}

function resolveContainerExecutionMode(): "host" | "docker_exec" {
  const raw = process.env.CONTAINER_TOOL_EXECUTION_MODE;
  if (raw === "host" || raw === "docker_exec") {
    return raw;
  }
  return "docker_exec";
}

function resolveAgentContainerName(): string {
  return process.env.AGENT_CONTAINER_NAME ?? "yui-ai-agent";
}

function resolveContainerDockerCliTimeoutSec(): number {
  return parsePositiveInt(process.env.CONTAINER_DOCKER_CLI_TIMEOUT_SEC, 60);
}

function resolveDockerProjectRoot(): string {
  return process.env.DOCKER_PROJECT_ROOT ?? process.cwd();
}

function resolveHostCliTimeoutSec(): number {
  return parsePositiveInt(process.env.HOST_CLI_TIMEOUT_SEC, 60);
}

function resolveHostHttpTimeoutSec(): number {
  return parsePositiveInt(process.env.HOST_HTTP_TIMEOUT_SEC, 60);
}

function resolveHostCliAllowlist(): string[] {
  const raw = process.env.HOST_CLI_ALLOWLIST;
  if (!raw || raw.trim().length === 0) {
    return ["git", "node", "npm", "yarn", "curl"];
  }
  const commands = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (commands.length === 0) {
    return ["git", "node", "npm", "yarn", "curl"];
  }
  return commands;
}

function resolveHostCliEnvAllowlist(): string[] {
  const raw = process.env.HOST_CLI_ENV_ALLOWLIST;
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveMemoryNamespaceValidationMode(): "warn" | "enforce" {
  const raw = process.env.MEMORY_NAMESPACE_VALIDATION_MODE;
  if (raw === "warn" || raw === "enforce") {
    return raw;
  }
  return "warn";
}

function resolveOllamaWebSearchApiUrl(): string | undefined {
  const raw = process.env.OLLAMA_WEB_SEARCH_API_URL;
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  return raw.trim();
}

function resolveAgentRuntimeBaseUrl(): string {
  return process.env.AGENT_RUNTIME_BASE_URL ?? "http://127.0.0.1:3801";
}

function resolveAgentRuntimeTimeoutSec(): number {
  return parsePositiveInt(process.env.AGENT_RUNTIME_TIMEOUT_SEC, 30);
}

function resolveGatewayApiSocketPath(): string | null {
  if (resolveInternalConnectionMode() !== "uds") {
    return null;
  }
  const raw =
    process.env.GATEWAY_API_SOCKET_PATH ??
    path.join(resolveDefaultRuntimeSocketDir(), "gateway-api.sock");
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  return path.resolve(raw);
}

function resolveAgentRuntimeSocketPath(): string | undefined {
  if (resolveInternalConnectionMode() !== "uds") {
    return undefined;
  }
  const raw =
    process.env.AGENT_RUNTIME_SOCKET_PATH ??
    path.join(resolveDefaultRuntimeSocketDir(), "agent-runtime.sock");
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  return path.resolve(raw);
}

function resolveDefaultRuntimeSocketDir(): string {
  const configured = process.env.RUNTIME_SOCKET_DIR;
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured);
  }
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntimeDir && xdgRuntimeDir.trim().length > 0) {
    return path.resolve(xdgRuntimeDir, "yui-ai");
  }
  return path.resolve("/tmp/yui-ai");
}

function resolveInternalConnectionMode(): "tcp" | "uds" {
  const raw = (process.env.INTERNAL_CONNECTION_MODE ?? "").toLowerCase();
  if (raw === "tcp" || raw === "uds") {
    return raw;
  }
  return "tcp";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function requestLogError(
  error: unknown,
  summaryLogger: Pick<GatewaySummaryLogger, "log">,
): void {
  const message = error instanceof Error ? error.message : String(error);
  summaryLogger.log({
    level: "error",
    hop: "INT",
    event: "gateway.error",
    traceId: "gateway-error",
    summary: message,
    status: "error",
  });
  if (error instanceof Error) {
    console.error("[gateway-api] error:", error);
    return;
  }

  console.error("[gateway-api] error:", String(error));
}

function extractTraceIdFromRequest(request: FastifyRequest): string {
  const params = toRecord(request.params);
  const body = toRecord(request.body);
  const fromParams = readString(params, "taskId") ?? readString(params, "task_id");
  if (fromParams) {
    return fromParams;
  }
  const fromBody =
    readString(body, "taskId") ??
    readString(body, "task_id") ??
    readString(body, "call_id");
  if (fromBody) {
    return fromBody;
  }
  return request.id;
}

function resolveHopFromPath(pathname: string): "A2M" | "INT" {
  if (
    pathname.startsWith("/v1/mcp/") ||
    pathname === "/v1/agent/approvals/request-and-wait"
  ) {
    return "A2M";
  }
  return "INT";
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(
  value: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!value) {
    return null;
  }
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  return raw;
}

function cleanupStaleSocket(socketPath: string): void {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  if (!existsSync(socketPath)) {
    return;
  }
  unlinkSync(socketPath);
}

function resolveExpectedInternalToken(input: {
  requestPath: string;
  botInternalToken: string;
  agentInternalToken: string;
}): string {
  if (
    input.requestPath === "/v1/agent/approvals/request-and-wait" ||
    input.requestPath.startsWith("/v1/mcp/")
  ) {
    return input.agentInternalToken;
  }
  return input.botInternalToken;
}

function isEntrypoint(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) {
    return false;
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  return path.resolve(argvPath) === currentFilePath;
}

if (isEntrypoint()) {
  main().catch((error) => {
    requestLogError(error, createGatewaySummaryLoggerFromEnv());
    process.exit(1);
  });
}
