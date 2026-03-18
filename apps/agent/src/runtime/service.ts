import type {
  AgentRunAcceptedResponse,
  AgentRunRequest,
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
