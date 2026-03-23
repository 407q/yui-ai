import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  HttpAgentRuntimeClient,
  type AgentRuntimeClient,
} from "./agent/runtimeClient.js";
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
  agentRuntimeClient?: AgentRuntimeClient;
  agentRuntimeBaseUrl?: string;
  agentRuntimeTimeoutSec?: number;
  botInternalToken?: string;
  agentInternalToken?: string;
  agentRuntimeInternalToken?: string;
}

export function buildGatewayApiServer(
  options: BuildGatewayApiServerOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
  });

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
      internalToken:
        options.agentRuntimeInternalToken ??
        process.env.GATEWAY_TO_AGENT_INTERNAL_TOKEN ??
        process.env.AGENT_INTERNAL_TOKEN,
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
    discordBotToken: process.env.DISCORD_BOT_TOKEN,
    discordGuildId: process.env.DISCORD_GUILD_ID,
    discordApiBaseUrl: process.env.DISCORD_API_BASE_URL,
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

    requestLogError(error);
    return reply.code(500).send({
      error: "internal_error",
      message: "Unexpected error occurred.",
    });
  });

  app.addHook("onRequest", async (request, reply) => {
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

  void registerGatewayRoutes(app, service);
  void registerMcpRoutes(app, mcpService);
  return app;
}

async function main(): Promise<void> {
  const host = process.env.GATEWAY_API_HOST ?? "0.0.0.0";
  const port = parsePositiveInt(process.env.GATEWAY_API_PORT, 3800);

  const app = buildGatewayApiServer();
  await app.listen({ host, port });
  app.log.info(`[gateway-api] listening on ${host}:${port}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`[gateway-api] received ${signal}, shutting down...`);
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      requestLogError(error);
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

function resolveAgentRuntimeBaseUrl(): string {
  return process.env.AGENT_RUNTIME_BASE_URL ?? "http://127.0.0.1:3801";
}

function resolveAgentRuntimeTimeoutSec(): number {
  return parsePositiveInt(process.env.AGENT_RUNTIME_TIMEOUT_SEC, 30);
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

function requestLogError(error: unknown): void {
  if (error instanceof Error) {
    console.error("[gateway-api] error:", error);
    return;
  }

  console.error("[gateway-api] error:", String(error));
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
    requestLogError(error);
    process.exit(1);
  });
}
