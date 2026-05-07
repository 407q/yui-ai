import { AgentRuntimeError } from "./errors.js";
import type { AgentTraceLoggerLike } from "./traceLogger.js";
import type { ToolCallRequestPayload, ToolCallResult } from "./types.js";
import http from "node:http";

export interface GatewayMcpClientOptions {
  baseUrl: string;
  timeoutSec: number;
  internalToken?: string;
  socketPath?: string;
  traceLogger?: AgentTraceLoggerLike;
}

export interface ApprovalRequestAndWaitInput {
  taskId: string;
  sessionId: string;
  toolName?: string;
  operation: string;
  path: string;
  timeoutSec: number;
}

export interface ApprovalRequestAndWaitResult {
  decision: "approved" | "rejected" | "timeout" | "canceled";
  approval: {
    approval_id: string;
    status: string;
    operation: string;
    path: string;
  } | null;
}

export class GatewayMcpClient {
  constructor(private readonly options: GatewayMcpClientOptions) {}

  async toolCall(input: ToolCallRequestPayload): Promise<ToolCallResult> {
    const startedAtMs = Date.now();
    this.options.traceLogger?.log({
      actor: "agent",
      event: "agent.mcp.tool_call.start",
      trace_id: input.task_id,
      session_id: input.session_id,
      task_id: input.task_id,
      call_id: input.call_id,
      direction: "outbound",
      peer: "gateway_mcp",
      status: "started",
      hop: "A2M",
      summary: `tool=${input.tool_name} call=${input.call_id}`,
      payload: {
        tool_name: input.tool_name,
        execution_target: input.execution_target,
        reason: input.reason,
      },
    });
    try {
      const payload = await this.requestWithTimeout(
        "POST",
        "/v1/mcp/tool-call",
        input,
        this.options.timeoutSec,
        {
          nonSuccessCode: "gateway_mcp_error",
          nonSuccessMessage: "Gateway MCP endpoint returned non-success response.",
          timeoutCode: "gateway_mcp_timeout",
          timeoutMessage: "Gateway MCP request timed out.",
          unreachableCode: "gateway_mcp_unreachable",
          unreachableMessage: "Gateway MCP endpoint is unreachable.",
        },
      );
      const result = payload as ToolCallResult;
      this.options.traceLogger?.log({
        actor: "agent",
        event: "agent.mcp.tool_call.result",
        trace_id: input.task_id,
        session_id: input.session_id,
        task_id: input.task_id,
        call_id: input.call_id,
        direction: "inbound",
        peer: "gateway_mcp",
        status: result.status,
        hop: "A2M",
        latency_ms: Date.now() - startedAtMs,
        summary: `tool=${input.tool_name} call=${input.call_id}`,
        payload: result.status === "ok" ? { status: "ok" } : { error_code: result.error_code },
      });
      return result;
    } catch (error) {
      const runtimeError = toRuntimeError(error);
      this.options.traceLogger?.log({
        level: runtimeError.code === "gateway_mcp_timeout" ? "warn" : "error",
        actor: "agent",
        event: "agent.mcp.tool_call.result",
        trace_id: input.task_id,
        session_id: input.session_id,
        task_id: input.task_id,
        call_id: input.call_id,
        direction: "inbound",
        peer: "gateway_mcp",
        status: runtimeError.code === "gateway_mcp_timeout" ? "timeout" : "error",
        hop: "A2M",
        latency_ms: Date.now() - startedAtMs,
        summary: `tool=${input.tool_name} call=${input.call_id}`,
        error: {
          code: runtimeError.code,
          message: runtimeError.message,
          details: runtimeError.details,
        },
      });
      throw error;
    }
  }

  async requestApprovalAndWait(
    input: ApprovalRequestAndWaitInput,
  ): Promise<ApprovalRequestAndWaitResult> {
    const timeoutSec = Math.max(this.options.timeoutSec, input.timeoutSec + 5);
    const startedAtMs = Date.now();
    this.options.traceLogger?.log({
      actor: "agent",
      event: "agent.mcp.approval.wait",
      trace_id: input.taskId,
      session_id: input.sessionId,
      task_id: input.taskId,
      direction: "outbound",
      peer: "gateway_approval",
      status: "waiting",
      hop: "A2M",
      summary: `op=${input.operation} path=${input.path}`,
      payload: {
        tool_name: input.toolName ?? null,
        timeout_sec: timeoutSec,
      },
    });
    try {
      const payload = await this.requestWithTimeout(
        "POST",
        "/v1/agent/approvals/request-and-wait",
        input,
        timeoutSec,
        {
          nonSuccessCode: "gateway_approval_error",
          nonSuccessMessage:
            "Gateway approval endpoint returned non-success response.",
          timeoutCode: "gateway_approval_timeout",
          timeoutMessage: "Gateway approval request timed out.",
          unreachableCode: "gateway_approval_unreachable",
          unreachableMessage: "Gateway approval endpoint is unreachable.",
        },
      );
      const result = payload as ApprovalRequestAndWaitResult;
      this.options.traceLogger?.log({
        actor: "agent",
        event: "agent.mcp.approval.result",
        trace_id: input.taskId,
        session_id: input.sessionId,
        task_id: input.taskId,
        direction: "inbound",
        peer: "gateway_approval",
        status: result.decision,
        hop: "A2M",
        latency_ms: Date.now() - startedAtMs,
        summary: `op=${input.operation} path=${input.path}`,
        payload: {
          approval_id: result.approval?.approval_id ?? null,
        },
      });
      return result;
    } catch (error) {
      const runtimeError = toRuntimeError(error);
      this.options.traceLogger?.log({
        level: runtimeError.code === "gateway_approval_timeout" ? "warn" : "error",
        actor: "agent",
        event: "agent.mcp.approval.result",
        trace_id: input.taskId,
        session_id: input.sessionId,
        task_id: input.taskId,
        direction: "inbound",
        peer: "gateway_approval",
        status: runtimeError.code === "gateway_approval_timeout" ? "timeout" : "error",
        hop: "A2M",
        latency_ms: Date.now() - startedAtMs,
        summary: `op=${input.operation} path=${input.path}`,
        error: {
          code: runtimeError.code,
          message: runtimeError.message,
          details: runtimeError.details,
        },
      });
      throw error;
    }
  }

  private async requestWithTimeout(
    method: "GET" | "POST",
    pathname: string,
    payload: unknown,
    timeoutSec: number,
    errorSpec: {
      nonSuccessCode: string;
      nonSuccessMessage: string;
      timeoutCode: string;
      timeoutMessage: string;
      unreachableCode: string;
      unreachableMessage: string;
    },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutSec * 1000);

    try {
      if (this.options.socketPath && this.options.socketPath.trim().length > 0) {
        return await this.requestWithUnixSocket(
          method,
          pathname,
          payload,
          timeoutSec,
          errorSpec,
        );
      }
      const response = await fetch(`${this.options.baseUrl}${pathname}`, {
        method,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...(this.options.internalToken && this.options.internalToken.length > 0
            ? { "x-internal-token": this.options.internalToken }
            : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const responsePayload = await parseJson(response);
      if (!response.ok) {
        throw new AgentRuntimeError(
          502,
          errorSpec.nonSuccessCode,
          errorSpec.nonSuccessMessage,
          {
            status: response.status,
            status_text: response.statusText,
            payload: responsePayload,
          },
        );
      }

      return responsePayload;
    } catch (error) {
      if (isAbortError(error)) {
        throw new AgentRuntimeError(
          504,
          errorSpec.timeoutCode,
          errorSpec.timeoutMessage,
          {
            timeout_sec: timeoutSec,
          },
        );
      }

      if (error instanceof AgentRuntimeError) {
        throw error;
      }

      throw new AgentRuntimeError(
        502,
        errorSpec.unreachableCode,
        errorSpec.unreachableMessage,
        {
          message: toErrorMessage(error),
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestWithUnixSocket(
    method: "GET" | "POST",
    pathname: string,
    payload: unknown,
    timeoutSec: number,
    errorSpec: {
      nonSuccessCode: string;
      nonSuccessMessage: string;
      timeoutCode: string;
      timeoutMessage: string;
      unreachableCode: string;
      unreachableMessage: string;
    },
  ): Promise<unknown> {
    const socketPath = this.options.socketPath;
    if (!socketPath || socketPath.trim().length === 0) {
      throw new AgentRuntimeError(
        500,
        "gateway_socket_path_invalid",
        "Gateway socket path is invalid.",
      );
    }
    try {
      const response = await requestJsonViaUnixSocket({
        socketPath,
        pathname,
        method,
        timeoutSec,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...(this.options.internalToken && this.options.internalToken.length > 0
            ? { "x-internal-token": this.options.internalToken }
            : {}),
        },
        body: JSON.stringify(payload),
      });
      const responsePayload = parseTextAsJson(response.bodyText);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new AgentRuntimeError(
          502,
          errorSpec.nonSuccessCode,
          errorSpec.nonSuccessMessage,
          {
            status: response.statusCode,
            status_text: response.statusMessage,
            payload: responsePayload,
          },
        );
      }
      return responsePayload;
    } catch (error) {
      if (error instanceof AgentRuntimeError) {
        throw error;
      }
      if (error instanceof UnixSocketRequestTimeoutError) {
        throw new AgentRuntimeError(
          504,
          errorSpec.timeoutCode,
          errorSpec.timeoutMessage,
          {
            timeout_sec: timeoutSec,
          },
        );
      }
      throw new AgentRuntimeError(
        502,
        errorSpec.unreachableCode,
        errorSpec.unreachableMessage,
        {
          message: toErrorMessage(error),
          socket_path: socketPath,
        },
      );
    }
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text || text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toRuntimeError(error: unknown): AgentRuntimeError {
  if (error instanceof AgentRuntimeError) {
    return error;
  }
  if (error instanceof Error) {
    return new AgentRuntimeError(500, "gateway_mcp_unknown_error", error.message);
  }
  return new AgentRuntimeError(500, "gateway_mcp_unknown_error", String(error));
}

interface UnixSocketRequestInput {
  socketPath: string;
  pathname: string;
  method: "GET" | "POST";
  timeoutSec: number;
  headers: Record<string, string>;
  body: string;
}

interface UnixSocketResponse {
  statusCode: number;
  statusMessage: string;
  bodyText: string;
}

class UnixSocketRequestTimeoutError extends Error {
  constructor(timeoutSec: number) {
    super(`Unix socket request timed out after ${timeoutSec}s`);
    this.name = "UnixSocketRequestTimeoutError";
  }
}

function requestJsonViaUnixSocket(
  input: UnixSocketRequestInput,
): Promise<UnixSocketResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: input.socketPath,
        path: input.pathname,
        method: input.method,
        headers: {
          ...input.headers,
          "content-length": Buffer.byteLength(input.body, "utf8").toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(
            typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
          );
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? "",
            bodyText: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", (error) => {
      reject(error);
    });
    req.setTimeout(input.timeoutSec * 1000, () => {
      req.destroy(new UnixSocketRequestTimeoutError(input.timeoutSec));
    });
    req.write(input.body);
    req.end();
  });
}

function parseTextAsJson(text: string): unknown {
  if (!text || text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
