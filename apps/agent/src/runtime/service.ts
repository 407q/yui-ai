import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  RuntimeSessionRegistryStore,
  RuntimeTaskSnapshotRecord,
} from "./runtimeStore.js";
import {
  createDefaultRuntimeSessionRegistryStore,
  closeDefaultRuntimeSessionRegistryStore,
} from "./runtimeStore.js";
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
  ToolProgressEvent,
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
  toolEvents: ToolProgressEvent[];
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
  private readonly shouldCloseRegistryStore: boolean;
  private restorePromise: Promise<void> | null = null;
  private readonly runtimeInstanceId = randomUUID();

  constructor(
    private readonly sdkProvider: CopilotSdkProvider,
    private readonly gatewayMcpClient: GatewayMcpClient,
    private readonly registryStore: RuntimeSessionRegistryStore = createDefaultRuntimeSessionRegistryStore(),
    options?: {
      closeRegistryStoreOnShutdown?: boolean;
    },
  ) {
    this.shouldCloseRegistryStore = options?.closeRegistryStoreOnShutdown ?? true;
  }

  async initialize(): Promise<void> {
    if (!this.restorePromise) {
      this.restorePromise = this.restoreRuntimeState().catch((error: unknown) => {
        this.restorePromise = null;
        throw error;
      });
    }
    await this.restorePromise;
  }

  async shutdown(): Promise<void> {
    if (!this.shouldCloseRegistryStore) {
      return;
    }
    await closeDefaultRuntimeSessionRegistryStore();
  }

  async runTask(input: AgentRunRequest): Promise<AgentRunAcceptedResponse> {
    await this.initialize();
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
    const persistedTask = await this.registryStore.getTaskSnapshot(input.task_id);
    if (persistedTask && persistedTask.status === "running") {
      throw new AgentRuntimeError(
        409,
        "task_already_exists",
        "Task already exists in runtime snapshot and is not terminal.",
        {
          task_id: input.task_id,
          status: "running",
        },
      );
    }
    const persistedSession = await this.registryStore.getSession(input.session_id);
    const bootstrapMode: SessionBootstrapMode =
      this.sessions.has(input.session_id) || persistedSession
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
      toolEvents: [],
      error: null,
      abortController: new AbortController(),
    };
    this.tasks.set(input.task_id, state);
    await this.persistTaskSnapshot(state);
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
      resolveSessionWorkspaceRootFromSessionId(input.session_id, sessionRootDir),
    );
    if (normalizedMountPath !== expectedTaskAttachmentDir) {
      throw new AgentRuntimeError(
        400,
        "invalid_attachment_mount_path",
        "attachment_mount_path must target the session workspace directory.",
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
          "Attachment name resolved outside session workspace directory.",
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

  async getTaskStatus(taskId: string): Promise<AgentTaskStatusResponse> {
    const state = this.tasks.get(taskId);
    if (state) {
      return this.toStatusResponse(state);
    }
    const persisted = await this.registryStore.getTaskSnapshot(taskId);
    if (persisted) {
      return toStatusResponseFromSnapshot(persisted);
    }
    throw new AgentRuntimeError(
      404,
      "task_not_found",
      "Task is not found in runtime.",
      {
        task_id: taskId,
      },
    );
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
      void this.persistTaskSnapshot(state);
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
        systemMemoryRefs: input.system_memory_refs ?? [],
        __toolRoutingMode:
          input.runtime_policy?.tool_routing?.mode ?? "gateway_only",
      };

      let sdkSession: SdkSessionHandle;
      const persistedSession = await this.registryStore.getSession(input.session_id);
      if (state.bootstrapMode === "create") {
        sdkSession = await this.sdkProvider.createSession({
          session_id: input.session_id,
          task_id: input.task_id,
          callbacks,
          sdk_session_id_hint: persistedSession?.sdkSessionId,
        });
      } else {
        sdkSession = await this.sdkProvider.resumeSession({
          session_id: input.session_id,
          task_id: input.task_id,
          callbacks,
          sdk_session_id_hint: persistedSession?.sdkSessionId,
        });
      }
      this.sessions.set(input.session_id, {
        sdkSession,
        updatedAt: new Date(),
      });
      await this.registryStore.upsertSession({
        sessionId: input.session_id,
        sdkSessionId: sdkSession.sdk_session_id,
        updatedAt: new Date(),
      });
      await this.persistTaskSnapshot(state);

      const sendResult = await this.sdkProvider.sendAndWait({
        task_id: input.task_id,
        session_id: input.session_id,
        sdk_session_id: sdkSession.sdk_session_id,
        prompt: input.prompt,
        system_memory_refs: input.system_memory_refs ?? [],
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
      await this.registryStore.upsertSession({
        sessionId: input.session_id,
        sdkSessionId: sdkSession.sdk_session_id,
        updatedAt: new Date(),
      });
      await this.persistTaskSnapshot(state);
    } catch (error) {
      if (isAbortError(error) || state.abortController.signal.aborted) {
        this.cancelTaskState(state);
        await this.persistTaskSnapshot(state);
        return;
      }

      this.failTask(state, error);
      await this.persistTaskSnapshot(state);
    }
  }

  private async handlePermissionRequest(
    input: AgentRunRequest,
    request: PermissionRequestInput,
  ): Promise<PermissionRequestResult> {
    const mode = input.runtime_policy?.tool_routing?.mode ?? "gateway_only";
    const allowExternal =
      input.runtime_policy?.tool_routing?.allow_external_mcp ?? false;
    const modeAllowed =
      mode === "gateway_only" || mode === "hybrid_container_builtin_gateway_host";
    if (!modeAllowed || allowExternal) {
      return {
        decision: "deny",
        reason: "external_mcp_disabled",
      };
    }

    if (request.execution_target !== "gateway_adapter") {
      return {
        decision: "allow",
        reason: "non_gateway_execution_target",
      };
    }

    if (!request.approval_scope) {
      return {
        decision: "allow",
        reason: "no_approval_required",
      };
    }

    const timeoutSec = resolveApprovalTimeoutSec();
    const approvalResult = await this.gatewayMcpClient.requestApprovalAndWait({
      taskId: request.task_id,
      sessionId: request.session_id,
      toolName: request.tool_name,
      operation: request.approval_scope.operation,
      path: request.approval_scope.path,
      timeoutSec,
    });
    if (approvalResult.decision === "approved") {
      return {
        decision: "allow",
        reason: "approval_granted",
      };
    }

    if (approvalResult.decision === "rejected") {
      return {
        decision: "deny",
        reason: "approval_rejected",
      };
    }
    if (approvalResult.decision === "timeout") {
      return {
        decision: "deny",
        reason: "approval_timeout",
      };
    }
    return {
      decision: "deny",
      reason: "approval_canceled",
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
    state.toolEvents = sendResult.tool_events;
    state.error = null;
    state.updatedAt = new Date();
    state.completedAt = state.updatedAt;
  }

  private cancelTaskState(state: TaskExecutionState): void {
    state.status = "canceled";
    state.result = null;
    state.toolEvents = [];
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
    state.toolEvents = [];
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
      tool_events: state.toolEvents,
      error: state.error,
    };
  }

  private async restoreRuntimeState(): Promise<void> {
    await this.registryStore.ping();
    await this.registryStore.markRunningTasksFailedOnStartup({
      runtimeInstanceId: this.runtimeInstanceId,
    });
    const restoredSessions = await this.registryStore.listSessions(1000);
    for (const record of restoredSessions) {
      this.sessions.set(record.sessionId, {
        sdkSession: {
          sdk_session_id: record.sdkSessionId,
        },
        updatedAt: record.updatedAt,
      });
    }
  }

  private async persistTaskSnapshot(state: TaskExecutionState): Promise<void> {
    await this.registryStore.upsertTaskSnapshot({
      taskId: state.taskId,
      sessionId: state.sessionId,
      status: state.status,
      bootstrapMode: state.bootstrapMode,
      sendAndWaitCount: state.sendAndWaitCount,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      completedAt: state.completedAt,
      resultJson: toTaskResultJson(state),
      toolEventsJson: toToolEventsJson(state.toolEvents),
      errorJson: state.error ? { ...state.error } : null,
    });
  }
}

function toTaskResultJson(state: TaskExecutionState): Record<string, unknown> | null {
  if (!state.result) {
    return null;
  }
  return {
    final_answer: state.result.final_answer,
    tool_results: state.result.tool_results,
  };
}

function toToolEventsJson(
  toolEvents: ToolProgressEvent[],
): Record<string, unknown>[] | null {
  if (toolEvents.length === 0) {
    return [];
  }
  return toolEvents.map((event) => ({ ...event }));
}

function toStatusResponseFromSnapshot(
  snapshot: RuntimeTaskSnapshotRecord,
): AgentTaskStatusResponse {
  const result = parseSnapshotResult(snapshot.resultJson);
  const toolEvents = parseSnapshotToolEvents(snapshot.toolEventsJson);
  const error = parseSnapshotError(snapshot.errorJson);
  return {
    task_id: snapshot.taskId,
    session_id: snapshot.sessionId,
    status: snapshot.status,
    bootstrap_mode: snapshot.bootstrapMode,
    send_and_wait_count: snapshot.sendAndWaitCount,
    started_at: snapshot.startedAt.toISOString(),
    updated_at: snapshot.updatedAt.toISOString(),
    completed_at: snapshot.completedAt ? snapshot.completedAt.toISOString() : null,
    result,
    tool_events: toolEvents,
    error,
  };
}

function parseSnapshotResult(snapshot: Record<string, unknown> | null): {
  final_answer: string;
  tool_results: ToolCallResult[];
} | null {
  if (!snapshot) {
    return null;
  }
  const finalAnswer = snapshot.final_answer;
  const toolResults = snapshot.tool_results;
  if (typeof finalAnswer !== "string" || !Array.isArray(toolResults)) {
    return null;
  }
  return {
    final_answer: finalAnswer,
    tool_results: toolResults as ToolCallResult[],
  };
}

function parseSnapshotToolEvents(
  snapshot: Record<string, unknown>[] | null,
): ToolProgressEvent[] {
  if (!snapshot || !Array.isArray(snapshot)) {
    return [];
  }
  const result: ToolProgressEvent[] = [];
  for (const entry of snapshot) {
    const callId = entry.call_id;
    const toolName = entry.tool_name;
    const executionTarget = entry.execution_target;
    const phase = entry.phase;
    const timestamp = entry.timestamp;
    if (
      typeof callId !== "string" ||
      typeof toolName !== "string" ||
      typeof executionTarget !== "string" ||
      (phase !== "start" && phase !== "result") ||
      typeof timestamp !== "string"
    ) {
      continue;
    }
    result.push({
      call_id: callId,
      tool_name: toolName,
      execution_target: executionTarget,
      phase,
      status: entry.status === "ok" || entry.status === "error" ? entry.status : undefined,
      error_code: typeof entry.error_code === "string" ? entry.error_code : undefined,
      message: typeof entry.message === "string" ? entry.message : undefined,
      arguments:
        entry.arguments && typeof entry.arguments === "object" && !Array.isArray(entry.arguments)
          ? (entry.arguments as Record<string, unknown>)
          : undefined,
      reason: typeof entry.reason === "string" ? entry.reason : undefined,
      result:
        entry.result && typeof entry.result === "object" && !Array.isArray(entry.result)
          ? (entry.result as Record<string, unknown>)
          : undefined,
      details:
        entry.details && typeof entry.details === "object" && !Array.isArray(entry.details)
          ? (entry.details as Record<string, unknown>)
          : undefined,
      timestamp,
    });
  }
  return result;
}

function parseSnapshotError(snapshot: Record<string, unknown> | null): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} | null {
  if (!snapshot) {
    return null;
  }
  const code = snapshot.code;
  const message = snapshot.message;
  if (typeof code !== "string" || typeof message !== "string") {
    return null;
  }
  const detailsRaw = snapshot.details;
  const details =
    detailsRaw && typeof detailsRaw === "object" && !Array.isArray(detailsRaw)
      ? (detailsRaw as Record<string, unknown>)
      : undefined;
  return {
    code,
    message,
    details,
  };
}

function assertGatewayOnlyRouting(input: AgentRunRequest): void {
  const mode = input.runtime_policy?.tool_routing?.mode ?? "gateway_only";
  const allowExternal =
    input.runtime_policy?.tool_routing?.allow_external_mcp ?? false;

  const modeAllowed =
    mode === "gateway_only" || mode === "hybrid_container_builtin_gateway_host";
  if (!modeAllowed || allowExternal) {
    throw new AgentRuntimeError(
      400,
      "external_mcp_disabled",
      "Only gateway_only or hybrid_container_builtin_gateway_host routing without external MCP is supported.",
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

function resolveSessionWorkspaceRootFromSessionId(
  sessionId: string,
  sessionRootDir: string = DEFAULT_SESSION_ROOT_DIR,
): string {
  return path.resolve(sessionRootDir, sessionId);
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

function resolveApprovalTimeoutSec(): number {
  const configured = process.env.BOT_APPROVAL_TIMEOUT_SEC;
  if (!configured) {
    return 120;
  }
  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 120;
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
