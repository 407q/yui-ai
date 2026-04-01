import { AgentRuntimeError } from "./errors.js";
import type { ToolCallRequestPayload, ToolCallResult } from "./types.js";
import http from "node:http";

export interface GatewayMcpClientOptions {
  baseUrl: string;
  timeoutSec: number;
  internalToken?: string;
  socketPath?: string;
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
    return payload as ToolCallResult;
  }

  async requestApprovalAndWait(
    input: ApprovalRequestAndWaitInput,
  ): Promise<ApprovalRequestAndWaitResult> {
    const timeoutSec = Math.max(this.options.timeoutSec, input.timeoutSec + 5);
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
    return payload as ApprovalRequestAndWaitResult;
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
