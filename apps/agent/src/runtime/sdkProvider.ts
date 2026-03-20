import { randomUUID } from "node:crypto";
import {
  CopilotClient,
  defineTool,
  type AssistantMessageEvent,
  type CopilotSession,
  type PermissionHandler as CopilotPermissionHandler,
  type PermissionRequest as CopilotPermissionRequest,
  type PermissionRequestResult as CopilotPermissionRequestResult,
  type ResumeSessionConfig,
  type SessionConfig,
  type Tool as CopilotTool,
  type ToolResultObject,
} from "@github/copilot-sdk";
import { z } from "zod";
import type {
  AgentToolCallSpec,
  PermissionRequestInput,
  PermissionRequestResult,
  ToolCallResult,
} from "./types.js";
import { buildActiveSystemMessage } from "./personaPolicy.js";

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
  shutdown?(): Promise<void>;
}

export interface CopilotCliSdkProviderOptions {
  githubToken: string;
  model: string;
  workingDirectory: string;
  sessionRootDirectory: string;
  sendTimeoutMs: number;
  sdkLogLevel: "none" | "error" | "warning" | "info" | "debug" | "all";
}

interface ActiveSendContext {
  input: SendAndWaitInput;
  runtimeToolResults: ToolCallResult[];
  declaredToolMap: Map<string, AgentToolCallSpec>;
}

interface SdkSessionState {
  sdkSessionId: string;
  appSessionId: string;
  session: CopilotSession | null;
  callbacks: SdkSessionCallbacks;
  activeSend: ActiveSendContext | null;
}

interface GatewayToolCallInput {
  toolName: string;
  arguments: Record<string, unknown>;
  defaultReason: string;
}

const containerFileReadSchema = z.object({
  path: z.string().min(1),
});

const containerFileWriteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const containerFileDeleteSchema = z.object({
  path: z.string().min(1),
});

const containerFileListSchema = z.object({
  path: z.string().optional().default("."),
});

const cliExecSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().optional(),
  timeoutSec: z.number().int().min(1).max(600).optional(),
});

const hostHttpRequestSchema = z.object({
  url: z.string().url(),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
    .optional()
    .default("GET"),
  headers: z.record(z.string(), z.string()).optional().default({}),
  body: z.string().optional(),
  timeoutSec: z.number().int().min(1).max(600).optional(),
});

const memoryUpsertSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
  value: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()).optional().default([]),
});

const memoryGetSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
});

const memorySearchSchema = z.object({
  namespace: z.string().min(1),
  query: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

const memoryDeleteSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
});

export class CopilotCliSdkProvider implements CopilotSdkProvider {
  private readonly client: CopilotClient;
  private readonly sessionsByAppSessionId = new Map<string, SdkSessionState>();
  private startPromise: Promise<void> | null = null;

  constructor(private readonly options: CopilotCliSdkProviderOptions) {
    this.client = new CopilotClient({
      autoStart: false,
      autoRestart: false,
      useStdio: false,
      githubToken: options.githubToken,
      useLoggedInUser: false,
      cwd: options.workingDirectory,
      logLevel: options.sdkLogLevel,
    });
  }

  async createSession(input: CreateSdkSessionInput): Promise<SdkSessionHandle> {
    assertCallbacks(input.callbacks);
    const state = await this.ensureSessionState(
      input.session_id,
      input.callbacks,
      "create",
    );
    return { sdk_session_id: state.sdkSessionId };
  }

  async resumeSession(input: CreateSdkSessionInput): Promise<SdkSessionHandle> {
    assertCallbacks(input.callbacks);
    const state = await this.ensureSessionState(
      input.session_id,
      input.callbacks,
      "resume",
    );
    return { sdk_session_id: state.sdkSessionId };
  }

  async sendAndWait(input: SendAndWaitInput): Promise<SendAndWaitResult> {
    assertCallbacks(input.callbacks);
    assertNotAborted(input.signal);

    const state = await this.ensureSessionState(
      input.session_id,
      input.callbacks,
      "resume",
    );
    if (state.sdkSessionId !== input.sdk_session_id) {
      throw new Error(
        `sdk_session_id mismatch: expected ${state.sdkSessionId}, got ${input.sdk_session_id}`,
      );
    }

    const declaredToolResults = await executeDeclaredToolCalls(input);
    const activeSend: ActiveSendContext = {
      input,
      runtimeToolResults: [],
      declaredToolMap: mapDeclaredToolCalls(input.tool_calls),
    };
    state.activeSend = activeSend;
    state.callbacks = input.callbacks;

    try {
      if (!state.session) {
        state.session = await this.openCopilotSession(state, "resume");
      }

      const assistantMessage = await this.sendAndWaitWithAbort(
        state.session,
        buildPromptWithDeclaredToolResults(input.prompt, declaredToolResults),
        input.signal,
      );

      const mergedToolResults = [
        ...declaredToolResults,
        ...activeSend.runtimeToolResults,
      ];
      return {
        final_answer: resolveFinalAnswer(
          input.prompt,
          input.sdk_session_id,
          assistantMessage,
          mergedToolResults,
        ),
        tool_results: mergedToolResults,
      };
    } finally {
      state.activeSend = null;
    }
  }

  async shutdown(): Promise<void> {
    const errors = await this.client.stop();
    if (errors.length === 0) {
      return;
    }
    throw new Error(
      `[copilot-sdk] failed to stop cleanly: ${errors.map((error) => error.message).join("; ")}`,
    );
  }

  private async ensureSessionState(
    appSessionId: string,
    callbacks: SdkSessionCallbacks,
    preferredOpenMode: "create" | "resume",
  ): Promise<SdkSessionState> {
    const existing = this.sessionsByAppSessionId.get(appSessionId);
    if (existing) {
      existing.callbacks = callbacks;
      return existing;
    }

    await this.ensureStarted();

    const sdkSessionId = toSdkSessionId(appSessionId);
    const state: SdkSessionState = {
      sdkSessionId,
      appSessionId,
      session: null,
      callbacks,
      activeSend: null,
    };
    state.session = await this.openCopilotSession(state, preferredOpenMode);

    this.sessionsByAppSessionId.set(appSessionId, state);
    return state;
  }

  private async ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.client.start().catch((error) => {
        this.startPromise = null;
        throw error;
      });
    }
    await this.startPromise;
  }

  private async openCopilotSession(
    state: SdkSessionState,
    preferredOpenMode: "create" | "resume",
  ): Promise<CopilotSession> {
    if (preferredOpenMode === "resume") {
      try {
        return await this.client.resumeSession(
          state.sdkSessionId,
          this.buildResumeSessionConfig(state),
        );
      } catch (resumeError) {
        try {
          return await this.client.createSession(this.buildCreateSessionConfig(state));
        } catch (createError) {
          throw new Error(
            `[copilot-sdk] failed to open session ${state.sdkSessionId}: ` +
              `resume=${toErrorMessage(resumeError)}; create=${toErrorMessage(createError)}`,
          );
        }
      }
    }

    try {
      return await this.client.createSession(this.buildCreateSessionConfig(state));
    } catch (createError) {
      try {
        return await this.client.resumeSession(
          state.sdkSessionId,
          this.buildResumeSessionConfig(state),
        );
      } catch (resumeError) {
        throw new Error(
          `[copilot-sdk] failed to open session ${state.sdkSessionId}: ` +
            `create=${toErrorMessage(createError)}; resume=${toErrorMessage(resumeError)}`,
        );
      }
    }
  }

  private buildCreateSessionConfig(state: SdkSessionState): SessionConfig {
    const base = this.buildSessionConfigBase(state);
    return {
      ...base,
      sessionId: state.sdkSessionId,
    };
  }

  private buildResumeSessionConfig(state: SdkSessionState): ResumeSessionConfig {
    return this.buildSessionConfigBase(state);
  }

  private buildSessionConfigBase(
    state: SdkSessionState,
  ): Omit<SessionConfig, "sessionId"> {
    const tools = this.buildGatewayTools(state);
    const availableTools = tools.map((tool) => tool.name);
    const workspaceRoot = resolveSessionWorkspaceRoot(
      state.appSessionId,
      this.options.sessionRootDirectory,
    );
    return {
      model: this.options.model,
      systemMessage: {
        content: buildSystemMessageWithRuntimeContracts(
          buildActiveSystemMessage(),
          workspaceRoot,
        ),
      },
      onPermissionRequest: this.createPermissionHandler(state),
      tools,
      availableTools,
      workingDirectory: workspaceRoot,
    };
  }

  private createPermissionHandler(
    state: SdkSessionState,
  ): CopilotPermissionHandler {
    return async (
      request: CopilotPermissionRequest,
    ): Promise<CopilotPermissionRequestResult> => {
      const activeSend = state.activeSend;
      if (!activeSend) {
        return {
          kind: "denied-no-approval-rule-and-could-not-request-from-user",
        };
      }

      if (request.kind !== "custom-tool") {
        return {
          kind: "denied-by-rules",
          rules: [
            {
              policy: "gateway_only",
              denied_kind: request.kind,
            },
          ],
        };
      }
      // Permission for custom tools is enforced in executeGatewayToolCall()
      // so that it stays aligned with Runtime callback behavior.
      return { kind: "approved" };
    };
  }

  private buildGatewayTools(state: SdkSessionState): CopilotTool<any>[] {
    return [
      this.defineGatewayTool(
        state,
        "container.file_read",
        "Read a file from the container session workspace via Gateway MCP.",
        containerFileReadSchema,
        "read file from container workspace",
      ),
      this.defineGatewayTool(
        state,
        "container.file_write",
        "Write a file in the container session workspace via Gateway MCP.",
        containerFileWriteSchema,
        "write file to container workspace",
      ),
      this.defineGatewayTool(
        state,
        "container.file_delete",
        "Delete a file in the container session workspace via Gateway MCP.",
        containerFileDeleteSchema,
        "delete file from container workspace",
      ),
      this.defineGatewayTool(
        state,
        "container.file_list",
        "List files in the container session workspace via Gateway MCP.",
        containerFileListSchema,
        "list files in container workspace",
      ),
      this.defineGatewayTool(
        state,
        "container.cli_exec",
        "Execute a CLI command in the container environment via Gateway MCP.",
        cliExecSchema,
        "execute container cli command",
      ),
      this.defineGatewayTool(
        state,
        "host.file_read",
        "Read a file on the host machine via Gateway MCP approval flow.",
        containerFileReadSchema,
        "read file on host",
      ),
      this.defineGatewayTool(
        state,
        "host.file_write",
        "Write a file on the host machine via Gateway MCP approval flow.",
        containerFileWriteSchema,
        "write file on host",
      ),
      this.defineGatewayTool(
        state,
        "host.file_delete",
        "Delete a file on the host machine via Gateway MCP approval flow.",
        containerFileDeleteSchema,
        "delete file on host",
      ),
      this.defineGatewayTool(
        state,
        "host.file_list",
        "List files on the host machine via Gateway MCP approval flow.",
        containerFileListSchema,
        "list files on host",
      ),
      this.defineGatewayTool(
        state,
        "host.cli_exec",
        "Execute an allowlisted command on the host machine via Gateway MCP approval flow.",
        cliExecSchema,
        "execute host cli command",
      ),
      this.defineGatewayTool(
        state,
        "host.http_request",
        "Send an HTTP request from the host machine via Gateway MCP approval flow.",
        hostHttpRequestSchema,
        "send host http request",
      ),
      this.defineGatewayTool(
        state,
        "memory.upsert",
        "Store memory in the Gateway memory store.",
        memoryUpsertSchema,
        "upsert memory entry",
      ),
      this.defineGatewayTool(
        state,
        "memory.get",
        "Retrieve a memory entry from the Gateway memory store.",
        memoryGetSchema,
        "get memory entry",
      ),
      this.defineGatewayTool(
        state,
        "memory.search",
        "Search entries in the Gateway memory store.",
        memorySearchSchema,
        "search memory entries",
      ),
      this.defineGatewayTool(
        state,
        "memory.delete",
        "Delete a memory entry from the Gateway memory store.",
        memoryDeleteSchema,
        "delete memory entry",
      ),
    ];
  }

  private defineGatewayTool<TArgs extends Record<string, unknown>>(
    state: SdkSessionState,
    gatewayToolName: string,
    description: string,
    parameters: z.ZodType<TArgs>,
    defaultReason: string,
  ): CopilotTool<any> {
    const copilotToolName = toCopilotCustomToolName(gatewayToolName);
    return defineTool<TArgs>(copilotToolName, {
      description,
      parameters,
      handler: async (args): Promise<ToolResultObject> =>
        this.executeGatewayToolCall(state, {
          toolName: gatewayToolName,
          arguments: toRecord(args),
          defaultReason,
        }),
    });
  }

  private async executeGatewayToolCall(
    state: SdkSessionState,
    input: GatewayToolCallInput,
  ): Promise<ToolResultObject> {
    const activeSend = state.activeSend;
    if (!activeSend) {
      return {
        resultType: "failure",
        textResultForLlm: "no active task context for gateway tool execution",
        error: "no_active_task_context",
      };
    }

    const declaredToolSpec = activeSend.declaredToolMap.get(input.toolName);
    const executionTarget = declaredToolSpec?.execution_target ?? "gateway_adapter";
    const reason = declaredToolSpec?.reason ?? input.defaultReason;
    const delayMs = declaredToolSpec?.delay_ms ?? 0;

    assertNotAborted(activeSend.input.signal);
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    assertNotAborted(activeSend.input.signal);

    let permission: PermissionRequestResult;
    try {
      permission = await activeSend.input.callbacks.onPermissionRequest({
        task_id: activeSend.input.task_id,
        session_id: activeSend.input.session_id,
        tool_name: input.toolName,
        reason,
        arguments: input.arguments,
      });
    } catch (error) {
      const message = `permission request failed: ${error instanceof Error ? error.message : String(error)}`;
      const failedResult: ToolCallResult = {
        task_id: activeSend.input.task_id,
        call_id: `call_${randomUUID()}`,
        tool_name: input.toolName,
        execution_target: executionTarget,
        reason,
        arguments: input.arguments,
        status: "error",
        error_code: "permission_request_failed",
        message,
      };
      activeSend.runtimeToolResults.push(failedResult);
      return {
        resultType: "failure",
        textResultForLlm: message,
        error: message,
      };
    }

    if (permission.decision === "deny") {
      const deniedResult: ToolCallResult = {
        task_id: activeSend.input.task_id,
        call_id: `call_${randomUUID()}`,
        tool_name: input.toolName,
        execution_target: executionTarget,
        reason,
        arguments: input.arguments,
        status: "error",
        error_code: "permission_denied",
        message: permission.reason,
      };
      activeSend.runtimeToolResults.push(deniedResult);
      return {
        resultType: "denied",
        textResultForLlm: permission.reason,
        error: permission.reason,
      };
    }

    const callId = `call_${randomUUID()}`;
    let toolResult: ToolCallResult;
    try {
      toolResult = await activeSend.input.onToolCall({
        task_id: activeSend.input.task_id,
        session_id: activeSend.input.session_id,
        call_id: callId,
        tool_name: input.toolName,
        execution_target: executionTarget,
        arguments: input.arguments,
        reason,
      });
    } catch (error) {
      const message = `tool execution failed: ${error instanceof Error ? error.message : String(error)}`;
      const failedResult: ToolCallResult = {
        task_id: activeSend.input.task_id,
        call_id: callId,
        tool_name: input.toolName,
        execution_target: executionTarget,
        reason,
        arguments: input.arguments,
        status: "error",
        error_code: "tool_execution_failed",
        message,
      };
      activeSend.runtimeToolResults.push(failedResult);
      return {
        resultType: "failure",
        textResultForLlm: message,
        error: message,
      };
    }
    const enrichedToolResult: ToolCallResult =
      toolResult.status === "ok"
        ? {
            ...toolResult,
            tool_name: input.toolName,
            execution_target: executionTarget,
            reason,
            arguments: input.arguments,
          }
        : {
            ...toolResult,
            tool_name: input.toolName,
            execution_target: executionTarget,
            reason,
            arguments: input.arguments,
          };
    activeSend.runtimeToolResults.push(enrichedToolResult);

    if (enrichedToolResult.status === "ok") {
      const text = safeJsonStringify(enrichedToolResult.result);
      return {
        resultType: "success",
        textResultForLlm: text,
        sessionLog: text,
      };
    }

    return {
      resultType: mapToolErrorToResultType(enrichedToolResult.error_code),
      textResultForLlm: `${enrichedToolResult.error_code}: ${enrichedToolResult.message}`,
      error: enrichedToolResult.message,
    };
  }

  private async sendAndWaitWithAbort(
    session: CopilotSession,
    prompt: string,
    signal: AbortSignal,
  ): Promise<AssistantMessageEvent | undefined> {
    assertNotAborted(signal);

    let removeAbortListener: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        void session.abort().catch(() => undefined);
        reject(createAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => {
        signal.removeEventListener("abort", onAbort);
      };
    });

    try {
      return (await Promise.race([
        session.sendAndWait({ prompt }, this.options.sendTimeoutMs),
        abortPromise,
      ])) as AssistantMessageEvent | undefined;
    } finally {
      removeAbortListener?.();
    }
  }
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

    const toolResults = await executeDeclaredToolCalls(input);

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

async function executeDeclaredToolCalls(
  input: SendAndWaitInput,
): Promise<ToolCallResult[]> {
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
        tool_name: toolCall.tool_name,
        execution_target: executionTarget,
        reason: toolCall.reason,
        arguments: toolCall.arguments,
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
    toolResults.push({
      ...result,
      tool_name: toolCall.tool_name,
      execution_target: executionTarget,
      reason: toolCall.reason,
      arguments: toolCall.arguments,
    });
  }

  return toolResults;
}

function mapDeclaredToolCalls(
  toolCalls: AgentToolCallSpec[],
): Map<string, AgentToolCallSpec> {
  const byName = new Map<string, AgentToolCallSpec>();
  for (const toolCall of toolCalls) {
    if (!byName.has(toolCall.tool_name)) {
      byName.set(toolCall.tool_name, toolCall);
    }
  }
  return byName;
}

function buildPromptWithDeclaredToolResults(
  prompt: string,
  toolResults: ToolCallResult[],
): string {
  if (toolResults.length === 0) {
    return prompt;
  }

  const lines = toolResults.map((result, index) => {
    const prefix = `- [${index + 1}]`;
    if (result.status === "ok") {
      return `${prefix} ${result.call_id} ok ${truncate(safeJsonStringify(result.result), 400)}`;
    }
    return `${prefix} ${result.call_id} error ${result.error_code}: ${truncate(result.message, 240)}`;
  });

  return (
    `${prompt}\n\n` +
    "[Gateway tool results executed before this response]\n" +
    `${lines.join("\n")}\n` +
    "Use these results as factual context."
  );
}

function resolveFinalAnswer(
  prompt: string,
  sdkSessionId: string,
  assistantMessage: AssistantMessageEvent | undefined,
  toolResults: ToolCallResult[],
): string {
  const content = assistantMessage?.data.content;
  if (typeof content === "string" && content.trim().length > 0) {
    return content;
  }

  const succeeded = toolResults.filter((result) => result.status === "ok").length;
  const failed = toolResults.filter((result) => result.status === "error").length;
  return (
    `Processed prompt: ${prompt}\n` +
    `sdk_session_id: ${sdkSessionId}\n` +
    `tool_calls: ${toolResults.length} (ok=${succeeded}, error=${failed})`
  );
}

function mapToolErrorToResultType(
  errorCode: string,
): "failure" | "rejected" | "denied" {
  if (
    errorCode === "permission_denied" ||
    errorCode === "approval_rejected" ||
    errorCode === "approval_timeout" ||
    errorCode === "path_not_approved_for_session" ||
    errorCode === "external_mcp_disabled"
  ) {
    return "denied";
  }
  if (errorCode === "invalid_tool_arguments") {
    return "rejected";
  }
  return "failure";
}

function toSdkSessionId(sessionId: string): string {
  return `yui_sdk_${sessionId}`;
}

function resolveSessionWorkspaceRoot(
  sessionId: string,
  sessionRootDirectory: string,
): string {
  return `${sessionRootDirectory}/${sessionId}`;
}

function buildSystemMessageWithRuntimeContracts(
  baseSystemMessage: string,
  workspaceRoot: string,
): string {
  return [
    baseSystemMessage,
    "",
    "<runtime_workspace_contract>",
    `- primary_workspace_root: ${workspaceRoot}`,
    `- attachment_mount_path: ${workspaceRoot}`,
    "- attachment_search_priority: attachment_mount_path > primary_workspace_root > avoid_/root/.copilot/session-state",
    "- container_tools_path_rule: use paths relative to primary_workspace_root whenever possible",
    "- host_approval_error_contract: on approval_required/rejected/timeout, explain next step and do not continue host operation silently",
    "- infra_status_contract: if infrastructure_status is booting/failed, avoid pretending completion and ask for retry/confirmation",
    "</runtime_workspace_contract>",
  ].join("\n");
}

function toCopilotCustomToolName(toolName: string): string {
  return toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  return { ...record };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return `{"stringify_error":"${toErrorMessage(error)}"}`;
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
