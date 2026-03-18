import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GatewayApiError } from "./errors.js";
import type { GatewayApiService } from "./service.js";

const threadParamsSchema = z.object({
  threadId: z.string().min(1),
});

const mentionStartBodySchema = z.object({
  userId: z.string().min(1),
  channelId: z.string().min(1),
  threadId: z.string().min(1),
  prompt: z.string().min(1),
  attachmentNames: z.array(z.string().min(1)).optional().default([]),
});

const threadMessageBodySchema = z.object({
  userId: z.string().min(1),
  prompt: z.string().min(1),
  attachmentNames: z.array(z.string().min(1)).optional().default([]),
});

const threadActionBodySchema = z.object({
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

  app.get("/v1/sessions", async (request) => {
    const query = parseOrThrow(
      listSessionsQuerySchema,
      request.query,
      "invalid_sessions_query",
    );

    const sessions = await service.listUserSessions(query.userId, query.limit);
    return { sessions };
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
