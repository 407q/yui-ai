export type GatewayLogLevel = "debug" | "info" | "warn" | "error";

export type GatewayHop = "G2A" | "A2M" | "INT";

export interface GatewaySummaryLogEvent {
  level?: GatewayLogLevel;
  hop?: GatewayHop;
  event: string;
  traceId: string;
  summary: string;
  status?: string;
  latencyMs?: number;
}

export interface GatewaySummaryLoggerOptions {
  level: GatewayLogLevel;
  enabled: boolean;
  maxChars: number;
}

const LEVEL_PRIORITY: Record<GatewayLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_OPTIONS: GatewaySummaryLoggerOptions = {
  level: "info",
  enabled: true,
  maxChars: 160,
};

export class GatewaySummaryLogger {
  private readonly options: GatewaySummaryLoggerOptions;

  constructor(options?: Partial<GatewaySummaryLoggerOptions>) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  log(input: GatewaySummaryLogEvent): void {
    if (!this.options.enabled) {
      return;
    }
    const level = input.level ?? "info";
    if (!shouldEmit(this.options.level, level)) {
      return;
    }
    const hop = input.hop ?? "INT";
    const event = toEventLabel(input.event);
    const status = input.status ?? defaultStatus(level);
    const latencyMs = input.latencyMs ?? 0;
    const line = truncate(
      `[${hop}][${event}][trace=${input.traceId}] ${input.summary} | ${status} ${latencyMs}ms`,
      this.options.maxChars,
    );
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
}

export function createGatewaySummaryLoggerFromEnv(): GatewaySummaryLogger {
  return new GatewaySummaryLogger({
    level: resolveLogLevel(process.env.GATEWAY_LOG_LEVEL),
    enabled: parseBooleanEnvFlag(process.env.GATEWAY_CONSOLE_SUMMARY, true),
    maxChars: resolvePositiveInt(process.env.GATEWAY_CONSOLE_SUMMARY_MAX_CHARS, 160),
  });
}

export const NOOP_GATEWAY_LOGGER: Pick<GatewaySummaryLogger, "log"> = {
  log: () => undefined,
};

function shouldEmit(minLevel: GatewayLogLevel, candidate: GatewayLogLevel): boolean {
  return LEVEL_PRIORITY[candidate] >= LEVEL_PRIORITY[minLevel];
}

function resolveLogLevel(raw: string | undefined): GatewayLogLevel {
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

function defaultStatus(level: GatewayLogLevel): string {
  if (level === "error") {
    return "error";
  }
  if (level === "warn") {
    return "warn";
  }
  return "ok";
}

function toEventLabel(event: string): string {
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
