import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { GatewayRepository } from "../gateway/repository.js";
import type { DiscordRecentMessageRecord } from "../gateway/types.js";
import {
  RECOMMENDED_MEMORY_NAMESPACES,
  isSystemMemoryNamespace,
} from "../gateway/memoryPolicy.js";
import { ContainerToolAdapter } from "../container-tools/adapter.js";
import { HostToolAdapter } from "./hostAdapter.js";
import type { ToolCallRequest, ToolCallResult } from "./types.js";

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

const discordChannelHistorySchema = z.object({
  channelId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  role: z.enum(["all", "user", "assistant"]).optional().default("all"),
});

const discordChannelListSchema = z.object({
  limit: z.number().int().min(1).max(200).optional().default(50),
});

export interface McpToolServiceOptions {
  containerSessionRoot: string;
  containerCliTimeoutSec: number;
  containerExecutionMode: "host" | "docker_exec";
  agentContainerName: string;
  containerDockerCliTimeoutSec: number;
  dockerProjectRoot: string;
  hostCliTimeoutSec: number;
  hostHttpTimeoutSec: number;
  hostCliAllowlist: string[];
  memoryNamespaceValidationMode?: "warn" | "enforce";
  discordBotToken?: string;
  discordGuildId?: string;
  discordApiBaseUrl?: string;
}

export class McpToolService {
  private readonly containerAdapter: ContainerToolAdapter;
  private readonly hostAdapter: HostToolAdapter;
  private readonly memoryNamespaceValidationMode: "warn" | "enforce";
  private discordGuildChannelsCache:
    | {
        fetchedAt: number;
        channels: DiscordGuildChannel[];
      }
    | null = null;

  constructor(
    private readonly repository: GatewayRepository,
    private readonly options: McpToolServiceOptions,
  ) {
    this.containerAdapter = new ContainerToolAdapter({
      sessionRoot: options.containerSessionRoot,
      cliTimeoutSec: options.containerCliTimeoutSec,
      executionMode: options.containerExecutionMode,
      containerName: options.agentContainerName,
      dockerCliTimeoutSec: options.containerDockerCliTimeoutSec,
      dockerProjectRoot: options.dockerProjectRoot,
    });
    this.hostAdapter = new HostToolAdapter({
      cliTimeoutSec: options.hostCliTimeoutSec,
      httpTimeoutSec: options.hostHttpTimeoutSec,
    });
    this.memoryNamespaceValidationMode =
      options.memoryNamespaceValidationMode ?? "warn";
  }

  async executeToolCall(input: ToolCallRequest): Promise<ToolCallResult> {
    const correlationId = `${input.taskId}:${input.callId}`;
    let taskIdForEvent: string | null = null;

    try {
      const task = await this.repository.findTaskById(input.taskId);
      if (!task) {
        throw new McpToolError(
          "invalid_tool_arguments",
          "Task is not found for the tool call.",
          {
            task_id: input.taskId,
          },
        );
      }
      taskIdForEvent = task.taskId;

      const session = await this.repository.findSessionById(input.sessionId);
      if (!session) {
        throw new McpToolError(
          "invalid_tool_arguments",
          "Session is not found for the tool call.",
          {
            session_id: input.sessionId,
          },
        );
      }

      if (task.sessionId !== session.sessionId) {
        throw new McpToolError(
          "invalid_tool_arguments",
          "Task and session are not associated.",
          {
            task_id: input.taskId,
            session_id: input.sessionId,
          },
        );
      }

      await this.repository.appendTaskEvent({
        eventId: newId("event"),
        taskId: input.taskId,
        eventType: "mcp.tool.call",
        payloadJson: {
          callId: input.callId,
          toolName: input.toolName,
          executionTarget: input.executionTarget,
          reason: input.reason,
          arguments: input.arguments,
        },
        timestamp: new Date(),
      });

      const result = await this.dispatchToolCall(input, session.userId);
      await this.repository.appendTaskEvent({
        eventId: newId("event"),
        taskId: input.taskId,
        eventType: "mcp.tool.result",
        payloadJson: {
          callId: input.callId,
          toolName: input.toolName,
          status: "ok",
          result,
        },
        timestamp: new Date(),
      });
      await this.repository.appendAuditLog({
        logId: newId("audit"),
        correlationId,
        actor: "gateway_mcp",
        decision: "allow",
        reason: input.toolName,
        raw: {
          task_id: input.taskId,
          session_id: input.sessionId,
          call_id: input.callId,
          tool_name: input.toolName,
          status: "ok",
        },
      });
      return {
        task_id: input.taskId,
        call_id: input.callId,
        status: "ok",
        result,
      };
    } catch (error) {
      const toolError = toMcpToolError(error);
      if (taskIdForEvent) {
        await this.repository.appendTaskEvent({
          eventId: newId("event"),
          taskId: taskIdForEvent,
          eventType: "mcp.tool.result",
          payloadJson: {
            callId: input.callId,
            toolName: input.toolName,
            status: "error",
            errorCode: toolError.code,
            message: toolError.message,
            details: toolError.details ?? {},
          },
          timestamp: new Date(),
        });
      }
      await this.repository.appendAuditLog({
        logId: newId("audit"),
        correlationId,
        actor: "gateway_mcp",
        decision: "deny",
        reason: toolError.code,
        raw: {
          task_id: input.taskId,
          session_id: input.sessionId,
          call_id: input.callId,
          tool_name: input.toolName,
          status: "error",
          error_code: toolError.code,
          details: toolError.details ?? {},
        },
      });
      return {
        task_id: input.taskId,
        call_id: input.callId,
        status: "error",
        error_code: toolError.code,
        message: toolError.message,
        details: toolError.details,
      };
    }
  }

  private async dispatchToolCall(
    input: ToolCallRequest,
    userId: string,
  ): Promise<Record<string, unknown>> {
    if (input.executionTarget !== "gateway_adapter") {
      throw new McpToolError(
        "external_mcp_disabled",
        "Only execution_target=gateway_adapter is supported.",
      );
    }

    switch (input.toolName) {
      case "container.file_read": {
        const args = parseToolArgs(containerFileReadSchema, input.arguments);
        return this.containerAdapter.fileRead(input.sessionId, args.path);
      }
      case "container.file_write": {
        const args = parseToolArgs(containerFileWriteSchema, input.arguments);
        return this.containerAdapter.fileWrite(
          input.sessionId,
          args.path,
          args.content,
        );
      }
      case "container.file_delete": {
        const args = parseToolArgs(containerFileDeleteSchema, input.arguments);
        return this.containerAdapter.fileDelete(input.sessionId, args.path);
      }
      case "container.file_list": {
        const args = parseToolArgs(containerFileListSchema, input.arguments);
        return this.containerAdapter.fileList(input.sessionId, args.path);
      }
      case "container.file_deliver": {
        const args = parseToolArgs(containerFileDeliverSchema, input.arguments);
        const file = await this.containerAdapter.fileReadBase64(
          input.sessionId,
          args.path,
          args.maxBytes,
        );
        return {
          path: file.path,
          bytes: file.bytes,
          content_base64: file.contentBase64,
          mime_type: resolveMimeTypeFromPath(file.path),
          file_name: path.basename(file.path),
          max_bytes: args.maxBytes,
        };
      }
      case "container.cli_exec": {
        const args = parseToolArgs(cliExecSchema, input.arguments);
        return this.containerAdapter.cliExec({
          sessionId: input.sessionId,
          command: args.command,
          args: args.args,
          cwd: args.cwd,
          timeoutSec: args.timeoutSec,
        });
      }
      case "host.file_read": {
        const args = parseToolArgs(containerFileReadSchema, input.arguments);
        const normalizedPath = normalizeHostPath(args.path);
        await this.assertHostScopeAllowed(input.sessionId, "read", normalizedPath);
        return this.hostAdapter.fileRead(normalizedPath);
      }
      case "host.file_write": {
        const args = parseToolArgs(containerFileWriteSchema, input.arguments);
        const normalizedPath = normalizeHostPath(args.path);
        await this.assertHostScopeAllowed(input.sessionId, "write", normalizedPath);
        return this.hostAdapter.fileWrite(normalizedPath, args.content);
      }
      case "host.file_delete": {
        const args = parseToolArgs(containerFileDeleteSchema, input.arguments);
        const normalizedPath = normalizeHostPath(args.path);
        await this.assertHostScopeAllowed(input.sessionId, "delete", normalizedPath);
        return this.hostAdapter.fileDelete(normalizedPath);
      }
      case "host.file_list": {
        const args = parseToolArgs(containerFileListSchema, input.arguments);
        const normalizedPath = normalizeHostPath(args.path);
        await this.assertHostScopeAllowed(input.sessionId, "list", normalizedPath);
        return this.hostAdapter.fileList(normalizedPath);
      }
      case "host.cli_exec": {
        const args = parseToolArgs(cliExecSchema, input.arguments);
        if (!this.options.hostCliAllowlist.includes(args.command)) {
          throw new McpToolError(
            "policy_denied_command",
            "Host command is not allowed by policy.",
            {
              command: args.command,
            },
          );
        }
        await this.assertHostScopeAllowed(input.sessionId, "exec", args.command);
        return this.hostAdapter.cliExec({
          command: args.command,
          args: args.args,
          cwd: args.cwd,
          timeoutSec: args.timeoutSec,
        });
      }
      case "host.http_request": {
        const args = parseToolArgs(hostHttpRequestSchema, input.arguments);
        const url = new URL(args.url);
        await this.assertHostScopeAllowed(input.sessionId, "http_request", url.origin);
        return this.hostAdapter.httpRequest({
          url: args.url,
          method: args.method,
          headers: args.headers,
          body: args.body,
          timeoutSec: args.timeoutSec,
        });
      }
      case "memory.upsert": {
        const args = parseToolArgs(memoryUpsertSchema, input.arguments);
        this.validateMemoryNamespace(args.namespace, input.callId);
        if (isSystemMemoryNamespace(args.namespace)) {
          throw new McpToolError(
            "memory_system_entry_read_only",
            "System memory entries are read-only for normal tool calls.",
            {
              namespace: args.namespace,
            },
          );
        }
        const stored = await this.repository.upsertMemory({
          memoryId: newId("mem"),
          userId,
          namespace: args.namespace,
          key: args.key,
          valueJson: args.value,
          tagsJson: args.tags,
          backlinks: args.backlinks,
        });
        return {
          memoryId: stored.memoryId,
          namespace: stored.namespace,
          key: stored.key,
          value: stored.valueJson,
          tags: stored.tagsJson,
          updatedAt: stored.updatedAt.toISOString(),
        };
      }
      case "memory.get": {
        const args = parseToolArgs(memoryGetSchema, input.arguments);
        this.validateMemoryNamespace(args.namespace, input.callId);
        const found = await this.repository.getMemory(userId, args.namespace, args.key, {
          includeSystemEntry: true,
        });
        return {
          found: found !== null,
          entry:
            found === null
              ? null
              : {
                  memoryId: found.memoryId,
                  userId: found.userId,
                  namespace: found.namespace,
                  key: found.key,
                  value: found.valueJson,
                  tags: found.tagsJson,
                  is_system: found.isSystem,
                  backlinks:
                    found.backlinks?.map((backlink) => ({
                      source_memory_id: backlink.sourceMemoryId,
                      source_namespace: backlink.sourceNamespace,
                      source_key: backlink.sourceKey,
                      relation: backlink.relation,
                      created_at: backlink.createdAt.toISOString(),
                    })) ?? [],
                  updatedAt: found.updatedAt.toISOString(),
                },
        };
      }
      case "memory.search": {
        const args = parseToolArgs(memorySearchSchema, input.arguments);
        this.validateMemoryNamespace(args.namespace, input.callId);
        const results = await this.repository.searchMemory({
          userId,
          namespace: args.namespace,
          query: args.query,
          limit: args.limit,
          includeSystemEntries: true,
        });
        return {
          entries: results.map((entry) => ({
            memoryId: entry.memoryId,
            userId: entry.userId,
            namespace: entry.namespace,
            key: entry.key,
            value: entry.valueJson,
            tags: entry.tagsJson,
            is_system: entry.isSystem,
            backlinks:
              entry.backlinks?.map((backlink) => ({
                source_memory_id: backlink.sourceMemoryId,
                source_namespace: backlink.sourceNamespace,
                source_key: backlink.sourceKey,
                relation: backlink.relation,
                created_at: backlink.createdAt.toISOString(),
              })) ?? [],
            updatedAt: entry.updatedAt.toISOString(),
          })),
        };
      }
      case "memory.delete": {
        const args = parseToolArgs(memoryDeleteSchema, input.arguments);
        this.validateMemoryNamespace(args.namespace, input.callId);
        if (isSystemMemoryNamespace(args.namespace)) {
          throw new McpToolError(
            "memory_system_entry_read_only",
            "System memory entries are read-only for normal tool calls.",
            {
              namespace: args.namespace,
            },
          );
        }
        await this.repository.deleteMemory(userId, args.namespace, args.key);
        return { deleted: true };
      }
      case "discord.channel_history": {
        const args = parseToolArgs(discordChannelHistorySchema, input.arguments);
        const session = await this.repository.findSessionById(input.sessionId);
        if (!session) {
          throw new McpToolError(
            "invalid_tool_arguments",
            "Session is not found for discord.channel_history.",
            {
              session_id: input.sessionId,
            },
          );
        }
        const targetChannelId = args.channelId?.trim() ?? session.channelId;
        await this.assertDiscordScopeAllowed(
          input.sessionId,
          "discord_channel_history",
          `discord_channel:${targetChannelId}`,
        );
        const channelSet = await this.listDiscordChannels();
        const matchedChannel = channelSet.channels.find(
          (channel) => channel.channelId === targetChannelId,
        );
        if (
          args.channelId &&
          channelSet.source === "discord_api" &&
          !matchedChannel
        ) {
          throw new McpToolError(
            "invalid_tool_arguments",
            "Requested Discord channel was not found in the configured guild.",
            {
              channel_id: targetChannelId,
              guild_id: channelSet.guildId,
            },
          );
        }
        const messages = await this.repository.listDiscordRecentMessages({
          channelId: targetChannelId,
          limit: args.limit,
        });
        const apiHistory = await this.listDiscordChannelMessages({
          channelId: targetChannelId,
          limit: args.limit,
          sessionId: input.sessionId,
          taskId: input.taskId,
          sessionUserId: userId,
        });
        const historyEntries =
          apiHistory.source === "discord_api"
            ? apiHistory.entries
            : messages.map((message) => toRepositoryDiscordHistoryEntry(message));
        return {
          channel_id: targetChannelId,
          channel_name: matchedChannel?.channelName ?? null,
          entries: toDiscordHistoryEntries(historyEntries, args.role, args.limit),
          source: channelSet.source,
          entries_source: apiHistory.source,
          fallback_reason:
            apiHistory.source === "repository" ? apiHistory.fallbackReason : null,
          note:
            apiHistory.source === "discord_api"
              ? "for non-thread context, entries are fetched from Discord channel messages API"
              : "for non-thread context, entries are derived from session records because Discord channel messages API was unavailable",
        };
      }
      case "discord.channel_list": {
        const args = parseToolArgs(discordChannelListSchema, input.arguments);
        const session = await this.repository.findSessionById(input.sessionId);
        if (!session) {
          throw new McpToolError(
            "invalid_tool_arguments",
            "Session is not found for discord.channel_list.",
            {
              session_id: input.sessionId,
            },
          );
        }
        await this.assertDiscordScopeAllowed(
          input.sessionId,
          "discord_channel_list",
          this.options.discordGuildId?.trim()
            ? `discord_guild:${this.options.discordGuildId.trim()}`
            : "discord_guild:known_channels",
        );
        const channelSet = await this.listDiscordChannels();
        return {
          guild_id: channelSet.guildId,
          source: channelSet.source,
          channels: channelSet.channels
            .slice(0, args.limit)
            .map((channel) => ({
              channel_id: channel.channelId,
              channel_name: channel.channelName,
              channel_type: channel.channelType,
              parent_channel_id: channel.parentChannelId,
              position: channel.position,
              last_seen_at: channel.lastSeenAt?.toISOString() ?? null,
            })),
          note:
            channelSet.source === "discord_api"
              ? "channels are fetched from the Discord guild API"
              : "known channels are derived from session records and related metadata events",
        };
      }
      default:
        throw new McpToolError(
          "invalid_tool_arguments",
          "Unsupported tool name.",
          {
            tool_name: input.toolName,
          },
        );
    }
  }

  private async assertHostScopeAllowed(
    sessionId: string,
    operation: string,
    scopeValue: string,
  ): Promise<void> {
    const grantedPermissions = await this.repository.listPathPermissions(
      sessionId,
      operation,
    );
    if (
      grantedPermissions.some((permission) =>
        this.isPermissionMatch(operation, permission.path, scopeValue),
      )
    ) {
      return;
    }

    const latestApproval = await this.repository.findLatestApprovalByScope(
      sessionId,
      operation,
      scopeValue,
    );
    if (!latestApproval || latestApproval.status === "requested") {
      throw new McpToolError(
        "approval_required",
        "Host operation requires approval before execution.",
        {
          session_id: sessionId,
          operation,
          scope: scopeValue,
          approval_id: latestApproval?.approvalId ?? null,
        },
      );
    }
    if (latestApproval.status === "rejected") {
      throw new McpToolError(
        "approval_rejected",
        "Host operation was rejected by approval policy.",
        {
          session_id: sessionId,
          operation,
          scope: scopeValue,
          approval_id: latestApproval.approvalId,
        },
      );
    }
    if (latestApproval.status === "timeout") {
      throw new McpToolError(
        "approval_timeout",
        "Host operation approval timed out.",
        {
          session_id: sessionId,
          operation,
          scope: scopeValue,
          approval_id: latestApproval.approvalId,
        },
      );
    }

    throw new McpToolError(
      "path_not_approved_for_session",
      "Path is not approved in this session.",
      {
        session_id: sessionId,
        operation,
        scope: scopeValue,
      },
    );
  }

  private async assertDiscordScopeAllowed(
    sessionId: string,
    operation: string,
    scopeValue: string,
  ): Promise<void> {
    const grantedPermissions = await this.repository.listPathPermissions(
      sessionId,
      operation,
    );
    if (
      grantedPermissions.some((permission) =>
        this.isPermissionMatch(operation, permission.path, scopeValue),
      )
    ) {
      return;
    }

    const latestApproval = await this.repository.findLatestApprovalByScope(
      sessionId,
      operation,
      scopeValue,
    );
    if (!latestApproval || latestApproval.status === "requested") {
      throw new McpToolError(
        "approval_required",
        "Discord operation requires approval before execution.",
        {
          session_id: sessionId,
          operation,
          scope: scopeValue,
          approval_id: latestApproval?.approvalId ?? null,
        },
      );
    }
    if (latestApproval.status === "rejected") {
      throw new McpToolError(
        "approval_rejected",
        "Discord operation was rejected by approval policy.",
        {
          session_id: sessionId,
          operation,
          scope: scopeValue,
          approval_id: latestApproval.approvalId,
        },
      );
    }
    if (latestApproval.status === "timeout") {
      throw new McpToolError(
        "approval_timeout",
        "Discord operation approval timed out.",
        {
          session_id: sessionId,
          operation,
          scope: scopeValue,
          approval_id: latestApproval.approvalId,
        },
      );
    }

    throw new McpToolError(
      "path_not_approved_for_session",
      "Discord scope is not approved in this session.",
      {
        session_id: sessionId,
        operation,
        scope: scopeValue,
      },
    );
  }

  private async listDiscordChannels(): Promise<{
    guildId: string | null;
    source: "discord_api" | "repository";
    channels: DiscordGuildChannel[];
    fallbackReason?: string;
  }> {
    const guildId = this.options.discordGuildId?.trim() || null;
    const token = this.options.discordBotToken?.trim();
    const apiBaseUrl = this.normalizeDiscordApiBaseUrl(
      this.options.discordApiBaseUrl,
    );
    if (!guildId || !token) {
      const known = await this.repository.listKnownDiscordChannels({ limit: 200 });
      return {
        guildId,
        source: "repository",
        channels: known.map((channel) => ({
          channelId: channel.channelId,
          channelName: channel.channelName,
          channelType: null,
          parentChannelId: null,
          position: null,
          lastSeenAt: channel.lastSeenAt,
        })),
      };
    }

    const cache = this.discordGuildChannelsCache;
    const now = Date.now();
    if (cache && now - cache.fetchedAt < 30_000) {
      return {
        guildId,
        source: "discord_api",
        channels: cache.channels,
      };
    }

    try {
      const response = await fetch(
        `${apiBaseUrl}/guilds/${encodeURIComponent(guildId)}/channels`,
        {
          method: "GET",
          headers: {
            Authorization: `Bot ${token}`,
          },
        },
      );
      if (!response.ok) {
        const responseBody = truncate(await response.text(), 400);
        throw new McpToolError(
          "tool_execution_failed",
          "Failed to fetch Discord guild channels.",
          {
            status: response.status,
            guild_id: guildId,
            response: responseBody,
          },
        );
      }
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) {
        throw new McpToolError(
          "tool_execution_failed",
          "Unexpected Discord channels response format.",
          {
            guild_id: guildId,
          },
        );
      }
      const channels = payload
        .map((entry) => parseDiscordGuildChannel(entry))
        .filter((entry): entry is DiscordGuildChannel => entry !== null)
        .sort((a, b) => {
          const positionA = a.position ?? Number.MAX_SAFE_INTEGER;
          const positionB = b.position ?? Number.MAX_SAFE_INTEGER;
          if (positionA !== positionB) {
            return positionA - positionB;
          }
          return a.channelId.localeCompare(b.channelId);
        });
      this.discordGuildChannelsCache = {
        fetchedAt: now,
        channels,
      };
      return {
        guildId,
        source: "discord_api",
        channels,
      };
    } catch (error) {
      const known = await this.repository.listKnownDiscordChannels({ limit: 200 });
      return {
        guildId,
        source: "repository",
        fallbackReason: summarizeError(error),
        channels: known.map((channel) => ({
          channelId: channel.channelId,
          channelName: channel.channelName,
          channelType: null,
          parentChannelId: null,
          position: null,
          lastSeenAt: channel.lastSeenAt,
        })),
      };
    }
  }

  private async listDiscordChannelMessages(input: {
    channelId: string;
    limit: number;
    sessionId: string;
    taskId: string;
    sessionUserId: string;
  }): Promise<{
    source: "discord_api" | "repository";
    entries: DiscordHistoryEntry[];
    fallbackReason?: string;
  }> {
    const token = this.options.discordBotToken?.trim();
    if (!token) {
      return {
        source: "repository",
        entries: [],
        fallbackReason: "discord_bot_token_missing",
      };
    }
    const apiBaseUrl = this.normalizeDiscordApiBaseUrl(
      this.options.discordApiBaseUrl,
    );
    const params = new URLSearchParams({
      limit: String(Math.min(Math.max(input.limit, 1), 50)),
    });
    try {
      const response = await fetch(
        `${apiBaseUrl}/channels/${encodeURIComponent(input.channelId)}/messages?${params.toString()}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bot ${token}`,
          },
        },
      );
      if (!response.ok) {
        const responseBody = truncate(await response.text(), 400);
        throw new McpToolError(
          "tool_execution_failed",
          "Failed to fetch Discord channel messages.",
          {
            status: response.status,
            channel_id: input.channelId,
            response: responseBody,
          },
        );
      }
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) {
        throw new McpToolError(
          "tool_execution_failed",
          "Unexpected Discord channel messages response format.",
          {
            channel_id: input.channelId,
          },
        );
      }
      const entries = payload
        .map((entry) =>
          parseDiscordChannelMessage(
            entry,
            input.sessionId,
            input.taskId,
            input.sessionUserId,
          ),
        )
        .filter((entry): entry is DiscordHistoryEntry => entry !== null)
        .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      return {
        source: "discord_api",
        entries,
      };
    } catch (error) {
      return {
        source: "repository",
        entries: [],
        fallbackReason: summarizeError(error),
      };
    }
  }

  private normalizeDiscordApiBaseUrl(raw: string | undefined): string {
    const base = raw?.trim() || "https://discord.com/api/v10";
    return base.endsWith("/") ? base.slice(0, -1) : base;
  }

  private isPermissionMatch(
    operation: string,
    grantedValue: string,
    scopeValue: string,
  ): boolean {
    if (
      operation === "discord_channel_history" &&
      grantedValue === "discord_channel:__session_channel__"
    ) {
      return scopeValue.startsWith("discord_channel:");
    }
    if (
      operation === "discord_channel_list" &&
      grantedValue === "discord_guild:__session_guild__"
    ) {
      return scopeValue.startsWith("discord_guild:");
    }
    if (
      operation === "read" ||
      operation === "write" ||
      operation === "delete" ||
      operation === "list"
    ) {
      const grantedPath = normalizeHostPath(grantedValue);
      const targetPath = normalizeHostPath(scopeValue);
      if (targetPath === grantedPath) {
        return true;
      }
      return targetPath.startsWith(`${grantedPath}${path.sep}`);
    }

    return grantedValue === scopeValue;
  }

  private validateMemoryNamespace(namespace: string, callId: string): void {
    if (RECOMMENDED_MEMORY_NAMESPACES.includes(namespace as (typeof RECOMMENDED_MEMORY_NAMESPACES)[number])) {
      return;
    }
    if (this.memoryNamespaceValidationMode === "enforce") {
      throw new McpToolError(
        "invalid_tool_arguments",
        "Memory namespace is not allowed by policy.",
        {
          namespace,
          allowed_namespaces: [...RECOMMENDED_MEMORY_NAMESPACES],
        },
      );
    }
    this.repository
      .appendAuditLog({
        logId: newId("audit"),
        correlationId: `memory-namespace:${callId}`,
        actor: "gateway_mcp",
        decision: "warn",
        reason: "memory_namespace_not_recommended",
        raw: {
          namespace,
          allowed_namespaces: [...RECOMMENDED_MEMORY_NAMESPACES],
        },
      })
      .catch(() => undefined);
  }
}

class McpToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

function parseToolArgs<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new McpToolError("invalid_tool_arguments", "Tool arguments are invalid.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function toMcpToolError(error: unknown): McpToolError {
  if (error instanceof McpToolError) {
    return error;
  }

  if (error instanceof Error && error.message === "container_path_out_of_scope") {
    return new McpToolError(
      "container_path_out_of_scope",
      "Container path is outside allowed session scope.",
    );
  }
  if (error instanceof Error && error.message === "container_path_not_found") {
    return new McpToolError(
      "container_path_not_found",
      "Container path was not found.",
    );
  }
  if (error instanceof Error && error.message === "container_path_not_file") {
    return new McpToolError(
      "container_path_not_file",
      "Container path is not a regular file.",
    );
  }
  if (error instanceof Error && error.message === "container_file_too_large") {
    return new McpToolError(
      "container_file_too_large",
      "Container file exceeds maxBytes limit.",
    );
  }
  if (
    error instanceof Error &&
    error.message.startsWith("memory_backlink_source_not_found:")
  ) {
    const [, sourceNamespace, sourceKey] = error.message.split(":", 3);
    return new McpToolError(
      "invalid_tool_arguments",
      "Backlink source memory entry was not found.",
      {
        source_namespace: sourceNamespace,
        source_key: sourceKey,
      },
    );
  }

  if (error instanceof Error) {
    return new McpToolError("tool_execution_failed", error.message);
  }

  return new McpToolError("tool_execution_failed", "Unexpected tool execution error.");
}

function normalizeHostPath(rawPath: string): string {
  return path.resolve(rawPath);
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}_${randomUUID().slice(0, 8)}`;
}

function resolveMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".txt":
    case ".md":
    case ".log":
    case ".json":
    case ".yml":
    case ".yaml":
    case ".xml":
    case ".csv":
      return "text/plain";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

interface DiscordGuildChannel {
  channelId: string;
  channelName: string | null;
  channelType: number | null;
  parentChannelId: string | null;
  position: number | null;
  lastSeenAt: Date | null;
}

interface DiscordHistoryEntry {
  eventId: string;
  sessionId: string;
  taskId: string;
  role: "user" | "assistant";
  userId: string;
  username: string | null;
  nickname: string | null;
  content: string;
  attachmentUrls: string[];
  reference: {
    messageId: string;
    channelId: string | null;
    guildId: string | null;
  } | null;
  replyTo: {
    messageId: string;
    channelId: string | null;
    userId: string | null;
    username: string | null;
    content: string | null;
    attachmentUrls: string[];
  } | null;
  forwardFrom: {
    messageId: string | null;
    channelId: string | null;
    guildId: string | null;
    userId: string | null;
    username: string | null;
    content: string | null;
    attachmentUrls: string[];
  } | null;
  timestamp: Date;
}

function parseDiscordGuildChannel(value: unknown): DiscordGuildChannel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const channelId = readNonEmptyString(record.id);
  if (!channelId) {
    return null;
  }
  const channelName = readNonEmptyString(record.name);
  const parentChannelId = readNonEmptyString(record.parent_id);
  const channelType =
    typeof record.type === "number" && Number.isFinite(record.type)
      ? record.type
      : null;
  const position =
    typeof record.position === "number" && Number.isFinite(record.position)
      ? record.position
      : null;
  return {
    channelId,
    channelName,
    channelType,
    parentChannelId,
    position,
    lastSeenAt: null,
  };
}

function parseDiscordChannelMessage(
  value: unknown,
  sessionId: string,
  taskId: string,
  sessionUserId: string,
): DiscordHistoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const messageId = readNonEmptyString(record.id);
  const content = readNonEmptyString(record.content);
  const timestampRaw = readNonEmptyString(record.timestamp);
  const author = asRecord(record.author);
  const authorId = readNonEmptyString(author?.id);
  if (!messageId || !timestampRaw || !authorId) {
    return null;
  }
  const timestamp = new Date(timestampRaw);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }
  const member = asRecord(record.member);
  const username =
    readNonEmptyString(author?.username) ?? readNonEmptyString(author?.global_name);
  const nickname = readNonEmptyString(member?.nick);
  const role: "user" | "assistant" =
    authorId === sessionUserId ? "user" : "assistant";
  const attachmentUrls = extractDiscordAttachmentUrls(record.attachments);
  const reference = parseDiscordMessageReference(record.message_reference);
  const replyTo = parseDiscordReplyTo(record.referenced_message);
  const forwardFrom = parseDiscordForwardSource(record.message_snapshots);
  return {
    eventId: messageId,
    sessionId,
    taskId,
    role,
    userId: authorId,
    username,
    nickname,
    content: content ?? "",
    attachmentUrls,
    reference,
    replyTo,
    forwardFrom,
    timestamp,
  };
}

function extractDiscordAttachmentUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const urls: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const url = readNonEmptyString(record?.url);
    if (!url) {
      continue;
    }
    urls.push(url);
  }
  return urls;
}

function parseDiscordMessageReference(value: unknown): {
  messageId: string;
  channelId: string | null;
  guildId: string | null;
} | null {
  const record = asRecord(value);
  const messageId = readNonEmptyString(record?.message_id);
  if (!messageId) {
    return null;
  }
  return {
    messageId,
    channelId: readNonEmptyString(record?.channel_id),
    guildId: readNonEmptyString(record?.guild_id),
  };
}

function parseDiscordReplyTo(value: unknown): {
  messageId: string;
  channelId: string | null;
  userId: string | null;
  username: string | null;
  content: string | null;
  attachmentUrls: string[];
} | null {
  const record = asRecord(value);
  const messageId = readNonEmptyString(record?.id);
  if (!messageId) {
    return null;
  }
  const author = asRecord(record?.author);
  return {
    messageId,
    channelId: readNonEmptyString(record?.channel_id),
    userId: readNonEmptyString(author?.id),
    username:
      readNonEmptyString(author?.username) ??
      readNonEmptyString(author?.global_name),
    content: readStringOrNull(record?.content),
    attachmentUrls: extractDiscordAttachmentUrls(record?.attachments),
  };
}

function parseDiscordForwardSource(value: unknown): {
  messageId: string | null;
  channelId: string | null;
  guildId: string | null;
  userId: string | null;
  username: string | null;
  content: string | null;
  attachmentUrls: string[];
} | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const first = asRecord(value[0]);
  const message = asRecord(first?.message);
  if (!message) {
    return null;
  }
  const author = asRecord(message.author);
  return {
    messageId: readNonEmptyString(message.id),
    channelId: readNonEmptyString(message.channel_id),
    guildId: readNonEmptyString(message.guild_id),
    userId: readNonEmptyString(author?.id),
    username:
      readNonEmptyString(author?.username) ??
      readNonEmptyString(author?.global_name),
    content: readStringOrNull(message.content),
    attachmentUrls: extractDiscordAttachmentUrls(message.attachments),
  };
}

function toRepositoryDiscordHistoryEntry(
  record: DiscordRecentMessageRecord,
): DiscordHistoryEntry {
  return {
    eventId: record.eventId,
    sessionId: record.sessionId,
    taskId: record.taskId,
    role: record.role,
    userId: record.userId,
    username: record.username,
    nickname: record.nickname,
    content: record.content,
    attachmentUrls: [],
    reference: null,
    replyTo: null,
    forwardFrom: null,
    timestamp: record.timestamp,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toDiscordHistoryEntries(
  records: DiscordHistoryEntry[],
  role: "all" | "user" | "assistant",
  limit: number,
): Array<{
  eventId: string;
  sessionId: string;
  taskId: string;
  role: "user" | "assistant";
  userId: string;
  username: string | null;
  nickname: string | null;
  content: string;
  attachmentUrls: string[];
  reference: {
    messageId: string;
    channelId: string | null;
    guildId: string | null;
  } | null;
  replyTo: {
    messageId: string;
    channelId: string | null;
    userId: string | null;
    username: string | null;
    content: string | null;
    attachmentUrls: string[];
  } | null;
  forwardFrom: {
    messageId: string | null;
    channelId: string | null;
    guildId: string | null;
    userId: string | null;
    username: string | null;
    content: string | null;
    attachmentUrls: string[];
  } | null;
  timestamp: string;
}> {
  const filtered = records.filter((entry) => role === "all" || entry.role === role);
  const sliced = filtered.slice(Math.max(filtered.length - limit, 0));
  return sliced.map((entry) => ({
    eventId: entry.eventId,
    sessionId: entry.sessionId,
    taskId: entry.taskId,
    role: entry.role,
    userId: entry.userId,
    username: entry.username,
    nickname: entry.nickname,
    content: entry.content,
    attachmentUrls: entry.attachmentUrls,
    reference: entry.reference
      ? {
          messageId: entry.reference.messageId,
          channelId: entry.reference.channelId,
          guildId: entry.reference.guildId,
        }
      : null,
    replyTo: entry.replyTo
      ? {
          messageId: entry.replyTo.messageId,
          channelId: entry.replyTo.channelId,
          userId: entry.replyTo.userId,
          username: entry.replyTo.username,
          content: entry.replyTo.content,
          attachmentUrls: entry.replyTo.attachmentUrls,
        }
      : null,
    forwardFrom: entry.forwardFrom
      ? {
          messageId: entry.forwardFrom.messageId,
          channelId: entry.forwardFrom.channelId,
          guildId: entry.forwardFrom.guildId,
          userId: entry.forwardFrom.userId,
          username: entry.forwardFrom.username,
          content: entry.forwardFrom.content,
          attachmentUrls: entry.forwardFrom.attachmentUrls,
        }
      : null,
    timestamp: entry.timestamp.toISOString(),
  }));
}
