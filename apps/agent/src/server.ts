import "dotenv/config";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentRuntimeError } from "./runtime/errors.js";
import { GatewayMcpClient } from "./runtime/gatewayMcpClient.js";
import { AgentRuntimeService } from "./runtime/service.js";
import {
  CopilotCliSdkProvider,
  MockCopilotSdkProvider,
  type CopilotSdkProvider,
} from "./runtime/sdkProvider.js";
import type { AgentRunRequest } from "./runtime/types.js";

const runTaskBodySchema: z.ZodType<AgentRunRequest> = z.object({
  task_id: z.string().min(1),
  session_id: z.string().min(1),
  prompt: z.string().min(1),
  sdk_execution_mode: z
    .enum(["single_send_and_wait"])
    .optional()
    .default("single_send_and_wait"),
  session_bootstrap_mode: z
    .enum(["create_or_resume"])
    .optional()
    .default("create_or_resume"),
  session_lifecycle_policy: z
    .object({
      explicit_close_command: z.string().default("/close"),
      idle_timeout_sec: z.number().int().positive().default(600),
      on_idle_timeout: z.enum(["idle_pause"]).default("idle_pause"),
      resume_trigger: z
        .enum(["thread_user_message"])
        .default("thread_user_message"),
    })
    .optional(),
  thread_context: z
    .object({
      channel_id: z.string().min(1),
      thread_id: z.string().min(1),
    })
    .optional(),
  attachment_mount_path: z.string().optional(),
  runtime_policy: z
    .object({
      tool_routing: z.object({
        mode: z.enum(["gateway_only"]).default("gateway_only"),
        allow_external_mcp: z.boolean().default(false),
      }),
    })
    .optional()
    .default({
      tool_routing: {
        mode: "gateway_only",
        allow_external_mcp: false,
      },
    }),
  tool_calls: z
    .array(
      z.object({
        tool_name: z.string().min(1),
        execution_target: z.string().optional(),
        arguments: z.record(z.string(), z.unknown()),
        reason: z.string().min(1),
        delay_ms: z.number().int().min(0).max(10000).optional(),
      }),
    )
    .optional()
    .default([]),
});

const taskParamsSchema = z.object({
  taskId: z.string().min(1),
});

interface BuildAgentServerOptions {
  logger?: boolean;
  startedAt?: Date;
  sdkProvider?: CopilotSdkProvider;
  gatewayBaseUrl?: string;
  gatewayMcpTimeoutSec?: number;
}

export function buildAgentServer(options: BuildAgentServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
  });

  const startedAt = options.startedAt ?? new Date();
  const sdkProvider = options.sdkProvider ?? resolveSdkProvider();
  const gatewayMcpClient = new GatewayMcpClient({
    baseUrl: options.gatewayBaseUrl ?? resolveGatewayBaseUrl(),
    timeoutSec:
      options.gatewayMcpTimeoutSec ?? resolvePositiveInt(process.env.AGENT_MCP_TIMEOUT_SEC, 30),
  });
  const runtimeService = new AgentRuntimeService(sdkProvider, gatewayMcpClient);

  app.addHook("onClose", async () => {
    if (typeof sdkProvider.shutdown === "function") {
      await sdkProvider.shutdown();
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AgentRuntimeError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        details: error.details ?? null,
      });
    }

    if (error instanceof Error) {
      console.error("[agent] unexpected error:", error);
    } else {
      console.error("[agent] unexpected error:", String(error));
    }

    return reply.code(500).send({
      error: "internal_error",
      message: "Unexpected runtime error.",
    });
  });

  app.get("/health", async () => {
    const summary = runtimeService.getRuntimeSummary();
    return {
      status: "ok",
      service: "agent-runtime",
      uptime_sec: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      ...summary,
    };
  });

  app.get("/ready", async () => {
    const summary = runtimeService.getRuntimeSummary();
    return {
      status: "ready",
      service: "agent-runtime",
      started_at: startedAt.toISOString(),
      ...summary,
    };
  });

  app.post("/v1/tasks/run", async (request, reply) => {
    const payload = parseOrThrow(
      runTaskBodySchema,
      request.body,
      "invalid_agent_run_request",
    );
    const accepted = await runtimeService.runTask(payload);
    return reply.code(202).send(accepted);
  });

  app.get("/v1/tasks/:taskId", async (request) => {
    const params = parseOrThrow(taskParamsSchema, request.params, "invalid_task_params");
    return runtimeService.getTaskStatus(params.taskId);
  });

  app.post("/v1/tasks/:taskId/cancel", async (request) => {
    const params = parseOrThrow(taskParamsSchema, request.params, "invalid_task_params");
    return runtimeService.cancelTask(params.taskId);
  });

  return app;
}

async function main(): Promise<void> {
  const host = process.env.AGENT_BIND_HOST ?? "0.0.0.0";
  const port = resolvePositiveInt(process.env.AGENT_PORT, 3801);
  const sdkProvider = resolveSdkProvider();
  const app = buildAgentServer({
    sdkProvider,
  });

  await app.listen({ host, port });
  app.log.info(`[agent] listening on ${host}:${port}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`[agent] received ${signal}, shutting down...`);
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      if (error instanceof Error) {
        console.error("[agent] shutdown error:", error);
      } else {
        console.error("[agent] shutdown error:", String(error));
      }
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

function resolveSdkProvider(): CopilotSdkProvider {
  const botMode = resolveBotMode();
  if (botMode === "mock") {
    return new MockCopilotSdkProvider();
  }

  assertCopilotNodeVersion();
  const githubToken = process.env.COPILOT_GITHUB_TOKEN;
  if (!githubToken) {
    throw new AgentRuntimeError(
      500,
      "copilot_token_missing",
      "COPILOT_GITHUB_TOKEN is required when BOT_MODE=standard.",
    );
  }
  return new CopilotCliSdkProvider({
    githubToken,
    model: process.env.COPILOT_MODEL ?? "claude-sonnet-4.6",
    workingDirectory: resolveCopilotWorkingDirectory(process.env.COPILOT_WORKING_DIRECTORY),
    sendTimeoutMs: resolvePositiveInt(process.env.COPILOT_SEND_TIMEOUT_MS, 180000),
    sdkLogLevel: resolveCopilotSdkLogLevel(process.env.COPILOT_SDK_LOG_LEVEL),
  });
}

function resolveGatewayBaseUrl(): string {
  return process.env.AGENT_GATEWAY_BASE_URL ?? "http://host.docker.internal:3800";
}

function resolveBotMode(): "mock" | "standard" {
  return process.env.BOT_MODE === "mock" ? "mock" : "standard";
}

function assertCopilotNodeVersion(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major >= 22) {
    return;
  }

  throw new AgentRuntimeError(
    500,
    "copilot_node_version_unsupported",
    "BOT_MODE=standard requires Node.js >= 22 (node:sqlite support).",
    {
      node_version: process.versions.node,
    },
  );
}

function resolveCopilotWorkingDirectory(raw: string | undefined): string {
  const fallback = process.cwd();
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  if (existsSync(raw) && statSync(raw).isDirectory()) {
    return raw;
  }

  console.warn(
    `[agent] COPILOT_WORKING_DIRECTORY is invalid: ${raw}. fallback to ${fallback}`,
  );
  return fallback;
}

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function resolveCopilotSdkLogLevel(
  raw: string | undefined,
): "none" | "error" | "warning" | "info" | "debug" | "all" {
  if (!raw) {
    return "info";
  }

  switch (raw.toLowerCase()) {
    case "none":
      return "none";
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "info";
    case "debug":
      return "debug";
    case "all":
      return "all";
    default:
      return "info";
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }

  throw new AgentRuntimeError(400, code, "Invalid request payload.", {
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    })),
  });
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
    if (error instanceof Error) {
      console.error("[agent] startup failed:", error);
    } else {
      console.error("[agent] startup failed:", String(error));
    }
    process.exit(1);
  });
}
