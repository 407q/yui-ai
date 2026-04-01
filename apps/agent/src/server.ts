import "dotenv/config";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { unlinkSync } from "node:fs";
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
import type {
  AgentRunRequest,
  AgentStageAttachmentsRequest,
} from "./runtime/types.js";

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
  session_workspace_root: z.string().optional(),
  attachment_mount_path: z.string().optional(),
  runtime_policy: z
    .object({
      tool_routing: z.object({
        mode: z
          .enum(["gateway_only", "hybrid_container_builtin_gateway_host"])
          .default("hybrid_container_builtin_gateway_host"),
        allow_external_mcp: z.boolean().default(false),
      }),
    })
    .optional()
    .default({
      tool_routing: {
        mode: "hybrid_container_builtin_gateway_host",
        allow_external_mcp: false,
      },
    }),
  system_memory_refs: z
    .array(
      z.object({
        namespace: z.string().min(1),
        key: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .optional()
    .default([]),
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

const stageAttachmentsBodySchema: z.ZodType<Omit<
  AgentStageAttachmentsRequest,
  "task_id"
>> = z.object({
  session_id: z.string().min(1),
  attachment_mount_path: z.string().min(1),
  attachments: z
    .array(
      z.object({
        name: z.string().min(1),
        source_url: z.string().url(),
      }),
    )
    .max(20),
});

interface BuildAgentServerOptions {
  logger?: boolean;
  startedAt?: Date;
  sdkProvider?: CopilotSdkProvider;
  gatewayBaseUrl?: string;
  gatewaySocketPath?: string;
  gatewayMcpTimeoutSec?: number;
  gatewayInternalToken?: string;
  requiredInternalToken?: string;
}

export function buildAgentServer(options: BuildAgentServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
  });

  const startedAt = options.startedAt ?? new Date();
  const sdkProvider = options.sdkProvider ?? resolveSdkProvider();
  const gatewayMcpClient = new GatewayMcpClient({
    baseUrl: options.gatewayBaseUrl ?? resolveGatewayBaseUrl(),
    socketPath: resolveGatewaySocketPathForOptions(options),
    timeoutSec:
      options.gatewayMcpTimeoutSec ?? resolvePositiveInt(process.env.AGENT_MCP_TIMEOUT_SEC, 30),
    internalToken:
      options.gatewayInternalToken ??
      process.env.AGENT_TO_GATEWAY_INTERNAL_TOKEN ??
      process.env.GATEWAY_INTERNAL_TOKEN,
  });
  const runtimeService = new AgentRuntimeService(sdkProvider, gatewayMcpClient);
  const requiredInternalToken =
    options.requiredInternalToken ?? process.env.GATEWAY_TO_AGENT_INTERNAL_TOKEN;

  app.addHook("onClose", async () => {
    await runtimeService.shutdown();
    if (typeof sdkProvider.shutdown === "function") {
      await sdkProvider.shutdown();
    }
  });

  app.addHook("onReady", async () => {
    await runtimeService.initialize();
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

  app.addHook("onRequest", async (request, reply) => {
    if (!requiredInternalToken || requiredInternalToken.length === 0) {
      return;
    }
    if (request.url === "/health" || request.url === "/ready") {
      return;
    }
    const header = request.headers["x-internal-token"];
    const providedToken = Array.isArray(header) ? header[0] : header;
    if (providedToken === requiredInternalToken) {
      return;
    }
    return reply.code(401).send({
      error: "internal_auth_required",
      message: "Valid internal token is required.",
    });
  });

  app.post("/v1/tasks/run", async (request, reply) => {
    await runtimeService.initialize();
    const payload = parseOrThrow(
      runTaskBodySchema,
      request.body,
      "invalid_agent_run_request",
    );
    const accepted = await runtimeService.runTask(payload);
    return reply.code(202).send(accepted);
  });

  app.post("/v1/tasks/:taskId/attachments/stage", async (request, reply) => {
    await runtimeService.initialize();
    const params = parseOrThrow(taskParamsSchema, request.params, "invalid_task_params");
    const payload = parseOrThrow(
      stageAttachmentsBodySchema,
      request.body,
      "invalid_stage_attachments_request",
    );
    const staged = await runtimeService.stageTaskAttachments({
      task_id: params.taskId,
      session_id: payload.session_id,
      attachment_mount_path: payload.attachment_mount_path,
      attachments: payload.attachments,
    });
    return reply.code(200).send(staged);
  });

  app.get("/v1/tasks/:taskId", async (request) => {
    await runtimeService.initialize();
    const params = parseOrThrow(taskParamsSchema, request.params, "invalid_task_params");
    return await runtimeService.getTaskStatus(params.taskId);
  });

  app.post("/v1/tasks/:taskId/cancel", async (request) => {
    await runtimeService.initialize();
    const params = parseOrThrow(taskParamsSchema, request.params, "invalid_task_params");
    return runtimeService.cancelTask(params.taskId);
  });

  return app;
}

async function main(): Promise<void> {
  const host = process.env.AGENT_BIND_HOST ?? "0.0.0.0";
  const port = resolvePositiveInt(process.env.AGENT_PORT, 3801);
  const socketPath = resolveAgentSocketPath();
  const sdkProvider = resolveSdkProvider();
  const app = buildAgentServer({
    sdkProvider,
  });

  if (socketPath) {
    cleanupStaleSocket(socketPath);
    await app.listen({ path: socketPath });
    app.log.info(`[agent] listening on socket ${socketPath}`);
  } else {
    await app.listen({ host, port });
    app.log.info(`[agent] listening on ${host}:${port}`);
  }

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
    sessionRootDirectory: resolveAgentSessionRootDirectory(
      process.env.AGENT_SESSION_ROOT_DIR,
    ),
    sendTimeoutMs: resolvePositiveInt(process.env.COPILOT_SEND_TIMEOUT_MS, 180000),
    sdkLogLevel: resolveCopilotSdkLogLevel(process.env.COPILOT_SDK_LOG_LEVEL),
  });
}

function resolveGatewayBaseUrl(): string {
  return process.env.AGENT_GATEWAY_BASE_URL ?? "http://host.docker.internal:3800";
}

function resolveGatewaySocketPath(): string | undefined {
  if (resolveInternalConnectionMode() !== "uds") {
    return undefined;
  }
  const raw =
    process.env.AGENT_GATEWAY_API_SOCKET_PATH ?? process.env.GATEWAY_API_SOCKET_PATH;
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  return path.resolve(raw);
}

function resolveGatewaySocketPathForOptions(
  options: BuildAgentServerOptions,
): string | undefined {
  if (options.gatewaySocketPath !== undefined) {
    return options.gatewaySocketPath;
  }
  if (options.gatewayBaseUrl !== undefined) {
    return undefined;
  }
  return resolveGatewaySocketPath();
}

function resolveAgentSocketPath(): string | null {
  if (resolveInternalConnectionMode() !== "uds") {
    return null;
  }
  const raw = process.env.AGENT_SOCKET_PATH;
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  return path.resolve(raw);
}

function resolveInternalConnectionMode(): "tcp" | "uds" {
  const raw = (process.env.INTERNAL_CONNECTION_MODE ?? "").toLowerCase();
  if (raw === "tcp" || raw === "uds") {
    return raw;
  }
  return "tcp";
}

function resolveAgentSessionRootDirectory(raw: string | undefined): string {
  if (!raw || raw.trim().length === 0) {
    return "/agent/session";
  }
  return path.resolve(raw);
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

function cleanupStaleSocket(socketPath: string): void {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  if (!existsSync(socketPath)) {
    return;
  }
  unlinkSync(socketPath);
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
