import { GatewayApiError } from "../gateway/errors.js";
import http from "node:http";
import type { GatewaySummaryLogger } from "../logging/summaryLogger.js";

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
  internalToken?: string;
  socketPath?: string;
  summaryLogger?: Pick<GatewaySummaryLogger, "log">;
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
    const traceContext = extractTraceContext(pathname, payload);
    const startedAtMs = Date.now();
    const startEvent = inferStartEvent(method, pathname, payload);
    this.options.summaryLogger?.log({
      hop: "G2A",
      event: startEvent.event,
      traceId: traceContext.traceId,
      summary: startEvent.summary,
      status: "sent",
    });

    const hasBody = payload !== undefined;
    const headers: Record<string, string> = {};
    if (hasBody) {
      headers["content-type"] = "application/json; charset=utf-8";
    }
    if (this.options.internalToken && this.options.internalToken.length > 0) {
      headers["x-internal-token"] = this.options.internalToken;
    }

    try {
      const response =
        this.options.socketPath && this.options.socketPath.trim().length > 0
          ? await this.requestViaSocket(
              method,
              pathname,
              hasBody ? JSON.stringify(payload) : null,
              headers,
            )
          : await this.requestViaHttp(
              method,
              pathname,
              hasBody ? JSON.stringify(payload) : null,
              headers,
            );
      const resultEvent = inferResultEvent(method, pathname, response);
      this.options.summaryLogger?.log({
        hop: "G2A",
        event: resultEvent.event,
        traceId: traceContext.traceId,
        summary: resultEvent.summary,
        status: resultEvent.status,
        latencyMs: Date.now() - startedAtMs,
      });
      return response;
    } catch (error) {
      const gatewayError = toGatewayApiError(error);
      this.options.summaryLogger?.log({
        level: gatewayError.statusCode >= 500 ? "error" : "warn",
        hop: "G2A",
        event: "gateway.agent.request.result",
        traceId: traceContext.traceId,
        summary: `${method} ${pathname}`,
        status: gatewayError.code,
        latencyMs: Date.now() - startedAtMs,
      });
      throw error;
    }
  }

  private async requestViaHttp(
    method: "GET" | "POST",
    pathname: string,
    body: string | null,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutSec * 1000);
    try {
      const response = await fetch(`${this.options.baseUrl}${pathname}`, {
        method,
        headers,
        body: body ?? undefined,
        signal: controller.signal,
      });
      const responseBody = await parseJson(response);
      if (!response.ok) {
        throw new GatewayApiError(
          502,
          "agent_runtime_error",
          "Agent runtime returned non-success response.",
          {
            status: response.status,
            statusText: response.statusText,
            body: responseBody,
          },
        );
      }
      return responseBody;
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

  private async requestViaSocket(
    method: "GET" | "POST",
    pathname: string,
    body: string | null,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const socketPath = this.options.socketPath;
    if (!socketPath || socketPath.trim().length === 0) {
      throw new GatewayApiError(
        500,
        "agent_runtime_socket_path_invalid",
        "Agent runtime socket path is invalid.",
      );
    }
    try {
      const response = await requestJsonViaUnixSocket({
        socketPath,
        pathname,
        method,
        timeoutSec: this.options.timeoutSec,
        headers,
        body,
      });
      const responseBody = parseTextAsJson(response.bodyText);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new GatewayApiError(
          502,
          "agent_runtime_error",
          "Agent runtime returned non-success response.",
          {
            status: response.statusCode,
            statusText: response.statusMessage,
            body: responseBody,
          },
        );
      }
      return responseBody;
    } catch (error) {
      if (error instanceof GatewayApiError) {
        throw error;
      }
      if (error instanceof UnixSocketRequestTimeoutError) {
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

interface UnixSocketRequestInput {
  socketPath: string;
  pathname: string;
  method: "GET" | "POST";
  timeoutSec: number;
  headers: Record<string, string>;
  body: string | null;
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
    const requestHeaders = {
      ...input.headers,
      ...(input.body
        ? {
            "content-length": Buffer.byteLength(input.body, "utf8").toString(),
          }
        : {}),
    };
    const req = http.request(
      {
        socketPath: input.socketPath,
        path: input.pathname,
        method: input.method,
        headers: requestHeaders,
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
    if (input.body) {
      req.write(input.body);
    }
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

function inferStartEvent(
  method: "GET" | "POST",
  pathname: string,
  payload: unknown,
): { event: string; summary: string } {
  if (method === "POST" && pathname === "/v1/tasks/run") {
    const body = asRecord(payload);
    const mode =
      asRecord(body?.runtime_policy)?.tool_routing &&
      typeof asRecord(asRecord(body?.runtime_policy)?.tool_routing)?.mode === "string"
        ? String(asRecord(asRecord(body?.runtime_policy)?.tool_routing)?.mode)
        : "unknown";
    return {
      event: "gateway.agent.run.request",
      summary: `POST /v1/tasks/run mode=${mode}`,
    };
  }
  if (method === "GET" && pathname.startsWith("/v1/tasks/")) {
    return {
      event: "gateway.agent.status.poll",
      summary: `GET ${pathname}`,
    };
  }
  if (method === "POST" && pathname.endsWith("/cancel")) {
    return {
      event: "gateway.agent.cancel.request",
      summary: `POST ${pathname}`,
    };
  }
  if (method === "POST" && pathname.includes("/attachments/stage")) {
    return {
      event: "gateway.agent.attachments.stage",
      summary: `POST ${pathname}`,
    };
  }
  return {
    event: "gateway.agent.request",
    summary: `${method} ${pathname}`,
  };
}

function inferResultEvent(
  method: "GET" | "POST",
  pathname: string,
  response: unknown,
): { event: string; summary: string; status: string } {
  const payload = asRecord(response);
  if (method === "POST" && pathname === "/v1/tasks/run") {
    const bootstrapMode = readString(payload, "bootstrap_mode") ?? "unknown";
    return {
      event: "agent.gateway.run.accepted",
      summary: `bootstrap=${bootstrapMode}`,
      status: "accepted",
    };
  }
  if (method === "GET" && pathname.startsWith("/v1/tasks/")) {
    const status = readString(payload, "status") ?? "unknown";
    return {
      event: "agent.gateway.status.snapshot",
      summary: `status=${status}`,
      status,
    };
  }
  if (method === "POST" && pathname.endsWith("/cancel")) {
    const status = readString(payload, "status") ?? "canceled";
    return {
      event: "agent.gateway.cancel.result",
      summary: `status=${status}`,
      status,
    };
  }
  if (method === "POST" && pathname.includes("/attachments/stage")) {
    const stagedCount = readNumber(payload, "staged_count");
    return {
      event: "agent.gateway.attachments.staged",
      summary: `staged=${stagedCount ?? 0}`,
      status: "ok",
    };
  }
  return {
    event: "gateway.agent.request.result",
    summary: `${method} ${pathname}`,
    status: "ok",
  };
}

function extractTraceContext(
  pathname: string,
  payload: unknown,
): {
  traceId: string;
} {
  const body = asRecord(payload);
  const traceFromBody =
    readString(body, "task_id") ??
    readString(body, "taskId") ??
    extractTaskIdFromPath(pathname);
  return {
    traceId: traceFromBody ?? `gateway-${Date.now()}`,
  };
}

function extractTaskIdFromPath(pathname: string): string | null {
  const matched = pathname.match(/^\/v1\/tasks\/([^/]+)/);
  if (!matched) {
    return null;
  }
  const raw = matched[1];
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  return decodeURIComponent(raw);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: Record<string, unknown> | null, key: string): string | null {
  if (!value) {
    return null;
  }
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  return raw;
}

function readNumber(value: Record<string, unknown> | null, key: string): number | null {
  if (!value) {
    return null;
  }
  const raw = value[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return raw;
}

function toGatewayApiError(error: unknown): GatewayApiError {
  if (error instanceof GatewayApiError) {
    return error;
  }
  if (error instanceof Error) {
    return new GatewayApiError(500, "gateway_runtime_client_error", error.message);
  }
  return new GatewayApiError(500, "gateway_runtime_client_error", String(error));
}
