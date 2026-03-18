import { AgentRuntimeError } from "./errors.js";
import type { ToolCallRequestPayload, ToolCallResult } from "./types.js";

export interface GatewayMcpClientOptions {
  baseUrl: string;
  timeoutSec: number;
}

export class GatewayMcpClient {
  constructor(private readonly options: GatewayMcpClientOptions) {}

  async toolCall(input: ToolCallRequestPayload): Promise<ToolCallResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutSec * 1000);

    try {
      const response = await fetch(`${this.options.baseUrl}/v1/mcp/tool-call`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      const payload = await parseJson(response);
      if (!response.ok) {
        throw new AgentRuntimeError(
          502,
          "gateway_mcp_error",
          "Gateway MCP endpoint returned non-success response.",
          {
            status: response.status,
            status_text: response.statusText,
            payload,
          },
        );
      }

      return payload as ToolCallResult;
    } catch (error) {
      if (isAbortError(error)) {
        throw new AgentRuntimeError(
          504,
          "gateway_mcp_timeout",
          "Gateway MCP request timed out.",
          {
            timeout_sec: this.options.timeoutSec,
          },
        );
      }

      if (error instanceof AgentRuntimeError) {
        throw error;
      }

      throw new AgentRuntimeError(
        502,
        "gateway_mcp_unreachable",
        "Gateway MCP endpoint is unreachable.",
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
