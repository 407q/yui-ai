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
  hostCliTimeoutSec?: number;
  hostHttpTimeoutSec?: number;
  hostCliAllowlist?: string[];
  agentRuntimeClient?: AgentRuntimeClient;
  agentRuntimeBaseUrl?: string;
  agentRuntimeTimeoutSec?: number;
}

export function buildGatewayApiServer(
  options: BuildGatewayApiServerOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
  });

  const pool = options.pool ?? createGatewayPool();
  const repository = options.repository ?? new PostgresGatewayRepository(pool);
  const agentRuntimeClient =
    options.agentRuntimeClient ??
    new HttpAgentRuntimeClient({
      baseUrl: options.agentRuntimeBaseUrl ?? resolveAgentRuntimeBaseUrl(),
      timeoutSec:
        options.agentRuntimeTimeoutSec ?? resolveAgentRuntimeTimeoutSec(),
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
    hostCliTimeoutSec: options.hostCliTimeoutSec ?? resolveHostCliTimeoutSec(),
    hostHttpTimeoutSec:
      options.hostHttpTimeoutSec ?? resolveHostHttpTimeoutSec(),
    hostCliAllowlist: options.hostCliAllowlist ?? resolveHostCliAllowlist(),
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
  const raw = process.env.SESSION_IDLE_TIMEOUT_SEC ?? process.env.MOCK_IDLE_TIMEOUT_SEC;
  return parsePositiveInt(raw, 600);
}

function resolveContainerSessionRoot(): string {
  return process.env.CONTAINER_SESSION_ROOT ?? "/tmp/yui-ai/session";
}

function resolveContainerCliTimeoutSec(): number {
  return parsePositiveInt(process.env.CONTAINER_CLI_TIMEOUT_SEC, 60);
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
