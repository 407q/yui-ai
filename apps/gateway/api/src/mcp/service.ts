import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { GatewayRepository } from "../gateway/repository.js";
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
}

const RECOMMENDED_MEMORY_NAMESPACES = [
  "profile.person",
  "conversation.fact",
  "knowledge.note",
  "task.preference",
] as const;

export class McpToolService {
  private readonly containerAdapter: ContainerToolAdapter;
  private readonly hostAdapter: HostToolAdapter;
  private readonly memoryNamespaceValidationMode: "warn" | "enforce";

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
        const found = await this.repository.getMemory(userId, args.namespace, args.key);
        return {
          found: found !== null,
          entry:
            found === null
              ? null
              : {
                  memoryId: found.memoryId,
                  namespace: found.namespace,
                  key: found.key,
                  value: found.valueJson,
                  tags: found.tagsJson,
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
        });
        return {
          entries: results.map((entry) => ({
            memoryId: entry.memoryId,
            namespace: entry.namespace,
            key: entry.key,
            value: entry.valueJson,
            tags: entry.tagsJson,
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
        await this.repository.deleteMemory(userId, args.namespace, args.key);
        return { deleted: true };
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

  private isPermissionMatch(
    operation: string,
    grantedValue: string,
    scopeValue: string,
  ): boolean {
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
