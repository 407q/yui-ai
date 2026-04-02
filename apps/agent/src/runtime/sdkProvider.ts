import { createHash, randomUUID } from "node:crypto";
import {
  CopilotClient,
  defineTool,
  type AssistantMessageEvent,
  type CopilotSession,
  type SessionEvent,
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
  ToolProgressEvent,
} from "./types.js";
import { buildActiveSystemMessage } from "./personaPolicy.js";

export interface SdkSessionHandle {
  sdk_session_id: string;
}

export interface SdkSessionCallbacks {
  onPermissionRequest: (
    input: PermissionRequestInput,
  ) => Promise<PermissionRequestResult>;
  systemMemoryRefs?: Array<{
    namespace: string;
    key: string;
    reason: string;
  }>;
  __toolRoutingMode?: ToolRoutingMode;
}

export interface CreateSdkSessionInput {
  session_id: string;
  task_id: string;
  callbacks: SdkSessionCallbacks;
  sdk_session_id_hint?: string;
}

export interface SendAndWaitInput {
  task_id: string;
  session_id: string;
  sdk_session_id: string;
  prompt: string;
  system_memory_refs?: Array<{
    namespace: string;
    key: string;
    reason: string;
  }>;
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
  tool_events: ToolProgressEvent[];
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
  runtimeToolEvents: ToolProgressEvent[];
  declaredToolMap: Map<string, AgentToolCallSpec>;
  builtinToolByCallId: Map<string, BuiltInToolInvocation>;
  sendTimeoutLastToolActivityAtMs: number;
}

interface SdkSessionState {
  sdkSessionId: string;
  appSessionId: string;
  session: CopilotSession | null;
  callbacks: SdkSessionCallbacks;
  activeSend: ActiveSendContext | null;
  routingMode: ToolRoutingMode;
  workspaceRoot: string;
  disposeSessionEventSubscription?: (() => void) | null;
}

interface GatewayToolCallInput {
  toolName: string;
  arguments: Record<string, unknown>;
  defaultReason: string;
}

type ToolRoutingMode = "gateway_only" | "hybrid_container_builtin_gateway_host";

interface BuiltInToolInvocation {
  toolName: string;
  arguments: Record<string, unknown>;
}

interface BuiltInToolResultInput {
  activeSend: ActiveSendContext;
  callId: string;
  toolName: string;
  argumentsPayload: Record<string, unknown>;
  toolResult: ToolResultObject;
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

const containerFileDeliverSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().min(1).max(8 * 1024 * 1024).optional().default(2 * 1024 * 1024),
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

const webGetSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional().default({}),
  timeoutSec: z.number().int().min(1).max(600).optional(),
});

const webPostSchema = z
  .object({
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional().default({}),
    body: z.string().optional(),
    bodyBase64: z.string().optional(),
    timeoutSec: z.number().int().min(1).max(600).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.body !== undefined && value.bodyBase64 !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bodyBase64"],
        message: "Specify either body or bodyBase64, not both.",
      });
      return;
    }
    if (value.bodyBase64 !== undefined && !isValidBase64(value.bodyBase64)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bodyBase64"],
        message: "bodyBase64 must be valid base64 text.",
      });
    }
  });

const webSearchSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(10).optional().default(5),
  apiUrl: z.string().url().optional(),
  timeoutSec: z.number().int().min(1).max(600).optional(),
});

const memoryUpsertSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
  value: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()).optional().default([]),
  backlinks: z
    .array(
      z.object({
        namespace: z.string().min(1),
        key: z.string().min(1),
        relation: z.string().min(1).max(64).optional(),
      }),
    )
    .optional(),
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

const systemMemoryFetchSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
  reason: z.string().min(1).optional(),
});

const discordChannelHistorySchema = z.object({
  channelId: z.string().min(1).optional(),
  limit: z.number().int().min(1).optional(),
  role: z.enum(["all", "user", "assistant"]).optional().default("all"),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
});

const discordChannelListSchema = z.object({
  limit: z.number().int().min(1).max(200).optional().default(50),
});

const HYBRID_BUILTIN_TOOL_ALLOWLIST = [
  "read_file",
  "edit_file",
  "str_replace_editor",
  "grep",
  "glob",
  "view",
] as const;

const DEFAULT_SYSTEM_MEMORY_REFS = [
  {
    namespace: "system.persona",
    key: "active_profile",
    reason: "load active persona profile",
  },
  {
    namespace: "system.policy",
    key: "core_rules",
    reason: "load core behavior and safety rules",
  },
  {
    namespace: "system.tooling",
    key: "routing_contract",
    reason: "load tool routing contract",
  },
] as const;

const GATEWAY_ONLY_BUILTIN_BLOCKLIST: ReadonlySet<string> = new Set([
  "read_file",
  "edit_file",
  "str_replace_editor",
  "grep",
  "glob",
  "view",
  "bash",
  "list_dir",
  "write",
  "read",
  "shell",
]);

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
      input.sdk_session_id_hint,
    );
    return { sdk_session_id: state.sdkSessionId };
  }

  async resumeSession(input: CreateSdkSessionInput): Promise<SdkSessionHandle> {
    assertCallbacks(input.callbacks);
    const state = await this.ensureSessionState(
      input.session_id,
      input.callbacks,
      "resume",
      input.sdk_session_id_hint,
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

    const systemMemoryToolCalls = buildSystemMemoryToolCalls(input.system_memory_refs);
    const declaredToolExecution = await executeDeclaredToolCalls({
      ...input,
      tool_calls: [...systemMemoryToolCalls, ...input.tool_calls],
    });
    const activeSend: ActiveSendContext = {
      input,
      runtimeToolResults: [],
      runtimeToolEvents: [],
      declaredToolMap: mapDeclaredToolCalls(input.tool_calls),
      builtinToolByCallId: new Map(),
      sendTimeoutLastToolActivityAtMs: Date.now(),
    };
    state.activeSend = activeSend;
    state.callbacks = {
      ...input.callbacks,
      systemMemoryRefs: normalizeSystemMemoryRefs(input.system_memory_refs),
    };

    try {
      if (!state.session) {
        state.session = await this.openCopilotSession(state, "resume");
      }
      this.attachSessionEventBridge(state);

      const assistantMessage = await this.sendAndWaitWithAbort(
        state.session,
        buildPromptWithDeclaredToolResults(
          input.prompt,
          declaredToolExecution.toolResults,
        ),
        input.signal,
        activeSend,
      );

      const mergedToolResults = [
        ...declaredToolExecution.toolResults,
        ...activeSend.runtimeToolResults,
      ];
      const mergedToolEvents = [
        ...declaredToolExecution.toolEvents,
        ...activeSend.runtimeToolEvents,
      ];
      return {
        final_answer: resolveFinalAnswer(
          input.prompt,
          input.sdk_session_id,
          assistantMessage,
          mergedToolResults,
        ),
        tool_results: mergedToolResults,
        tool_events: mergedToolEvents,
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
    sdkSessionIdHint?: string,
  ): Promise<SdkSessionState> {
    const resolvedRoutingMode = resolveToolRoutingModeFromCallbacks(callbacks);
    const existing = this.sessionsByAppSessionId.get(appSessionId);
    if (existing) {
      existing.callbacks = callbacks;
      if (existing.routingMode !== resolvedRoutingMode) {
        existing.disposeSessionEventSubscription?.();
        existing.disposeSessionEventSubscription = null;
        if (existing.session) {
          await existing.session.disconnect();
          existing.session = null;
        }
      }
      existing.routingMode = resolvedRoutingMode;
      return existing;
    }

    await this.ensureStarted();

    const sdkSessionId = sdkSessionIdHint ?? toSdkSessionId(appSessionId);
    const routingMode = resolvedRoutingMode;
    const workspaceRoot = resolveSessionWorkspaceRoot(
      appSessionId,
      this.options.sessionRootDirectory,
    );
    const state: SdkSessionState = {
      sdkSessionId,
      appSessionId,
      session: null,
      callbacks,
      activeSend: null,
      routingMode,
      workspaceRoot,
      disposeSessionEventSubscription: null,
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
    const availableTools = this.buildAvailableTools(state, tools);
    return {
      model: this.options.model,
      systemMessage: {
        content: buildSystemMessageWithRuntimeContracts(
          buildActiveSystemMessage(),
          state.workspaceRoot,
          state.routingMode,
        ),
      },
      onPermissionRequest: this.createPermissionHandler(state),
      hooks: this.createSessionHooks(state),
      tools,
      availableTools,
      workingDirectory: state.workspaceRoot,
    };
  }

  private buildAvailableTools(
    state: SdkSessionState,
    tools: CopilotTool<any>[],
  ): string[] {
    const customToolNames = tools.map((tool) => tool.name);
    if (state.routingMode === "hybrid_container_builtin_gateway_host") {
      return [...customToolNames, ...HYBRID_BUILTIN_TOOL_ALLOWLIST];
    }
    return customToolNames;
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

      const routingMode = state.routingMode;
      if (routingMode === "gateway_only") {
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
      }

      if (request.kind === "custom-tool") {
        return { kind: "approved" };
      }
      if (
        request.kind === "read" ||
        request.kind === "write" ||
        request.kind === "shell"
      ) {
        return { kind: "approved" };
      }
      return {
        kind: "denied-by-rules",
        rules: [
          {
            policy: "hybrid_container_builtin_gateway_host",
            denied_kind: request.kind,
          },
        ],
      };
    };
  }

  private createSessionHooks(
    state: SdkSessionState,
  ): NonNullable<SessionConfig["hooks"]> {
    return {
      onPreToolUse: async (input: {
        toolName: string;
        toolArgs: unknown;
      }) => {
        if (state.routingMode === "gateway_only") {
          if (GATEWAY_ONLY_BUILTIN_BLOCKLIST.has(input.toolName)) {
            return {
              permissionDecision: "deny",
              permissionDecisionReason:
                "gateway_only mode forbids built-in tools. Use gateway custom tools.",
            };
          }
          return {
            permissionDecision: "allow",
          };
        }

        if (isHybridBuiltInTool(input.toolName)) {
          const args = toRecord(input.toolArgs);
          const pathTarget = extractBuiltInPathTarget(input.toolName, args);
          if (!pathTarget) {
            return {
              permissionDecision: "deny",
              permissionDecisionReason:
                "hybrid mode requires explicit file path arguments for built-in tools.",
            };
          }
          if (!isPathAllowedForWorkspace(pathTarget, state.workspaceRoot)) {
            return {
              permissionDecision: "deny",
              permissionDecisionReason:
                "hybrid mode built-in tools are limited to the session workspace.",
            };
          }
        }
        return {
          permissionDecision: "allow",
        };
      },
      onPostToolUse: async (input: {
        toolName: string;
        toolArgs: unknown;
        toolResult: ToolResultObject;
      }) => {
        const activeSend = state.activeSend;
        if (!activeSend) {
          return;
        }
        if (!isHybridBuiltInTool(input.toolName)) {
          return;
        }
        const args = toRecord(input.toolArgs);
        const callId = findBuiltInToolCallId(activeSend.builtinToolByCallId, input.toolName, args);
        if (!callId) {
          return;
        }
        const logged = buildBuiltInToolResult({
          activeSend,
          callId,
          toolName: input.toolName,
          argumentsPayload: args,
          toolResult: input.toolResult,
        });
        if (logged) {
          activeSend.runtimeToolResults.push(logged);
          activeSend.runtimeToolEvents.push(
            createToolProgressResultEvent({
              callId,
              toolName: input.toolName,
              executionTarget: "builtin_container",
              status: logged.status,
              errorCode:
                logged.status === "error" ? logged.error_code : undefined,
              message:
                logged.status === "error" ? logged.message : undefined,
              result: logged.status === "ok" ? logged.result : undefined,
              details: logged.status === "error" ? logged.details : undefined,
            }),
          );
        }
      },
    };
  }

  private attachSessionEventBridge(state: SdkSessionState): void {
    if (!state.session) {
      return;
    }
    if (state.disposeSessionEventSubscription) {
      return;
    }
    state.disposeSessionEventSubscription = state.session.on((event) => {
      onSessionEvent(state, event);
    });
  }

  private buildGatewayTools(state: SdkSessionState): CopilotTool<any>[] {
    return [
      this.defineGatewayTool(
        state,
        "container.file_read",
        "Read a file from the container session workspace via Gateway MCP. Prefer this over host.file_read for task files and attachments under /agent/session/<session_id>.",
        containerFileReadSchema,
        "read file from container workspace",
      ),
      this.defineGatewayTool(
        state,
        "container.file_write",
        "Write a file in the container session workspace via Gateway MCP. Default all task outputs under /agent/session/<session_id> unless user explicitly requested host path changes.",
        containerFileWriteSchema,
        "write file to container workspace",
      ),
      this.defineGatewayTool(
        state,
        "container.file_delete",
        "Delete a file in the container session workspace via Gateway MCP. Use for files under /agent/session/<session_id>.",
        containerFileDeleteSchema,
        "delete file from container workspace",
      ),
      this.defineGatewayTool(
        state,
        "container.file_list",
        "List files in the container session workspace via Gateway MCP. Start here when exploring project files and attachments.",
        containerFileListSchema,
        "list files in container workspace",
      ),
      this.defineGatewayTool(
        state,
        "container.file_deliver",
        "Read a file from the container session workspace and return it as base64 payload for user delivery. Use for requested file exports from /agent/session/<session_id>.",
        containerFileDeliverSchema,
        "deliver container file to user",
      ),
      this.defineGatewayTool(
        state,
        "container.cli_exec",
        "Execute a CLI command in the container environment via Gateway MCP. Prefer this for analysis/build/test tasks inside /agent/session/<session_id>.",
        cliExecSchema,
        "execute container cli command",
      ),
      this.defineGatewayTool(
        state,
        "host.file_read",
        "Read a file on the host machine via Gateway MCP approval flow. Use only when user explicitly requested host path access.",
        containerFileReadSchema,
        "read file on host",
      ),
      this.defineGatewayTool(
        state,
        "host.file_write",
        "Write a file on the host machine via Gateway MCP approval flow. Avoid by default; requires explicit user intent and approval.",
        containerFileWriteSchema,
        "write file on host",
      ),
      this.defineGatewayTool(
        state,
        "host.file_delete",
        "Delete a file on the host machine via Gateway MCP approval flow. Use only for explicit host cleanup requests.",
        containerFileDeleteSchema,
        "delete file on host",
      ),
      this.defineGatewayTool(
        state,
        "host.file_list",
        "List files on the host machine via Gateway MCP approval flow. Not default for project workspace exploration.",
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
        "web.get",
        "Send a web GET request via Gateway MCP approval flow. For non-text responses, Gateway stores artifacts under the session workspace and returns the saved path.",
        webGetSchema,
        "send web get request",
      ),
      this.defineGatewayTool(
        state,
        "web.post",
        "Send a web POST request via Gateway MCP approval flow. Use body for text payloads or bodyBase64 for binary payloads.",
        webPostSchema,
        "send web post request",
      ),
      this.defineGatewayTool(
        state,
        "web.search",
        "Search the web via Ollama Web Search API through Gateway MCP approval flow.",
        webSearchSchema,
        "search web",
      ),
      this.defineGatewayTool(
        state,
        "memory.upsert",
        "Store memory in the Gateway memory store. Use recommended namespaces and set backlinks when this entry depends on existing memory.",
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
        "Search entries in the Gateway memory store. For knowledge-heavy questions, always consult memory.search/get (including system.*) before fallback assumptions.",
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
      this.defineGatewayTool(
        state,
        "discord.channel_history",
        "Get Discord channel context metadata for a Discord channel (current channel by default, requires approval).",
        discordChannelHistorySchema,
        "get discord channel history",
      ),
      this.defineGatewayTool(
        state,
        "discord.channel_list",
        "List Discord channels in the configured guild (requires approval).",
        discordChannelListSchema,
        "list discord channels",
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
    const callId = `call_${randomUUID()}`;
    this.markSendToolExecutionActivity(activeSend);
    activeSend.runtimeToolEvents.push(
      createToolProgressStartEvent({
        callId,
        toolName: input.toolName,
        executionTarget,
        reason,
        argumentsPayload: input.arguments,
      }),
    );

    assertNotAborted(activeSend.input.signal);
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    assertNotAborted(activeSend.input.signal);

    try {
      let permission: PermissionRequestResult;
      try {
        permission = await activeSend.input.callbacks.onPermissionRequest({
          task_id: activeSend.input.task_id,
          session_id: activeSend.input.session_id,
          tool_name: input.toolName,
          reason,
          arguments: input.arguments,
          execution_target: executionTarget,
          approval_scope: resolveApprovalScopeFromGatewayToolCall(
            input.toolName,
            input.arguments,
          ),
        });
      } catch (error) {
        const message = `permission request failed: ${error instanceof Error ? error.message : String(error)}`;
        const failedResult: ToolCallResult = {
          task_id: activeSend.input.task_id,
          call_id: callId,
          tool_name: input.toolName,
          execution_target: executionTarget,
          reason,
          arguments: input.arguments,
          status: "error",
          error_code: "permission_request_failed",
          message,
        };
        activeSend.runtimeToolResults.push(failedResult);
        activeSend.runtimeToolEvents.push(
          createToolProgressResultEvent({
            callId,
            toolName: input.toolName,
            executionTarget,
            status: "error",
            errorCode: failedResult.error_code,
            message: failedResult.message,
            details: { error: message },
          }),
        );
        return {
          resultType: "failure",
          textResultForLlm: message,
          error: message,
        };
      }

      if (permission.decision === "deny") {
        const deniedResult: ToolCallResult = {
          task_id: activeSend.input.task_id,
          call_id: callId,
          tool_name: input.toolName,
          execution_target: executionTarget,
          reason,
          arguments: input.arguments,
          status: "error",
          error_code: "permission_denied",
          message: permission.reason,
        };
        activeSend.runtimeToolResults.push(deniedResult);
        activeSend.runtimeToolEvents.push(
          createToolProgressResultEvent({
            callId,
            toolName: input.toolName,
            executionTarget,
            status: "error",
            errorCode: deniedResult.error_code,
            message: deniedResult.message,
            details: { reason: permission.reason },
          }),
        );
        return {
          resultType: "denied",
          textResultForLlm: permission.reason,
          error: permission.reason,
        };
      }

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
        activeSend.runtimeToolEvents.push(
          createToolProgressResultEvent({
            callId,
            toolName: input.toolName,
            executionTarget,
            status: "error",
            errorCode: failedResult.error_code,
            message: failedResult.message,
            details: { error: message },
          }),
        );
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
      activeSend.runtimeToolEvents.push(
        createToolProgressResultEvent({
          callId,
          toolName: input.toolName,
          executionTarget,
          status: enrichedToolResult.status,
          errorCode:
            enrichedToolResult.status === "error"
              ? enrichedToolResult.error_code
              : undefined,
          message:
            enrichedToolResult.status === "error"
              ? enrichedToolResult.message
              : undefined,
          result:
            enrichedToolResult.status === "ok"
              ? enrichedToolResult.result
              : undefined,
          details:
            enrichedToolResult.status === "error"
              ? enrichedToolResult.details
              : undefined,
        }),
      );

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
    } finally {
      this.markSendToolExecutionActivity(activeSend);
    }
  }

  private async sendAndWaitWithAbort(
    session: CopilotSession,
    prompt: string,
    signal: AbortSignal,
    activeSend: ActiveSendContext,
  ): Promise<AssistantMessageEvent | undefined> {
    assertNotAborted(signal);

    let removeAbortListener: (() => void) | undefined;
    let removeSessionListener: (() => void) | undefined;
    let timeoutWatcher: ReturnType<typeof setInterval> | undefined;
    let waitingForCurrentSend = false;
    let latestAssistantMessage: AssistantMessageEvent | undefined;

    const completionPromise = new Promise<AssistantMessageEvent | undefined>(
      (resolve, reject) => {
        const onSessionEvent = (event: SessionEvent) => {
          if (!waitingForCurrentSend) {
            return;
          }
          if (event.type === "assistant.message") {
            latestAssistantMessage = event;
            return;
          }
          if (event.type === "session.idle") {
            resolve(latestAssistantMessage);
          }
        };
        removeSessionListener = session.on(onSessionEvent);

        timeoutWatcher = setInterval(() => {
          if (!waitingForCurrentSend) {
            return;
          }
          const elapsed = Date.now() - activeSend.sendTimeoutLastToolActivityAtMs;
          if (elapsed <= this.options.sendTimeoutMs) {
            return;
          }
          reject(createSendTimeoutError(this.options.sendTimeoutMs));
        }, 200);
      },
    );

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
      activeSend.sendTimeoutLastToolActivityAtMs = Date.now();
      waitingForCurrentSend = true;
      await Promise.race([session.send({ prompt }), abortPromise]);
      return (await Promise.race([
        completionPromise,
        abortPromise,
      ])) as AssistantMessageEvent | undefined;
    } finally {
      waitingForCurrentSend = false;
      if (timeoutWatcher) {
        clearInterval(timeoutWatcher);
      }
      removeSessionListener?.();
      removeAbortListener?.();
    }
  }

  private markSendToolExecutionActivity(activeSend: ActiveSendContext): void {
    activeSend.sendTimeoutLastToolActivityAtMs = Date.now();
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

    const systemMemoryToolCalls = buildSystemMemoryToolCalls(input.system_memory_refs);
    const declaredToolExecution = await executeDeclaredToolCalls({
      ...input,
      tool_calls: [...systemMemoryToolCalls, ...input.tool_calls],
    });
    const toolResults = declaredToolExecution.toolResults;

    const succeeded = toolResults.filter((result) => result.status === "ok").length;
    const failed = toolResults.filter((result) => result.status === "error").length;
    const finalAnswer =
      `Processed prompt: ${input.prompt}\n` +
      `sdk_session_id: ${input.sdk_session_id}\n` +
      `tool_calls: ${toolResults.length} (ok=${succeeded}, error=${failed})`;

    return {
      final_answer: finalAnswer,
      tool_results: toolResults,
      tool_events: declaredToolExecution.toolEvents,
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

function createSendTimeoutError(timeoutMs: number): Error {
  return new Error(`Timeout after ${timeoutMs}ms waiting for session.idle`);
}

async function executeDeclaredToolCalls(
  input: SendAndWaitInput,
): Promise<{ toolResults: ToolCallResult[]; toolEvents: ToolProgressEvent[] }> {
  const toolResults: ToolCallResult[] = [];
  const toolEvents: ToolProgressEvent[] = [];
  for (const toolCall of input.tool_calls) {
    assertNotAborted(input.signal);

    const delayMs = toolCall.delay_ms ?? 0;
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    assertNotAborted(input.signal);

    const executionTarget = toolCall.execution_target ?? "gateway_adapter";
    const declaredCallId = `declared_${input.task_id}_${toolCall.tool_name}_${safeJsonStringify(toolCall.arguments)}`;
    const callId = `call_${createStableHexHash(declaredCallId).slice(0, 16)}`;
    toolEvents.push(
      createToolProgressStartEvent({
        callId,
        toolName: toolCall.tool_name,
        executionTarget,
        reason: toolCall.reason,
        argumentsPayload: toolCall.arguments,
      }),
    );
    const permission = await input.callbacks.onPermissionRequest({
      task_id: input.task_id,
      session_id: input.session_id,
      tool_name: toolCall.tool_name,
      reason: toolCall.reason,
      arguments: toolCall.arguments,
      execution_target: executionTarget,
      approval_scope: resolveApprovalScopeFromGatewayToolCall(
        toolCall.tool_name,
        toolCall.arguments,
      ),
    });

    if (permission.decision === "deny") {
      const deniedResult: ToolCallResult = {
        task_id: input.task_id,
        call_id: callId,
        tool_name: toolCall.tool_name,
        execution_target: executionTarget,
        reason: toolCall.reason,
        arguments: toolCall.arguments,
        status: "error",
        error_code: "permission_denied",
        message: permission.reason,
      };
      toolResults.push(deniedResult);
      toolEvents.push(
        createToolProgressResultEvent({
          callId,
          toolName: toolCall.tool_name,
          executionTarget,
          status: "error",
          errorCode: deniedResult.error_code,
          message: deniedResult.message,
          details: { reason: permission.reason },
        }),
      );
      continue;
    }

    const result = await input.onToolCall({
      task_id: input.task_id,
      session_id: input.session_id,
      call_id: callId,
      tool_name: toolCall.tool_name,
      execution_target: executionTarget,
      arguments: toolCall.arguments,
      reason: toolCall.reason,
    });
    const enrichedResult: ToolCallResult = {
      ...result,
      tool_name: toolCall.tool_name,
      execution_target: executionTarget,
      reason: toolCall.reason,
      arguments: toolCall.arguments,
    };
    toolResults.push(enrichedResult);
    toolEvents.push(
      createToolProgressResultEvent({
        callId,
        toolName: toolCall.tool_name,
        executionTarget,
        status: enrichedResult.status,
        errorCode: enrichedResult.status === "error" ? enrichedResult.error_code : undefined,
        message: enrichedResult.status === "error" ? enrichedResult.message : undefined,
        result: enrichedResult.status === "ok" ? enrichedResult.result : undefined,
        details: enrichedResult.status === "error" ? enrichedResult.details : undefined,
      }),
    );
  }

  return {
    toolResults,
    toolEvents,
  };
}

function normalizeSystemMemoryRefs(
  refs:
    | Array<{
        namespace: string;
        key: string;
        reason: string;
      }>
    | undefined,
): Array<{
  namespace: string;
  key: string;
  reason: string;
}> {
  const source = refs && refs.length > 0 ? refs : [...DEFAULT_SYSTEM_MEMORY_REFS];
  const parsed = source
    .map((entry) => systemMemoryFetchSchema.safeParse(entry))
    .filter(
      (
        result,
      ): result is { success: true; data: z.infer<typeof systemMemoryFetchSchema> } =>
        result.success,
    )
    .map((result) => ({
      namespace: result.data.namespace.trim(),
      key: result.data.key.trim(),
      reason:
        result.data.reason && result.data.reason.trim().length > 0
          ? result.data.reason.trim()
          : "load required system memory",
    }))
    .filter((entry) => entry.namespace.length > 0 && entry.key.length > 0);
  const seen = new Set<string>();
  const deduped: Array<{ namespace: string; key: string; reason: string }> = [];
  for (const entry of parsed) {
    const key = `${entry.namespace}\u0000${entry.key}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function buildSystemMemoryToolCalls(
  refs:
    | Array<{
        namespace: string;
        key: string;
        reason: string;
      }>
    | undefined,
): AgentToolCallSpec[] {
  const normalized = normalizeSystemMemoryRefs(refs);
  return normalized.map((entry) => ({
    tool_name: "memory.get",
    execution_target: "gateway_adapter",
    arguments: {
      namespace: entry.namespace,
      key: entry.key,
    },
    reason: `system memory preload: ${entry.reason}`,
  }));
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
    errorCode === "builtin_permission_denied" ||
    errorCode === "approval_rejected" ||
    errorCode === "approval_timeout" ||
    errorCode === "path_not_approved_for_session" ||
    errorCode === "external_mcp_disabled"
  ) {
    return "denied";
  }
  if (
    errorCode === "invalid_tool_arguments" ||
    errorCode === "builtin_invalid_arguments"
  ) {
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
  routingMode: ToolRoutingMode,
): string {
  const routingContract =
    routingMode === "hybrid_container_builtin_gateway_host"
      ? "- tool_routing_mode: hybrid_container_builtin_gateway_host (container built-ins allowed, host operations via gateway tools)"
      : "- tool_routing_mode: gateway_only (all operations via gateway tools)";
  return [
    baseSystemMessage,
    "",
    "<runtime_workspace_contract>",
    `- primary_workspace_root: ${workspaceRoot}`,
    `- attachment_mount_path: ${workspaceRoot}`,
    "- attachment_search_priority: attachment_mount_path > primary_workspace_root > avoid_/root/.copilot/session-state",
    "- workspace_default_rule: treat file operations and cli tasks as container workspace operations by default",
    "- container_tools_path_rule: use paths relative to primary_workspace_root whenever possible",
    "- file_roundtrip_rule: when user sends files, process them inside the container workspace and return outputs using container.file_deliver instead of host path operations",
    "- host_tool_usage_rule: use host.* tools only when user explicitly requests host access and approval allows it",
    "- host_approval_trigger_rule: when host access is explicitly requested, call the required host.* tool directly; gateway will return approval_required and start approval flow automatically when needed",
    "- discord_tool_usage_rule: discord.* tools are approval-gated; call the required discord.* tool directly so gateway can trigger approval_required flow with concrete scope",
    "- system_memory_contract: treat provided system_memory_refs as mandatory context; execute memory.get for each ref before other knowledge-heavy reasoning",
    "- system_memory_write_guard: do not attempt to update/delete system.* entries; they are read-only",
    routingContract,
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

function createStableHexHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveToolRoutingModeFromCallbacks(
  callbacks: SdkSessionCallbacks,
): ToolRoutingMode {
  const mode = callbacks.__toolRoutingMode ?? "gateway_only";
  if (
    mode === "gateway_only" ||
    mode === "hybrid_container_builtin_gateway_host"
  ) {
    return mode;
  }
  return "gateway_only";
}

function isHybridBuiltInTool(toolName: string): boolean {
  return HYBRID_BUILTIN_TOOL_ALLOWLIST.includes(
    toolName as (typeof HYBRID_BUILTIN_TOOL_ALLOWLIST)[number],
  );
}

function extractBuiltInPathTarget(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (
    toolName === "read_file" ||
    toolName === "edit_file" ||
    toolName === "str_replace_editor" ||
    toolName === "view"
  ) {
    return (
      readStringFromRecord(args, "path") ??
      readStringFromRecord(args, "file_path") ??
      readStringFromRecord(args, "filePath") ??
      readStringFromRecord(args, "target_file") ??
      readStringFromRecord(args, "targetFile") ??
      readStringFromRecord(args, "file")
    );
  }
  if (toolName === "grep" || toolName === "glob") {
    return readStringFromRecord(args, "path") ?? ".";
  }
  return null;
}

function isPathAllowedForWorkspace(pathValue: string, workspaceRoot: string): boolean {
  if (pathValue.trim().length === 0) {
    return false;
  }
  const candidatePath = pathValue.trim();
  const normalizedWorkspace = normalizePosixPath(workspaceRoot);
  if (candidatePath === ".") {
    return true;
  }
  const normalizedTarget = candidatePath.startsWith("/")
    ? normalizePosixPath(candidatePath)
    : normalizePosixPath(`${normalizedWorkspace}/${candidatePath}`);
  return (
    normalizedTarget === normalizedWorkspace ||
    normalizedTarget.startsWith(`${normalizedWorkspace}/`)
  );
}

function normalizePosixPath(value: string): string {
  const replaced = value.replace(/\\/g, "/");
  const parts = replaced.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (part.length === 0 || part === ".") {
      continue;
    }
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return `/${normalized.join("/")}`;
}

function resolveApprovalScopeFromGatewayToolCall(
  toolName: string,
  args: Record<string, unknown>,
): { operation: string; path: string } | null {
  if (toolName === "host.file_read") {
    const normalizedPath = normalizeApprovalPathForGatewayToolCall(
      toolName,
      args,
    );
    if (!normalizedPath) {
      return null;
    }
    return {
      operation: "read",
      path: normalizedPath,
    };
  }
  if (toolName === "host.file_write") {
    const normalizedPath = normalizeApprovalPathForGatewayToolCall(
      toolName,
      args,
    );
    if (!normalizedPath) {
      return null;
    }
    return {
      operation: "write",
      path: normalizedPath,
    };
  }
  if (toolName === "host.file_delete") {
    const normalizedPath = normalizeApprovalPathForGatewayToolCall(
      toolName,
      args,
    );
    if (!normalizedPath) {
      return null;
    }
    return {
      operation: "delete",
      path: normalizedPath,
    };
  }
  if (toolName === "host.file_list") {
    const normalizedPath = normalizeApprovalPathForGatewayToolCall(
      toolName,
      args,
    );
    if (!normalizedPath) {
      return null;
    }
    return {
      operation: "list",
      path: normalizedPath,
    };
  }
  if (toolName === "host.cli_exec") {
    const command = normalizeApprovalPathForGatewayToolCall(toolName, args);
    if (!command) {
      return null;
    }
    return {
      operation: "exec",
      path: command,
    };
  }
  if (toolName === "host.http_request") {
    const origin = normalizeApprovalPathForGatewayToolCall(toolName, args);
    if (!origin) {
      return null;
    }
    return {
      operation: "http_request",
      path: origin,
    };
  }
  if (toolName === "web.get" || toolName === "web.post") {
    const origin = normalizeApprovalPathForGatewayToolCall(toolName, args);
    if (!origin) {
      return null;
    }
    return {
      operation: "http_request",
      path: origin,
    };
  }
  if (toolName === "web.search") {
    const origin = normalizeApprovalPathForGatewayToolCall(toolName, args);
    if (!origin) {
      return null;
    }
    return {
      operation: "web_search",
      path: origin,
    };
  }
  if (toolName === "discord.channel_history") {
    const channelScope = normalizeApprovalPathForGatewayToolCall(toolName, args);
    if (!channelScope) {
      return null;
    }
    return {
      operation: "discord_channel_history",
      path: channelScope,
    };
  }
  if (toolName === "discord.channel_list") {
    const guildScope = normalizeApprovalPathForGatewayToolCall(toolName, args);
    if (!guildScope) {
      return null;
    }
    return {
      operation: "discord_channel_list",
      path: guildScope,
    };
  }
  return null;
}

function normalizeApprovalPathForGatewayToolCall(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (
    toolName === "host.file_read" ||
    toolName === "host.file_write" ||
    toolName === "host.file_delete" ||
    toolName === "host.file_list"
  ) {
    const pathValue = readStringFromRecord(args, "path") ?? ".";
    if (!pathValue) {
      return null;
    }
    return pathValue;
  }
  if (toolName === "host.http_request" || toolName === "web.get" || toolName === "web.post") {
    const rawUrl = readStringFromRecord(args, "url");
    if (!rawUrl) {
      return null;
    }
    try {
      const url = new URL(rawUrl);
      return url.origin;
    } catch {
      return null;
    }
  }
  if (toolName === "web.search") {
    const rawUrl = readStringFromRecord(args, "apiUrl");
    if (!rawUrl) {
      return "web_search:__configured_origin__";
    }
    try {
      const url = new URL(rawUrl);
      return url.origin;
    } catch {
      return null;
    }
  }
  if (toolName === "discord.channel_history") {
    const channelId =
      readStringFromRecord(args, "channelId") ?? "__session_channel__";
    return `discord_channel:${channelId}`;
  }
  if (toolName === "discord.channel_list") {
    return "discord_guild:__session_guild__";
  }
  if (toolName === "host.cli_exec") {
    const command = readStringFromRecord(args, "command");
    if (command && command.trim().length > 0) {
      return command;
    }
    return null;
  }
  return null;
}

function readStringFromRecord(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNumberFromRecord(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isValidBase64(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return true;
  }
  return /^[A-Za-z0-9+/]+={0,2}$/.test(normalized) && normalized.length % 4 === 0;
}

function createToolProgressStartEvent(input: {
  callId: string;
  toolName: string;
  executionTarget: string;
  reason?: string;
  argumentsPayload?: Record<string, unknown>;
}): ToolProgressEvent {
  return {
    call_id: input.callId,
    tool_name: input.toolName,
    execution_target: input.executionTarget,
    phase: "start",
    reason: input.reason,
    arguments: input.argumentsPayload,
    timestamp: new Date().toISOString(),
  };
}

function createToolProgressResultEvent(input: {
  callId: string;
  toolName: string;
  executionTarget: string;
  status: "ok" | "error";
  errorCode?: string;
  message?: string;
  result?: Record<string, unknown>;
  details?: Record<string, unknown>;
}): ToolProgressEvent {
  return {
    call_id: input.callId,
    tool_name: input.toolName,
    execution_target: input.executionTarget,
    phase: "result",
    status: input.status,
    error_code: input.errorCode,
    message: input.message,
    result: input.result,
    details: input.details,
    timestamp: new Date().toISOString(),
  };
}

function findBuiltInToolCallId(
  pending: Map<string, BuiltInToolInvocation>,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  for (const [callId, invocation] of pending.entries()) {
    if (invocation.toolName !== toolName) {
      continue;
    }
    if (safeJsonStringify(invocation.arguments) !== safeJsonStringify(args)) {
      continue;
    }
    pending.delete(callId);
    return callId;
  }
  if (pending.size > 0) {
    const bestEffort = pending.entries().next().value as
      | [string, BuiltInToolInvocation]
      | undefined;
    if (bestEffort && bestEffort[1].toolName === toolName) {
      pending.delete(bestEffort[0]);
      return bestEffort[0];
    }
  }
  return null;
}

function buildBuiltInToolResult(input: BuiltInToolResultInput): ToolCallResult | null {
  const { activeSend, callId, toolName, argumentsPayload, toolResult } = input;
  if (toolResult.resultType === "success") {
    return {
      task_id: activeSend.input.task_id,
      call_id: callId,
      tool_name: toolName,
      execution_target: "builtin_container",
      reason: `builtin_${toolName}`,
      arguments: argumentsPayload,
      status: "ok",
      result: normalizeBuiltinToolResultToRecord(
        toolName,
        argumentsPayload,
        toolResult,
      ),
    };
  }

  const errorCode =
    toolResult.resultType === "denied"
      ? "builtin_permission_denied"
      : toolResult.resultType === "rejected"
        ? "builtin_invalid_arguments"
        : "builtin_execution_failed";
  return {
    task_id: activeSend.input.task_id,
    call_id: callId,
    tool_name: toolName,
    execution_target: "builtin_container",
    reason: `builtin_${toolName}`,
    arguments: argumentsPayload,
    status: "error",
    error_code: errorCode,
    message:
      toolResult.error ??
      toolResult.textResultForLlm ??
      "Built-in tool execution failed.",
  };
}

function normalizeBuiltinToolResultToRecord(
  toolName: string,
  argumentsPayload: Record<string, unknown>,
  toolResult: ToolResultObject,
): Record<string, unknown> {
  if (toolName === "read_file" || toolName === "view") {
    const payload: Record<string, unknown> = {
      path:
        readStringFromRecord(argumentsPayload, "path") ??
        readStringFromRecord(argumentsPayload, "file_path") ??
        readStringFromRecord(argumentsPayload, "filePath") ??
        readStringFromRecord(argumentsPayload, "target_file") ??
        readStringFromRecord(argumentsPayload, "targetFile"),
      content: toolResult.textResultForLlm,
    };
    const bytes = Buffer.byteLength(toolResult.textResultForLlm, "utf8");
    payload.bytes = bytes;
    return payload;
  }
  if (toolName === "grep") {
    return {
      path: readStringFromRecord(argumentsPayload, "path") ?? ".",
      query:
        readStringFromRecord(argumentsPayload, "pattern") ??
        readStringFromRecord(argumentsPayload, "query") ??
        "",
      content: toolResult.textResultForLlm,
    };
  }
  if (toolName === "glob") {
    return {
      path: readStringFromRecord(argumentsPayload, "path") ?? ".",
      pattern: readStringFromRecord(argumentsPayload, "pattern") ?? "",
      content: toolResult.textResultForLlm,
    };
  }
  if (toolName === "edit_file" || toolName === "str_replace_editor") {
    return {
      path:
        readStringFromRecord(argumentsPayload, "path") ??
        readStringFromRecord(argumentsPayload, "file_path") ??
        readStringFromRecord(argumentsPayload, "filePath") ??
        readStringFromRecord(argumentsPayload, "target_file") ??
        readStringFromRecord(argumentsPayload, "targetFile"),
      content: toolResult.textResultForLlm,
    };
  }
  if (toolName === "bash") {
    return {
      command: readStringFromRecord(argumentsPayload, "command") ?? "",
      exit_code: readNumberFromRecord(argumentsPayload, "exit_code"),
      content: toolResult.textResultForLlm,
    };
  }
  return {
    content: toolResult.textResultForLlm,
  };
}

function onSessionEvent(state: SdkSessionState, event: SessionEvent): void {
  const activeSend = state.activeSend;
  if (!activeSend) {
    return;
  }
  if (state.routingMode !== "hybrid_container_builtin_gateway_host") {
    return;
  }
  if (event.type !== "tool.execution_start") {
    return;
  }
  const toolName = event.data.toolName;
  if (!isHybridBuiltInTool(toolName)) {
    return;
  }
  activeSend.sendTimeoutLastToolActivityAtMs = Date.now();
  const args = toRecord(event.data.arguments);
  activeSend.runtimeToolEvents.push(
    createToolProgressStartEvent({
      callId: event.data.toolCallId,
      toolName,
      executionTarget: "builtin_container",
      argumentsPayload: args,
      reason: `builtin_${toolName}`,
    }),
  );
  activeSend.builtinToolByCallId.set(event.data.toolCallId, {
    toolName,
    arguments: args,
  });
}
