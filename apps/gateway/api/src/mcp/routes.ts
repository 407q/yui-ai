import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GatewayApiError } from "../gateway/errors.js";
import type { McpToolService } from "./service.js";

const toolCallBodySchema = z.object({
  task_id: z.string().min(1),
  session_id: z.string().min(1),
  call_id: z.string().min(1),
  tool_name: z.string().min(1),
  execution_target: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  reason: z.string().min(1),
});

export async function registerMcpRoutes(
  app: FastifyInstance,
  service: McpToolService,
): Promise<void> {
  app.post("/v1/mcp/tool-call", async (request) => {
    const body = parseOrThrow(
      toolCallBodySchema,
      request.body,
      "invalid_mcp_tool_call_request",
    );

    return service.executeToolCall({
      taskId: body.task_id,
      sessionId: body.session_id,
      callId: body.call_id,
      toolName: body.tool_name,
      executionTarget: body.execution_target,
      arguments: body.arguments,
      reason: body.reason,
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
