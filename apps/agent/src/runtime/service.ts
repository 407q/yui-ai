import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentAttachmentSource,
  AgentRunAcceptedResponse,
  AgentRunRequest,
  AgentStagedAttachmentFile,
  AgentStageAttachmentsRequest,
  AgentStageAttachmentsResponse,
  AgentTaskStatus,
  AgentTaskStatusResponse,
  PermissionRequestInput,
  PermissionRequestResult,
  SessionBootstrapMode,
  ToolCallResult,
} from "./types.js";
import { AgentRuntimeError } from "./errors.js";
import type { GatewayMcpClient } from "./gatewayMcpClient.js";
import type {
  CopilotSdkProvider,
  SdkSessionHandle,
  SendAndWaitResult,
} from "./sdkProvider.js";

interface SessionState {
  sdkSession: SdkSessionHandle;
  updatedAt: Date;
}

interface TaskExecutionState {
  taskId: string;
  sessionId: string;
  status: AgentTaskStatus;
  bootstrapMode: SessionBootstrapMode;
  sendAndWaitCount: number;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  result: {
    final_answer: string;
    tool_results: ToolCallResult[];
  } | null;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  } | null;
  abortController: AbortController;
}

const DEFAULT_SESSION_ROOT_DIR = "/agent/session";
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 20;
const MAX_ATTACHMENT_BASENAME_LENGTH = 120;

export class AgentRuntimeService {
  private readonly sessions = new Map<string, SessionState>();
  private readonly tasks = new Map<string, TaskExecutionState>();

  constructor(
    private readonly sdkProvider: CopilotSdkProvider,
    private readonly gatewayMcpClient: GatewayMcpClient,
  ) {}

  async runTask(input: AgentRunRequest): Promise<AgentRunAcceptedResponse> {
    const existingTask = this.tasks.get(input.task_id);
    if (existingTask) {
      throw new AgentRuntimeError(
        409,
        "task_already_exists",
        "Task already exists in runtime.",
        {
          task_id: input.task_id,
          status: existingTask.status,
        },
      );
    }

    assertGatewayOnlyRouting(input);
    const bootstrapMode: SessionBootstrapMode = this.sessions.has(input.session_id)
      ? "resume"
      : "create";
    const now = new Date();
    const state: TaskExecutionState = {
      taskId: input.task_id,
      sessionId: input.session_id,
      status: "running",
      bootstrapMode,
      sendAndWaitCount: 0,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      result: null,
      error: null,
      abortController: new AbortController(),
    };
    this.tasks.set(input.task_id, state);
    void this.executeTask(state, input);

    return this.toAcceptedResponse(state);
  }

  async stageTaskAttachments(
    input: AgentStageAttachmentsRequest,
  ): Promise<AgentStageAttachmentsResponse> {
    const sessionRootDir = resolveAgentSessionRootDir();
    const normalizedMountPath = normalizeAttachmentMountPath(
      input.attachment_mount_path,
    );
    const expectedTaskAttachmentDir = path.resolve(
      sessionRootDir,
      input.session_id,
      "attachments",
    );
    if (normalizedMountPath !== expectedTaskAttachmentDir) {
      throw new AgentRuntimeError(
        400,
        "invalid_attachment_mount_path",
        "attachment_mount_path must target the session attachments directory.",
        {
          attachment_mount_path: input.attachment_mount_path,
          expected_path: expectedTaskAttachmentDir,
        },
      );
    }

    if (input.attachments.length > MAX_ATTACHMENT_COUNT) {
      throw new AgentRuntimeError(
        400,
        "too_many_attachments",
        "Too many attachments to stage.",
        {
          max_attachments: MAX_ATTACHMENT_COUNT,
          received: input.attachments.length,
        },
      );
    }

    await fs.mkdir(expectedTaskAttachmentDir, { recursive: true });
    const maxAttachmentBytes = resolveMaxAttachmentBytes();
    const stagedFiles: AgentStagedAttachmentFile[] = [];
    const stagedFileNames = new Set<string>();
    for (const attachment of input.attachments) {
      const fileName = makeUniqueAttachmentFileName(
        sanitizeAttachmentFileName(attachment.name),
        stagedFileNames,
      );
      const targetPath = path.resolve(expectedTaskAttachmentDir, fileName);
      if (!isPathInsideDirectory(targetPath, expectedTaskAttachmentDir)) {
        throw new AgentRuntimeError(
          400,
          "invalid_attachment_name",
          "Attachment name resolved outside attachments directory.",
          {
            name: attachment.name,
          },
        );
      }

      const downloaded = await downloadAttachmentBinary(attachment, maxAttachmentBytes);
      await fs.writeFile(targetPath, downloaded.buffer);
      stagedFiles.push({
        name: fileName,
        path: targetPath,
        bytes: downloaded.bytes,
      });
    }

    return {
      task_id: input.task_id,
      session_id: input.session_id,
      attachment_mount_path: expectedTaskAttachmentDir,
      staged_count: stagedFiles.length,
      staged_files: stagedFiles,
    };
  }

  getTaskStatus(taskId: string): AgentTaskStatusResponse {
    const state = this.tasks.get(taskId);
    if (!state) {
      throw new AgentRuntimeError(
        404,
        "task_not_found",
        "Task is not found in runtime.",
        {
          task_id: taskId,
        },
      );
    }

    return this.toStatusResponse(state);
  }

  cancelTask(taskId: string): AgentTaskStatusResponse {
    const state = this.tasks.get(taskId);
    if (!state) {
      throw new AgentRuntimeError(
        404,
        "task_not_found",
        "Task is not found in runtime.",
        {
          task_id: taskId,
        },
      );
    }

    if (state.status === "running") {
      state.abortController.abort();
      state.updatedAt = new Date();
    }

    return this.toStatusResponse(state);
  }

  getRuntimeSummary(): {
    active_tasks: number;
    sessions: number;
  } {
    const activeTasks = [...this.tasks.values()].filter(
      (task) => task.status === "running" || task.status === "queued",
    ).length;
    return {
      active_tasks: activeTasks,
      sessions: this.sessions.size,
    };
  }

  private async executeTask(
    state: TaskExecutionState,
    input: AgentRunRequest,
  ): Promise<void> {
    try {
      const callbacks = {
        onPermissionRequest: async (
          request: PermissionRequestInput,
        ): Promise<PermissionRequestResult> =>
          this.handlePermissionRequest(input, request),
      };

      let sdkSession: SdkSessionHandle;
      if (state.bootstrapMode === "create") {
        sdkSession = await this.sdkProvider.createSession({
          session_id: input.session_id,
          task_id: input.task_id,
          callbacks,
        });
      } else {
        sdkSession = await this.sdkProvider.resumeSession({
          session_id: input.session_id,
          task_id: input.task_id,
          callbacks,
        });
      }
      this.sessions.set(input.session_id, {
        sdkSession,
        updatedAt: new Date(),
      });

      const sendResult = await this.sdkProvider.sendAndWait({
        task_id: input.task_id,
        session_id: input.session_id,
        sdk_session_id: sdkSession.sdk_session_id,
        prompt: input.prompt,
        tool_calls: input.tool_calls ?? [],
        callbacks,
        signal: state.abortController.signal,
        onToolCall: (toolCall) => this.gatewayMcpClient.toolCall(toolCall),
      });
      state.sendAndWaitCount += 1;
      this.completeTask(state, sendResult);
      this.sessions.set(input.session_id, {
        sdkSession,
        updatedAt: new Date(),
      });
    } catch (error) {
      if (isAbortError(error) || state.abortController.signal.aborted) {
        this.cancelTaskState(state);
        return;
      }

      this.failTask(state, error);
    }
  }

  private async handlePermissionRequest(
    input: AgentRunRequest,
    _request: PermissionRequestInput,
  ): Promise<PermissionRequestResult> {
    const mode = input.runtime_policy?.tool_routing?.mode ?? "gateway_only";
    const allowExternal =
      input.runtime_policy?.tool_routing?.allow_external_mcp ?? false;
    if (mode !== "gateway_only" || allowExternal) {
      return {
        decision: "deny",
        reason: "external_mcp_disabled",
      };
    }

    return {
      decision: "allow",
      reason: "delegated_to_gateway_mcp",
    };
  }

  private completeTask(
    state: TaskExecutionState,
    sendResult: SendAndWaitResult,
  ): void {
    state.status = "completed";
    state.result = {
      final_answer: sendResult.final_answer,
      tool_results: sendResult.tool_results,
    };
    state.error = null;
    state.updatedAt = new Date();
    state.completedAt = state.updatedAt;
  }

  private cancelTaskState(state: TaskExecutionState): void {
    state.status = "canceled";
    state.result = null;
    state.error = {
      code: "task_canceled",
      message: "Task execution was canceled.",
    };
    state.updatedAt = new Date();
    state.completedAt = state.updatedAt;
  }

  private failTask(state: TaskExecutionState, error: unknown): void {
    state.status = "failed";
    state.result = null;
    state.error = toTaskError(error);
    state.updatedAt = new Date();
    state.completedAt = state.updatedAt;
  }

  private toAcceptedResponse(state: TaskExecutionState): AgentRunAcceptedResponse {
    return {
      task_id: state.taskId,
      session_id: state.sessionId,
      status: state.status,
      bootstrap_mode: state.bootstrapMode,
      send_and_wait_count: state.sendAndWaitCount,
      started_at: state.startedAt.toISOString(),
      updated_at: state.updatedAt.toISOString(),
    };
  }

  private toStatusResponse(state: TaskExecutionState): AgentTaskStatusResponse {
    return {
      task_id: state.taskId,
      session_id: state.sessionId,
      status: state.status,
      bootstrap_mode: state.bootstrapMode,
      send_and_wait_count: state.sendAndWaitCount,
      started_at: state.startedAt.toISOString(),
      updated_at: state.updatedAt.toISOString(),
      completed_at: state.completedAt ? state.completedAt.toISOString() : null,
      result: state.result,
      error: state.error,
    };
  }
}

function assertGatewayOnlyRouting(input: AgentRunRequest): void {
  const mode = input.runtime_policy?.tool_routing?.mode ?? "gateway_only";
  const allowExternal =
    input.runtime_policy?.tool_routing?.allow_external_mcp ?? false;

  if (mode !== "gateway_only" || allowExternal) {
    throw new AgentRuntimeError(
      400,
      "external_mcp_disabled",
      "Only gateway_only routing without external MCP is supported.",
      {
        mode,
        allow_external_mcp: allowExternal,
      },
    );
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toTaskError(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (error instanceof AgentRuntimeError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  if (error instanceof Error) {
    return {
      code: "task_execution_failed",
      message: error.message,
    };
  }

  return {
    code: "task_execution_failed",
    message: String(error),
  };
}

function resolveAgentSessionRootDir(): string {
  const configured = process.env.AGENT_SESSION_ROOT_DIR;
  if (!configured || configured.trim().length === 0) {
    return path.resolve(DEFAULT_SESSION_ROOT_DIR);
  }
  return path.resolve(configured);
}

function resolveMaxAttachmentBytes(): number {
  const configured = process.env.AGENT_ATTACHMENT_MAX_BYTES;
  if (!configured) {
    return DEFAULT_MAX_ATTACHMENT_BYTES;
  }
  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_ATTACHMENT_BYTES;
  }
  return parsed;
}

function normalizeAttachmentMountPath(attachmentMountPath: string): string {
  if (!attachmentMountPath || attachmentMountPath.trim().length === 0) {
    throw new AgentRuntimeError(
      400,
      "invalid_attachment_mount_path",
      "attachment_mount_path is required.",
    );
  }
  return path.resolve(attachmentMountPath);
}

function isPathInsideDirectory(targetPath: string, baseDirectory: string): boolean {
  const relative = path.relative(baseDirectory, targetPath);
  if (relative === "") {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sanitizeAttachmentFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new AgentRuntimeError(
      400,
      "invalid_attachment_name",
      "Attachment name is empty.",
    );
  }

  const parsed = path.parse(trimmed);
  const safeBase = parsed.name
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_ATTACHMENT_BASENAME_LENGTH);
  const extension = parsed.ext
    .replace(/[^a-zA-Z0-9.]+/g, "")
    .slice(0, 20);

  const base = safeBase.length > 0 ? safeBase : "attachment";
  const fileName = `${base}${extension}`;
  if (fileName === "." || fileName === "..") {
    throw new AgentRuntimeError(
      400,
      "invalid_attachment_name",
      "Attachment name is invalid.",
      {
        name,
      },
    );
  }
  return fileName;
}

function makeUniqueAttachmentFileName(
  fileName: string,
  usedNames: Set<string>,
): string {
  if (!usedNames.has(fileName)) {
    usedNames.add(fileName);
    return fileName;
  }

  const parsed = path.parse(fileName);
  let serial = 2;
  while (serial <= 1000) {
    const candidate = `${parsed.name}_${serial}${parsed.ext}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    serial += 1;
  }
  throw new AgentRuntimeError(
    400,
    "duplicate_attachment_name_overflow",
    "Failed to allocate unique attachment name.",
    {
      name: fileName,
    },
  );
}

async function downloadAttachmentBinary(
  attachment: AgentAttachmentSource,
  maxBytes: number,
): Promise<{ buffer: Buffer; bytes: number }> {
  const sourceUrl = attachment.source_url.trim();
  if (!sourceUrl) {
    throw new AgentRuntimeError(
      400,
      "invalid_attachment_source",
      "Attachment source URL is empty.",
      {
        name: attachment.name,
      },
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    throw new AgentRuntimeError(
      400,
      "invalid_attachment_source",
      "Attachment source URL is invalid.",
      {
        name: attachment.name,
        source_url: sourceUrl,
      },
    );
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new AgentRuntimeError(
      400,
      "invalid_attachment_source_protocol",
      "Attachment source URL must use http or https.",
      {
        name: attachment.name,
        source_url: sourceUrl,
      },
    );
  }

  let response: Response;
  try {
    response = await fetch(parsedUrl);
  } catch (error) {
    throw new AgentRuntimeError(
      502,
      "attachment_download_failed",
      "Failed to download attachment from source URL.",
      {
        name: attachment.name,
        source_url: sourceUrl,
        message: error instanceof Error ? error.message : String(error),
      },
    );
  }

  if (!response.ok) {
    throw new AgentRuntimeError(
      502,
      "attachment_download_failed",
      "Attachment source returned non-success status.",
      {
        name: attachment.name,
        source_url: sourceUrl,
        status: response.status,
        status_text: response.statusText,
      },
    );
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new AgentRuntimeError(
        400,
        "attachment_too_large",
        "Attachment exceeds maximum allowed size.",
        {
          name: attachment.name,
          source_url: sourceUrl,
          max_bytes: maxBytes,
          content_length: contentLength,
        },
      );
    }
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength > maxBytes) {
    throw new AgentRuntimeError(
      400,
      "attachment_too_large",
      "Attachment exceeds maximum allowed size.",
      {
        name: attachment.name,
        source_url: sourceUrl,
        max_bytes: maxBytes,
        bytes: buffer.byteLength,
      },
    );
  }

  return {
    buffer,
    bytes: buffer.byteLength,
  };
}
