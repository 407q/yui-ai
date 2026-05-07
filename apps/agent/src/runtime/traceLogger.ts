import { promises as fs } from "node:fs";
import path from "node:path";

export type TraceLogLevel = "debug" | "info" | "warn" | "error";

export type TraceActor = "gateway" | "agent" | "copilot_sdk" | "lm";

export type TraceDirection = "inbound" | "outbound" | "internal";

export type TraceHop = "G2A" | "A2S" | "S2L" | "A2M" | "INT";

export interface AgentTraceEvent {
  level?: TraceLogLevel;
  actor: TraceActor;
  event: string;
  trace_id: string;
  session_id: string;
  task_id: string;
  sdk_session_id?: string;
  call_id?: string;
  direction?: TraceDirection;
  peer?: string;
  status?: string;
  latency_ms?: number;
  hop?: TraceHop;
  summary?: string;
  payload?: Record<string, unknown>;
  error?: {
    code?: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface AgentTraceLoggerOptions {
  level: TraceLogLevel;
  consoleSummaryEnabled: boolean;
  traceLogPath: string;
  includePayload: boolean;
  redactKeys: string[];
  summaryMaxChars: number;
}

export interface AgentTraceLoggerLike {
  log(event: AgentTraceEvent): void;
}

interface AgentTraceLogEntry {
  ts: string;
  level: TraceLogLevel;
  actor: TraceActor;
  event: string;
  trace_id: string;
  session_id: string;
  task_id: string;
  sdk_session_id?: string;
  call_id?: string;
  direction?: TraceDirection;
  peer?: string;
  status?: string;
  latency_ms?: number;
  summary?: string;
  error?: {
    code?: string;
    message: string;
    details?: Record<string, unknown>;
  };
  payload_keys?: string[];
  payload?: Record<string, unknown>;
}

const LEVEL_PRIORITY: Record<TraceLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_TRACE_LOGGER_OPTIONS: AgentTraceLoggerOptions = {
  level: "info",
  consoleSummaryEnabled: true,
  traceLogPath: "/var/log/yui-ai/agent-trace.jsonl",
  includePayload: false,
  redactKeys: ["token", "authorization", "secret", "password"],
  summaryMaxChars: 140,
};

export class AgentTraceLogger implements AgentTraceLoggerLike {
  private readonly options: AgentTraceLoggerOptions;
  private writeQueue: Promise<void> = Promise.resolve();
  private traceSinkEnabled = true;
  private traceSinkWarned = false;

  constructor(options?: Partial<AgentTraceLoggerOptions>) {
    this.options = {
      ...DEFAULT_TRACE_LOGGER_OPTIONS,
      ...options,
    };
  }

  log(event: AgentTraceEvent): void {
    const level = event.level ?? "info";
    if (!shouldEmitLog(this.options.level, level)) {
      return;
    }

    const entry = this.toEntry(event, level);
    if (this.options.consoleSummaryEnabled) {
      this.emitSummaryLine(event, level);
    }
    this.appendJsonEntry(entry);
  }

  private toEntry(event: AgentTraceEvent, level: TraceLogLevel): AgentTraceLogEntry {
    const payload = event.payload ? sanitizeValue(event.payload, this.options.redactKeys) : undefined;
    const summary =
      event.summary && event.summary.trim().length > 0
        ? truncate(event.summary.trim(), this.options.summaryMaxChars)
        : undefined;
    return {
      ts: new Date().toISOString(),
      level,
      actor: event.actor,
      event: event.event,
      trace_id: event.trace_id,
      session_id: event.session_id,
      task_id: event.task_id,
      sdk_session_id: event.sdk_session_id,
      call_id: event.call_id,
      direction: event.direction,
      peer: event.peer,
      status: event.status,
      latency_ms: event.latency_ms,
      summary,
      error: event.error
        ? {
            ...event.error,
            details: event.error.details
              ? sanitizeValue(event.error.details, this.options.redactKeys)
              : undefined,
          }
        : undefined,
      payload_keys: payload ? Object.keys(payload).sort() : undefined,
      payload: this.options.includePayload ? payload : undefined,
    };
  }

  private emitSummaryLine(event: AgentTraceEvent, level: TraceLogLevel): void {
    const hop = event.hop ?? "INT";
    const eventLabel = toSummaryEventLabel(event.event);
    const summary = event.summary && event.summary.trim().length > 0 ? event.summary.trim() : "-";
    const status = event.status ?? inferStatusFromLevel(level);
    const latency = event.latency_ms ?? 0;
    const raw = `[${hop}][${eventLabel}][trace=${event.trace_id}] ${summary} | ${status} ${latency}ms`;
    const line = truncate(raw, this.options.summaryMaxChars);
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  }

  private appendJsonEntry(entry: AgentTraceLogEntry): void {
    if (!this.traceSinkEnabled) {
      return;
    }
    const line = `${JSON.stringify(entry)}\n`;
    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.mkdir(path.dirname(this.options.traceLogPath), { recursive: true });
        await fs.appendFile(this.options.traceLogPath, line, "utf8");
      })
      .catch((error: unknown) => {
        this.traceSinkEnabled = false;
        if (this.traceSinkWarned) {
          return;
        }
        this.traceSinkWarned = true;
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[agent-trace] failed to append trace log at ${this.options.traceLogPath}: ${message}`,
        );
      });
  }
}

export class NoopTraceLogger implements AgentTraceLoggerLike {
  log(_event: AgentTraceEvent): void {}
}

export function createAgentTraceLoggerFromEnv(): AgentTraceLogger {
  return new AgentTraceLogger({
    level: resolveTraceLogLevel(process.env.AGENT_LOG_LEVEL),
    consoleSummaryEnabled: parseBooleanEnvFlag(process.env.AGENT_CONSOLE_SUMMARY, true),
    traceLogPath:
      process.env.AGENT_TRACE_LOG_PATH?.trim() && process.env.AGENT_TRACE_LOG_PATH.trim().length > 0
        ? process.env.AGENT_TRACE_LOG_PATH.trim()
        : DEFAULT_TRACE_LOGGER_OPTIONS.traceLogPath,
    includePayload: parseBooleanEnvFlag(process.env.AGENT_LOG_INCLUDE_PAYLOAD, false),
    redactKeys: resolveRedactKeys(process.env.AGENT_LOG_REDACT_KEYS),
    summaryMaxChars: resolvePositiveInt(process.env.AGENT_CONSOLE_SUMMARY_MAX_CHARS, 140),
  });
}

function resolveTraceLogLevel(raw: string | undefined): TraceLogLevel {
  if (!raw) {
    return "info";
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error"
  ) {
    return normalized;
  }
  return "info";
}

function resolveRedactKeys(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [...DEFAULT_TRACE_LOGGER_OPTIONS.redactKeys];
  }
  const tokens = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (tokens.length === 0) {
    return [...DEFAULT_TRACE_LOGGER_OPTIONS.redactKeys];
  }
  return [...new Set(tokens)];
}

function sanitizeValue(
  value: Record<string, unknown>,
  redactKeys: string[],
): Record<string, unknown> {
  const lowered = redactKeys.map((entry) => entry.toLowerCase());
  return sanitizeUnknown(value, lowered) as Record<string, unknown>;
}

function sanitizeUnknown(value: unknown, redactKeys: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item, redactKeys));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    const keyLower = key.toLowerCase();
    const shouldRedact = redactKeys.some((token) => keyLower.includes(token));
    sanitized[key] = shouldRedact ? "***" : sanitizeUnknown(entryValue, redactKeys);
  }
  return sanitized;
}

function inferStatusFromLevel(level: TraceLogLevel): string {
  if (level === "error") {
    return "error";
  }
  if (level === "warn") {
    return "warn";
  }
  return "ok";
}

function shouldEmitLog(minLevel: TraceLogLevel, candidate: TraceLogLevel): boolean {
  return LEVEL_PRIORITY[candidate] >= LEVEL_PRIORITY[minLevel];
}

function toSummaryEventLabel(event: string): string {
  const parts = event.split(".");
  return parts[parts.length - 1] ?? event;
}

function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0 || value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function parseBooleanEnvFlag(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
