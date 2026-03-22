import { AgentRuntimeError } from "./errors.js";
import type { ToolCallRequestPayload, ToolCallResult } from "./types.js";

export interface GatewayMcpClientOptions {
  baseUrl: string;
  timeoutSec: number;
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
      const response = await fetch(`${this.options.baseUrl}${pathname}`, {
        method,
        headers: {
          "content-type": "application/json; charset=utf-8",
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
