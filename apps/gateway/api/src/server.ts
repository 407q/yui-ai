import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { createGatewayPool } from "./gateway/db.js";
import { GatewayApiError } from "./gateway/errors.js";
import {
  PostgresGatewayRepository,
  type GatewayRepository,
} from "./gateway/repository.js";
import { registerGatewayRoutes } from "./gateway/routes.js";
import { GatewayApiService } from "./gateway/service.js";

interface BuildGatewayApiServerOptions {
  logger?: boolean;
  pool?: Pool;
  repository?: GatewayRepository;
  sessionIdleTimeoutSec?: number;
}

export function buildGatewayApiServer(
  options: BuildGatewayApiServerOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
  });

  const pool = options.pool ?? createGatewayPool();
  const repository = options.repository ?? new PostgresGatewayRepository(pool);
  const service = new GatewayApiService(repository, {
    sessionIdleTimeoutSec:
      options.sessionIdleTimeoutSec ?? resolveSessionIdleTimeoutSec(),
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
