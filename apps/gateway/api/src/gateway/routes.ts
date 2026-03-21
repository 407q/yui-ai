import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GatewayApiError } from "./errors.js";
import type { GatewayApiService } from "./service.js";

const threadParamsSchema = z.object({
  threadId: z.string().min(1),
});

const mentionStartBodySchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1).optional(),
  nickname: z.string().min(1).optional(),
  channelId: z.string().min(1),
  channelName: z.string().min(1).optional(),
  threadId: z.string().min(1),
  threadName: z.string().min(1).optional(),
  prompt: z.string().min(1),
  attachmentNames: z.array(z.string().min(1)).optional().default([]),
});

const threadMessageBodySchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1).optional(),
  nickname: z.string().min(1).optional(),
  channelName: z.string().min(1).optional(),
  threadName: z.string().min(1).optional(),
  prompt: z.string().min(1),
  attachmentNames: z.array(z.string().min(1)).optional().default([]),
});

const threadActionBodySchema = z.object({
  userId: z.string().min(1),
});

const approvalRequestBodySchema = z.object({
  userId: z.string().min(1),
  operation: z.string().min(1),
  path: z.string().min(1),
});

const approvalParamsSchema = z.object({
  approvalId: z.string().min(1),
});

const approvalRespondBodySchema = z.object({
  userId: z.string().min(1).optional(),
  decision: z.enum(["approved", "rejected", "timeout"]),
});

const taskParamsSchema = z.object({
  taskId: z.string().min(1),
});

const agentTaskStatusQuerySchema = z.object({
  includeTaskEvents: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((value) => value === true || value === "true"),
  afterTimestamp: z.string().optional(),
  eventTypes: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => {
      if (!value) {
        return undefined;
      }
      if (Array.isArray(value)) {
        return value;
      }
      return value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }),
  eventsLimit: z.coerce.number().int().min(1).max(500).optional(),
});

const agentToolCallSchema = z.object({
  toolName: z.string().min(1),
  executionTarget: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()),
  reason: z.string().min(1),
  delayMs: z.number().int().min(0).max(10000).optional(),
});

const agentAttachmentSchema = z.object({
  name: z.string().min(1),
  sourceUrl: z.string().url(),
});

const contextEnvelopeBehaviorSchema = z.object({
  botMode: z.enum(["standard", "mock", "unknown"]).optional(),
  sessionStatus: z.string().min(1).optional(),
  infrastructureStatus: z.enum(["ready", "booting", "failed", "unknown"]).optional(),
  toolRoutingPolicy: z
    .enum(["gateway_only", "hybrid_container_builtin_gateway_host"])
    .optional(),
  approvalPolicy: z.enum(["host_ops_require_explicit_approval"]).optional(),
  responseContract: z.enum(["ja, concise, ask_when_ambiguous"]).optional(),
  executionContract: z.enum(["no_external_mcp, no_unapproved_host_ops"]).optional(),
});

const contextEnvelopeRuntimeFeedbackSchema = z.object({
  previousTaskTerminalStatus: z.enum(["completed", "failed", "canceled"]).optional(),
  previousToolErrors: z.array(z.string()).optional(),
  retryHint: z.string().optional(),
  attachmentSources: z.array(agentAttachmentSchema).optional().default([]),
  systemMemoryReferences: z
    .array(
      z.object({
        namespace: z.string().min(1),
        key: z.string().min(1),
        reason: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
});

const contextEnvelopeDiscordSchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1).optional(),
  nickname: z.string().min(1).optional(),
  channelId: z.string().min(1),
  channelName: z.string().optional(),
  threadId: z.string().min(1),
  threadName: z.string().optional(),
});

const contextEnvelopeSchema = z.object({
  behavior: contextEnvelopeBehaviorSchema.optional(),
  runtimeFeedback: contextEnvelopeRuntimeFeedbackSchema.optional(),
  discord: contextEnvelopeDiscordSchema.optional(),
});

const agentRunBodySchema = z.object({
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  prompt: z.string().min(1),
  attachmentNames: z.array(z.string().min(1)).optional().default([]),
  attachmentMountPath: z.string().optional(),
  contextEnvelope: contextEnvelopeSchema.optional(),
  toolCalls: z.array(agentToolCallSchema).optional().default([]),
});

const agentCancelBodySchema = z.object({
  userId: z.string().min(1),
});

const listSessionsQuerySchema = z.object({
  userId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export async function registerGatewayRoutes(
  app: FastifyInstance,
  service: GatewayApiService,
): Promise<void> {
  app.get("/health", async () => {
    await service.ping();
    return {
      status: "ok",
      service: "gateway-api",
    };
  });

  app.post("/v1/discord/mentions/start", async (request, reply) => {
    const body = parseOrThrow(
      mentionStartBodySchema,
      request.body,
      "invalid_mentions_start_request",
    );
    const result = await service.startFromMention(body);
    return reply.code(201).send({
      session: result.session,
      taskId: result.taskId,
    });
  });

  app.post("/v1/threads/:threadId/messages", async (request) => {
    const params = parseOrThrow(
      threadParamsSchema,
      request.params,
      "invalid_thread_params",
    );
    const body = parseOrThrow(
      threadMessageBodySchema,
      request.body,
      "invalid_thread_message_request",
    );

    const result = await service.handleThreadMessage({
      ...body,
      threadId: params.threadId,
    });

    return {
      session: result.session,
      taskId: result.taskId,
      resumedFromIdle: result.resumedFromIdle,
    };
  });

  app.get("/v1/threads/:threadId/status", async (request) => {
    const params = parseOrThrow(
      threadParamsSchema,
      request.params,
      "invalid_thread_params",
    );
    const status = await service.getThreadStatus(params.threadId);
    return status;
  });

  app.post("/v1/threads/:threadId/cancel", async (request) => {
    const params = parseOrThrow(
      threadParamsSchema,
      request.params,
      "invalid_thread_params",
    );
    const body = parseOrThrow(
      threadActionBodySchema,
      request.body,
      "invalid_thread_cancel_request",
    );
    const result = await service.cancelThreadTask({
      threadId: params.threadId,
      userId: body.userId,
    });
    return result;
  });

  app.post("/v1/threads/:threadId/close", async (request) => {
    const params = parseOrThrow(
      threadParamsSchema,
      request.params,
      "invalid_thread_params",
    );
    const body = parseOrThrow(
      threadActionBodySchema,
      request.body,
      "invalid_thread_close_request",
    );
    const result = await service.closeThreadSession({
      threadId: params.threadId,
      userId: body.userId,
    });
    return result;
  });

  app.post("/v1/threads/:threadId/approvals/request", async (request) => {
    const params = parseOrThrow(
      threadParamsSchema,
      request.params,
      "invalid_thread_params",
    );
    const body = parseOrThrow(
      approvalRequestBodySchema,
      request.body,
      "invalid_approval_request",
    );

    const result = await service.requestApproval({
      threadId: params.threadId,
      userId: body.userId,
      operation: body.operation,
      path: body.path,
    });

    return {
      session: result.session,
      task: result.task,
      approval: result.approval,
    };
  });

  app.post("/v1/approvals/:approvalId/respond", async (request) => {
    const params = parseOrThrow(
      approvalParamsSchema,
      request.params,
      "invalid_approval_params",
    );
    const body = parseOrThrow(
      approvalRespondBodySchema,
      request.body,
      "invalid_approval_respond_request",
    );

    const result = await service.respondApproval({
      approvalId: params.approvalId,
      decision: body.decision,
      responderId: body.userId ?? null,
    });
    return {
      session: result.session,
      task: result.task,
      approval: result.approval,
    };
  });

  app.get("/v1/sessions", async (request) => {
    const query = parseOrThrow(
      listSessionsQuerySchema,
      request.query,
      "invalid_sessions_query",
    );

    const sessions = await service.listUserSessions(query.userId, query.limit);
    return { sessions };
  });

  app.post("/v1/agent/tasks/run", async (request) => {
    const body = parseOrThrow(
      agentRunBodySchema,
      request.body,
      "invalid_agent_run_request",
    );
    const result = await service.runAgentTask({
      taskId: body.taskId,
      sessionId: body.sessionId,
      userId: body.userId,
      prompt: body.prompt,
      attachmentNames: body.attachmentNames,
      attachmentMountPath: body.attachmentMountPath,
      contextEnvelope: body.contextEnvelope,
      toolCalls: body.toolCalls.map((toolCall) => ({
        tool_name: toolCall.toolName,
        execution_target: toolCall.executionTarget,
        arguments: toolCall.arguments,
        reason: toolCall.reason,
        delay_ms: toolCall.delayMs,
      })),
    });
    return result;
  });

  app.get("/v1/agent/tasks/:taskId/status", async (request) => {
    const params = parseOrThrow(
      taskParamsSchema,
      request.params,
      "invalid_task_params",
    );
    const query = parseOrThrow(
      agentTaskStatusQuerySchema,
      request.query,
      "invalid_agent_task_status_query",
    );
    return service.getAgentTaskStatus({
      taskId: params.taskId,
      includeTaskEvents: query.includeTaskEvents,
      afterTimestamp: query.afterTimestamp,
      eventTypes: query.eventTypes,
      eventsLimit: query.eventsLimit,
    });
  });

  app.post("/v1/agent/tasks/:taskId/cancel", async (request) => {
    const params = parseOrThrow(
      taskParamsSchema,
      request.params,
      "invalid_task_params",
    );
    const body = parseOrThrow(
      agentCancelBodySchema,
      request.body,
      "invalid_agent_cancel_request",
    );
    return service.cancelAgentTask({
      taskId: params.taskId,
      userId: body.userId,
    });
  });
}

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: string,
): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }

  throw new GatewayApiError(400, code, "Invalid request payload.", {
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    })),
  });
}
