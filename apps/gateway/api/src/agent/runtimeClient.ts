import { GatewayApiError } from "../gateway/errors.js";

export type AgentRuntimeTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export interface AgentRuntimeToolCall {
  tool_name: string;
  execution_target?: string;
  arguments: Record<string, unknown>;
  reason: string;
  delay_ms?: number;
}

export interface AgentRuntimeAttachmentSource {
  name: string;
  source_url: string;
}

export interface AgentRuntimeRunTaskInput {
  task_id: string;
  session_id: string;
  prompt: string;
  thread_context: {
    channel_id: string;
    thread_id: string;
  };
  session_workspace_root?: string;
  attachment_mount_path?: string;
  runtime_policy: {
    tool_routing: {
      mode: "gateway_only" | "hybrid_container_builtin_gateway_host";
      allow_external_mcp: boolean;
    };
  };
  system_memory_refs?: Array<{
    namespace: string;
    key: string;
    reason: string;
  }>;
  tool_calls?: AgentRuntimeToolCall[];
}

export interface AgentRuntimeStageAttachmentsInput {
  task_id: string;
  session_id: string;
  attachment_mount_path: string;
  attachments: AgentRuntimeAttachmentSource[];
}

export interface AgentRuntimeStageAttachmentsResponse {
  task_id: string;
  session_id: string;
  attachment_mount_path: string;
  staged_count: number;
  staged_files: Array<{
    name: string;
    path: string;
    bytes: number;
  }>;
}

export interface AgentRuntimeTaskSnapshot {
  task_id: string;
  session_id: string;
  status: AgentRuntimeTaskStatus;
  bootstrap_mode: "create" | "resume";
  send_and_wait_count: number;
  started_at: string;
  updated_at: string;
  completed_at?: string | null;
  result?: {
    final_answer: string;
    tool_results: unknown[];
  } | null;
  tool_events?: Array<{
    call_id: string;
    tool_name: string;
    execution_target: string;
    phase: "start" | "result";
    status?: "ok" | "error";
    error_code?: string;
    message?: string;
    arguments?: Record<string, unknown>;
    reason?: string;
    result?: Record<string, unknown>;
    details?: Record<string, unknown>;
    timestamp: string;
  }> | null;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  } | null;
}

export interface AgentRuntimeClient {
  stageTaskAttachments(
    input: AgentRuntimeStageAttachmentsInput,
  ): Promise<AgentRuntimeStageAttachmentsResponse>;
  runTask(input: AgentRuntimeRunTaskInput): Promise<AgentRuntimeTaskSnapshot>;
  getTaskStatus(taskId: string): Promise<AgentRuntimeTaskSnapshot>;
  cancelTask(taskId: string): Promise<AgentRuntimeTaskSnapshot>;
}

export interface HttpAgentRuntimeClientOptions {
  baseUrl: string;
  timeoutSec: number;
}

export class HttpAgentRuntimeClient implements AgentRuntimeClient {
  constructor(private readonly options: HttpAgentRuntimeClientOptions) {}

  async stageTaskAttachments(
    input: AgentRuntimeStageAttachmentsInput,
  ): Promise<AgentRuntimeStageAttachmentsResponse> {
    const response = await this.request(
      "POST",
      `/v1/tasks/${encodeURIComponent(input.task_id)}/attachments/stage`,
      {
        session_id: input.session_id,
        attachment_mount_path: input.attachment_mount_path,
        attachments: input.attachments,
      },
    );
    return response as AgentRuntimeStageAttachmentsResponse;
  }

  async runTask(input: AgentRuntimeRunTaskInput): Promise<AgentRuntimeTaskSnapshot> {
    const response = await this.request("POST", "/v1/tasks/run", input);
    return response as AgentRuntimeTaskSnapshot;
  }

  async getTaskStatus(taskId: string): Promise<AgentRuntimeTaskSnapshot> {
    const response = await this.request(
      "GET",
      `/v1/tasks/${encodeURIComponent(taskId)}`,
    );
    return response as AgentRuntimeTaskSnapshot;
  }

  async cancelTask(taskId: string): Promise<AgentRuntimeTaskSnapshot> {
    const response = await this.request(
      "POST",
      `/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
    );
    return response as AgentRuntimeTaskSnapshot;
  }

  private async request(
    method: "GET" | "POST",
    pathname: string,
    payload?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutSec * 1000);

    const hasBody = payload !== undefined;
    const headers: Record<string, string> = {};
    if (hasBody) {
      headers["content-type"] = "application/json; charset=utf-8";
    }

    try {
      const response = await fetch(`${this.options.baseUrl}${pathname}`, {
        method,
        headers,
        body: hasBody ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });
      const body = await parseJson(response);
      if (!response.ok) {
        throw new GatewayApiError(
          502,
          "agent_runtime_error",
          "Agent runtime returned non-success response.",
          {
            status: response.status,
            statusText: response.statusText,
            body,
          },
        );
      }
      return body;
    } catch (error) {
      if (error instanceof GatewayApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new GatewayApiError(
          504,
          "agent_runtime_timeout",
          "Agent runtime request timed out.",
          {
            timeout_sec: this.options.timeoutSec,
          },
        );
      }

      throw new GatewayApiError(
        502,
        "agent_runtime_unreachable",
        "Agent runtime is unreachable.",
        {
          message: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      clearTimeout(timeout);
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
