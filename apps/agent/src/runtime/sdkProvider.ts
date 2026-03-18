import { randomUUID } from "node:crypto";
import type {
  AgentToolCallSpec,
  PermissionRequestInput,
  PermissionRequestResult,
  ToolCallResult,
} from "./types.js";

export interface SdkSessionHandle {
  sdk_session_id: string;
}

export interface SdkSessionCallbacks {
  onPermissionRequest: (
    input: PermissionRequestInput,
  ) => Promise<PermissionRequestResult>;
}

export interface CreateSdkSessionInput {
  session_id: string;
  task_id: string;
  callbacks: SdkSessionCallbacks;
}

export interface SendAndWaitInput {
  task_id: string;
  session_id: string;
  sdk_session_id: string;
  prompt: string;
  tool_calls: AgentToolCallSpec[];
  signal: AbortSignal;
  callbacks: SdkSessionCallbacks;
  onToolCall: (call: {
    task_id: string;
    session_id: string;
    call_id: string;
    tool_name: string;
    execution_target: string;
    arguments: Record<string, unknown>;
    reason: string;
  }) => Promise<ToolCallResult>;
}

export interface SendAndWaitResult {
  final_answer: string;
  tool_results: ToolCallResult[];
}

export interface CopilotSdkProvider {
  createSession(input: CreateSdkSessionInput): Promise<SdkSessionHandle>;
  resumeSession(input: CreateSdkSessionInput): Promise<SdkSessionHandle>;
  sendAndWait(input: SendAndWaitInput): Promise<SendAndWaitResult>;
}

export class MockCopilotSdkProvider implements CopilotSdkProvider {
  async createSession(input: CreateSdkSessionInput): Promise<SdkSessionHandle> {
    assertCallbacks(input.callbacks);
    return {
      sdk_session_id: `mock_sdk_${input.session_id}_${randomUUID().slice(0, 8)}`,
    };
  }

  async resumeSession(input: CreateSdkSessionInput): Promise<SdkSessionHandle> {
    assertCallbacks(input.callbacks);
    return {
      sdk_session_id: `mock_sdk_${input.session_id}_${randomUUID().slice(0, 8)}`,
    };
  }

  async sendAndWait(input: SendAndWaitInput): Promise<SendAndWaitResult> {
    assertCallbacks(input.callbacks);
    assertNotAborted(input.signal);

    const toolResults: ToolCallResult[] = [];
    for (const toolCall of input.tool_calls) {
      assertNotAborted(input.signal);

      const delayMs = toolCall.delay_ms ?? 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      assertNotAborted(input.signal);

      const executionTarget = toolCall.execution_target ?? "gateway_adapter";
      const permission = await input.callbacks.onPermissionRequest({
        task_id: input.task_id,
        session_id: input.session_id,
        tool_name: toolCall.tool_name,
        reason: toolCall.reason,
        arguments: toolCall.arguments,
      });

      if (permission.decision === "deny") {
        toolResults.push({
          task_id: input.task_id,
          call_id: `call_${randomUUID()}`,
          status: "error",
          error_code: "permission_denied",
          message: permission.reason,
        });
        continue;
      }

      const callId = `call_${randomUUID()}`;
      const result = await input.onToolCall({
        task_id: input.task_id,
        session_id: input.session_id,
        call_id: callId,
        tool_name: toolCall.tool_name,
        execution_target: executionTarget,
        arguments: toolCall.arguments,
        reason: toolCall.reason,
      });
      toolResults.push(result);
    }

    const succeeded = toolResults.filter((result) => result.status === "ok").length;
    const failed = toolResults.filter((result) => result.status === "error").length;
    const finalAnswer =
      `Processed prompt: ${input.prompt}\n` +
      `sdk_session_id: ${input.sdk_session_id}\n` +
      `tool_calls: ${toolResults.length} (ok=${succeeded}, error=${failed})`;

    return {
      final_answer: finalAnswer,
      tool_results: toolResults,
    };
  }
}

function assertCallbacks(callbacks: SdkSessionCallbacks): void {
  if (typeof callbacks.onPermissionRequest !== "function") {
    throw new Error("onPermissionRequest callback is required.");
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const error = new Error("Task execution aborted.");
  error.name = "AbortError";
  return error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
