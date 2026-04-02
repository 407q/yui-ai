import "dotenv/config";
import { Buffer } from "node:buffer";
import http from "node:http";
import path from "node:path";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  AnyThreadChannel,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Channel,
  Client,
  type MessageEditOptions,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Message,
  type Snowflake,
} from "discord.js";
import {
  RuntimeSupervisor,
  type RuntimeSupervisorShutdownOptions,
} from "./orchestration/supervisor.js";

type SessionStatus =
  | "running"
  | "waiting_approval"
  | "idle_waiting"
  | "idle_paused"
  | "canceled"
  | "failed"
  | "closed_by_user";

type ApprovalDecision = "approved" | "rejected" | "timeout" | "canceled";
type SystemControlMode = "exit" | "reboot";
type RuntimeInfrastructureStatus = "booting" | "ready" | "failed";
type ContextEnvelopeTaskTerminalStatus = "completed" | "failed" | "canceled";
type ApprovalOperationCode =
  | "read"
  | "write"
  | "delete"
  | "list"
  | "exec"
  | "http_request"
  | "web_search"
  | "discord_channel_history"
  | "discord_channel_list"
  | "unknown";

interface RuntimeFeedbackState {
  previousTaskTerminalStatus?: ContextEnvelopeTaskTerminalStatus;
  previousToolErrors: string[];
  retryHint?: string;
  attachmentSources: GatewayAttachmentSource[];
}

interface ContextEnvelopeDiscordPayload {
  userId: string;
  username?: string;
  nickname?: string;
  channelId: string;
  channelName?: string;
  threadId: string;
  threadName?: string;
}

interface QueuedRun {
  prompt: string;
  attachments: GatewayAttachmentSource[];
  triggeredByUserId: Snowflake;
}

interface GatewayAttachmentSource {
  name: string;
  sourceUrl: string;
}

interface DeliveredContainerFile {
  path: string;
  fileName: string;
  bytes: number;
  mimeType: string;
  contentBase64: string;
}

interface MockSession {
  id: string;
  ownerUserId: Snowflake;
  ownerUsername?: string;
  ownerNickname?: string;
  channelId: Snowflake;
  channelName?: string;
  threadId: Snowflake;
  threadName?: string;
  gatewaySessionId?: string;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  idleDeadlineAt: Date;
  currentTaskId?: string;
  pendingApprovalId?: string;
  runSequence: number;
  cancelRequested: boolean;
  lastEvent: string;
  queuedRun?: QueuedRun;
  runtimeFeedback: RuntimeFeedbackState;
  lastTaskEventTimestamp?: string;
  lastToolEventTimestamp?: string;
}

interface PendingApproval {
  approvalId: string;
  sessionId: string;
  threadId: Snowflake;
  messageId: Snowflake | null;
  request: {
    toolName: string;
    operationCode: ApprovalOperationCode;
    target: string;
    targetLine?: string;
  };
}

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_BOT_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN is required.");
}
const BOT_MODE = process.env.BOT_MODE === "mock" ? "mock" : "standard";
const IS_MOCK_MODE = BOT_MODE === "mock";
const LOG_PREFIX = `[bot:${BOT_MODE}]`;
const ALERT_TAG = BOT_MODE === "mock" ? "bot-mock" : "bot";

const SYSTEM_ALERT_CHANNEL_ID = process.env.BOT_SYSTEM_ALERT_CHANNEL_ID;
const GATEWAY_API_BASE_URL = process.env.GATEWAY_API_BASE_URL ?? "http://127.0.0.1:3800";
const AGENT_RUNTIME_BASE_URL = process.env.AGENT_RUNTIME_BASE_URL ?? "http://127.0.0.1:3801";
const DEFAULT_GATEWAY_API_SOCKET_PATH = "/tmp/sockets/gateway-api.sock";
const DEFAULT_AGENT_RUNTIME_SOCKET_PATH = "/tmp/sockets/agent-runtime.sock";
const BOT_TO_GATEWAY_INTERNAL_TOKEN =
  process.env.BOT_TO_GATEWAY_INTERNAL_TOKEN ?? process.env.GATEWAY_INTERNAL_TOKEN ?? "";
const GATEWAY_API_SOCKET_PATH = resolveOptionalSocketPath(
  resolveInternalConnectionMode() === "uds"
    ? process.env.GATEWAY_API_SOCKET_PATH ?? DEFAULT_GATEWAY_API_SOCKET_PATH
    : undefined,
);
const AGENT_RUNTIME_SOCKET_PATH = resolveOptionalSocketPath(
  resolveInternalConnectionMode() === "uds"
    ? process.env.AGENT_RUNTIME_SOCKET_PATH ?? DEFAULT_AGENT_RUNTIME_SOCKET_PATH
    : undefined,
);
const GATEWAY_API_HOST = process.env.GATEWAY_API_HOST ?? "127.0.0.1";
const GATEWAY_API_PORT = parsePositiveInt(process.env.GATEWAY_API_PORT, 3800);
const ORCHESTRATOR_MONITOR_INTERVAL_SEC = parsePositiveInt(
  process.env.BOT_ORCHESTRATOR_MONITOR_INTERVAL_SEC,
  15,
);
const ORCHESTRATOR_FAILURE_THRESHOLD = parsePositiveInt(
  process.env.BOT_ORCHESTRATOR_FAILURE_THRESHOLD,
  3,
);
const ORCHESTRATOR_COMMAND_TIMEOUT_SEC = parsePositiveInt(
  process.env.BOT_ORCHESTRATOR_COMMAND_TIMEOUT_SEC,
  240,
);
const ORCHESTRATOR_CLEANUP_ENABLED =
  process.env.BOT_ORCHESTRATOR_CLEANUP_ENABLED !== "false";
const ORCHESTRATOR_CLEANUP_INTERVAL_SEC = parsePositiveInt(
  process.env.BOT_ORCHESTRATOR_CLEANUP_INTERVAL_SEC,
  24 * 60 * 60,
);
const ORCHESTRATOR_COMPOSE_BUILD =
  process.env.BOT_ORCHESTRATOR_COMPOSE_BUILD !== "false";
const ORCHESTRATOR_ENABLED = process.env.BOT_ORCHESTRATOR_ENABLED !== "false";

const IDLE_TIMEOUT_SEC = parsePositiveInt(process.env.BOT_IDLE_TIMEOUT_SEC, 600);
const AGENT_STATUS_TIMEOUT_SEC = parsePositiveInt(
  process.env.BOT_AGENT_STATUS_TIMEOUT_SEC,
  180,
);
const AGENT_POLL_INTERVAL_MS = parsePositiveInt(
  process.env.BOT_AGENT_POLL_INTERVAL_MS,
  800,
);
const TYPING_PULSE_MS = 7000;
const BOT_OPERATION_LOG_ENABLED = process.env.BOT_OPERATION_LOG_ENABLED !== "false";
const BOT_OPERATION_LOG_MAX_FIELD_CHARS = parsePositiveInt(
  process.env.BOT_OPERATION_LOG_MAX_FIELD_CHARS,
  320,
);
const BOT_OPERATION_LOG_MESSAGE_LIMIT = 1800;
const BOT_DELIVERED_FILE_MAX_BYTES = parsePositiveInt(
  process.env.BOT_DELIVERED_FILE_MAX_BYTES,
  2 * 1024 * 1024,
);
const BOT_DELIVERED_FILE_MAX_COUNT = parsePositiveInt(
  process.env.BOT_DELIVERED_FILE_MAX_COUNT,
  3,
);
const TOOL_PROGRESS_LOG_PREVIEW_MAX_LINES = 8;
const TOOL_PROGRESS_LOG_PREVIEW_MAX_CHARS = 720;
const BOT_EVENT_DEDUP_TTL_MS = parsePositiveInt(
  process.env.BOT_EVENT_DEDUP_TTL_MS,
  5 * 60 * 1000,
);
function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}

let client = createDiscordClient();

const sessionsById = new Map<string, MockSession>();
const sessionIdByThreadId = new Map<Snowflake, string>();
const sessionIdsByUserId = new Map<Snowflake, Set<string>>();
const sessionOwnerUserIdByThreadId = new Map<Snowflake, Snowflake>();
const pendingApprovals = new Map<string, PendingApproval>();
const idleTimerBySessionId = new Map<string, NodeJS.Timeout>();
const runningSessionIds = new Set<string>();
const toolProgressMessageByCallId = new Map<string, ToolProgressMessageState>();
const suppressedToolProgressCallByCallId = new Map<string, Snowflake>();
const recentlySeenMessageIds = new Map<Snowflake, number>();
const recentlySeenInteractionIds = new Map<Snowflake, number>();
let isSystemControlPending = false;
let isGracefulShutdownInProgress = false;
let runtimeInfrastructureStatus: RuntimeInfrastructureStatus = ORCHESTRATOR_ENABLED
  ? "booting"
  : "ready";
let runtimeSupervisor: RuntimeSupervisor | null = null;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function resolveOptionalSocketPath(raw: string | undefined): string | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  return path.resolve(raw);
}

function resolveInternalConnectionMode(): "tcp" | "uds" {
  const raw = (process.env.INTERNAL_CONNECTION_MODE ?? "").toLowerCase();
  if (raw === "tcp" || raw === "uds") {
    return raw;
  }
  return "tcp";
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface GatewayStartResponse {
  session: {
    sessionId: string;
    status: string;
  };
  taskId: string;
}

interface GatewayThreadMessageResponse {
  session: {
    sessionId: string;
    status: string;
  };
  taskId: string;
  resumedFromIdle: boolean;
}

interface GatewayAgentToolCall {
  toolName: string;
  executionTarget?: string;
  arguments: Record<string, unknown>;
  reason: string;
  delayMs?: number;
}

interface GatewayAgentToolCallBuildResult {
  toolCalls: GatewayAgentToolCall[];
  errors: string[];
}

interface GatewayAgentTaskSnapshot {
  task_id: string;
  session_id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
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

interface GatewayAgentRunResponse {
  session: {
    sessionId: string;
    status: string;
  };
  task: {
    taskId: string;
    status: string;
  };
  agentTask: GatewayAgentTaskSnapshot;
}

interface GatewayAgentTaskStatusResponse {
  session: {
    sessionId: string;
    status: string;
  };
  task: {
    taskId: string;
    status: string;
  };
  agentTask: GatewayAgentTaskSnapshot;
  pendingApproval?: {
    approvalId: string;
    status: string;
    operation: string;
    path: string;
  } | null;
  taskEvents?: GatewayTaskEvent[];
}

interface GatewayRunContextEnvelopePayload {
  behavior: {
    botMode: "standard" | "mock";
    sessionStatus: string;
    infrastructureStatus: "ready" | "booting" | "failed";
    toolRoutingPolicy:
      | "gateway_only"
      | "hybrid_container_builtin_gateway_host";
    approvalPolicy:
      | "host_ops_require_explicit_approval";
    responseContract: "ja, concise, ask_when_ambiguous";
    executionContract: "no_external_mcp, no_unapproved_host_ops";
  };
  runtimeFeedback: {
    previousTaskTerminalStatus?: ContextEnvelopeTaskTerminalStatus;
    previousToolErrors: string[];
    retryHint?: string;
    attachmentSources: GatewayAttachmentSource[];
  };
  discord: ContextEnvelopeDiscordPayload;
}

interface GatewayRunRequestPayload {
  taskId: string;
  sessionId: string;
  userId: string;
  prompt: string;
  attachmentNames: string[];
  contextEnvelope: GatewayRunContextEnvelopePayload;
  toolCalls: GatewayAgentToolCall[];
}

interface GatewayThreadStatusResponse {
  session: {
    sessionId: string;
    userId: string;
    channelId: string;
    threadId: string;
    status: string;
    lastThreadActivityAt?: string;
    idleDeadlineAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
  };
  latestTask: {
    taskId: string;
    status: string;
  } | null;
  pendingApproval: {
    approvalId: string;
    status: string;
  } | null;
}

interface GatewayTaskEvent {
  eventId: string;
  taskId: string;
  eventType: string;
  payloadJson: Record<string, unknown>;
  timestamp: string;
}

interface ToolProgressMessageState {
  threadId: Snowflake;
  callId: string;
  toolName: string;
  executionTarget: string | null;
  reason: string | null;
  argumentsPayload: Record<string, unknown> | null;
  detail: string | null;
  status: "pending" | "ok" | "error";
  messageId: Snowflake;
}

class GatewayApiRequestError extends Error {
  constructor(
    readonly method: string,
    readonly pathname: string,
    readonly statusCode: number,
    readonly statusText: string,
    readonly responseText: string,
  ) {
    super(
      `[gateway-api] ${method} ${pathname} failed: ${statusCode} ${statusText} ${responseText}`,
    );
    this.name = "GatewayApiRequestError";
  }
}

async function gatewayApiRequest<T>(
  method: "GET" | "POST",
  pathname: string,
  payload?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (payload !== undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  if (BOT_TO_GATEWAY_INTERNAL_TOKEN.length > 0) {
    headers["x-internal-token"] = BOT_TO_GATEWAY_INTERNAL_TOKEN;
  }
  const body = payload ? JSON.stringify(payload) : null;
  if (GATEWAY_API_SOCKET_PATH) {
    const response = await requestJsonViaUnixSocket({
      socketPath: GATEWAY_API_SOCKET_PATH,
      pathname,
      method,
      timeoutSec: 30,
      headers,
      body,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new GatewayApiRequestError(
        method,
        pathname,
        response.statusCode,
        response.statusMessage,
        response.bodyText,
      );
    }
    return parseJsonText(response.bodyText) as T;
  }

  const response = await fetch(`${GATEWAY_API_BASE_URL}${pathname}`, {
    method,
    headers,
    body: body ?? undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new GatewayApiRequestError(
      method,
      pathname,
      response.status,
      response.statusText,
      text,
    );
  }

  return (await response.json()) as T;
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

function requestJsonViaUnixSocket(
  input: UnixSocketRequestInput,
): Promise<UnixSocketResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: input.socketPath,
        path: input.pathname,
        method: input.method,
        headers: {
          ...input.headers,
          ...(input.body
            ? {
                "content-length": Buffer.byteLength(input.body, "utf8").toString(),
              }
            : {}),
        },
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
    req.on("error", reject);
    req.setTimeout(input.timeoutSec * 1000, () => {
      req.destroy(new Error("gateway_api_socket_timeout"));
    });
    if (input.body) {
      req.write(input.body);
    }
    req.end();
  });
}

function parseJsonText(text: string): unknown {
  if (!text || text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function truncateOperationLogValue(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function toOperationLogJson(value: unknown, maxChars: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  return truncateOperationLogValue(serialized, maxChars);
}

function sanitizeOperationLogLine(line: string): string {
  return truncateOperationLogValue(
    line.replace(/```/g, "'''").replace(/\r?\n/g, "\\n"),
    BOT_OPERATION_LOG_MAX_FIELD_CHARS * 2,
  );
}

function buildOperationLogBlocks(title: string, lines: string[]): string[] {
  const normalizedTitle = sanitizeOperationLogLine(title);
  const normalizedLines = lines.map((line) => sanitizeOperationLogLine(line));
  if (normalizedLines.length === 0) {
    return [`\`\`\`text\n[oplog] ${normalizedTitle}\n\`\`\``];
  }

  const blocks: string[] = [];
  let chunk: string[] = [];
  let chunkIndex = 1;
  for (const line of normalizedLines) {
    const header =
      chunkIndex === 1
        ? `[oplog] ${normalizedTitle}`
        : `[oplog] ${normalizedTitle} (part ${chunkIndex})`;
    const nextLines = chunk.length === 0 ? [header, line] : [...chunk, line];
    const candidate = `\`\`\`text\n${nextLines.join("\n")}\n\`\`\``;
    if (candidate.length <= BOT_OPERATION_LOG_MESSAGE_LIMIT) {
      chunk = nextLines;
      continue;
    }

    if (chunk.length === 0) {
      blocks.push(
        `\`\`\`text\n${header}\n${truncateOperationLogValue(line, BOT_OPERATION_LOG_MESSAGE_LIMIT - 32)}\n\`\`\``,
      );
      chunkIndex += 1;
      continue;
    }

    blocks.push(`\`\`\`text\n${chunk.join("\n")}\n\`\`\``);
    chunkIndex += 1;
    const continuedHeader = `[oplog] ${normalizedTitle} (part ${chunkIndex})`;
    chunk = [continuedHeader, line];
  }

  if (chunk.length > 0) {
    blocks.push(`\`\`\`text\n${chunk.join("\n")}\n\`\`\``);
  }
  return blocks;
}

async function sendOperationLog(
  threadId: Snowflake,
  title: string,
  lines: string[],
): Promise<void> {
  if (!BOT_OPERATION_LOG_ENABLED) {
    return;
  }
  try {
    const conciseLines = summarizeOperationLog(title, lines);
    if (conciseLines.length === 0) {
      return;
    }
    const blocks = buildOperationLogBlocks("actions", conciseLines);
    for (const block of blocks) {
      await sendToThread(threadId, block);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} operation log send failed`, error);
  }
}

function summarizeOperationLog(title: string, lines: string[]): string[] {
  switch (title) {
    case "gateway.mentions.start":
      return [];
    case "gateway.mentions.started":
      return [];
    case "gateway.threads.message":
      return [];
    case "gateway.threads.message.accepted":
      return [];
    case "run.start":
      return [];
    case "gateway.agent.run.request":
      return [];
    case "gateway.agent.run.accepted":
      return [];
    case "gateway.agent.status.terminal": {
      const terminalStatus = extractOperationLogValue(lines, "- terminal_status=");
      if (terminalStatus === "completed") {
        return [];
      }
      if (terminalStatus === "failed") {
        return ["❌ Agent 実行が失敗"];
      }
      if (terminalStatus === "canceled") {
        return [];
      }
      return [];
    }
    case "run.approval.required":
      return [];
    case "run.approval.approved":
      return [];
    case "run.approval.rejected":
      return [];
    case "run.approval.timeout":
      return [];
    case "approval.request.gateway":
      return [];
    case "approval.requested":
      return [];
    case "approval.button.clicked":
      return [];
    case "approval.button.settled":
    case "approval.settle":
      return [];
    case "gateway.cancel.request":
      return ["🛑 キャンセルを要求"];
    case "gateway.cancel.agent_task":
      return ["🛑 Agent タスクをキャンセル"];
    case "gateway.cancel.thread":
      return ["🧵 スレッドタスクをキャンセル"];
    case "gateway.close.request":
      return [];
    case "gateway.close.agent_task_cancel":
      return [];
    case "gateway.close.thread":
      return [];
    case "run.final_answer":
      return [];
    case "run.error":
      return ["❌ 実行エラーを検出"];
    default:
      return [];
  }
}

function extractOperationLogValue(lines: string[], prefix: string): string | null {
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return null;
}

function resolveToolEmoji(toolName: string): string {
  if (toolName === "read_file" || toolName === "view") {
    return "📄";
  }
  if (toolName === "edit_file" || toolName === "str_replace_editor") {
    return "✍️";
  }
  if (toolName === "glob") {
    return "📂";
  }
  if (toolName === "grep") {
    return "🔎";
  }
  if (toolName === "bash") {
    return "💻";
  }
  if (toolName.endsWith("file_read")) {
    return "📄";
  }
  if (toolName === "container.file_deliver") {
    return "📦";
  }
  if (toolName.endsWith("file_write")) {
    return "✍️";
  }
  if (toolName.endsWith("file_delete")) {
    return "🗑️";
  }
  if (toolName.endsWith("file_list")) {
    return "📂";
  }
  if (toolName.endsWith("cli_exec")) {
    return "💻";
  }
  if (
    toolName === "host.http_request" ||
    toolName === "web.get" ||
    toolName === "web.post" ||
    toolName === "web.search"
  ) {
    return "🌐";
  }
  if (toolName.startsWith("discord.")) {
    return "💬";
  }
  if (toolName.startsWith("memory.")) {
    return "🧠";
  }
  return "🛠️";
}

function resolveToolDetail(
  toolName: string,
  args: Record<string, unknown> | null,
): string | null {
  if (!args) {
    return null;
  }
  if (
    toolName === "read_file" ||
    toolName === "edit_file" ||
    toolName === "str_replace_editor" ||
    toolName === "view"
  ) {
    return (
      readString(args, "path") ??
      readString(args, "file_path") ??
      readString(args, "filePath") ??
      readString(args, "target_file") ??
      readString(args, "targetFile") ??
      readString(args, "file")
    );
  }
  if (toolName === "grep" || toolName === "glob") {
    return readString(args, "path") ?? ".";
  }
  if (toolName === "bash") {
    return readString(args, "command");
  }
  if (toolName.endsWith("file_read") || toolName.endsWith("file_write") || toolName.endsWith("file_delete") || toolName.endsWith("file_list")) {
    return readString(args, "path");
  }
  if (toolName === "container.file_deliver") {
    return readString(args, "path");
  }
  if (toolName.endsWith("cli_exec")) {
    return readString(args, "command");
  }
  if (toolName === "host.http_request" || toolName === "web.get" || toolName === "web.post") {
    return readString(args, "url");
  }
  if (toolName === "web.search") {
    return readString(args, "query");
  }
  if (toolName === "discord.channel_history") {
    return readString(args, "channelId") ?? "session channel";
  }
  if (toolName === "discord.channel_list") {
    const limit = args["limit"];
    if (typeof limit === "number" && Number.isFinite(limit)) {
      return `limit=${limit}`;
    }
    return "configured guild";
  }
  if (toolName.startsWith("memory.")) {
    const namespace = readString(args, "namespace");
    const key = readString(args, "key");
    if (namespace && key) {
      return `${namespace}/${key}`;
    }
    return namespace;
  }
  return null;
}

const RAW_SYSTEM_ERROR_CODES = new Set<string>([
  "tool_execution_failed",
  "unknown_error",
]);

const TOOL_ERROR_REASON_BY_CODE: Record<string, string> = {
  approval_required: "承認が必要です",
  approval_rejected: "承認が拒否されました",
  approval_timeout: "承認がタイムアウトしました",
  external_mcp_disabled: "許可されていない実行経路です",
  invalid_tool_arguments: "入力値が不正です",
  container_path_out_of_scope: "許可されたコンテナ範囲外です",
  container_path_not_found: "対象が見つかりません",
  container_path_not_file: "対象はファイルではありません",
  container_file_too_large: "サイズ上限を超えています",
  policy_denied_command: "許可リスト外コマンドです",
  path_not_approved_for_session: "このセッションで未承認です",
};

function resolveToolPathArg(args: Record<string, unknown> | null): string | null {
  if (!args) {
    return null;
  }
  return (
    readString(args, "path") ??
    readString(args, "file_path") ??
    readString(args, "filePath") ??
    readString(args, "target_file") ??
    readString(args, "targetFile") ??
    readString(args, "file")
  );
}

function parseScopeSuffix(scope: string | null, prefix: string): string | null {
  if (!scope || !scope.startsWith(prefix)) {
    return null;
  }
  const value = scope.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

function shortenIdentifier(raw: string): string {
  const normalized = raw.trim();
  if (normalized.length <= 6) {
    return normalized;
  }
  return normalized.slice(0, 6);
}

function shortenUrlForDisplay(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const rendered = `${url.origin}${url.pathname}`;
    return truncateOperationLogValue(rendered, 72);
  } catch {
    return truncateOperationLogValue(rawUrl, 72);
  }
}

function formatDiscordChannelTarget(
  channelName: string | null | undefined,
  channelId: string | null | undefined,
): string {
  const normalizedName = channelName?.trim();
  const name =
    normalizedName && normalizedName.length > 0
      ? normalizedName.startsWith("#")
        ? normalizedName
        : `#${normalizedName}`
      : "#session";
  if (!channelId) {
    return name;
  }
  return `${name} (${shortenIdentifier(channelId)})`;
}

function formatCommandTarget(args: Record<string, unknown> | null): string {
  const command = readString(args, "command");
  if (!command) {
    return "対象不明";
  }
  const argList = readArray(args, "args")
    ?.map((value) => (typeof value === "string" ? value : null))
    .filter((value): value is string => value !== null) ?? [];
  const rendered = [command, ...argList].join(" ");
  return `$ ${truncateOperationLogValue(rendered, 120)}`;
}

function resolveToolTargetLine(input: {
  toolName: string;
  args: Record<string, unknown> | null;
  resultPayload?: Record<string, unknown> | null;
  detailsPayload?: Record<string, unknown> | null;
  fallbackDetail?: string | null;
}): string {
  const scope = readString(input.detailsPayload, "scope");
  if (
    input.toolName === "read_file" ||
    input.toolName === "edit_file" ||
    input.toolName === "str_replace_editor" ||
    input.toolName === "view" ||
    input.toolName.endsWith("file_read") ||
    input.toolName.endsWith("file_write") ||
    input.toolName.endsWith("file_delete") ||
    input.toolName.endsWith("file_list") ||
    input.toolName === "container.file_deliver"
  ) {
    const pathValue =
      resolveToolPathArg(input.args) ??
      readString(input.resultPayload, "path") ??
      scope ??
      input.fallbackDetail;
    return pathValue ? truncateOperationLogValue(pathValue, 120) : "対象不明";
  }
  if (input.toolName === "grep" || input.toolName === "glob") {
    const pathValue =
      readString(input.args, "path") ?? scope ?? input.fallbackDetail ?? ".";
    return truncateOperationLogValue(pathValue, 120);
  }
  if (
    input.toolName === "bash" ||
    input.toolName === "container.cli_exec" ||
    input.toolName === "host.cli_exec"
  ) {
    return formatCommandTarget(input.args);
  }
  if (
    input.toolName === "host.http_request" ||
    input.toolName === "web.get" ||
    input.toolName === "web.post"
  ) {
    const method =
      (readString(input.args, "method") ??
        readString(input.resultPayload, "method") ??
        (input.toolName === "web.post" ? "POST" : "GET")).toUpperCase();
    const rawUrl =
      readString(input.args, "url") ??
      readString(input.resultPayload, "url") ??
      scope;
    const urlText = rawUrl ? shortenUrlForDisplay(rawUrl) : "(url不明)";
    return `${method} ${urlText}`;
  }
  if (input.toolName === "web.search") {
    const query =
      readString(input.args, "query") ?? readString(input.resultPayload, "query");
    return query
      ? truncateOperationLogValue(`search: ${query}`, 120)
      : "web.search";
  }
  if (input.toolName === "discord.channel_history") {
    const scopeChannelId = parseScopeSuffix(scope, "discord_channel:");
    const channelId =
      readString(input.resultPayload, "channel_id") ??
      readString(input.args, "channelId") ??
      scopeChannelId;
    const channelName = readString(input.resultPayload, "channel_name");
    return formatDiscordChannelTarget(channelName, channelId);
  }
  if (input.toolName === "discord.channel_list") {
    return "Guild channels";
  }
  if (input.toolName.startsWith("memory.")) {
    const namespace =
      readString(input.args, "namespace") ??
      readString(input.resultPayload, "namespace");
    if (input.toolName === "memory.search") {
      const query = readString(input.args, "query");
      if (namespace && query) {
        return truncateOperationLogValue(`${namespace}: ${query}`, 120);
      }
    }
    const key = readString(input.args, "key") ?? readString(input.resultPayload, "key");
    if (namespace && key) {
      return truncateOperationLogValue(`${namespace}/${key}`, 120);
    }
    if (namespace) {
      return truncateOperationLogValue(namespace, 120);
    }
    return "memory";
  }
  if (input.fallbackDetail) {
    return truncateOperationLogValue(input.fallbackDetail, 120);
  }
  return "対象不明";
}

function formatListPreview(values: string[], count: number): string {
  const top = values.slice(0, 3).join(", ");
  const rendered = top.length > 0 ? top : "-";
  return `${count}件: ${truncateOperationLogValue(rendered, 96)}`;
}

function readNamedEntries(values: unknown[] | null): string[] {
  if (!values) {
    return [];
  }
  return values
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      const record = asRecord(value);
      return (
        readString(record, "name") ??
        readString(record, "key") ??
        readString(record, "path") ??
        readString(record, "channel_name")
      );
    })
    .filter((value): value is string => Boolean(value))
    .map((value) => truncateOperationLogValue(value, 36));
}

function countContentLines(content: string | null | undefined): number {
  if (!content) {
    return 0;
  }
  const normalized = content.replace(/\r\n/g, "\n");
  if (normalized.length === 0) {
    return 0;
  }
  return normalized.split("\n").length;
}

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const line = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) {
    return null;
  }
  return truncateOperationLogValue(sanitizeToolProgressContent(line), 110);
}

function formatBytesHuman(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return "size unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveToolSuccessLine(
  toolName: string,
  resultPayload: Record<string, unknown> | null | undefined,
  logExcerpt: string | null | undefined,
): string {
  const entries = readArray(resultPayload, "entries");
  const listEntries = readArray(resultPayload, "channels") ?? entries;
  if (
    toolName === "read_file" ||
    toolName === "view" ||
    toolName === "container.file_read" ||
    toolName === "host.file_read"
  ) {
    const lineCount = countContentLines(readString(resultPayload, "content"));
    return lineCount > 0 ? `${lineCount}行を取得` : "読み取り完了";
  }
  if (toolName === "edit_file" || toolName === "str_replace_editor") {
    const add = readNumber(resultPayload, "add") ?? readNumber(resultPayload, "added");
    const del =
      readNumber(resultPayload, "del") ??
      readNumber(resultPayload, "deleted") ??
      readNumber(resultPayload, "remove");
    if (add !== null || del !== null) {
      return `更新完了（+${add ?? 0}/-${del ?? 0}）`;
    }
    return "更新完了";
  }
  if (toolName === "container.file_write") {
    const bytes = readNumber(resultPayload, "bytes");
    return bytes !== null ? `${bytes} bytes 書き込み` : "書き込みました";
  }
  if (toolName === "host.file_write") {
    return "書き込みました";
  }
  if (toolName === "container.file_delete" || toolName === "host.file_delete") {
    return "削除しました";
  }
  if (toolName === "glob" || toolName === "container.file_list" || toolName === "host.file_list") {
    const names = readNamedEntries(listEntries);
    const count = listEntries?.length ?? 0;
    return formatListPreview(names, count);
  }
  if (toolName === "grep") {
    const matches =
      readArray(resultPayload, "matches") ??
      readArray(resultPayload, "results") ??
      entries;
    const count =
      readNumber(resultPayload, "match_count") ??
      readNumber(resultPayload, "count") ??
      (matches ? matches.length : null);
    const names = readNamedEntries(matches);
    if (count !== null) {
      return count > 0
        ? `${count}件ヒット: ${truncateOperationLogValue(names.slice(0, 3).join(", ") || "-", 84)}`
        : "0件ヒット";
    }
    const preview = firstNonEmptyLine(logExcerpt);
    return preview ? `検索完了: ${preview}` : "検索完了";
  }
  if (toolName === "bash" || toolName === "container.cli_exec" || toolName === "host.cli_exec") {
    const stdout = readString(resultPayload, "stdout") ?? logExcerpt;
    const stdoutPreview = firstNonEmptyLine(stdout);
    if (stdoutPreview) {
      return stdoutPreview;
    }
    const exitCode =
      readNumber(resultPayload, "exitCode") ?? readNumber(resultPayload, "exit_code");
    if (exitCode !== null) {
      return `exit=${exitCode}`;
    }
    return "コマンド実行完了";
  }
  if (toolName === "container.file_deliver") {
    const fileName =
      readString(resultPayload, "file_name") ??
      (() => {
        const sourcePath = readString(resultPayload, "path");
        return sourcePath ? path.basename(sourcePath) : null;
      })();
    const size = formatBytesHuman(readNumber(resultPayload, "bytes"));
    if (fileName) {
      return `${fileName} (${size}) を返却`;
    }
    return "ファイルを返却しました";
  }
  if (toolName === "host.http_request") {
    const status = readNumber(resultPayload, "status");
    return status !== null ? `HTTP ${status}` : "HTTP リクエスト完了";
  }
  if (toolName === "web.get" || toolName === "web.post") {
    const status = readNumber(resultPayload, "status");
    const bodySaved = readBoolean(resultPayload, "body_saved");
    if (bodySaved) {
      const bytes = formatBytesHuman(readNumber(resultPayload, "body_bytes"));
      return `${status !== null ? `HTTP ${status}` : "HTTP 応答"} / 非テキスト保存 ${bytes}`;
    }
    return status !== null ? `HTTP ${status}` : "HTTP リクエスト完了";
  }
  if (toolName === "web.search") {
    const results = readArray(resultPayload, "results");
    const count = results?.length ?? 0;
    return `${count}件取得`;
  }
  if (toolName === "memory.search") {
    const foundEntries = readArray(resultPayload, "entries");
    const keys = readNamedEntries(foundEntries);
    const count = foundEntries?.length ?? 0;
    return count > 0 ? `${count}件ヒット: ${keys.slice(0, 3).join(", ")}` : "0件ヒット";
  }
  if (toolName === "memory.get") {
    const found = readBoolean(resultPayload, "found");
    if (found === false) {
      return "見つかりません";
    }
    return "見つかりました";
  }
  if (toolName === "memory.upsert") {
    return "保存しました";
  }
  if (toolName === "memory.delete") {
    return "削除しました";
  }
  if (toolName === "discord.channel_history") {
    const historyEntries = readArray(resultPayload, "entries");
    if (!historyEntries || historyEntries.length === 0) {
      return "履歴0件";
    }
    const latest = asRecord(historyEntries[historyEntries.length - 1]);
    const speaker =
      readString(latest, "nickname") ??
      readString(latest, "username") ??
      readString(latest, "userId") ??
      "unknown";
    const content = readString(latest, "content") ?? "(本文なし)";
    const preview = truncateOperationLogValue(sanitizeToolProgressContent(content), 64);
    const remaining = historyEntries.length - 1;
    return remaining > 0
      ? `${speaker}: ${preview}（他${remaining}件）`
      : `${speaker}: ${preview}`;
  }
  if (toolName === "discord.channel_list") {
    const channels = readArray(resultPayload, "channels");
    const names =
      channels
        ?.map((value) => {
          const channel = asRecord(value);
          const rawName = readString(channel, "channel_name");
          if (!rawName) {
            return null;
          }
          return rawName.startsWith("#") ? rawName : `#${rawName}`;
        })
        .filter((value): value is string => value !== null) ?? [];
    return formatListPreview(names, channels?.length ?? 0);
  }
  const excerpt = firstNonEmptyLine(logExcerpt);
  return excerpt ?? "処理が完了しました";
}

function resolveToolErrorLine(input: {
  toolName: string;
  targetLine: string;
  errorCode: string | null;
  errorMessage: string | null;
  resultPayload?: Record<string, unknown> | null;
  detailsPayload?: Record<string, unknown> | null;
}): string {
  const rawMessage = truncateOperationLogValue(
    sanitizeToolProgressContent(input.errorMessage ?? "不明なエラーです。"),
    200,
  );
  if (!input.errorCode || RAW_SYSTEM_ERROR_CODES.has(input.errorCode)) {
    return rawMessage;
  }
  const reason = TOOL_ERROR_REASON_BY_CODE[input.errorCode];
  if (!reason) {
    return rawMessage;
  }
  if (
    input.toolName === "read_file" ||
    input.toolName === "view" ||
    input.toolName === "container.file_read" ||
    input.toolName === "host.file_read"
  ) {
    return `${input.targetLine} の読み取りに失敗しました（${reason}）`;
  }
  if (input.toolName === "edit_file" || input.toolName === "str_replace_editor") {
    return `${input.targetLine} の更新に失敗しました（${reason}）`;
  }
  if (input.toolName === "grep" || input.toolName === "memory.search") {
    return `${input.targetLine} の検索に失敗しました（${reason}）`;
  }
  if (
    input.toolName === "glob" ||
    input.toolName === "container.file_list" ||
    input.toolName === "host.file_list" ||
    input.toolName === "discord.channel_list"
  ) {
    if (input.toolName === "discord.channel_list") {
      return `チャンネル一覧の取得に失敗しました（${reason}）`;
    }
    return `${input.targetLine} の一覧取得に失敗しました（${reason}）`;
  }
  if (input.toolName === "container.file_write" || input.toolName === "host.file_write") {
    return `${input.targetLine} への書き込みに失敗しました（${reason}）`;
  }
  if (input.toolName === "container.file_delete" || input.toolName === "host.file_delete") {
    return `${input.targetLine} の削除に失敗しました（${reason}）`;
  }
  if (
    input.toolName === "bash" ||
    input.toolName === "container.cli_exec" ||
    input.toolName === "host.cli_exec"
  ) {
    const exitCode =
      readNumber(input.detailsPayload, "exitCode") ??
      readNumber(input.detailsPayload, "exit_code") ??
      readNumber(input.resultPayload, "exitCode") ??
      readNumber(input.resultPayload, "exit_code");
    if (exitCode !== null) {
      return `コマンド実行に失敗しました（exit=${exitCode} / ${reason}）`;
    }
    return `コマンド実行に失敗しました（${reason}）`;
  }
  if (input.toolName === "container.file_deliver") {
    return `${input.targetLine} の返却に失敗しました（${reason}）`;
  }
  if (
    input.toolName === "host.http_request" ||
    input.toolName === "web.get" ||
    input.toolName === "web.post"
  ) {
    const statusCode =
      readNumber(input.detailsPayload, "status") ?? readNumber(input.resultPayload, "status");
    if (statusCode !== null) {
      return `${input.targetLine} で失敗しました（HTTP ${statusCode} / ${reason}）`;
    }
    return `${input.targetLine} で失敗しました（${reason}）`;
  }
  if (input.toolName === "web.search") {
    const statusCode =
      readNumber(input.detailsPayload, "status") ?? readNumber(input.resultPayload, "status");
    if (statusCode !== null) {
      return `${input.targetLine} に失敗しました（HTTP ${statusCode} / ${reason}）`;
    }
    return `${input.targetLine} に失敗しました（${reason}）`;
  }
  if (input.toolName === "memory.get") {
    return `${input.targetLine} の取得に失敗しました（${reason}）`;
  }
  if (input.toolName === "memory.upsert") {
    return `${input.targetLine} の保存に失敗しました（${reason}）`;
  }
  if (input.toolName === "memory.delete") {
    return `${input.targetLine} の削除に失敗しました（${reason}）`;
  }
  if (input.toolName === "discord.channel_history") {
    return `${input.targetLine} の履歴取得に失敗しました（${reason}）`;
  }
  return `処理に失敗しました（${reason}）`;
}

function buildToolProgressMessageContent(input: {
  toolName: string;
  executionTarget?: string | null;
  reason?: string | null;
  argumentsPayload?: Record<string, unknown> | null;
  detail: string | null;
  status: "pending" | "ok" | "error";
  resultPayload?: Record<string, unknown> | null;
  detailsPayload?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  logExcerpt?: string | null;
}): string {
  const toolEmoji = resolveToolEmoji(input.toolName);
  const targetLine = resolveToolTargetLine({
    toolName: input.toolName,
    args: input.argumentsPayload ?? null,
    resultPayload: input.resultPayload,
    detailsPayload: input.detailsPayload,
    fallbackDetail: input.detail,
  });
  const lines = [`${toolEmoji} ${input.toolName}`, targetLine];
  if (input.status === "pending") {
    lines.push("⏳ 実行中");
    const reason =
      input.reason && input.reason.trim().length > 0
        ? `理由: ${truncateOperationLogValue(sanitizeToolProgressContent(input.reason), 96)}`
        : "実行を開始しました";
    lines.push(reason);
    return `\`\`\`text\n${lines.join("\n")}\n\`\`\``;
  }
  if (input.status === "ok") {
    lines.push("✅ 成功");
    lines.push(
      resolveToolSuccessLine(input.toolName, input.resultPayload, input.logExcerpt),
    );
    return `\`\`\`text\n${lines.join("\n")}\n\`\`\``;
  }
  lines.push("❌ 失敗");
  lines.push(
    resolveToolErrorLine({
      toolName: input.toolName,
      targetLine,
      errorCode: input.errorCode ?? "unknown_error",
      errorMessage: input.errorMessage ?? "不明なエラーです。",
      resultPayload: input.resultPayload,
      detailsPayload: input.detailsPayload,
    }),
  );
  return `\`\`\`text\n${lines.join("\n")}\n\`\`\``;
}

function sanitizeToolProgressContent(value: string): string {
  return value.replace(/```/g, "'''").replace(/\r?\n/g, "\\n");
}

function truncateToolProgressLog(
  value: string,
  maxChars = TOOL_PROGRESS_LOG_PREVIEW_MAX_CHARS,
): string {
  return truncateOperationLogValue(
    sanitizeToolProgressContent(value).trim(),
    maxChars,
  );
}

function selectToolLogExcerpt(
  payload: Record<string, unknown> | null | undefined,
): string | null {
  if (!payload) {
    return null;
  }
  const candidates: string[] = [];
  const directFields = ["stdout", "stderr", "output", "content", "body"];
  for (const field of directFields) {
    const value = readString(payload, field);
    if (value && value.trim().length > 0) {
      candidates.push(value);
    }
  }

  const nestedResult = readRecord(payload, "result");
  if (nestedResult) {
    for (const field of directFields) {
      const value = readString(nestedResult, field);
      if (value && value.trim().length > 0) {
        candidates.push(value);
      }
    }
    const entries = nestedResult["entries"];
    if (Array.isArray(entries) && entries.length > 0) {
      candidates.push(
        toOperationLogJson(
          entries.slice(0, 5),
          TOOL_PROGRESS_LOG_PREVIEW_MAX_CHARS,
        ),
      );
    }
  }

  const details = readRecord(payload, "details");
  if (details) {
    const detailOut =
      readString(details, "stdout") ??
      readString(details, "stderr") ??
      readString(details, "response") ??
      readString(details, "content");
    if (detailOut && detailOut.trim().length > 0) {
      candidates.push(detailOut);
    }
  }

  const message = readString(payload, "message");
  if (message && message.trim().length > 0) {
    candidates.push(message);
  }

  const first = candidates.find((candidate) => candidate.trim().length > 0);
  if (!first) {
    return null;
  }
  const lines = first
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, TOOL_PROGRESS_LOG_PREVIEW_MAX_LINES);
  if (lines.length === 0) {
    return null;
  }
  return truncateToolProgressLog(lines.join(" | "));
}

function normalizeTaskEventTimestamp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function readToolEventCallId(payload: Record<string, unknown>): string | null {
  return readString(payload, "call_id") ?? readString(payload, "callId");
}

function shouldSuppressToolProgressLog(input: {
  toolName: string;
  reason?: string | null;
  argumentsPayload?: Record<string, unknown> | null;
  resultPayload?: Record<string, unknown> | null;
  detailsPayload?: Record<string, unknown> | null;
}): boolean {
  if (input.toolName !== "memory.get" && input.toolName !== "memory.search") {
    return false;
  }

  const reason = input.reason?.toLowerCase() ?? "";
  if (reason.includes("system memory preload")) {
    return true;
  }

  const namespaceFromArgs = readString(input.argumentsPayload, "namespace");
  if (namespaceFromArgs?.startsWith("system.")) {
    return true;
  }

  const namespaceFromResult = readString(input.resultPayload, "namespace");
  if (namespaceFromResult?.startsWith("system.")) {
    return true;
  }

  const entry = readRecord(input.resultPayload, "entry");
  const namespaceFromEntry = readString(entry, "namespace");
  if (namespaceFromEntry?.startsWith("system.")) {
    return true;
  }

  const namespaceFromDetails = readString(input.detailsPayload, "namespace");
  if (namespaceFromDetails?.startsWith("system.")) {
    return true;
  }

  return false;
}

async function sendToolProgressStartMessage(
  session: MockSession,
  eventPayload: Record<string, unknown>,
): Promise<void> {
  const callId = readToolEventCallId(eventPayload);
  const toolName = readStringAny(eventPayload, ["tool_name", "toolName"]);
  if (!callId || !toolName || toolProgressMessageByCallId.has(callId)) {
    return;
  }
  const executionTarget = readStringAny(eventPayload, [
    "execution_target",
    "executionTarget",
  ]);
  const reason = readString(eventPayload, "reason");
  const argumentsPayload = readRecord(eventPayload, "arguments");
  if (
    shouldSuppressToolProgressLog({
      toolName,
      reason,
      argumentsPayload,
    })
  ) {
    suppressedToolProgressCallByCallId.set(callId, session.threadId);
    return;
  }
  const detail = resolveToolDetail(toolName, argumentsPayload);
  const content = buildToolProgressMessageContent({
    toolName,
    executionTarget,
    reason,
    argumentsPayload,
    detail,
    status: "pending",
  });
  const sent = await sendToThread(session.threadId, content);
  if (!sent) {
    return;
  }
  toolProgressMessageByCallId.set(callId, {
    threadId: session.threadId,
    callId,
    toolName,
    executionTarget,
    reason,
    argumentsPayload,
    detail,
    status: "pending",
    messageId: sent.id,
  });
}

async function updateToolProgressResultMessage(
  eventPayload: Record<string, unknown>,
): Promise<void> {
  const callId = readToolEventCallId(eventPayload);
  if (!callId) {
    return;
  }
  const suppressedThreadId = suppressedToolProgressCallByCallId.get(callId);
  if (suppressedThreadId) {
    suppressedToolProgressCallByCallId.delete(callId);
    return;
  }
  const state = toolProgressMessageByCallId.get(callId);
  if (!state || state.status !== "pending") {
    const toolName = readStringAny(eventPayload, ["tool_name", "toolName"]);
    if (!toolName) {
      return;
    }
    const resultPayload = readRecord(eventPayload, "result");
    const detailsPayload = readRecord(eventPayload, "details");
    if (
      shouldSuppressToolProgressLog({
        toolName,
        argumentsPayload: readRecord(eventPayload, "arguments"),
        resultPayload,
        detailsPayload,
      })
    ) {
      return;
    }
    return;
  }
  const status = readString(eventPayload, "status");
  if (status !== "ok" && status !== "error") {
    return;
  }
  const errorCode = readStringAny(eventPayload, ["error_code", "errorCode"]);
  const errorMessage = readString(eventPayload, "message");
  const displayStatus: "ok" | "error" = status;
  const resultPayload = readRecord(eventPayload, "result");
  const detailsPayload = readRecord(eventPayload, "details");
  const logExcerpt =
    selectToolLogExcerpt(resultPayload) ??
    selectToolLogExcerpt(detailsPayload) ??
    selectToolLogExcerpt(eventPayload);
  const shouldUseRawSystemMessage =
    errorCode === "tool_execution_failed" || errorCode === "unknown_error";
  const mergedError =
    displayStatus === "error"
      ? shouldUseRawSystemMessage
        ? (errorMessage ?? "tool execution failed")
        : (errorMessage ?? "tool execution failed")
      : undefined;
  const content = buildToolProgressMessageContent({
    toolName: state.toolName,
    executionTarget: state.executionTarget,
    reason: state.reason,
    argumentsPayload: state.argumentsPayload,
    detail: state.detail,
    status: displayStatus,
    resultPayload,
    detailsPayload,
    errorCode,
    errorMessage: mergedError,
    logExcerpt,
  });
  await editThreadMessage(state.threadId, state.messageId, {
    content,
    embeds: [],
    components: [],
    files: [],
  });
  state.status = displayStatus;
}

async function syncToolProgressMessages(
  session: MockSession,
  taskId: string,
): Promise<void> {
  const queryParts: string[] = [];
  queryParts.push(`userId=${encodeURIComponent(session.ownerUserId)}`);
  queryParts.push("includeTaskEvents=true");
  queryParts.push(
    `eventTypes=${encodeURIComponent(
      [
        "mcp.tool.call",
        "mcp.tool.result",
        "approval.requested",
        "approval.approved",
        "approval.rejected",
        "approval.timeout",
        "approval.canceled",
      ].join(","),
    )}`,
  );
  queryParts.push("eventsLimit=100");
  const eventAfterTimestamp = session.lastTaskEventTimestamp;
  const toolAfterTimestamp = session.lastToolEventTimestamp;
  if (eventAfterTimestamp || toolAfterTimestamp) {
    const candidates = [eventAfterTimestamp, toolAfterTimestamp].filter(
      (value): value is string => Boolean(value),
    );
    const latest = candidates.sort((a, b) => a.localeCompare(b)).at(-1);
    if (latest) {
      queryParts.push(`afterTimestamp=${encodeURIComponent(latest)}`);
    }
  }
  const statusResponse = await gatewayApiRequest<GatewayAgentTaskStatusResponse>(
    "GET",
    `/v1/agent/tasks/${encodeURIComponent(taskId)}/status?${queryParts.join("&")}`,
  );
  session.gatewaySessionId = statusResponse.session.sessionId;
  session.currentTaskId = statusResponse.task.taskId;
  setSessionStatus(
    session,
    mapGatewaySessionStatus(statusResponse.session.status),
    `agent task ${statusResponse.agentTask.status}`,
  );
  await syncPendingApprovalResolution(session, statusResponse);

  const toolEvents = statusResponse.agentTask.tool_events ?? [];
  for (const toolEvent of toolEvents) {
    const phase = toolEvent.phase;
    if (phase === "start") {
      await sendToolProgressStartMessage(session, {
        call_id: toolEvent.call_id,
        tool_name: toolEvent.tool_name,
        execution_target: toolEvent.execution_target,
        phase: toolEvent.phase,
        reason: toolEvent.reason,
        arguments: toolEvent.arguments,
      });
      continue;
    }
    if (phase === "result") {
      await updateToolProgressResultMessage({
        call_id: toolEvent.call_id,
        tool_name: toolEvent.tool_name,
        execution_target: toolEvent.execution_target,
        phase: toolEvent.phase,
        status: toolEvent.status,
        error_code: toolEvent.error_code,
        message: toolEvent.message,
        result: toolEvent.result,
        details: toolEvent.details,
      });
    }
  }
  const normalizedToolEventTimestamps = toolEvents
    .map((event) => normalizeTaskEventTimestamp(event.timestamp))
    .filter((value): value is string => value !== null);
  if (normalizedToolEventTimestamps.length > 0) {
    const sorted = [...normalizedToolEventTimestamps].sort((a, b) =>
      a.localeCompare(b),
    );
    const last = sorted.at(-1);
    if (last) {
      session.lastToolEventTimestamp = last;
    }
  }

  const events = statusResponse.taskEvents ?? [];
  for (const event of events) {
    const payload = asRecord(event.payloadJson);
    if (!payload) {
      continue;
    }
    if (event.eventType === "mcp.tool.call") {
      await sendToolProgressStartMessage(session, payload);
      continue;
    }
    if (event.eventType === "mcp.tool.result") {
      await updateToolProgressResultMessage(payload);
    }
  }
  const normalizedEvents = events
    .map((event) => normalizeTaskEventTimestamp(event.timestamp))
    .filter((value): value is string => value !== null);
  if (normalizedEvents.length > 0) {
    const sorted = [...normalizedEvents].sort((a, b) => a.localeCompare(b));
    const last = sorted.at(-1);
    if (last) {
      session.lastTaskEventTimestamp = last;
    }
  }
}

function clearToolProgressMessagesForSession(sessionId: string): void {
  const session = sessionsById.get(sessionId);
  if (!session) {
    return;
  }
  for (const [callId, state] of toolProgressMessageByCallId.entries()) {
    if (session.threadId === state.threadId) {
      toolProgressMessageByCallId.delete(callId);
    }
  }
  for (const [callId, threadId] of suppressedToolProgressCallByCallId.entries()) {
    if (session.threadId === threadId) {
      suppressedToolProgressCallByCallId.delete(callId);
    }
  }
}

async function ensureGatewayTaskForRun(
  session: MockSession,
  prompt: string,
  attachmentNames: string[],
  discord: ContextEnvelopeDiscordPayload,
): Promise<void> {
  if (!session.gatewaySessionId) {
    await sendOperationLog(session.threadId, "gateway.mentions.start", [
      `- thread_id=${session.threadId}`,
      `- prompt_length=${prompt.length}`,
      `- attachments=${attachmentNames.length > 0 ? attachmentNames.join(", ") : "none"}`,
      `- request=${toOperationLogJson(
        {
          userId: session.ownerUserId,
          username: discord.username,
          nickname: discord.nickname,
          channelId: session.channelId,
          channelName: discord.channelName,
          threadId: session.threadId,
          threadName: discord.threadName,
          prompt,
          attachmentNames,
        },
        BOT_OPERATION_LOG_MAX_FIELD_CHARS,
      )}`,
    ]);
    const started = await gatewayApiRequest<GatewayStartResponse>(
      "POST",
      "/v1/discord/mentions/start",
      {
        userId: session.ownerUserId,
        username: discord.username,
        nickname: discord.nickname,
        channelId: session.channelId,
        channelName: discord.channelName,
        threadId: session.threadId,
        threadName: discord.threadName,
        prompt,
        attachmentNames,
      },
    );
    session.gatewaySessionId = started.session.sessionId;
    session.currentTaskId = started.taskId;
    await sendOperationLog(session.threadId, "gateway.mentions.started", [
      `- session_id=${started.session.sessionId}`,
      `- task_id=${started.taskId}`,
      `- status=${started.session.status}`,
    ]);
    return;
  }

  await sendOperationLog(session.threadId, "gateway.threads.message", [
    `- thread_id=${session.threadId}`,
    `- prompt_length=${prompt.length}`,
    `- attachments=${attachmentNames.length > 0 ? attachmentNames.join(", ") : "none"}`,
    `- request=${toOperationLogJson(
      {
        userId: session.ownerUserId,
        username: discord.username,
        nickname: discord.nickname,
        prompt,
        attachmentNames,
        channelName: discord.channelName,
        threadName: discord.threadName,
      },
      BOT_OPERATION_LOG_MAX_FIELD_CHARS,
    )}`,
  ]);
  const task = await gatewayApiRequest<GatewayThreadMessageResponse>(
    "POST",
    `/v1/threads/${session.threadId}/messages`,
    {
      userId: session.ownerUserId,
      username: discord.username,
      nickname: discord.nickname,
      prompt,
      attachmentNames,
      channelName: discord.channelName,
      threadName: discord.threadName,
    },
  );
  session.currentTaskId = task.taskId;
  await sendOperationLog(session.threadId, "gateway.threads.message.accepted", [
    `- session_id=${task.session.sessionId}`,
    `- task_id=${task.taskId}`,
    `- status=${task.session.status}`,
    `- resumed_from_idle=${task.resumedFromIdle}`,
  ]);
}

async function addReviewedReaction(message: Message): Promise<void> {
  try {
    await message.react("👀");
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to add reviewed reaction`, error);
  }
}

function isThreadChannel(
  channel:
    | Channel
    | Message["channel"]
    | ChatInputCommandInteraction["channel"]
    | null,
): channel is AnyThreadChannel {
  return channel !== null && channel.isThread();
}

function extractPromptFromMention(message: Message, botUserId: Snowflake): string {
  const mentionPattern = new RegExp(`<@!?${botUserId}>`, "g");
  return message.content.replace(mentionPattern, "").trim();
}

function resolveSessionByThreadId(threadId: Snowflake): MockSession | undefined {
  const sessionId = sessionIdByThreadId.get(threadId);
  if (!sessionId) {
    return undefined;
  }

  return sessionsById.get(sessionId);
}

function attachSessionToUser(session: MockSession): void {
  const current = sessionIdsByUserId.get(session.ownerUserId) ?? new Set<string>();
  current.add(session.id);
  sessionIdsByUserId.set(session.ownerUserId, current);
  sessionOwnerUserIdByThreadId.set(session.threadId, session.ownerUserId);
}

function detachSessionFromUser(session: MockSession): void {
  const current = sessionIdsByUserId.get(session.ownerUserId);
  if (!current) {
    return;
  }
  current.delete(session.id);
  if (current.size === 0) {
    sessionIdsByUserId.delete(session.ownerUserId);
  } else {
    sessionIdsByUserId.set(session.ownerUserId, current);
  }
  const sessionOnThread = resolveSessionByThreadId(session.threadId);
  if (!sessionOnThread) {
    sessionOwnerUserIdByThreadId.delete(session.threadId);
  }
}

function setSessionStatus(
  session: MockSession,
  status: SessionStatus,
  lastEvent: string,
): void {
  session.status = status;
  session.lastEvent = lastEvent;
  session.updatedAt = new Date();
}

function createRuntimeFeedbackState(): RuntimeFeedbackState {
  return {
    previousToolErrors: [],
    attachmentSources: [],
  };
}

function parseDateOrFallback(
  value: string | null | undefined,
  fallback: Date,
): Date {
  if (!value) {
    return fallback;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }
  return parsed;
}

function syncIdleTimerForSession(session: MockSession): void {
  clearIdleTimer(session.id);
  if (session.status === "closed_by_user" || !shouldTrackIdle(session)) {
    return;
  }
  const delayMs = Math.max(1, session.idleDeadlineAt.getTime() - Date.now());
  const timer = setTimeout(() => {
    void handleIdleTimeout(session.id);
  }, delayMs);
  idleTimerBySessionId.set(session.id, timer);
}

function extractThreadDisplayName(thread: AnyThreadChannel): string | undefined {
  const name = thread.name?.trim();
  return name && name.length > 0 ? name : undefined;
}

function extractThreadParentName(thread: AnyThreadChannel): string | undefined {
  const parent = thread.parent;
  if (!parent) {
    return undefined;
  }
  const name = parent.name?.trim();
  return name && name.length > 0 ? name : undefined;
}

function resolveDiscordUsername(
  thread: AnyThreadChannel,
  userId: string,
): string | undefined {
  const member = thread.members.cache.get(userId);
  const username = member?.user?.username?.trim();
  if (username && username.length > 0) {
    return username;
  }
  const guildMember = thread.guild.members.cache.get(userId);
  const guildUsername = guildMember?.user.username?.trim();
  return guildUsername && guildUsername.length > 0 ? guildUsername : undefined;
}

function resolveDiscordNickname(
  thread: AnyThreadChannel,
  userId: string,
): string | undefined {
  const guildMember = thread.guild.members.cache.get(userId);
  const nickname =
    guildMember?.nickname?.trim() ??
    guildMember?.displayName?.trim();
  return nickname && nickname.length > 0 ? nickname : undefined;
}

async function fetchThreadStatusFromGateway(
  threadId: Snowflake,
  requesterUserId?: Snowflake,
): Promise<GatewayThreadStatusResponse | null> {
  const userId = sessionOwnerUserIdByThreadId.get(threadId) ?? requesterUserId;
  if (!userId) {
    return null;
  }
  try {
    return await gatewayApiRequest<GatewayThreadStatusResponse>(
      "GET",
      `/v1/threads/${threadId}/status?userId=${encodeURIComponent(userId)}`,
    );
  } catch (error) {
    if (
      error instanceof GatewayApiRequestError &&
      error.statusCode === 404
    ) {
      return null;
    }
    throw error;
  }
}

function upsertSessionFromGatewayStatus(input: {
  thread: AnyThreadChannel;
  status: GatewayThreadStatusResponse;
  ownerUsername?: string;
  ownerNickname?: string;
}): MockSession {
  const gatewaySessionId = input.status.session.sessionId;
  const existingByThread = resolveSessionByThreadId(input.thread.id);
  const existingByGateway = [...sessionsById.values()].find(
    (candidate) => candidate.gatewaySessionId === gatewaySessionId,
  );
  const now = new Date();
  const parsedLastThreadActivityAt = parseDateOrFallback(
    input.status.session.lastThreadActivityAt,
    now,
  );
  const parsedCreatedAt = parseDateOrFallback(
    input.status.session.createdAt,
    parsedLastThreadActivityAt,
  );
  const parsedUpdatedAt = parseDateOrFallback(
    input.status.session.updatedAt,
    now,
  );
  const parsedIdleDeadlineAt = parseDateOrFallback(
    input.status.session.idleDeadlineAt ?? undefined,
    new Date(parsedLastThreadActivityAt.getTime() + IDLE_TIMEOUT_SEC * 1000),
  );
  const status = mapGatewaySessionStatus(input.status.session.status);
  const pendingApprovalId =
    input.status.pendingApproval?.status === "requested"
      ? input.status.pendingApproval.approvalId
      : undefined;
  const threadName = extractThreadDisplayName(input.thread) ?? input.thread.name;
  const channelName = extractThreadParentName(input.thread);
  const ownerUserId = input.status.session.userId as Snowflake;
  const channelId = input.status.session.channelId as Snowflake;

  let session = existingByThread ?? existingByGateway;
  if (!session) {
    session = {
      id: newId("ses"),
      ownerUserId,
      ownerUsername: input.ownerUsername,
      ownerNickname: input.ownerNickname,
      channelId,
      channelName,
      threadId: input.thread.id,
      threadName,
      gatewaySessionId,
      status,
      createdAt: parsedCreatedAt,
      updatedAt: parsedUpdatedAt,
      lastActivityAt: parsedLastThreadActivityAt,
      idleDeadlineAt: parsedIdleDeadlineAt,
      currentTaskId: input.status.latestTask?.taskId,
      pendingApprovalId,
      runSequence: 0,
      cancelRequested: false,
      lastEvent: `status synced: ${input.status.session.status}`,
      runtimeFeedback: createRuntimeFeedbackState(),
      lastTaskEventTimestamp: undefined,
      lastToolEventTimestamp: undefined,
    };
    sessionsById.set(session.id, session);
    sessionIdByThreadId.set(input.thread.id, session.id);
    attachSessionToUser(session);
    syncIdleTimerForSession(session);
    return session;
  }

  if (session.ownerUserId !== ownerUserId) {
    detachSessionFromUser(session);
    session.ownerUserId = ownerUserId;
  }
  if (input.ownerUsername && input.ownerUsername.trim().length > 0) {
    session.ownerUsername = input.ownerUsername.trim();
  }
  if (input.ownerNickname !== undefined) {
    session.ownerNickname = input.ownerNickname;
  }
  session.channelId = channelId;
  session.channelName = channelName ?? session.channelName;
  session.threadId = input.thread.id;
  session.threadName = threadName ?? session.threadName;
  session.gatewaySessionId = gatewaySessionId;
  session.status = status;
  session.createdAt = parsedCreatedAt;
  session.updatedAt = parsedUpdatedAt;
  session.lastActivityAt = parsedLastThreadActivityAt;
  session.idleDeadlineAt = parsedIdleDeadlineAt;
  session.currentTaskId = input.status.latestTask?.taskId;
  session.pendingApprovalId = pendingApprovalId;
  session.lastEvent = `status synced: ${input.status.session.status}`;

  sessionsById.set(session.id, session);
  sessionIdByThreadId.set(input.thread.id, session.id);
  attachSessionToUser(session);
  syncIdleTimerForSession(session);
  return session;
}

async function restoreSessionFromGatewayThread(input: {
  thread: AnyThreadChannel;
  requesterUserId?: Snowflake;
}): Promise<MockSession | undefined> {
  const status = await fetchThreadStatusFromGateway(
    input.thread.id,
    input.requesterUserId,
  );
  if (!status) {
    return undefined;
  }
  const ownerUsername = resolveDiscordUsername(input.thread, status.session.userId);
  const ownerNickname = resolveDiscordNickname(input.thread, status.session.userId);
  return upsertSessionFromGatewayStatus({
    thread: input.thread,
    status,
    ownerUsername,
    ownerNickname,
  });
}

async function buildDiscordContextPayload(
  session: MockSession,
): Promise<ContextEnvelopeDiscordPayload> {
  const channel = await client.channels.fetch(session.threadId);
  if (!isThreadChannel(channel)) {
    throw new Error("session_thread_not_found");
  }
  const username = resolveDiscordUsername(channel, session.ownerUserId);
  const nickname = resolveDiscordNickname(channel, session.ownerUserId);
  return {
    userId: session.ownerUserId,
    username: session.ownerUsername ?? username,
    nickname: session.ownerNickname ?? nickname,
    channelId: session.channelId,
    channelName: session.channelName ?? extractThreadParentName(channel),
    threadId: session.threadId,
    threadName: session.threadName ?? extractThreadDisplayName(channel),
  };
}

async function resolveDiscordContextPayloadForRun(
  session: MockSession,
): Promise<ContextEnvelopeDiscordPayload> {
  try {
    return await buildDiscordContextPayload(session);
  } catch (error) {
    await sendOperationLog(session.threadId, "context.discord.fallback", [
      "- reason=failed_to_fetch_discord_context",
      `- detail=${truncateOperationLogValue(summarizeError(error), BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`,
    ]);
    return {
      userId: session.ownerUserId,
      username: session.ownerUsername,
      nickname: session.ownerNickname,
      channelId: session.channelId,
      channelName: session.channelName,
      threadId: session.threadId,
      threadName: session.threadName,
    };
  }
}

function toContextEnvelopeSessionStatus(status: SessionStatus): string {
  return status;
}

function inferBotModeForContextEnvelope(): "standard" | "mock" {
  return BOT_MODE;
}

function inferInfrastructureStatusForContextEnvelope():
  | "ready"
  | "booting"
  | "failed" {
  return runtimeInfrastructureStatus;
}

function clearRuntimeFeedback(session: MockSession): void {
  session.runtimeFeedback.previousTaskTerminalStatus = undefined;
  session.runtimeFeedback.previousToolErrors = [];
  session.runtimeFeedback.retryHint = undefined;
  session.runtimeFeedback.attachmentSources = [];
  session.lastTaskEventTimestamp = undefined;
  session.lastToolEventTimestamp = undefined;
}

function updateRuntimeFeedbackFromTerminalStatus(
  session: MockSession,
  terminalStatus: ContextEnvelopeTaskTerminalStatus,
  toolErrors: string[],
): void {
  session.runtimeFeedback.previousTaskTerminalStatus = terminalStatus;
  session.runtimeFeedback.previousToolErrors = toolErrors.slice(0, 3);
  session.runtimeFeedback.retryHint = undefined;
}

function updateRuntimeFeedbackRetryHint(session: MockSession, hint: string): void {
  session.runtimeFeedback.retryHint = hint;
}

function buildAttachmentSources(attachments: Message["attachments"]): GatewayAttachmentSource[] {
  const sources: GatewayAttachmentSource[] = [];
  for (const attachment of attachments.values()) {
    const name = attachment.name ?? attachment.id;
    const sourceUrl = attachment.url;
    if (!name || !sourceUrl) {
      continue;
    }
    sources.push({
      name,
      sourceUrl,
    });
  }
  return sources;
}

function buildRunContextEnvelopePayload(
  session: MockSession,
  attachmentSources: GatewayAttachmentSource[],
  discord: ContextEnvelopeDiscordPayload,
): GatewayRunContextEnvelopePayload {
  return {
    behavior: {
      botMode: inferBotModeForContextEnvelope(),
      sessionStatus: toContextEnvelopeSessionStatus(session.status),
      infrastructureStatus: inferInfrastructureStatusForContextEnvelope(),
      toolRoutingPolicy: "hybrid_container_builtin_gateway_host",
      approvalPolicy: "host_ops_require_explicit_approval",
      responseContract: "ja, concise, ask_when_ambiguous",
      executionContract: "no_external_mcp, no_unapproved_host_ops",
    },
    runtimeFeedback: {
      previousTaskTerminalStatus: session.runtimeFeedback.previousTaskTerminalStatus,
      previousToolErrors: session.runtimeFeedback.previousToolErrors,
      retryHint: session.runtimeFeedback.retryHint,
      attachmentSources: [...attachmentSources],
    },
    discord,
  };
}

function buildRunRequestPayload(
  session: MockSession,
  prompt: string,
  attachments: GatewayAttachmentSource[],
  toolCalls: GatewayAgentToolCall[],
  discord: ContextEnvelopeDiscordPayload,
): GatewayRunRequestPayload {
  const attachmentNames = attachments.map((attachment) => attachment.name);
  return {
    taskId: session.currentTaskId ?? "",
    sessionId: session.gatewaySessionId ?? "",
    userId: session.ownerUserId,
    prompt,
    attachmentNames,
    contextEnvelope: buildRunContextEnvelopePayload(session, attachments, discord),
    toolCalls,
  };
}

function clearIdleTimer(sessionId: string): void {
  const timer = idleTimerBySessionId.get(sessionId);
  if (!timer) {
    return;
  }

  clearTimeout(timer);
  idleTimerBySessionId.delete(sessionId);
}

function shouldTrackIdle(session: MockSession): boolean {
  return session.status === "idle_waiting" || session.status === "idle_paused";
}

function touchSession(session: MockSession): void {
  const now = new Date();
  session.lastActivityAt = now;
  session.idleDeadlineAt = new Date(now.getTime() + IDLE_TIMEOUT_SEC * 1000);
  session.updatedAt = now;

  clearIdleTimer(session.id);
  if (session.status === "closed_by_user" || !shouldTrackIdle(session)) {
    return;
  }

  const timer = setTimeout(() => {
    void handleIdleTimeout(session.id);
  }, IDLE_TIMEOUT_SEC * 1000);
  idleTimerBySessionId.set(session.id, timer);
}

async function sendToThread(
  threadId: Snowflake,
  payload: Parameters<AnyThreadChannel["send"]>[0],
): Promise<Message<true> | null> {
  const channel = await client.channels.fetch(threadId);
  if (!isThreadChannel(channel)) {
    return null;
  }

  const sent = await channel.send(payload);
  return sent;
}

async function editThreadMessage(
  threadId: Snowflake,
  messageId: Snowflake,
  payload: MessageEditOptions,
): Promise<void> {
  const channel = await client.channels.fetch(threadId);
  if (!isThreadChannel(channel)) {
    return;
  }
  const message = await channel.messages.fetch(messageId);
  await message.edit(payload);
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

class SessionRunCanceledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRunCanceledError";
  }
}

function mapGatewaySessionStatus(status: string): SessionStatus {
  if (
    status === "running" ||
    status === "waiting_approval" ||
    status === "idle_waiting" ||
    status === "idle_paused" ||
    status === "canceled" ||
    status === "failed" ||
    status === "closed_by_user"
  ) {
    return status;
  }
  return "running";
}

function shouldBlockNewInputWhileActive(session: MockSession): boolean {
  return session.status === "running" || session.status === "waiting_approval";
}

function isIgnorableTaskCancelError(error: unknown): boolean {
  if (!(error instanceof GatewayApiRequestError)) {
    return false;
  }
  return error.statusCode === 404 || error.statusCode === 409;
}

async function sendSystemAlert(content: string): Promise<void> {
  if (!SYSTEM_ALERT_CHANNEL_ID) {
    return;
  }

  try {
    const channel = await client.channels.fetch(SYSTEM_ALERT_CHANNEL_ID);
    if (!channel || !("send" in channel)) {
      return;
    }

    await channel.send(content);
  } catch (error) {
    console.error(`${LOG_PREFIX} system alert failed`, error);
  }
}

function getInfrastructureStatusMessage(): string {
  if (runtimeInfrastructureStatus === "ready") {
    return "ready";
  }
  if (runtimeInfrastructureStatus === "booting") {
    return "booting";
  }
  return "failed";
}

function buildInfrastructureNotReadyMessage(): string {
  if (runtimeInfrastructureStatus === "booting") {
    return "⚙️ システム起動中です。しばらく待ってから再試行してください。";
  }
  return "🚨 システムの起動に失敗しています。`/reboot` で再起動するか、管理者へ連絡してください。";
}

function isInfrastructureReady(): boolean {
  return runtimeInfrastructureStatus === "ready";
}

async function bootInfrastructure(): Promise<void> {
  if (!ORCHESTRATOR_ENABLED) {
    runtimeInfrastructureStatus = "ready";
    return;
  }

  runtimeInfrastructureStatus = "booting";
  const supervisor = new RuntimeSupervisor({
    projectRoot: process.cwd(),
    gatewayApiBaseUrl: GATEWAY_API_BASE_URL,
    gatewayApiSocketPath: GATEWAY_API_SOCKET_PATH ?? undefined,
    gatewayApiHost: GATEWAY_API_HOST,
    gatewayApiPort: GATEWAY_API_PORT,
    agentRuntimeBaseUrl: AGENT_RUNTIME_BASE_URL,
    agentRuntimeSocketPath: AGENT_RUNTIME_SOCKET_PATH ?? undefined,
    composeBuild: ORCHESTRATOR_COMPOSE_BUILD,
    monitorIntervalSec: ORCHESTRATOR_MONITOR_INTERVAL_SEC,
    failureThreshold: ORCHESTRATOR_FAILURE_THRESHOLD,
    commandTimeoutSec: ORCHESTRATOR_COMMAND_TIMEOUT_SEC,
    cleanupEnabled: ORCHESTRATOR_CLEANUP_ENABLED,
    cleanupIntervalSec: ORCHESTRATOR_CLEANUP_INTERVAL_SEC,
    onLog: (message) => {
      console.log(`[orchestrator] ${message}`);
    },
    onAlert: async (message) => {
      await sendSystemAlert(message);
    },
    onFatal: async (reason) => {
      await gracefulTerminateFromInfrastructureFailure(reason);
    },
  });
  runtimeSupervisor = supervisor;

  await sendSystemAlert("🟡 [orchestrator] 起動準備を開始します。");
  try {
    await supervisor.boot();
    runtimeInfrastructureStatus = "ready";
    await sendSystemAlert("🟢 [orchestrator] 起動準備が完了しました。");
  } catch (error) {
    runtimeInfrastructureStatus = "failed";
    runtimeSupervisor = null;
    throw error;
  }
}

async function shutdownInfrastructure(
  options: RuntimeSupervisorShutdownOptions = {},
): Promise<void> {
  if (!runtimeSupervisor) {
    return;
  }

  const supervisor = runtimeSupervisor;
  runtimeSupervisor = null;
  await supervisor.shutdown(options);
}

async function gracefulTerminateFromInfrastructureFailure(
  reason: string,
): Promise<void> {
  if (isGracefulShutdownInProgress) {
    return;
  }
  isGracefulShutdownInProgress = true;

  runtimeInfrastructureStatus = "failed";
  await sendSystemAlert(`🚨 [orchestrator] ${reason}`);
  try {
    await shutdownInfrastructure({ stopCompose: ORCHESTRATOR_ENABLED });
  } catch (error) {
    console.error(`${LOG_PREFIX} graceful infrastructure shutdown failed`, error);
  }
  try {
    await setOfflineImmediately();
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to set offline during graceful shutdown`, error);
  }

  setTimeout(() => {
    process.exit(1);
  }, 50);
}

async function reportRuntimeError(context: string, error: unknown): Promise<void> {
  const summary = summarizeError(error);
  console.error(`${LOG_PREFIX} ${context}`, error);
  await sendSystemAlert(`🚨 [${ALERT_TAG}:error] ${context}\n${summary}`);
}

function startTypingLoop(threadId: Snowflake): () => void {
  let stopped = false;
  let interval: NodeJS.Timeout | undefined;

  void (async () => {
    const channel = await client.channels.fetch(threadId);
    if (!isThreadChannel(channel)) {
      return;
    }

    const pulse = async (): Promise<void> => {
      if (stopped) {
        return;
      }

      await channel.sendTyping();
    };

    await pulse();
    interval = setInterval(() => {
      void pulse().catch((error: unknown) => {
        console.error(`${LOG_PREFIX} typing pulse failed`, error);
      });
    }, TYPING_PULSE_MS);
  })().catch((error: unknown) => {
    console.error(`${LOG_PREFIX} typing loop setup failed`, error);
  });

  return () => {
    stopped = true;
    if (interval) {
      clearInterval(interval);
    }
  };
}

async function setOfflineImmediately(): Promise<void> {
  if (client.user) {
    await client.user.setStatus("invisible");
  }

  await client.destroy();
}

function resetRuntimeStateForReboot(): void {
  for (const timer of idleTimerBySessionId.values()) {
    clearTimeout(timer);
  }
  idleTimerBySessionId.clear();

  pendingApprovals.clear();

  sessionsById.clear();
  sessionIdByThreadId.clear();
  sessionIdsByUserId.clear();
  sessionOwnerUserIdByThreadId.clear();
  recentlySeenMessageIds.clear();
  recentlySeenInteractionIds.clear();
  runningSessionIds.clear();
}

function cleanupDedupCache(cache: Map<Snowflake, number>, now: number): void {
  for (const [id, seenAt] of cache) {
    if (now - seenAt > BOT_EVENT_DEDUP_TTL_MS) {
      cache.delete(id);
    }
  }
}

function markEventIfNew(cache: Map<Snowflake, number>, id: Snowflake): boolean {
  const now = Date.now();
  cleanupDedupCache(cache, now);
  if (cache.has(id)) {
    return false;
  }
  cache.set(id, now);
  return true;
}

async function rebootInProcess(): Promise<void> {
  resetRuntimeStateForReboot();
  runtimeInfrastructureStatus = ORCHESTRATOR_ENABLED ? "booting" : "ready";
  await setOfflineImmediately();
  client = createDiscordClient();
  registerClientEventHandlers();
  await client.login(DISCORD_BOT_TOKEN);
}

async function handleIdleTimeout(sessionId: string): Promise<void> {
  const session = sessionsById.get(sessionId);
  if (!session) {
    return;
  }

  if (session.status === "closed_by_user" || session.status === "idle_paused") {
    return;
  }

  session.cancelRequested = true;
  updateRuntimeFeedbackFromTerminalStatus(session, "canceled", []);
  updateRuntimeFeedbackRetryHint(
    session,
    `previous run was canceled after ${IDLE_TIMEOUT_SEC}s idle timeout`,
  );
  session.runSequence += 1;
  if (session.pendingApprovalId) {
    settleApproval(session.pendingApprovalId);
    session.pendingApprovalId = undefined;
  }

  try {
    await syncCancelWithGateway(session, session.ownerUserId);
  } catch (error) {
    console.error(`${LOG_PREFIX} idle timeout cancel sync failed`, error);
  }

  setSessionStatus(
    session,
    "idle_paused",
    `thread inactive for ${IDLE_TIMEOUT_SEC} seconds`,
  );

  await sendToThread(
    session.threadId,
    `⏸️ セッションは ${IDLE_TIMEOUT_SEC} 秒の無発言で一時停止しました。` +
      `\n同じスレッドで再度メッセージを送ると自動再開します。`,
  );
}

async function relayLmMessage(threadId: Snowflake, rawMessage: string): Promise<void> {
  await sendToThread(threadId, rawMessage);
}

function toDeliveredAttachment(file: DeliveredContainerFile): AttachmentBuilder | null {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(file.contentBase64, "base64");
  } catch {
    return null;
  }
  if (
    buffer.byteLength !== file.bytes ||
    buffer.byteLength <= 0 ||
    buffer.byteLength > BOT_DELIVERED_FILE_MAX_BYTES
  ) {
    return null;
  }
  const description = `${file.path} (${file.mimeType})`;
  return new AttachmentBuilder(buffer, {
    name: file.fileName,
    description: truncateOperationLogValue(description, 100),
  });
}

async function sendDeliveredFilesToThread(
  threadId: Snowflake,
  deliveredFiles: DeliveredContainerFile[],
): Promise<void> {
  if (deliveredFiles.length === 0) {
    return;
  }
  const files = deliveredFiles
    .map((file) => toDeliveredAttachment(file))
    .filter((file): file is AttachmentBuilder => file !== null);
  if (files.length === 0) {
    return;
  }
  await sendToThread(threadId, {
    content: "📦 コンテナからファイルを送信しました。",
    files,
  });
}

function buildStatusEmbed(session: MockSession): EmbedBuilder {
  const idleDeadline = `<t:${Math.floor(session.idleDeadlineAt.getTime() / 1000)}:R>`;
  const updatedAt = `<t:${Math.floor(session.updatedAt.getTime() / 1000)}:F>`;
  const createdAt = `<t:${Math.floor(session.createdAt.getTime() / 1000)}:F>`;

  return new EmbedBuilder()
    .setTitle("Session Status")
    .setColor(0x5b8def)
    .addFields(
      { name: "status", value: `\`${session.status}\``, inline: true },
      {
        name: "infra",
        value: `\`${getInfrastructureStatusMessage()}\``,
        inline: true,
      },
      { name: "last_event", value: session.lastEvent || "-" },
      { name: "idle_deadline", value: idleDeadline, inline: true },
      { name: "updated_at", value: updatedAt, inline: true },
      { name: "created_at", value: createdAt, inline: true },
    );
}

function buildListEmbed(userId: Snowflake): EmbedBuilder {
  const ids = [...(sessionIdsByUserId.get(userId) ?? new Set<string>())];
  const sessions = ids
    .map((id) => sessionsById.get(id))
    .filter((session): session is MockSession => session !== undefined)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 20);

  const description =
    sessions.length === 0
      ? "セッションはありません。"
      : sessions
          .map(
            (session) => `- <#${session.threadId}> | \`${session.status}\``,
          )
          .join("\n");

  return new EmbedBuilder()
    .setTitle("My Sessions")
    .setColor(0x46c37b)
    .setDescription(description);
}

function settleApproval(approvalId: string): boolean {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    return false;
  }

  pendingApprovals.delete(approvalId);
  const session = sessionsById.get(pending.sessionId);
  if (session && session.pendingApprovalId === approvalId) {
    session.pendingApprovalId = undefined;
    touchSession(session);
  }
  return true;
}

function isRunCanceled(session: MockSession, runSequence: number): boolean {
  return session.cancelRequested || runSequence !== session.runSequence;
}

function resolveApprovalTargetLine(request: {
  operationCode: ApprovalOperationCode;
  target: string;
}): string {
  const rawTarget = truncateOperationLogValue(
    sanitizeToolProgressContent(request.target),
    120,
  );
  switch (request.operationCode) {
    case "read":
      return `ファイル読み取り: ${rawTarget}`;
    case "write":
      return `ファイル書き込み: ${rawTarget}`;
    case "delete":
      return `ファイル削除: ${rawTarget}`;
    case "list":
      return `ファイル一覧: ${rawTarget}`;
    case "exec":
      return `$ ${rawTarget}`;
    case "http_request":
      return `HTTP リクエスト: ${shortenUrlForDisplay(request.target)}`;
    case "web_search":
      return `Web検索: ${shortenUrlForDisplay(request.target)}`;
    case "discord_channel_history": {
      const channelId = parseScopeSuffix(request.target, "discord_channel:");
      if (channelId) {
        return `チャンネル履歴参照: #channel (${shortenIdentifier(channelId)})`;
      }
      if (request.target === "session channel") {
        return "チャンネル履歴参照: #session";
      }
      return `チャンネル履歴参照: ${rawTarget}`;
    }
    case "discord_channel_list":
      return "チャンネル一覧参照: Guild channels";
    default:
      return `承認対象: ${rawTarget}`;
  }
}

function resolveApprovalTargetLineFromRequest(request: {
  operationCode: ApprovalOperationCode;
  target: string;
  targetLine?: string;
}): string {
  const cachedTargetLine = request.targetLine?.trim();
  if (cachedTargetLine && cachedTargetLine.length > 0) {
    return cachedTargetLine;
  }
  return resolveApprovalTargetLine(request);
}

async function resolveDiscordChannelNameById(channelId: string): Promise<string | undefined> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !("name" in channel)) {
      return undefined;
    }
    const name = typeof channel.name === "string" ? channel.name.trim() : "";
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

async function resolveApprovalTargetLineForSession(
  session: MockSession,
  request: {
    operationCode: ApprovalOperationCode;
    target: string;
  },
): Promise<string> {
  if (request.operationCode !== "discord_channel_history") {
    return resolveApprovalTargetLine(request);
  }
  const scopeChannelId = parseScopeSuffix(request.target, "discord_channel:");
  if (scopeChannelId === "__session_channel__" || request.target === "session channel") {
    return `チャンネル履歴参照: ${formatDiscordChannelTarget(
      session.channelName,
      session.channelId,
    )}`;
  }
  if (!scopeChannelId) {
    return resolveApprovalTargetLine(request);
  }
  if (scopeChannelId === session.channelId) {
    return `チャンネル履歴参照: ${formatDiscordChannelTarget(
      session.channelName,
      session.channelId,
    )}`;
  }
  if (scopeChannelId === session.threadId) {
    return `チャンネル履歴参照: ${formatDiscordChannelTarget(
      session.threadName,
      session.threadId,
    )}`;
  }
  const resolvedName = await resolveDiscordChannelNameById(scopeChannelId);
  return `チャンネル履歴参照: ${formatDiscordChannelTarget(resolvedName, scopeChannelId)}`;
}

function resolveApprovalDecisionLine(decision: ApprovalDecision): string {
  switch (decision) {
    case "approved":
      return "✅ 承認しました";
    case "rejected":
      return "❌ 拒否しました";
    case "timeout":
      return "⏱️ 承認がタイムアウトしました";
    case "canceled":
      return "🛑 承認待ちを終了しました";
    default:
      return "🛑 承認待ちを終了しました";
  }
}

function buildApprovalRequestMessageContent(input: {
  toolName: string;
  operationCode: ApprovalOperationCode;
  target: string;
  targetLine?: string;
}): string {
  const request = {
    operationCode: input.operationCode,
    target: input.target,
    targetLine: input.targetLine,
  };
  const lines = [
    "🛂 承認リクエスト",
    input.toolName,
    resolveApprovalTargetLineFromRequest(request),
    "この操作を実行しますか？",
  ];
  return `\`\`\`text\n${lines.join("\n")}\n\`\`\``;
}

function buildApprovalResultMessageContent(input: {
  toolName: string;
  operationCode: ApprovalOperationCode;
  target: string;
  targetLine?: string;
  decision: ApprovalDecision;
}): string {
  const request = {
    operationCode: input.operationCode,
    target: input.target,
    targetLine: input.targetLine,
  };
  const lines = [
    "🛂 承認結果",
    input.toolName,
    resolveApprovalTargetLineFromRequest(request),
    resolveApprovalDecisionLine(input.decision),
  ];
  return `\`\`\`text\n${lines.join("\n")}\n\`\`\``;
}

function buildApprovalSyncFailureMessageContent(
  pending: PendingApproval,
  error: unknown,
): string {
  const systemMessage = truncateOperationLogValue(
    sanitizeToolProgressContent(summarizeError(error)),
    220,
  );
  const lines = [
    "🛂 承認結果の反映",
    pending.request.toolName,
    resolveApprovalTargetLineFromRequest(pending.request),
    "❌ 失敗",
    systemMessage,
  ];
  return `\`\`\`text\n${lines.join("\n")}\n\`\`\``;
}

function toApprovalOperationCode(value: string | null): ApprovalOperationCode {
  switch (value) {
    case "read":
    case "write":
    case "delete":
    case "list":
    case "exec":
    case "http_request":
    case "web_search":
    case "discord_channel_history":
    case "discord_channel_list":
      return value;
    default:
      return "unknown";
  }
}

function toApprovalRequestFromPending(status: GatewayAgentTaskStatusResponse): {
  approvalId: string;
  toolName: string;
  operationCode: ApprovalOperationCode;
  target: string;
} | null {
  const pending = status.pendingApproval;
  if (!pending || pending.status !== "requested") {
    return null;
  }
  const taskEvents = status.taskEvents ?? [];
  const requestedEvent = [...taskEvents]
    .reverse()
    .find(
      (event) =>
        event.eventType === "approval.requested" &&
        readString(asRecord(event.payloadJson), "approvalId") === pending.approvalId,
    );
  const requestedPayload = requestedEvent
    ? asRecord(requestedEvent.payloadJson)
    : null;
  const toolName = readString(requestedPayload, "toolName") ?? "host.operation";
  return {
    approvalId: pending.approvalId,
    toolName,
    operationCode: toApprovalOperationCode(pending.operation),
    target: pending.path,
  };
}

function resolveApprovalDecisionFromTaskEvents(
  taskEvents: GatewayTaskEvent[] | undefined,
  approvalId: string,
): ApprovalDecision | null {
  if (!taskEvents || taskEvents.length === 0) {
    return null;
  }
  const resolvedEvent = [...taskEvents]
    .reverse()
    .find((event) => {
      if (
        event.eventType !== "approval.approved" &&
        event.eventType !== "approval.rejected" &&
        event.eventType !== "approval.timeout" &&
        event.eventType !== "approval.canceled"
      ) {
        return false;
      }
      const payload = asRecord(event.payloadJson);
      return readString(payload, "approvalId") === approvalId;
    });
  if (!resolvedEvent) {
    return null;
  }
  if (resolvedEvent.eventType === "approval.approved") {
    return "approved";
  }
  if (resolvedEvent.eventType === "approval.rejected") {
    return "rejected";
  }
  if (resolvedEvent.eventType === "approval.timeout") {
    return "timeout";
  }
  return "canceled";
}

async function syncPendingApprovalMessage(
  session: MockSession,
  status: GatewayAgentTaskStatusResponse,
): Promise<void> {
  const pending = toApprovalRequestFromPending(status);
  if (!pending) {
    return;
  }
  if (pendingApprovals.has(pending.approvalId)) {
    return;
  }

  session.pendingApprovalId = pending.approvalId;
  setSessionStatus(
    session,
    "waiting_approval",
    `approval requested: ${pending.toolName} ${pending.operationCode} ${pending.target}`,
  );
  touchSession(session);
  const targetLine = await resolveApprovalTargetLineForSession(session, {
    operationCode: pending.operationCode,
    target: pending.target,
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approval:${pending.approvalId}:approve`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`approval:${pending.approvalId}:reject`)
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger),
  );

  const sent = await sendToThread(session.threadId, {
    content: `<@${session.ownerUserId}>\n${buildApprovalRequestMessageContent({
      toolName: pending.toolName,
      operationCode: pending.operationCode,
      target: pending.target,
      targetLine,
    })}`,
    components: [row],
  });
  pendingApprovals.set(pending.approvalId, {
    approvalId: pending.approvalId,
    sessionId: session.id,
    threadId: session.threadId,
    messageId: sent?.id ?? null,
    request: {
      toolName: pending.toolName,
      operationCode: pending.operationCode,
      target: pending.target,
      targetLine,
    },
  });
}

async function syncPendingApprovalResolution(
  session: MockSession,
  status: GatewayAgentTaskStatusResponse,
): Promise<void> {
  if (status.pendingApproval?.status === "requested") {
    await syncPendingApprovalMessage(session, status);
    return;
  }
  if (!session.pendingApprovalId) {
    return;
  }
  const localPending = pendingApprovals.get(session.pendingApprovalId);
  if (!localPending) {
    session.pendingApprovalId = undefined;
    return;
  }
  const decision = resolveApprovalDecisionFromTaskEvents(
    status.taskEvents,
    localPending.approvalId,
  );
  if (decision && localPending.messageId) {
    await editThreadMessage(localPending.threadId, localPending.messageId, {
      content: buildApprovalResultMessageContent({
        toolName: localPending.request.toolName,
        operationCode: localPending.request.operationCode,
        target: localPending.request.target,
        targetLine: localPending.request.targetLine,
        decision,
      }),
      components: [],
      embeds: [],
      files: [],
    });
  }
  settleApproval(localPending.approvalId);
  session.pendingApprovalId = undefined;
  touchSession(session);
}

function buildAgentToolCalls(prompt: string): GatewayAgentToolCallBuildResult {
  const toolCalls: GatewayAgentToolCall[] = [];
  const errors: string[] = [];
  const lines = prompt.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const hostReadPath = extractHostReadDirectivePath(trimmed);
    if (hostReadPath) {
      toolCalls.push({
        toolName: "host.file_read",
        executionTarget: "gateway_adapter",
        arguments: {
          path: hostReadPath,
        },
        reason: "user requested host file read",
      });
      continue;
    }

    const parsedToolDirective = parseToolDirectiveLine(trimmed);
    if (!parsedToolDirective.matched) {
      continue;
    }
    if (parsedToolDirective.error) {
      errors.push(parsedToolDirective.error);
      continue;
    }
    const parsedToolCall = parsedToolDirective.toolCall;
    if (!parsedToolCall) {
      errors.push("invalid #tool directive.");
      continue;
    }
    toolCalls.push(parsedToolCall);
  }
  return {
    toolCalls,
    errors,
  };
}

function extractHostReadDirectivePath(prompt: string): string | null {
  const match = prompt.match(/^#host-read:\s*(.+)$/i);
  const rawPath = match?.[1]?.trim();
  if (!rawPath) {
    return null;
  }
  return path.resolve(rawPath);
}

function parseToolDirectiveLine(
  line: string,
):
  | { matched: false }
  | { matched: true; toolCall: GatewayAgentToolCall; error?: undefined }
  | { matched: true; toolCall?: undefined; error: string } {
  if (!line.startsWith("#tool:")) {
    return { matched: false };
  }

  const body = line.slice("#tool:".length).trim();
  if (!body) {
    return {
      matched: true,
      error: "empty #tool directive. expected `#tool: <tool_name> <json_arguments>`.",
    };
  }

  const firstSpaceIndex = body.indexOf(" ");
  const toolName = (firstSpaceIndex === -1 ? body : body.slice(0, firstSpaceIndex)).trim();
  const rawArgs =
    firstSpaceIndex === -1 ? "" : body.slice(firstSpaceIndex + 1).trim();
  if (!toolName) {
    return {
      matched: true,
      error: "invalid #tool directive. tool name is required.",
    };
  }

  let argumentsPayload: Record<string, unknown> = {};
  if (rawArgs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      return {
        matched: true,
        error:
          `invalid #tool JSON for \`${toolName}\`. arguments must be a JSON object.`,
      };
    }
    const record = asRecord(parsed);
    if (!record) {
      return {
        matched: true,
        error:
          `invalid #tool arguments for \`${toolName}\`. JSON object is required.`,
      };
    }
    argumentsPayload = record;
  }

  return {
    matched: true,
    toolCall: {
      toolName,
      executionTarget: "gateway_adapter",
      arguments: argumentsPayload,
      reason: "user requested tool execution via #tool directive",
    },
  };
}

function formatToolCallSummary(toolCalls: GatewayAgentToolCall[]): string {
  const names = toolCalls.map((toolCall) => toolCall.toolName);
  const uniqueNames = [...new Set(names)];
  const listed = uniqueNames
    .slice(0, 4)
    .map((name) => `\`${name}\``)
    .join(", ");
  const remaining = uniqueNames.length - Math.min(uniqueNames.length, 4);
  if (remaining > 0) {
    return `${listed} (+${remaining})`;
  }
  return listed;
}


function summarizeToolErrors(toolResults: unknown[]): string[] {
  const summaries: string[] = [];
  for (const result of toolResults) {
    const record = asRecord(result);
    if (!record || record.status !== "error") {
      continue;
    }
    const errorCode =
      readString(record, "error_code") ?? readString(record, "code") ?? "unknown_error";
    const message =
      readString(record, "message") ?? "ツール実行でエラーが発生しました。";
    if (errorCode === "tool_execution_failed" || errorCode === "unknown_error") {
      summaries.push(message);
      continue;
    }
    summaries.push(`${errorCode}: ${message}`);
  }
  return summaries;
}

function extractDeliveredFilesFromToolResults(toolResults: unknown[]): DeliveredContainerFile[] {
  const delivered: DeliveredContainerFile[] = [];
  for (const result of toolResults) {
    const record = asRecord(result);
    if (!record || record.status !== "ok") {
      continue;
    }
    const toolName = readString(record, "tool_name");
    if (toolName !== "container.file_deliver") {
      continue;
    }
    const payload = readRecord(record, "result");
    if (!payload) {
      continue;
    }
    const pathValue = readString(payload, "path");
    const fileName = readString(payload, "file_name");
    const mimeType =
      readString(payload, "mime_type") ?? "application/octet-stream";
    const contentBase64 = readString(payload, "content_base64");
    const bytes = readNumber(payload, "bytes");
    if (!pathValue || !fileName || !contentBase64 || bytes === null) {
      continue;
    }
    if (bytes <= 0 || bytes > BOT_DELIVERED_FILE_MAX_BYTES) {
      continue;
    }
    delivered.push({
      path: pathValue,
      fileName,
      bytes,
      mimeType,
      contentBase64,
    });
  }
  return delivered.slice(0, BOT_DELIVERED_FILE_MAX_COUNT);
}


function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function readStringAny(
  record: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = readString(record, key);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function readNumber(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(
  record: Record<string, unknown> | null | undefined,
  key: string,
): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function readArray(
  record: Record<string, unknown> | null | undefined,
  key: string,
): unknown[] | null {
  const value = record?.[key];
  return Array.isArray(value) ? value : null;
}

function readRecord(
  record: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  return asRecord(record?.[key]);
}

function buildGatewayApiErrorLogLines(error: unknown): string[] {
  if (error instanceof GatewayApiRequestError) {
    return [
      `- type=gateway_api_error`,
      `- method=${error.method}`,
      `- path=${error.pathname}`,
      `- status=${error.statusCode} ${error.statusText}`,
      `- response=${truncateOperationLogValue(error.responseText, BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`,
    ];
  }
  return [
    "- type=runtime_error",
    `- message=${truncateOperationLogValue(summarizeError(error), BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`,
  ];
}

function readGatewayApiErrorCode(error: unknown): string | null {
  if (!(error instanceof GatewayApiRequestError)) {
    return null;
  }
  try {
    const parsed = JSON.parse(error.responseText);
    const record = asRecord(parsed);
    return readString(record, "error");
  } catch {
    return null;
  }
}

async function waitForAgentTaskTerminalStatus(
  session: MockSession,
  taskId: string,
  runSequence: number,
): Promise<GatewayAgentTaskStatusResponse> {
  const inactivityTimeoutMs = AGENT_STATUS_TIMEOUT_SEC * 1000;
  let lastObservedActivityAtMs = Date.now();
  let lastObservedTaskEventTimestamp = session.lastTaskEventTimestamp;
  let lastObservedToolEventTimestamp = session.lastToolEventTimestamp;
  let pollCount = 0;
  while (true) {
    if (isRunCanceled(session, runSequence)) {
      throw new SessionRunCanceledError(
        "run canceled while waiting for agent status",
      );
    }

    const status = await gatewayApiRequest<GatewayAgentTaskStatusResponse>(
      "GET",
      `/v1/agent/tasks/${encodeURIComponent(taskId)}/status?userId=${encodeURIComponent(
        session.ownerUserId,
      )}`,
    );
    session.gatewaySessionId = status.session.sessionId;
    session.currentTaskId = status.task.taskId;
    setSessionStatus(
      session,
      mapGatewaySessionStatus(status.session.status),
      `agent task ${status.agentTask.status}`,
    );
    pollCount += 1;
    const statusUpdatedAtMs = parseTimestampMs(status.agentTask.updated_at);
    if (statusUpdatedAtMs !== null && statusUpdatedAtMs > lastObservedActivityAtMs) {
      lastObservedActivityAtMs = statusUpdatedAtMs;
    }

    if (
      session.lastTaskEventTimestamp &&
      session.lastTaskEventTimestamp !== lastObservedTaskEventTimestamp
    ) {
      const taskEventMs = parseTimestampMs(session.lastTaskEventTimestamp);
      if (taskEventMs !== null && taskEventMs > lastObservedActivityAtMs) {
        lastObservedActivityAtMs = taskEventMs;
      }
      lastObservedTaskEventTimestamp = session.lastTaskEventTimestamp;
    }

    if (
      session.lastToolEventTimestamp &&
      session.lastToolEventTimestamp !== lastObservedToolEventTimestamp
    ) {
      const toolEventMs = parseTimestampMs(session.lastToolEventTimestamp);
      if (toolEventMs !== null && toolEventMs > lastObservedActivityAtMs) {
        lastObservedActivityAtMs = toolEventMs;
      }
      lastObservedToolEventTimestamp = session.lastToolEventTimestamp;
    }

    if (
      status.agentTask.status === "completed" ||
      status.agentTask.status === "failed" ||
      status.agentTask.status === "canceled"
    ) {
      await sendOperationLog(session.threadId, "gateway.agent.status.terminal", [
        `- task_id=${status.task.taskId}`,
        `- session_id=${status.session.sessionId}`,
        `- polls=${pollCount}`,
        `- terminal_status=${status.agentTask.status}`,
        `- send_and_wait_count=${status.agentTask.send_and_wait_count}`,
        `- completed_at=${status.agentTask.completed_at ?? "null"}`,
      ]);
      return status;
    }

    const inactivityElapsedMs = Date.now() - lastObservedActivityAtMs;
    if (inactivityElapsedMs > inactivityTimeoutMs) {
      throw new Error(
        `Agent task status polling timed out after ${AGENT_STATUS_TIMEOUT_SEC} seconds without activity.`,
      );
    }

    await wait(AGENT_POLL_INTERVAL_MS);
  }
}

async function runAgentTaskAttempt(
  session: MockSession,
  prompt: string,
  attachments: GatewayAttachmentSource[],
  toolCalls: GatewayAgentToolCall[],
  discord: ContextEnvelopeDiscordPayload,
  runSequence: number,
): Promise<GatewayAgentTaskStatusResponse> {
  const attachmentNames = attachments.map((attachment) => attachment.name);
  await ensureGatewayTaskForRun(session, prompt, attachmentNames, discord);
  if (!session.gatewaySessionId || !session.currentTaskId) {
    throw new Error("Gateway task is not initialized.");
  }

  const runPayload = buildRunRequestPayload(
    session,
    prompt,
    attachments,
    toolCalls,
    discord,
  );
  await sendOperationLog(session.threadId, "gateway.agent.run.request", [
    `- run_sequence=${runSequence}`,
    `- session_id=${runPayload.sessionId}`,
    `- task_id=${runPayload.taskId}`,
    `- prompt_length=${prompt.length}`,
    `- attachments=${attachmentNames.length > 0 ? attachmentNames.join(", ") : "none"}`,
    `- tool_calls=${toolCalls.length}`,
    `- request=${toOperationLogJson(runPayload, BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`,
  ]);
  const runAccepted = await gatewayApiRequest<GatewayAgentRunResponse>(
    "POST",
    "/v1/agent/tasks/run",
    runPayload,
  );
  session.currentTaskId = runAccepted.task.taskId;
  session.gatewaySessionId = runAccepted.session.sessionId;
  setSessionStatus(
    session,
    mapGatewaySessionStatus(runAccepted.session.status),
    "agent run accepted",
  );
  await sendOperationLog(session.threadId, "gateway.agent.run.accepted", [
    `- task_id=${runAccepted.task.taskId}`,
    `- session_id=${runAccepted.session.sessionId}`,
    `- session_status=${runAccepted.session.status}`,
    `- agent_status=${runAccepted.agentTask.status}`,
    `- bootstrap_mode=${runAccepted.agentTask.bootstrap_mode}`,
    `- send_and_wait_count=${runAccepted.agentTask.send_and_wait_count}`,
  ]);

  return waitForAgentTaskTerminalStatus(session, runAccepted.task.taskId, runSequence);
}

async function waitForAgentTaskWithToolProgress(
  session: MockSession,
  prompt: string,
  attachments: GatewayAttachmentSource[],
  toolCalls: GatewayAgentToolCall[],
  discord: ContextEnvelopeDiscordPayload,
  runSequence: number,
): Promise<GatewayAgentTaskStatusResponse> {
  const terminalPromise = runAgentTaskAttempt(
    session,
    prompt,
    attachments,
    toolCalls,
    discord,
    runSequence,
  );
  while (true) {
    const race = await Promise.race([
      terminalPromise.then((value) => ({ kind: "terminal" as const, value })),
      wait(AGENT_POLL_INTERVAL_MS).then(() => ({ kind: "tick" as const })),
    ]);
    if (race.kind === "terminal") {
      await syncToolProgressMessages(session, race.value.task.taskId);
      return race.value;
    }
    if (session.currentTaskId) {
      await syncToolProgressMessages(session, session.currentTaskId);
    }
  }
}

async function syncCancelWithGateway(
  session: MockSession,
  userId: Snowflake,
): Promise<void> {
  await sendOperationLog(session.threadId, "gateway.cancel.request", [
    `- session_id=${session.gatewaySessionId ?? "unknown"}`,
    `- task_id=${session.currentTaskId ?? "none"}`,
    `- user_id=${userId}`,
  ]);
  if (session.currentTaskId) {
    try {
      await gatewayApiRequest(
        "POST",
        `/v1/agent/tasks/${encodeURIComponent(session.currentTaskId)}/cancel`,
        { userId },
      );
      await sendOperationLog(session.threadId, "gateway.cancel.agent_task", [
        `- task_id=${session.currentTaskId}`,
        "- status=accepted",
      ]);
    } catch (error) {
      if (!isIgnorableTaskCancelError(error)) {
        throw error;
      }
      await sendOperationLog(session.threadId, "gateway.cancel.agent_task", [
        `- task_id=${session.currentTaskId}`,
        "- status=ignored",
        ...buildGatewayApiErrorLogLines(error),
      ]);
    }
  }

  await gatewayApiRequest("POST", `/v1/threads/${session.threadId}/cancel`, {
    userId,
  });
  await sendOperationLog(session.threadId, "gateway.cancel.thread", [
    `- thread_id=${session.threadId}`,
    "- status=accepted",
  ]);
}

async function syncCloseWithGateway(
  session: MockSession,
  userId: Snowflake,
): Promise<void> {
  await sendOperationLog(session.threadId, "gateway.close.request", [
    `- session_id=${session.gatewaySessionId ?? "unknown"}`,
    `- task_id=${session.currentTaskId ?? "none"}`,
    `- user_id=${userId}`,
  ]);
  if (session.currentTaskId) {
    try {
      await gatewayApiRequest(
        "POST",
        `/v1/agent/tasks/${encodeURIComponent(session.currentTaskId)}/cancel`,
        { userId },
      );
      await sendOperationLog(session.threadId, "gateway.close.agent_task_cancel", [
        `- task_id=${session.currentTaskId}`,
        "- status=accepted",
      ]);
    } catch (error) {
      if (!isIgnorableTaskCancelError(error)) {
        throw error;
      }
      await sendOperationLog(session.threadId, "gateway.close.agent_task_cancel", [
        `- task_id=${session.currentTaskId}`,
        "- status=ignored",
        ...buildGatewayApiErrorLogLines(error),
      ]);
    }
  }

  await gatewayApiRequest("POST", `/v1/threads/${session.threadId}/close`, {
    userId,
  });
  await sendOperationLog(session.threadId, "gateway.close.thread", [
    `- thread_id=${session.threadId}`,
    "- status=accepted",
  ]);
}

async function refreshSessionFromGateway(session: MockSession): Promise<void> {
  const status = await fetchThreadStatusFromGateway(session.threadId);
  if (!status) {
    throw new Error("gateway_session_not_found");
  }
  session.gatewaySessionId = status.session.sessionId;
  session.currentTaskId = status.latestTask?.taskId;
  session.pendingApprovalId =
    status.pendingApproval?.status === "requested"
      ? status.pendingApproval.approvalId
      : undefined;
  setSessionStatus(
    session,
    mapGatewaySessionStatus(status.session.status),
    `status synced: ${status.session.status}`,
  );
  session.lastActivityAt = parseDateOrFallback(
    status.session.lastThreadActivityAt,
    session.lastActivityAt,
  );
  session.idleDeadlineAt = parseDateOrFallback(
    status.session.idleDeadlineAt ?? undefined,
    new Date(session.lastActivityAt.getTime() + IDLE_TIMEOUT_SEC * 1000),
  );
  syncIdleTimerForSession(session);
}

async function runAgentTask(
  session: MockSession,
  prompt: string,
  attachments: GatewayAttachmentSource[],
  triggeredByUserId: Snowflake,
): Promise<void> {
  const attachmentNames = attachments.map((attachment) => attachment.name);
  if (runningSessionIds.has(session.id)) {
    if (session.status === "idle_paused") {
      session.queuedRun = { prompt, attachments, triggeredByUserId };
      await sendToThread(
        session.threadId,
        "▶️ 自動再開リクエストを受け付けました。停止処理後に再開します。",
      );
      return;
    }

    await sendToThread(
      session.threadId,
      "⚠️ すでに実行中のタスクがあります。完了後に再度お試しください。",
    );
    return;
  }

  runningSessionIds.add(session.id);
  session.runSequence += 1;
  const runSequence = session.runSequence;
  session.cancelRequested = false;
  session.queuedRun = undefined;
  session.runtimeFeedback.attachmentSources = attachments;
  setSessionStatus(
    session,
    "running",
    `task started by <@${triggeredByUserId}>`,
  );
  touchSession(session);
  await sendOperationLog(session.threadId, "run.start", [
    `- run_sequence=${runSequence}`,
    `- triggered_by=${triggeredByUserId}`,
    `- prompt_length=${prompt.length}`,
    `- attachments=${attachmentNames.length > 0 ? attachmentNames.join(", ") : "none"}`,
    `- bot_mode=${BOT_MODE}`,
    `- infrastructure=${getInfrastructureStatusMessage()}`,
  ]);
  let stopTyping: (() => void) | undefined;
  const startTyping = (): void => {
    if (stopTyping) {
      stopTyping();
    }
    stopTyping = startTypingLoop(session.threadId);
  };
  const clearTyping = (): void => {
    if (!stopTyping) {
      return;
    }

    stopTyping();
    stopTyping = undefined;
  };

  try {
    const discordContext = await resolveDiscordContextPayloadForRun(session);
    if (attachmentNames.length > 0) {
      await sendToThread(
        session.threadId,
        `📎 添付ファイル: ${attachmentNames.map((name) => `\`${name}\``).join(", ")}`,
      );
    }

    let toolCalls: GatewayAgentToolCall[] = [];
    if (IS_MOCK_MODE) {
      const parsedToolCalls = buildAgentToolCalls(prompt);
      if (parsedToolCalls.errors.length > 0) {
        setSessionStatus(session, "idle_waiting", "invalid tool directive");
        touchSession(session);
        await sendToThread(
          session.threadId,
          [
            "⚠️ ツール指定の解析に失敗しました。",
            "形式: `#tool: <tool_name> <JSON object>` または `#host-read: <path>`",
            ...parsedToolCalls.errors.slice(0, 3).map((error) => `- ${error}`),
          ].join("\n"),
        );
        return;
      }
      toolCalls = parsedToolCalls.toolCalls;
      if (toolCalls.length > 0) {
        await sendToThread(
          session.threadId,
          `🧪 ツール実行デモを開始します: ${formatToolCallSummary(toolCalls)}`,
        );
        await sendOperationLog(session.threadId, "run.mock.tool_calls", [
          ...toolCalls.map(
            (toolCall, index) =>
              `- [${index + 1}] ${toolCall.toolName} target=${toolCall.executionTarget ?? "gateway_adapter"} args=${toOperationLogJson(toolCall.arguments, BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`,
          ),
        ]);
      }
    }

    if (isRunCanceled(session, runSequence)) {
      throw new SessionRunCanceledError("run canceled before agent execution");
    }

    startTyping();
    const terminal = await waitForAgentTaskWithToolProgress(
      session,
      prompt,
      attachments,
      toolCalls,
      discordContext,
      runSequence,
    );
    clearTyping();
    await syncPendingApprovalResolution(session, terminal);

    if (terminal.agentTask.status === "canceled") {
      updateRuntimeFeedbackFromTerminalStatus(session, "canceled", []);
      throw new SessionRunCanceledError("agent runtime canceled the task");
    }
    if (terminal.agentTask.status === "failed") {
      const runtimeError = terminal.agentTask.error?.message ?? "agent runtime failed";
      updateRuntimeFeedbackFromTerminalStatus(session, "failed", []);
      updateRuntimeFeedbackRetryHint(
        session,
        `previous runtime failure: ${runtimeError}`,
      );
      throw new Error(runtimeError);
    }
    const runtimeResult = terminal.agentTask.result;
    const deliveredFiles = extractDeliveredFilesFromToolResults(
      runtimeResult?.tool_results ?? [],
    );
    if (deliveredFiles.length > 0) {
      await sendDeliveredFilesToThread(session.threadId, deliveredFiles);
    }
    const toolErrors = summarizeToolErrors(runtimeResult?.tool_results ?? []);

    const rawLmMessage = runtimeResult?.final_answer ?? prompt ?? "(empty prompt)";
    await sendOperationLog(session.threadId, "run.final_answer", [
      `- length=${rawLmMessage.length}`,
      `- preview=${truncateOperationLogValue(rawLmMessage, BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`,
    ]);
    await relayLmMessage(session.threadId, rawLmMessage);
    updateRuntimeFeedbackFromTerminalStatus(session, "completed", toolErrors);
    setSessionStatus(session, "idle_waiting", "agent run completed");
    clearToolProgressMessagesForSession(session.id);
    touchSession(session);
  } catch (error) {
    clearTyping();
    await sendOperationLog(session.threadId, "run.error", buildGatewayApiErrorLogLines(error));
    if (error instanceof SessionRunCanceledError || isRunCanceled(session, runSequence)) {
      if (
        session.runtimeFeedback.previousTaskTerminalStatus === undefined ||
        session.runtimeFeedback.previousTaskTerminalStatus === "completed"
      ) {
        updateRuntimeFeedbackFromTerminalStatus(session, "canceled", []);
      }
      clearToolProgressMessagesForSession(session.id);
      setSessionStatus(session, "idle_waiting", "run canceled");
      touchSession(session);
      await sendToThread(session.threadId, "🛑 タスクはキャンセルされました。");
      return;
    }
    if (
      session.runtimeFeedback.previousTaskTerminalStatus === undefined ||
      session.runtimeFeedback.previousTaskTerminalStatus === "completed"
    ) {
      updateRuntimeFeedbackFromTerminalStatus(session, "failed", []);
      updateRuntimeFeedbackRetryHint(
        session,
        `previous run failed: ${summarizeError(error)}`,
      );
    }
    setSessionStatus(session, "failed", summarizeError(error));
    clearToolProgressMessagesForSession(session.id);
    touchSession(session);
    await sendToThread(
      session.threadId,
      "❌ 実行中にエラーが発生しました。少し待ってから再試行してください。",
    );
    console.error(`${LOG_PREFIX} run failed`, error);
  } finally {
    clearTyping();
    runningSessionIds.delete(session.id);

    const queuedRun = sessionsById.get(session.id)?.queuedRun;
    if (
      queuedRun &&
      session.status !== "closed_by_user" &&
      !runningSessionIds.has(session.id)
    ) {
      session.queuedRun = undefined;
      void runAgentTask(
        session,
        queuedRun.prompt,
        queuedRun.attachments,
        queuedRun.triggeredByUserId,
      ).catch((error: unknown) => {
        console.error(`${LOG_PREFIX} queued resume failed`, error);
      });
    }
  }
}

async function handleApprovalButton(interaction: ButtonInteraction): Promise<void> {
  const [prefix, approvalId, action] = interaction.customId.split(":");
  if (prefix !== "approval" || !approvalId || !action) {
    return;
  }

  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    await interaction.reply({
      content: "この承認は既に処理済みか期限切れです。",
      ephemeral: true,
    });
    return;
  }

  const session = sessionsById.get(pending.sessionId);
  if (!session) {
    settleApproval(approvalId);
    await interaction.reply({
      content: "対応するセッションが見つかりません。",
      ephemeral: true,
    });
    return;
  }

  if (interaction.user.id !== session.ownerUserId) {
    await interaction.reply({
      content: "この承認はセッション作成者のみ操作できます。",
      ephemeral: true,
    });
    return;
  }

  const decision: "approved" | "rejected" =
    action === "approve" ? "approved" : "rejected";
  try {
    await gatewayApiRequest(
      "POST",
      `/v1/approvals/${approvalId}/respond`,
      {
        userId: interaction.user.id,
        decision,
      },
    );
  } catch (error) {
    console.error(`${LOG_PREFIX} approval response sync failed`, error);
    await interaction.reply({
      content: buildApprovalSyncFailureMessageContent(pending, error),
      ephemeral: true,
    });
    return;
  }

  if (!settleApproval(approvalId)) {
    await interaction.reply({
      content: "この承認は既に処理済みか期限切れです。",
      ephemeral: true,
    });
    return;
  }

  await interaction.update({
    content: buildApprovalResultMessageContent({
      toolName: pending.request.toolName,
      operationCode: pending.request.operationCode,
      target: pending.request.target,
      targetLine: pending.request.targetLine,
      decision,
    }),
    components: [],
    embeds: [],
    files: [],
  });

  touchSession(session);
}

function cancelSession(session: MockSession, by: Snowflake): void {
  session.cancelRequested = true;
  clearToolProgressMessagesForSession(session.id);
  updateRuntimeFeedbackFromTerminalStatus(session, "canceled", []);
  updateRuntimeFeedbackRetryHint(session, `canceled by <@${by}>`);
  setSessionStatus(session, "idle_waiting", `task canceled by <@${by}>`);

  if (session.pendingApprovalId) {
    settleApproval(session.pendingApprovalId);
    session.pendingApprovalId = undefined;
  }

  touchSession(session);
}

function closeSession(session: MockSession, by: Snowflake): void {
  session.cancelRequested = true;
  clearToolProgressMessagesForSession(session.id);
  clearRuntimeFeedback(session);
  setSessionStatus(session, "closed_by_user", `closed by <@${by}>`);

  if (session.pendingApprovalId) {
    settleApproval(session.pendingApprovalId);
    session.pendingApprovalId = undefined;
  }

  clearIdleTimer(session.id);
}

function formatSessionControlMessage(command: "/close" | "/exit" | "/reboot"): string {
  return `⚠️ \`${command}\` を受け付けました。セッションを終了します。`;
}

function formatSessionResumeMessage(): string {
  return "▶️ `/resume` でセッションを再開しました。メッセージを送ると処理を再開します。";
}

async function closeAllSessions(by: Snowflake): Promise<number> {
  let closedCount = 0;
  for (const session of sessionsById.values()) {
    if (session.status === "closed_by_user") {
      continue;
    }

    try {
      await syncCloseWithGateway(session, by);
    } catch (error) {
      console.error(`${LOG_PREFIX} close sync failed during system control`, error);
    }
    closeSession(session, by);
    closedCount += 1;
  }

  return closedCount;
}

async function executeSystemControl(
  mode: SystemControlMode,
  requestedBy: Snowflake,
  notify: (content: string) => Promise<unknown>,
): Promise<void> {
  if (isSystemControlPending) {
    await notify("⚠️ すでに終了処理中です。");
    return;
  }

  isSystemControlPending = true;
  const closedCount = await closeAllSessions(requestedBy);

  await notify(formatSessionControlMessage(`/${mode}`));
  await sendSystemAlert(
    `⚠️ [${ALERT_TAG}:control] /${mode} requested by <@${requestedBy}> ` +
      `(closed_sessions: ${closedCount})`,
  );

  const shutdownOptions: RuntimeSupervisorShutdownOptions = {
    stopCompose: ORCHESTRATOR_ENABLED,
  };
  try {
    await shutdownInfrastructure(shutdownOptions);
  } catch (error) {
    console.error(`${LOG_PREFIX} infrastructure shutdown failed`, error);
  }

  if (mode === "reboot") {
    try {
      await rebootInProcess();
      return;
    } catch (error) {
      isSystemControlPending = false;
      throw error;
    }
  }

  try {
    await setOfflineImmediately();
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to set offline during exit`, error);
  }

  setTimeout(() => {
    process.exit(0);
  }, 50);
}

async function syncResumeWithGateway(
  session: MockSession,
  userId: Snowflake,
): Promise<void> {
  await sendOperationLog(session.threadId, "gateway.resume.request", [
    `- session_id=${session.gatewaySessionId ?? "unknown"}`,
    `- task_id=${session.currentTaskId ?? "none"}`,
    `- user_id=${userId}`,
  ]);
  await gatewayApiRequest("POST", `/v1/threads/${session.threadId}/resume`, {
    userId,
  });
  await sendOperationLog(session.threadId, "gateway.resume.thread", [
    `- thread_id=${session.threadId}`,
    "- status=accepted",
  ]);
}

async function startSessionFromMention(message: Message): Promise<void> {
  if (!message.inGuild() || !client.user) {
    return;
  }

  if (!isInfrastructureReady()) {
    await message.reply(buildInfrastructureNotReadyMessage());
    return;
  }

  const prompt = extractPromptFromMention(message, client.user.id);
  const attachments = buildAttachmentSources(message.attachments);
  const attachmentNames = attachments.map((attachment) => attachment.name);

  if (!prompt && attachmentNames.length === 0) {
    await message.reply(
      "開始するには、メンションに続けてプロンプトか添付を指定してください。",
    );
    return;
  }

  const threadName = `task-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
  const thread = await message.startThread({
    name: threadName,
    autoArchiveDuration: 60,
    reason: "Discord UX mock session",
  });

  const now = new Date();
  const channelName = message.channel?.isTextBased()
    ? (message.channel as { name?: string }).name
    : undefined;
  const session: MockSession = {
    id: newId("ses"),
    ownerUserId: message.author.id,
    ownerUsername: message.author.username,
    ownerNickname: message.member?.nickname ?? message.member?.displayName ?? undefined,
    channelId: message.channelId,
    channelName: channelName && channelName.trim().length > 0 ? channelName : undefined,
    threadId: thread.id,
    threadName: thread.name,
    status: "running",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    idleDeadlineAt: new Date(now.getTime() + IDLE_TIMEOUT_SEC * 1000),
    runSequence: 0,
    cancelRequested: false,
    lastEvent: "session created from mention",
    runtimeFeedback: createRuntimeFeedbackState(),
    lastTaskEventTimestamp: undefined,
    lastToolEventTimestamp: undefined,
  };

  sessionsById.set(session.id, session);
  sessionIdByThreadId.set(thread.id, session.id);
  attachSessionToUser(session);
  touchSession(session);
  await addReviewedReaction(message);
  await runAgentTask(session, prompt, attachments, message.author.id);
}

async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const { commandName } = interaction;
  if (commandName === "list") {
    await interaction.reply({
      embeds: [buildListEmbed(interaction.user.id)],
      ephemeral: true,
    });
    return;
  }

  if (commandName === "exit") {
    await executeSystemControl("exit", interaction.user.id, (content) =>
      interaction.reply({ content }),
    );
    return;
  }

  if (commandName === "reboot") {
    await executeSystemControl("reboot", interaction.user.id, (content) =>
      interaction.reply({ content }),
    );
    return;
  }

  if (!isThreadChannel(interaction.channel)) {
    await interaction.reply({
      content: "このコマンドはセッションスレッド内で実行してください。",
      ephemeral: true,
    });
    return;
  }

  const thread = interaction.channel;
  let session = resolveSessionByThreadId(thread.id);
  if (!session) {
    try {
      session = await restoreSessionFromGatewayThread({
        thread,
        requesterUserId: interaction.user.id,
      });
    } catch (error) {
      console.error(`${LOG_PREFIX} session restore failed`, error);
      await interaction.reply({
        content:
          "Gateway API からセッション状態の復元に失敗しました。しばらく待ってから再試行してください。",
        ephemeral: true,
      });
      return;
    }
  }

  if (!session) {
    await interaction.reply({
      content: "このスレッドに対応するセッションが見つかりません。",
      ephemeral: true,
    });
    return;
  }

  if (interaction.user.id !== session.ownerUserId) {
    await interaction.reply({
      content: "このセッションは作成者のみ操作できます。",
      ephemeral: true,
    });
    return;
  }

  touchSession(session);

  if (!isInfrastructureReady()) {
    await interaction.reply({
      content: buildInfrastructureNotReadyMessage(),
      ephemeral: true,
    });
    return;
  }

  if (commandName === "status") {
    try {
      await refreshSessionFromGateway(session);
    } catch (error) {
      console.error(`${LOG_PREFIX} status sync failed`, error);
    }
    await interaction.reply({
      embeds: [buildStatusEmbed(session)],
      ephemeral: true,
    });
    return;
  }

  if (commandName === "cancel") {
    try {
      await syncCancelWithGateway(session, interaction.user.id);
    } catch (error) {
      console.error(`${LOG_PREFIX} cancel sync failed`, error);
      await interaction.reply({
        content:
          "Gateway API へのキャンセル反映に失敗しました。しばらく待ってから再試行してください。",
        ephemeral: true,
      });
      return;
    }

    cancelSession(session, interaction.user.id);
    await interaction.reply({ content: "🛑 タスクをキャンセルしました。" });
    return;
  }

  if (commandName === "close") {
    try {
      await syncCloseWithGateway(session, interaction.user.id);
    } catch (error) {
      console.error(`${LOG_PREFIX} close sync failed`, error);
      await interaction.reply({
        content:
          "Gateway API へのクローズ反映に失敗しました。しばらく待ってから再試行してください。",
        ephemeral: true,
      });
      return;
    }

    closeSession(session, interaction.user.id);
    await interaction.reply({ content: formatSessionControlMessage("/close") });
  } else if (commandName === "resume") {
    try {
      await syncResumeWithGateway(session, interaction.user.id);
      await refreshSessionFromGateway(session);
    } catch (error) {
      const errorCode = readGatewayApiErrorCode(error);
      console.error(`${LOG_PREFIX} resume sync failed`, error);
      if (errorCode === "session_not_resumable") {
        await interaction.reply({
          content:
            "このセッションはすでに稼働中です。必要なら `/status` で状態を確認してください。",
          ephemeral: true,
        });
        return;
      }
      if (errorCode === "session_not_found") {
        await interaction.reply({
          content:
            "このスレッドに対応する Gateway セッションが見つかりませんでした。新しく開始してください。",
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({
        content:
          "Gateway API への再開反映に失敗しました。しばらく待ってから再試行してください。",
        ephemeral: true,
      });
      return;
    }

    clearRuntimeFeedback(session);
    clearToolProgressMessagesForSession(session.id);
    session.cancelRequested = false;
    session.queuedRun = undefined;
    session.runSequence += 1;
    session.pendingApprovalId = undefined;
    setSessionStatus(session, "idle_waiting", `resumed by <@${interaction.user.id}>`);
    touchSession(session);
    await interaction.reply({ content: formatSessionResumeMessage() });
  } else {
    await interaction.reply({
      content: "未対応のコマンドです。",
      ephemeral: true,
    });
  }
}

async function handleThreadMessage(message: Message): Promise<void> {
  if (!isThreadChannel(message.channel)) {
    return;
  }

  const thread = message.channel;
  let session = resolveSessionByThreadId(thread.id);
  if (!session) {
    try {
      session = await restoreSessionFromGatewayThread({
        thread,
        requesterUserId: message.author.id,
      });
    } catch (error) {
      console.error(`${LOG_PREFIX} session restore failed for message`, error);
      await message.reply(
        "Gateway API からセッション状態の復元に失敗しました。しばらく待ってから再試行してください。",
      );
      return;
    }
    if (!session) {
      return;
    }
  }

  if (message.author.id !== session.ownerUserId) {
    return;
  }

  if (!isInfrastructureReady()) {
    await message.reply(buildInfrastructureNotReadyMessage());
    return;
  }

  touchSession(session);
  session.ownerUsername = message.author.username;
  session.ownerNickname = message.member?.nickname ?? message.member?.displayName ?? undefined;
  session.threadName = message.channel.name;
  const parentName = message.channel.parent?.name;
  if (parentName && parentName.trim().length > 0) {
    session.channelName = parentName;
  }

  if (session.status === "closed_by_user") {
    await message.reply("このセッションは `/close` で終了済みです。");
    return;
  }

  if (shouldBlockNewInputWhileActive(session)) {
    await message.reply("現在実行中です。完了を待ってから再送してください。");
    return;
  }

  const prompt = message.content.trim();
  const attachments = buildAttachmentSources(message.attachments);
  const attachmentNames = attachments.map((attachment) => attachment.name);

  if (!prompt && attachmentNames.length === 0) {
    await message.reply("プロンプトか添付を指定してください。");
    return;
  }

  await addReviewedReaction(message);

  if (session.status === "idle_paused") {
    await message.reply("▶️ セッションを自動再開します。");
  }

  await runAgentTask(session, prompt, attachments, message.author.id);
}

async function handleClientReady(readyClient: Client<true>): Promise<void> {
  const startupMessage =
    `[bot:${BOT_MODE}] Logged in as ${readyClient.user.tag} | ` +
    `idle=${IDLE_TIMEOUT_SEC}s | ` +
    `agent_inactive_timeout=${AGENT_STATUS_TIMEOUT_SEC}s | infra=${getInfrastructureStatusMessage()}`;
  console.log(startupMessage);
  await sendSystemAlert(`🟢 ${startupMessage}`);

  if (ORCHESTRATOR_ENABLED) {
    if (runtimeSupervisor) {
      runtimeInfrastructureStatus = "ready";
    } else {
      try {
        await bootInfrastructure();
      } catch (error) {
        console.error(`${LOG_PREFIX} orchestrator boot failed`, error);
        await gracefulTerminateFromInfrastructureFailure(
          `boot failed: ${summarizeError(error)}`,
        );
      }
    }
  } else {
    runtimeInfrastructureStatus = "ready";
  }

  if (isSystemControlPending) {
    isSystemControlPending = false;
    await sendSystemAlert(`🟢 [${ALERT_TAG}:control] reboot completed.`);
  }
}

function registerClientEventHandlers(): void {
  client.on(Events.ClientReady, (readyClient) => {
    void handleClientReady(readyClient).catch((error: unknown) => {
      void reportRuntimeError("ready handler failed", error);
    });
  });

  client.on(Events.MessageCreate, (message) => {
    void (async () => {
      if (message.author.bot || !client.user) {
        return;
      }
      if (!markEventIfNew(recentlySeenMessageIds, message.id)) {
        return;
      }

      if (
        message.inGuild() &&
        message.mentions.users.has(client.user.id) &&
        !message.channel.isThread()
      ) {
        await startSessionFromMention(message);
        return;
      }

      await handleThreadMessage(message);
    })().catch((error: unknown) => {
      void reportRuntimeError("message handler failed", error);
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      if (!markEventIfNew(recentlySeenInteractionIds, interaction.id)) {
        return;
      }
      if (interaction.isButton()) {
        await handleApprovalButton(interaction);
        return;
      }

      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction);
      }
    })().catch((error: unknown) => {
      void reportRuntimeError("interaction handler failed", error);
    });
  });

  client.on(Events.Error, (error) => {
    void reportRuntimeError("client error event", error);
  });
}

process.on("unhandledRejection", (reason: unknown) => {
  void reportRuntimeError("unhandledRejection", reason);
});

process.on("uncaughtException", (error: Error) => {
  void reportRuntimeError("uncaughtException", error).finally(() => {
    process.exit(1);
  });
});

process.once("SIGTERM", () => {
  void (async () => {
    await shutdownInfrastructure();
    process.exit(0);
  })().catch((error: unknown) => {
    console.error(`${LOG_PREFIX} SIGTERM shutdown failed`, error);
    process.exit(1);
  });
});

process.once("SIGINT", () => {
  void (async () => {
    await shutdownInfrastructure();
    process.exit(0);
  })().catch((error: unknown) => {
    console.error(`${LOG_PREFIX} SIGINT shutdown failed`, error);
    process.exit(1);
  });
});

registerClientEventHandlers();
void client.login(DISCORD_BOT_TOKEN);
