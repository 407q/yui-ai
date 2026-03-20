import "dotenv/config";
import path from "node:path";
import {
  ActionRowBuilder,
  AnyThreadChannel,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Channel,
  Client,
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

interface RuntimeFeedbackState {
  previousTaskTerminalStatus?: ContextEnvelopeTaskTerminalStatus;
  previousToolErrors: string[];
  retryHint?: string;
  attachmentSources: GatewayAttachmentSource[];
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

interface ToolApprovalRequest {
  tool: string;
  operationCode: string;
  operationLabel: string;
  target: string;
}

interface MockSession {
  id: string;
  ownerUserId: Snowflake;
  channelId: Snowflake;
  threadId: Snowflake;
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
}

interface PendingApproval {
  approvalId: string;
  sessionId: string;
  timeout: NodeJS.Timeout;
  resolve: (decision: ApprovalDecision) => void;
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
const ORCHESTRATOR_COMPOSE_BUILD =
  process.env.BOT_ORCHESTRATOR_COMPOSE_BUILD !== "false";
const ORCHESTRATOR_ENABLED = process.env.BOT_ORCHESTRATOR_ENABLED !== "false";

const IDLE_TIMEOUT_SEC = parsePositiveInt(process.env.BOT_IDLE_TIMEOUT_SEC, 600);
const APPROVAL_TIMEOUT_SEC = parsePositiveInt(
  process.env.BOT_APPROVAL_TIMEOUT_SEC,
  120,
);
const AGENT_STATUS_TIMEOUT_SEC = parsePositiveInt(
  process.env.BOT_AGENT_STATUS_TIMEOUT_SEC,
  180,
);
const AGENT_POLL_INTERVAL_MS = parsePositiveInt(
  process.env.BOT_AGENT_POLL_INTERVAL_MS,
  800,
);
const AGENT_APPROVAL_RETRY_MAX = parsePositiveInt(
  process.env.BOT_AGENT_APPROVAL_RETRY_MAX,
  3,
);
const TYPING_PULSE_MS = 7000;
const BOT_OPERATION_LOG_ENABLED = process.env.BOT_OPERATION_LOG_ENABLED !== "false";
const BOT_OPERATION_LOG_MAX_FIELD_CHARS = parsePositiveInt(
  process.env.BOT_OPERATION_LOG_MAX_FIELD_CHARS,
  320,
);
const BOT_OPERATION_LOG_MESSAGE_LIMIT = 1800;

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
const pendingApprovals = new Map<string, PendingApproval>();
const idleTimerBySessionId = new Map<string, NodeJS.Timeout>();
const runningSessionIds = new Set<string>();
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

interface GatewayApprovalRequestResponse {
  approval: {
    approvalId: string;
    status: string;
  };
  session: {
    sessionId: string;
    status: string;
  };
  task: {
    taskId: string;
    status: string;
  };
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
}

interface GatewayRunContextEnvelopePayload {
  behavior: {
    botMode: "standard" | "mock";
    sessionStatus: string;
    infrastructureStatus: "ready" | "booting" | "failed";
    toolRoutingPolicy: "gateway_only";
    approvalPolicy: "host_ops_require_explicit_approval";
    responseContract: "ja, concise, ask_when_ambiguous";
    executionContract: "no_external_mcp, no_unapproved_host_ops";
  };
  runtimeFeedback: {
    previousTaskTerminalStatus?: ContextEnvelopeTaskTerminalStatus;
    previousToolErrors: string[];
    retryHint?: string;
    attachmentSources: GatewayAttachmentSource[];
  };
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
    status: string;
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
  const response = await fetch(`${GATEWAY_API_BASE_URL}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: payload ? JSON.stringify(payload) : undefined,
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
    case "run.tool_results":
      return summarizeToolOperationLines(lines);
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

function summarizeToolOperationLines(lines: string[]): string[] {
  const operations = parseToolOperationSummaries(lines);
  if (operations.length === 0) {
    return [];
  }

  return operations
    .filter((operation) => !isSuppressedToolOperation(operation))
    .slice(0, 8)
    .map((operation) => {
      const statusEmoji = operation.status === "ok" ? "✅" : "❌";
      const toolEmoji = resolveToolEmoji(operation.toolName);
      const detail = resolveToolDetail(operation.toolName, operation.arguments);
      return detail
        ? `${toolEmoji} ${operation.toolName} ${detail} ${statusEmoji}`
        : `${toolEmoji} ${operation.toolName} ${statusEmoji}`;
    });
}

interface ToolOperationSummary {
  status: "ok" | "error";
  toolName: string;
  arguments: Record<string, unknown> | null;
  errorCode: string | null;
}

function parseToolOperationSummaries(lines: string[]): ToolOperationSummary[] {
  const operations: ToolOperationSummary[] = [];
  let current: ToolOperationSummary | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const summaryMatch = line.match(
      /^- \[\d+\] status=(ok|error) call_id=[^ ]+ tool=([^ ]+) target=[^ ]+$/,
    );
    if (summaryMatch) {
      const status = summaryMatch[1];
      const toolName = summaryMatch[2];
      if (!status || !toolName) {
        current = null;
        continue;
      }
      current = {
        status: status as "ok" | "error",
        toolName,
        arguments: null,
        errorCode: null,
      };
      operations.push({
        status: current.status,
        toolName: current.toolName,
        arguments: current.arguments,
        errorCode: current.errorCode,
      });
      continue;
    }

    if (current && line.startsWith("arguments=")) {
      current.arguments = parseOperationLogJson(line.slice("arguments=".length));
      continue;
    }
    if (current && line.startsWith("error=")) {
      const errorValue = line.slice("error=".length).trim();
      const errorCode = errorValue.split(":", 1)[0]?.trim() ?? null;
      current.errorCode = errorCode && errorCode.length > 0 ? errorCode : null;
      continue;
    }
  }

  return operations;
}

function isSuppressedToolOperation(operation: ToolOperationSummary): boolean {
  if (operation.status !== "error") {
    return false;
  }
  if (operation.errorCode === "approval_required") {
    return false;
  }
  return operation.errorCode === "approval_rejected" || operation.errorCode === "approval_timeout";
}

function parseOperationLogJson(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function resolveToolEmoji(toolName: string): string {
  if (toolName.endsWith("file_read")) {
    return "📄";
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
  if (toolName === "host.http_request") {
    return "🌐";
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
  if (toolName.endsWith("file_read") || toolName.endsWith("file_write") || toolName.endsWith("file_delete") || toolName.endsWith("file_list")) {
    return readString(args, "path");
  }
  if (toolName.endsWith("cli_exec")) {
    return readString(args, "command");
  }
  if (toolName === "host.http_request") {
    return readString(args, "url");
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

async function ensureGatewayTaskForRun(
  session: MockSession,
  prompt: string,
  attachmentNames: string[],
): Promise<void> {
  if (!session.gatewaySessionId) {
    await sendOperationLog(session.threadId, "gateway.mentions.start", [
      `- thread_id=${session.threadId}`,
      `- prompt_length=${prompt.length}`,
      `- attachments=${attachmentNames.length > 0 ? attachmentNames.join(", ") : "none"}`,
      `- request=${toOperationLogJson(
        {
          userId: session.ownerUserId,
          channelId: session.channelId,
          threadId: session.threadId,
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
        channelId: session.channelId,
        threadId: session.threadId,
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
        prompt,
        attachmentNames,
      },
      BOT_OPERATION_LOG_MAX_FIELD_CHARS,
    )}`,
  ]);
  const task = await gatewayApiRequest<GatewayThreadMessageResponse>(
    "POST",
    `/v1/threads/${session.threadId}/messages`,
    {
      userId: session.ownerUserId,
      prompt,
      attachmentNames,
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
): GatewayRunContextEnvelopePayload {
  return {
    behavior: {
      botMode: inferBotModeForContextEnvelope(),
      sessionStatus: toContextEnvelopeSessionStatus(session.status),
      infrastructureStatus: inferInfrastructureStatusForContextEnvelope(),
      toolRoutingPolicy: "gateway_only",
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
  };
}

function buildRunRequestPayload(
  session: MockSession,
  prompt: string,
  attachments: GatewayAttachmentSource[],
  toolCalls: GatewayAgentToolCall[],
): GatewayRunRequestPayload {
  const attachmentNames = attachments.map((attachment) => attachment.name);
  return {
    taskId: session.currentTaskId ?? "",
    sessionId: session.gatewaySessionId ?? "",
    userId: session.ownerUserId,
    prompt,
    attachmentNames,
    contextEnvelope: buildRunContextEnvelopePayload(session, attachments),
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
): Promise<void> {
  const channel = await client.channels.fetch(threadId);
  if (!isThreadChannel(channel)) {
    return;
  }

  await channel.send(payload);
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
    gatewayApiHost: GATEWAY_API_HOST,
    gatewayApiPort: GATEWAY_API_PORT,
    agentRuntimeBaseUrl: AGENT_RUNTIME_BASE_URL,
    composeBuild: ORCHESTRATOR_COMPOSE_BUILD,
    monitorIntervalSec: ORCHESTRATOR_MONITOR_INTERVAL_SEC,
    failureThreshold: ORCHESTRATOR_FAILURE_THRESHOLD,
    commandTimeoutSec: ORCHESTRATOR_COMMAND_TIMEOUT_SEC,
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

  for (const approval of pendingApprovals.values()) {
    clearTimeout(approval.timeout);
    approval.resolve("canceled");
  }
  pendingApprovals.clear();

  sessionsById.clear();
  sessionIdByThreadId.clear();
  sessionIdsByUserId.clear();
  runningSessionIds.clear();
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
    settleApproval(session.pendingApprovalId, "canceled");
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

function settleApproval(approvalId: string, decision: ApprovalDecision): boolean {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timeout);
  pendingApprovals.delete(approvalId);
  pending.resolve(decision);
  return true;
}

function isRunCanceled(session: MockSession, runSequence: number): boolean {
  return session.cancelRequested || runSequence !== session.runSequence;
}

async function requestApproval(
  session: MockSession,
  request: ToolApprovalRequest,
): Promise<ApprovalDecision> {
  const gatewayApproval = await gatewayApiRequest<GatewayApprovalRequestResponse>(
    "POST",
    `/v1/threads/${session.threadId}/approvals/request`,
    {
      userId: session.ownerUserId,
      operation: request.operationCode,
      path: request.target,
    },
  );
  const approvalId = gatewayApproval.approval.approvalId;
  session.pendingApprovalId = approvalId;
  session.currentTaskId = gatewayApproval.task.taskId;
  setSessionStatus(
    session,
    "waiting_approval",
    `approval requested: ${request.tool} ${request.operationCode} ${request.target}`,
  );
  touchSession(session);

  const approvalEmbed = new EmbedBuilder()
    .setTitle("Tool Approval Request")
    .setDescription("以下の操作を実行してよいか確認してください。")
    .setColor(0xffb020)
    .addFields(
      { name: "使用したいツール", value: request.tool },
      { name: "行う操作", value: request.operationLabel },
      { name: "ターゲットとなる場所", value: request.target },
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approval:${approvalId}:approve`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`approval:${approvalId}:reject`)
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger),
  );

  await sendToThread(session.threadId, {
    content: `<@${session.ownerUserId}> 確認依頼です。`,
    embeds: [approvalEmbed],
    components: [row],
  });

  return new Promise<ApprovalDecision>((resolve) => {
    const timeout = setTimeout(() => {
      const unresolved = pendingApprovals.get(approvalId);
      if (!unresolved) {
        return;
      }

      pendingApprovals.delete(approvalId);
      session.pendingApprovalId = undefined;
      void gatewayApiRequest(
        "POST",
        `/v1/approvals/${approvalId}/respond`,
        {
          decision: "timeout",
        },
      ).catch((error: unknown) => {
        console.error(`${LOG_PREFIX} approval timeout sync failed`, error);
      });
      resolve("timeout");
    }, APPROVAL_TIMEOUT_SEC * 1000);

    pendingApprovals.set(approvalId, {
      approvalId,
      sessionId: session.id,
      timeout,
      resolve,
    });
  });
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

function resolveApprovalRequestFromResults(
  toolResults: unknown[],
  toolCalls: GatewayAgentToolCall[],
): ToolApprovalRequest | null {
  for (let index = 0; index < toolResults.length; index += 1) {
    const result = asRecord(toolResults[index]);
    if (!result) {
      continue;
    }

    if (result.status !== "error" || result.error_code !== "approval_required") {
      continue;
    }

    const details = asRecord(result.details);
    const toolCall = toolCalls[index];
    const operationCode =
      readString(details, "operation") ?? inferApprovalOperationFromToolCall(toolCall);
    const target =
      readString(details, "scope") ?? inferApprovalTargetFromToolCall(toolCall);
    if (!operationCode || !target) {
      continue;
    }

    return {
      tool: toolCall?.toolName ?? `host.${operationCode}`,
      operationCode,
      operationLabel: describeApprovalOperation(operationCode),
      target,
    };
  }

  return null;
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
    summaries.push(`${errorCode}: ${message}`);
  }
  return summaries;
}

function inferApprovalOperationFromToolCall(
  toolCall: GatewayAgentToolCall | undefined,
): string | null {
  switch (toolCall?.toolName) {
    case "host.file_read":
      return "read";
    case "host.file_write":
      return "write";
    case "host.file_delete":
      return "delete";
    case "host.file_list":
      return "list";
    case "host.cli_exec":
      return "exec";
    case "host.http_request":
      return "http_request";
    default:
      return null;
  }
}

function inferApprovalTargetFromToolCall(
  toolCall: GatewayAgentToolCall | undefined,
): string | null {
  if (!toolCall) {
    return null;
  }

  if (
    toolCall.toolName === "host.file_read" ||
    toolCall.toolName === "host.file_write" ||
    toolCall.toolName === "host.file_delete" ||
    toolCall.toolName === "host.file_list"
  ) {
    const filePath = readString(toolCall.arguments, "path");
    return filePath ? path.resolve(filePath) : null;
  }

  if (toolCall.toolName === "host.cli_exec") {
    return readString(toolCall.arguments, "command");
  }

  if (toolCall.toolName === "host.http_request") {
    const rawUrl = readString(toolCall.arguments, "url");
    if (!rawUrl) {
      return null;
    }
    try {
      return new URL(rawUrl).origin;
    } catch {
      return rawUrl;
    }
  }

  return null;
}

function describeApprovalOperation(operation: string): string {
  switch (operation) {
    case "read":
      return "ファイル内容の読み取り";
    case "write":
      return "ファイル内容の書き込み";
    case "delete":
      return "ファイル削除";
    case "list":
      return "ディレクトリ一覧取得";
    case "exec":
      return "CLI コマンド実行";
    case "http_request":
      return "HTTP リクエスト送信";
    default:
      return operation;
  }
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

function readRecord(
  record: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  return asRecord(record?.[key]);
}

function toToolResultStatus(value: unknown): "ok" | "error" | null {
  if (value === "ok" || value === "error") {
    return value;
  }
  return null;
}

function buildToolResultOperationLogLines(toolResults: unknown[]): string[] {
  if (toolResults.length === 0) {
    return ["- tool_results: none"];
  }

  const lines: string[] = [`- tool_results_count: ${toolResults.length}`];
  for (let index = 0; index < toolResults.length; index += 1) {
    const resultRecord = asRecord(toolResults[index]);
    if (!resultRecord) {
      lines.push(`- [${index + 1}] status=unknown raw=${toOperationLogJson(toolResults[index], BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`);
      continue;
    }

    const status = toToolResultStatus(resultRecord.status);
    const callId = readString(resultRecord, "call_id") ?? `call_${index + 1}`;
    const toolName = readString(resultRecord, "tool_name") ?? "unknown_tool";
    const executionTarget =
      readString(resultRecord, "execution_target") ?? "gateway_adapter";
    const reason = readString(resultRecord, "reason") ?? "-";
    const argumentsPayload = readRecord(resultRecord, "arguments") ?? {};
    lines.push(
      `- [${index + 1}] status=${status ?? "unknown"} call_id=${callId} tool=${toolName} target=${executionTarget}`,
    );
    lines.push(
      `  reason=${truncateOperationLogValue(reason, BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`,
    );
    lines.push(
      `  arguments=${toOperationLogJson(argumentsPayload, BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`,
    );

    if (status === "ok") {
      const resultPayload = readRecord(resultRecord, "result") ?? {};
      lines.push(
        `  result=${toOperationLogJson(resultPayload, BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`,
      );
      continue;
    }

    const errorCode = readString(resultRecord, "error_code") ?? "unknown_error";
    const message = readString(resultRecord, "message") ?? "unknown error";
    const details = readRecord(resultRecord, "details");
    lines.push(
      `  error=${errorCode}: ${truncateOperationLogValue(message, BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`,
    );
    if (details) {
      lines.push(
        `  details=${toOperationLogJson(details, BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`,
      );
    }
  }
  return lines;
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

async function waitForAgentTaskTerminalStatus(
  session: MockSession,
  taskId: string,
  runSequence: number,
): Promise<GatewayAgentTaskStatusResponse> {
  const deadline = Date.now() + AGENT_STATUS_TIMEOUT_SEC * 1000;
  let pollCount = 0;
  while (Date.now() <= deadline) {
    if (isRunCanceled(session, runSequence)) {
      throw new SessionRunCanceledError(
        "run canceled while waiting for agent status",
      );
    }

    const status = await gatewayApiRequest<GatewayAgentTaskStatusResponse>(
      "GET",
      `/v1/agent/tasks/${encodeURIComponent(taskId)}/status`,
    );
    session.gatewaySessionId = status.session.sessionId;
    session.currentTaskId = status.task.taskId;
    setSessionStatus(
      session,
      mapGatewaySessionStatus(status.session.status),
      `agent task ${status.agentTask.status}`,
    );
    pollCount += 1;

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

    await wait(AGENT_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Agent task status polling timed out after ${AGENT_STATUS_TIMEOUT_SEC} seconds.`,
  );
}

async function runAgentTaskAttempt(
  session: MockSession,
  prompt: string,
  attachments: GatewayAttachmentSource[],
  toolCalls: GatewayAgentToolCall[],
  runSequence: number,
): Promise<GatewayAgentTaskStatusResponse> {
  const attachmentNames = attachments.map((attachment) => attachment.name);
  await ensureGatewayTaskForRun(session, prompt, attachmentNames);
  if (!session.gatewaySessionId || !session.currentTaskId) {
    throw new Error("Gateway task is not initialized.");
  }

  const runPayload = buildRunRequestPayload(session, prompt, attachments, toolCalls);
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
  const status = await gatewayApiRequest<GatewayThreadStatusResponse>(
    "GET",
    `/v1/threads/${session.threadId}/status`,
  );
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

    let attempt = 0;
    let terminal: GatewayAgentTaskStatusResponse | null = null;
    while (attempt <= AGENT_APPROVAL_RETRY_MAX) {
      if (isRunCanceled(session, runSequence)) {
        throw new SessionRunCanceledError("run canceled before agent execution");
      }

      startTyping();
      terminal = await runAgentTaskAttempt(
        session,
        prompt,
        attachments,
        toolCalls,
        runSequence,
      );
      clearTyping();

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

      const approvalRequest = resolveApprovalRequestFromResults(
        terminal.agentTask.result?.tool_results ?? [],
        toolCalls,
      );
      if (!approvalRequest) {
        break;
      }

      if (attempt >= AGENT_APPROVAL_RETRY_MAX) {
        throw new Error(
          `approval retry limit reached (${AGENT_APPROVAL_RETRY_MAX})`,
        );
      }

      const approvalDecision = await requestApproval(session, approvalRequest);
      session.pendingApprovalId = undefined;
      touchSession(session);

      if (approvalDecision === "approved") {
        attempt += 1;
        updateRuntimeFeedbackRetryHint(
          session,
          "previous run stopped by approval_required; approved and retrying",
        );
        await sendToThread(
          session.threadId,
          "✅ 承認を確認しました。Agent 実行を再開します。",
        );
        continue;
      }

      if (approvalDecision === "rejected") {
        updateRuntimeFeedbackFromTerminalStatus(session, "failed", []);
        updateRuntimeFeedbackRetryHint(
          session,
          "approval rejected in previous attempt",
        );
        throw new Error("approval rejected");
      }
      if (approvalDecision === "timeout") {
        updateRuntimeFeedbackFromTerminalStatus(session, "failed", []);
        updateRuntimeFeedbackRetryHint(
          session,
          "approval timeout in previous attempt",
        );
        throw new Error("approval timeout");
      }
      updateRuntimeFeedbackFromTerminalStatus(session, "canceled", []);
      throw new SessionRunCanceledError("run canceled while waiting approval");
    }

    const runtimeResult = terminal?.agentTask.result;
    const toolResultLines = buildToolResultOperationLogLines(
      runtimeResult?.tool_results ?? [],
    );
    await sendOperationLog(session.threadId, "run.tool_results", toolResultLines);
    const toolErrors = summarizeToolErrors(runtimeResult?.tool_results ?? []);
    if (toolErrors.length > 0) {
      await sendToThread(
        session.threadId,
        `⚠️ ツール実行エラー: ${toolErrors.slice(0, 3).join(" | ")}`,
      );
    }

    const rawLmMessage = runtimeResult?.final_answer ?? prompt ?? "(empty prompt)";
    await sendOperationLog(session.threadId, "run.final_answer", [
      `- length=${rawLmMessage.length}`,
      `- preview=${truncateOperationLogValue(rawLmMessage, BOT_OPERATION_LOG_MAX_FIELD_CHARS)}`,
    ]);
    await relayLmMessage(session.threadId, rawLmMessage);
    updateRuntimeFeedbackFromTerminalStatus(session, "completed", toolErrors);
    setSessionStatus(session, "idle_waiting", "agent run completed");
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
    settleApproval(approvalId, "canceled");
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

  const decision: ApprovalDecision = action === "approve" ? "approved" : "rejected";
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
      content:
        "承認結果を Gateway API へ反映できませんでした。しばらく待ってから再試行してください。",
      ephemeral: true,
    });
    return;
  }

  if (!settleApproval(approvalId, decision)) {
    await interaction.reply({
      content: "この承認は既に処理済みか期限切れです。",
      ephemeral: true,
    });
    return;
  }

  await interaction.update({ components: [] });
  await interaction.followUp({
    content: decision === "approved" ? "✅ 承認しました。" : "❌ 拒否しました。",
  });

  touchSession(session);
}

function cancelSession(session: MockSession, by: Snowflake): void {
  session.cancelRequested = true;
  updateRuntimeFeedbackFromTerminalStatus(session, "canceled", []);
  updateRuntimeFeedbackRetryHint(session, `canceled by <@${by}>`);
  setSessionStatus(session, "idle_waiting", `task canceled by <@${by}>`);

  if (session.pendingApprovalId) {
    settleApproval(session.pendingApprovalId, "canceled");
    session.pendingApprovalId = undefined;
  }

  touchSession(session);
}

function closeSession(session: MockSession, by: Snowflake): void {
  session.cancelRequested = true;
  clearRuntimeFeedback(session);
  setSessionStatus(session, "closed_by_user", `closed by <@${by}>`);

  if (session.pendingApprovalId) {
    settleApproval(session.pendingApprovalId, "canceled");
    session.pendingApprovalId = undefined;
  }

  clearIdleTimer(session.id);
}

function formatSessionControlMessage(command: "/close" | "/exit" | "/reboot"): string {
  return `⚠️ \`${command}\` を受け付けました。セッションを終了します。`;
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
  const session: MockSession = {
    id: newId("ses"),
    ownerUserId: message.author.id,
    channelId: message.channelId,
    threadId: thread.id,
    status: "running",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    idleDeadlineAt: new Date(now.getTime() + IDLE_TIMEOUT_SEC * 1000),
    runSequence: 0,
    cancelRequested: false,
    lastEvent: "session created from mention",
    runtimeFeedback: createRuntimeFeedbackState(),
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

  const session = resolveSessionByThreadId(interaction.channel.id);
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

  const session = resolveSessionByThreadId(message.channel.id);
  if (!session) {
    return;
  }

  if (message.author.id !== session.ownerUserId) {
    return;
  }

  if (!isInfrastructureReady()) {
    await message.reply(buildInfrastructureNotReadyMessage());
    return;
  }

  touchSession(session);

  if (session.status === "closed_by_user") {
    await message.reply("このセッションは `/close` で終了済みです。");
    return;
  }

  if (session.status === "running" || session.status === "waiting_approval") {
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
    `idle=${IDLE_TIMEOUT_SEC}s | approval=${APPROVAL_TIMEOUT_SEC}s | ` +
    `agent_timeout=${AGENT_STATUS_TIMEOUT_SEC}s | infra=${getInfrastructureStatusMessage()}`;
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
