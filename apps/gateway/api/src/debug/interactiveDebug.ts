import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import {
  RuntimeSupervisor,
  type RuntimeHealthSnapshot,
} from "../orchestration/supervisor.js";
import { execCommand } from "../mcp/exec.js";

type ComponentKey =
  | "discord.bot"
  | "compose.agent"
  | "compose.postgres"
  | "db.migrate"
  | "gateway.api"
  | "orchestrator.monitor"
  | "orchestrator.cleanup";

type SettingKey =
  | "composeBuild"
  | "autoRecoveryEnabled"
  | "stopComposeOnExit"
  | "snapshotOnFailure"
  | "envDumpOnStart"
  | "monitorIntervalSec"
  | "failureThreshold"
  | "commandTimeoutSec"
  | "cleanupIntervalSec"
  | "internalConnectionMode"
  | "runtimeSocketDir"
  | "gatewayApiSocketPath"
  | "agentRuntimeSocketPath";

interface DebugComponents {
  "discord.bot": boolean;
  "compose.agent": boolean;
  "compose.postgres": boolean;
  "db.migrate": boolean;
  "gateway.api": boolean;
  "orchestrator.monitor": boolean;
  "orchestrator.cleanup": boolean;
}

interface DebugSettings {
  composeBuild: boolean;
  autoRecoveryEnabled: boolean;
  stopComposeOnExit: boolean;
  snapshotOnFailure: boolean;
  envDumpOnStart: boolean;
  monitorIntervalSec: number;
  failureThreshold: number;
  commandTimeoutSec: number;
  cleanupIntervalSec: number;
  internalConnectionMode: "tcp" | "uds";
  runtimeSocketDir: string;
  gatewayApiSocketPath: string;
  agentRuntimeSocketPath: string;
}

interface DebugConfig {
  components: DebugComponents;
  settings: DebugSettings;
}

type DebugEventLevel = "info" | "warn" | "error";

interface DebugEvent {
  timestamp: string;
  level: DebugEventLevel;
  scope: "preflight" | "runtime" | "system";
  command: string;
  message: string;
}

interface RuntimeFailureState {
  errorCounts: {
    ECONNREFUSED: number;
    EACCES: number;
    ENOENT: number;
  };
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastFailureSummary: string | null;
}

interface EnvDisplayEntry {
  value: string;
  source: "explicit env" | "default" | "derived" | "unset";
}

const DEFAULT_CONFIG = createDefaultConfig();
let currentConfig = cloneConfig(DEFAULT_CONFIG);
let runtimeSupervisor: RuntimeSupervisor | null = null;
let discordBotProcess: ChildProcess | null = null;
const commandHistory: string[] = [];
const eventHistory: DebugEvent[] = [];
const discordBotLogBuffer: string[] = [];
const runtimeFailureState: RuntimeFailureState = {
  errorCounts: {
    ECONNREFUSED: 0,
    EACCES: 0,
    ENOENT: 0,
  },
  lastSuccessAt: null,
  lastFailureAt: null,
  consecutiveFailures: 0,
  lastFailureSummary: null,
};
const DEBUG_PROFILE_DIR = path.resolve("debug", "profiles");
const debugSessionId = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\..+/, "")
  .replace("T", "-");

async function main(): Promise<void> {
  installProcessGuards();
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  console.log(`[debug] session=${debugSessionId}`);
  console.log("[debug] preflight mode started. type 'help' for commands.");
  printPreflightSummary(currentConfig);

  try {
    const preflightAction = await runPreflightLoop(rl);
    if (preflightAction === "exit") {
      return;
    }
    await attemptInfrastructureStart();
    console.log("[debug] runtime console is ready.");
    await runRuntimeLoop(rl);
  } finally {
    rl.close();
    await shutdownInfrastructure({
      stopCompose: currentConfig.settings.stopComposeOnExit,
    });
  }
}

async function runPreflightLoop(
  rl: ReturnType<typeof createInterface>,
): Promise<"start" | "exit"> {
  for (;;) {
    const line = await readLineSafely(rl, "debug(preflight)> ");
    if (line === null) {
      return "exit";
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    commandHistory.push(`preflight: ${trimmed}`);
    const [command, ...rawArgs] = splitArgs(trimmed);
    if (!command) {
      continue;
    }

    try {
      const action = await handlePreflightCommand(rl, command, rawArgs);
      if (action === "start" || action === "exit") {
        return action;
      }
    } catch (error) {
      await handleCommandError({
        scope: "preflight",
        command: trimmed,
        error,
      });
    }
  }
}

async function runRuntimeLoop(
  rl: ReturnType<typeof createInterface>,
): Promise<void> {
  printRuntimeHelp();
  for (;;) {
    const line = await readLineSafely(rl, "debug(runtime)> ");
    if (line === null) {
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    commandHistory.push(`runtime: ${trimmed}`);
    const [command, ...rawArgs] = splitArgs(trimmed);
    if (!command) {
      continue;
    }

    try {
      const shouldExit = await handleRuntimeCommand(rl, command, rawArgs);
      if (shouldExit) {
        return;
      }
    } catch (error) {
      await handleCommandError({
        scope: "runtime",
        command: trimmed,
        error,
      });
    }
  }
}

async function handlePreflightCommand(
  rl: ReturnType<typeof createInterface>,
  command: string,
  rawArgs: string[],
): Promise<"start" | "exit" | "continue"> {
  switch (command) {
    case "help":
      printPreflightHelp();
      return "continue";
    case "preflight":
      printPreflightSummary(currentConfig);
      return "continue";
    case "components":
      printComponents(currentConfig.components);
      return "continue";
    case "enable":
      updateComponent(rawArgs[0], true);
      return "continue";
    case "disable":
      updateComponent(rawArgs[0], false);
      return "continue";
    case "preset":
      applyPreset(rawArgs[0]);
      return "continue";
    case "set":
      applySetting(rawArgs[0], rawArgs.slice(1).join(" "));
      return "continue";
    case "unset":
      unsetSetting(rawArgs[0]);
      return "continue";
    case "diff":
      printDiff();
      return "continue";
    case "env":
      printEnv(rawArgs[0]);
      return "continue";
    case "config":
      printEffectiveConfig();
      return "continue";
    case "validate":
      printValidation();
      return "continue";
    case "save-profile":
      await saveProfile(rawArgs[0]);
      return "continue";
    case "load-profile":
      await loadProfile(rawArgs[0]);
      return "continue";
    case "reset":
      currentConfig = cloneConfig(DEFAULT_CONFIG);
      console.log("[debug] preflight settings reset.");
      return "continue";
    case "start":
      if (!(await confirmStart(rl, rawArgs))) {
        return "continue";
      }
      appendDebugEvent({
        level: "info",
        scope: "preflight",
        command: "start",
        message: "preflight completed",
      });
      return "start";
    case "exit":
      return "exit";
    default:
      console.log(`[debug] unknown command: ${command}`);
      return "continue";
  }
}

async function handleRuntimeCommand(
  rl: ReturnType<typeof createInterface>,
  command: string,
  rawArgs: string[],
): Promise<boolean> {
  switch (command) {
    case "help":
      printRuntimeHelp();
      return false;
    case "status":
      await printRuntimeStatus();
      markRuntimeCommandSuccess("status");
      return false;
    case "probe":
      await printRuntimeProbe(rawArgs[0]);
      markRuntimeCommandSuccess("probe");
      return false;
    case "ps":
      await runComposeAndPrint(["ps"]);
      markRuntimeCommandSuccess("ps");
      return false;
    case "logs":
      if (await handleLogsCommand(rawArgs)) {
        markRuntimeCommandSuccess("logs");
      }
      return false;
    case "restart":
      if (await handleRestartCommand(rawArgs[0])) {
        markRuntimeCommandSuccess("restart");
      }
      return false;
    case "bot":
      if (await handleBotCommand(rawArgs[0])) {
        markRuntimeCommandSuccess("bot");
      }
      return false;
    case "up":
      if (await handleUpCommand()) {
        markRuntimeCommandSuccess("up");
      }
      return false;
    case "down":
      if (!(await confirmDownCommand(rl, rawArgs))) {
        return false;
      }
      await runComposeAndPrint(["down", "--remove-orphans"]);
      markRuntimeCommandSuccess("down");
      return false;
    case "sockets":
      await printSocketStatus();
      markRuntimeCommandSuccess("sockets");
      return false;
    case "env":
      printEnv(rawArgs[0]);
      return false;
    case "config":
      printEffectiveConfig();
      return false;
    case "history":
      printHistory();
      return false;
    case "snapshot":
      await writeSnapshot(rawArgs[0]);
      markRuntimeCommandSuccess("snapshot");
      return false;
    case "exit":
      if (rawArgs.includes("--with-compose-down")) {
        currentConfig.settings.stopComposeOnExit = true;
      }
      return true;
    default:
      console.log(`[debug] unknown command: ${command}`);
      return false;
  }
}

async function readLineSafely(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string | null> {
  try {
    return await rl.question(prompt);
  } catch (error) {
    appendDebugEvent({
      level: "warn",
      scope: "system",
      command: "readline",
      message: `input stream closed: ${toErrorMessage(error)}`,
    });
    return null;
  }
}

async function attemptInfrastructureStart(): Promise<boolean> {
  try {
    await startInfrastructure();
    markRuntimeCommandSuccess("startup");
    appendDebugEvent({
      level: "info",
      scope: "runtime",
      command: "startup",
      message: "infrastructure started",
    });
    if (currentConfig.settings.envDumpOnStart) {
      console.log("[debug] startup env snapshot:");
      printEnv(undefined);
    }
    return true;
  } catch (error) {
    await handleCommandError({
      scope: "runtime",
      command: "startup",
      error,
    });
    console.log(
      "[debug] startup failed. runtime shell remains available for investigation.",
    );
    return false;
  }
}

async function startInfrastructure(): Promise<void> {
  if (runtimeSupervisor) {
    await shutdownInfrastructure({ stopCompose: false });
  }
  applySettingsToEnvironment();
  const composeServices = resolveSelectedComposeServices(currentConfig.components);
  runtimeSupervisor = new RuntimeSupervisor({
    projectRoot: process.cwd(),
    gatewayApiBaseUrl:
      process.env.GATEWAY_API_BASE_URL ?? "http://127.0.0.1:3800",
    gatewayApiSocketPath:
      currentConfig.settings.internalConnectionMode === "uds"
        ? currentConfig.settings.gatewayApiSocketPath
        : undefined,
    gatewayApiHost: process.env.GATEWAY_API_HOST ?? "127.0.0.1",
    gatewayApiPort: parsePositiveInt(process.env.GATEWAY_API_PORT, 3800),
    agentRuntimeBaseUrl:
      process.env.AGENT_RUNTIME_BASE_URL ?? "http://127.0.0.1:3801",
    agentRuntimeSocketPath:
      currentConfig.settings.internalConnectionMode === "uds"
        ? currentConfig.settings.agentRuntimeSocketPath
        : undefined,
    composeBuild: currentConfig.settings.composeBuild,
    composeUpEnabled: composeServices.length > 0,
    composeServices,
    dbMigrateEnabled: currentConfig.components["db.migrate"],
    gatewayStartEnabled: currentConfig.components["gateway.api"],
    autoRecoveryEnabled: currentConfig.settings.autoRecoveryEnabled,
    monitoringEnabled: currentConfig.components["orchestrator.monitor"],
    cleanupEnabled: currentConfig.components["orchestrator.cleanup"],
    monitorIntervalSec: currentConfig.settings.monitorIntervalSec,
    failureThreshold: currentConfig.settings.failureThreshold,
    commandTimeoutSec: currentConfig.settings.commandTimeoutSec,
    cleanupIntervalSec: currentConfig.settings.cleanupIntervalSec,
    rollbackOnBootFailure: false,
    onLog: (message) => {
      console.log(`[orchestrator] ${message}`);
    },
    onAlert: async (message) => {
      console.log(`[alert] ${message}`);
    },
    onFatal: async (reason) => {
      appendDebugEvent({
        level: "error",
        scope: "runtime",
        command: "orchestrator.onFatal",
        message: reason,
      });
      console.log(`[fatal] ${reason}`);
    },
  });
  await runtimeSupervisor.boot();
  if (currentConfig.components["discord.bot"]) {
    await startDiscordBotProcess();
  } else {
    console.log("[debug] discord bot start skipped (disabled)");
  }
}

async function shutdownInfrastructure(input: { stopCompose: boolean }): Promise<void> {
  await stopDiscordBotProcess();
  if (!runtimeSupervisor) {
    return;
  }
  await runtimeSupervisor.shutdown({
    stopCompose: input.stopCompose,
  });
  runtimeSupervisor = null;
}

function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    void handleCommandError({
      scope: "system",
      command: "unhandledRejection",
      error: reason,
    });
  });
  process.on("uncaughtException", (error) => {
    void handleCommandError({
      scope: "system",
      command: "uncaughtException",
      error,
    });
  });
}

async function handleCommandError(input: {
  scope: DebugEvent["scope"];
  command: string;
  error: unknown;
}): Promise<void> {
  const detail = toErrorMessage(input.error);
  appendDebugEvent({
    level: "error",
    scope: input.scope,
    command: input.command,
    message: detail,
  });
  if (input.scope !== "preflight") {
    markRuntimeCommandFailure(input.command, detail);
  }
  console.log(`[debug][error] ${input.command}: ${detail}`);
  if (currentConfig.settings.snapshotOnFailure) {
    const tag = sanitizeSnapshotTag(`failure-${input.command}`);
    try {
      await writeSnapshot(tag);
    } catch (snapshotError) {
      console.log(
        `[debug] snapshot on failure skipped: ${toErrorMessage(snapshotError)}`,
      );
    }
  }
}

function markRuntimeCommandSuccess(command: string): void {
  runtimeFailureState.lastSuccessAt = new Date().toISOString();
  runtimeFailureState.consecutiveFailures = 0;
  appendDebugEvent({
    level: "info",
    scope: "runtime",
    command,
    message: "ok",
  });
}

function markRuntimeCommandFailure(command: string, detail: string): void {
  runtimeFailureState.lastFailureAt = new Date().toISOString();
  runtimeFailureState.consecutiveFailures += 1;
  runtimeFailureState.lastFailureSummary = `${command}: ${detail}`;
  const code = detectKnownErrorCode(detail);
  if (code) {
    runtimeFailureState.errorCounts[code] += 1;
  }
}

function appendDebugEvent(input: Omit<DebugEvent, "timestamp">): void {
  eventHistory.push({
    ...input,
    timestamp: new Date().toISOString(),
  });
  if (eventHistory.length > 1500) {
    eventHistory.shift();
  }
}

function detectKnownErrorCode(
  text: string,
): keyof RuntimeFailureState["errorCounts"] | null {
  if (text.includes("ECONNREFUSED")) {
    return "ECONNREFUSED";
  }
  if (text.includes("EACCES")) {
    return "EACCES";
  }
  if (text.includes("ENOENT")) {
    return "ENOENT";
  }
  return null;
}

function sanitizeSnapshotTag(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "-");
  return safe.slice(0, 64);
}

async function printRuntimeStatus(): Promise<void> {
  console.log(
    `[debug] shell=alive session=${debugSessionId} discord_bot=${resolveDiscordBotStatusLabel()}`,
  );
  if (!runtimeSupervisor) {
    console.log("[debug] runtime supervisor is not started.");
    printFailureSummary();
    return;
  }
  const snapshot = await runtimeSupervisor.snapshotHealth();
  printHealthSnapshot(snapshot);
  printFailureSummary();
}

async function printRuntimeProbe(targetRaw: string | undefined): Promise<void> {
  if (!runtimeSupervisor) {
    console.log("[debug] runtime supervisor is not started.");
    return;
  }
  const target = (targetRaw ?? "all").toLowerCase();
  const snapshot = await runtimeSupervisor.snapshotHealth();
  if (target === "all") {
    printHealthSnapshot(snapshot);
    return;
  }
  if (target === "gateway") {
    console.log(
      `gateway=${snapshot.gateway.ok ? "ok" : "ng"}(${snapshot.gateway.detail})`,
    );
    return;
  }
  if (target === "agent") {
    console.log(`agent=${snapshot.agent.ok ? "ok" : "ng"}(${snapshot.agent.detail})`);
    return;
  }
  if (target === "db") {
    console.log(
      `db=${snapshot.compose.ok ? "ok" : "ng"}(${snapshot.compose.detail})`,
    );
    return;
  }
  console.log("[debug] probe target must be one of: all | gateway | agent | db");
}

function printHealthSnapshot(snapshot: RuntimeHealthSnapshot): void {
  console.log(
    [
      `gateway=${snapshot.gateway.ok ? "ok" : "ng"}(${snapshot.gateway.detail})`,
      `agent=${snapshot.agent.ok ? "ok" : "ng"}(${snapshot.agent.detail})`,
      `compose=${snapshot.compose.ok ? "ok" : "ng"}(${snapshot.compose.detail})`,
      `discord_bot=${resolveDiscordBotStatusLabel()}`,
    ].join(" "),
  );
}

function printFailureSummary(): void {
  const payload = {
    last_success_at: runtimeFailureState.lastSuccessAt,
    last_failure_at: runtimeFailureState.lastFailureAt,
    consecutive_failures: runtimeFailureState.consecutiveFailures,
    last_failure: runtimeFailureState.lastFailureSummary,
    error_counts: runtimeFailureState.errorCounts,
  };
  console.log(`[debug] failures=${JSON.stringify(payload)}`);
}

async function handleLogsCommand(args: string[]): Promise<boolean> {
  const target = args[0] ?? "all";
  const tail = parsePositiveInt(args[1], 120);
  if (target === "all") {
    await runComposeAndPrint(["logs", "--tail", String(tail)]);
    printDiscordBotLogs(tail);
    return true;
  }
  if (target === "bot") {
    printDiscordBotLogs(tail);
    return true;
  }
  if (target !== "agent" && target !== "postgres") {
    console.log("[debug] logs target must be one of: all | agent | postgres | bot");
    return false;
  }
  await runComposeAndPrint(["logs", target, "--tail", String(tail)]);
  return true;
}

async function handleRestartCommand(targetRaw: string | undefined): Promise<boolean> {
  const target = targetRaw ?? "all";
  if (target === "all") {
    return attemptInfrastructureStart();
  }
  if (target === "bot") {
    await restartDiscordBotProcess();
    return true;
  }
  if (target !== "agent" && target !== "postgres") {
    console.log("[debug] restart target must be one of: all | agent | postgres | bot");
    return false;
  }
  await runComposeAndPrint(["restart", target]);
  return true;
}

async function handleBotCommand(actionRaw: string | undefined): Promise<boolean> {
  const action = (actionRaw ?? "status").toLowerCase();
  if (action === "status") {
    console.log(`[debug] discord bot: ${resolveDiscordBotStatusLabel()}`);
    return true;
  }
  if (action === "start") {
    await startDiscordBotProcess();
    return true;
  }
  if (action === "stop") {
    await stopDiscordBotProcess();
    return true;
  }
  if (action === "restart") {
    await restartDiscordBotProcess();
    return true;
  }
  console.log("[debug] bot action must be one of: status | start | stop | restart");
  return false;
}

async function handleUpCommand(): Promise<boolean> {
  const services = resolveSelectedComposeServices(currentConfig.components);
  if (services.length === 0) {
    console.log("[debug] no compose services are enabled.");
    return false;
  }
  await runComposeAndPrint([
    "up",
    "-d",
    ...(currentConfig.settings.composeBuild ? ["--build"] : []),
    ...services,
  ]);
  return true;
}

async function runComposeAndPrint(args: string[]): Promise<void> {
  const output = await execCommand({
    command: "docker",
    args: [
      "compose",
      "-f",
      `docker-compose.${currentConfig.settings.internalConnectionMode}.yml`,
      ...args,
    ],
    cwd: process.cwd(),
    timeoutSec: currentConfig.settings.commandTimeoutSec,
    extraEnv: resolveComposeCurrentUserEnv(),
  });
  if (output.stdout.trim().length > 0) {
    console.log(output.stdout.trimEnd());
  }
  if (output.stderr.trim().length > 0) {
    console.log(output.stderr.trimEnd());
  }
  if (output.timedOut) {
    throw new Error(`docker compose ${args.join(" ")} timed out`);
  }
  if (output.exitCode !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} failed (exit=${output.exitCode})`,
    );
  }
}

async function startDiscordBotProcess(): Promise<void> {
  if (!currentConfig.components["discord.bot"]) {
    console.log("[debug] discord bot component is disabled.");
    return;
  }
  if (discordBotProcess) {
    console.log(
      `[debug] discord bot is already running (pid=${discordBotProcess.pid}).`,
    );
    return;
  }
  if (!process.env.DISCORD_BOT_TOKEN) {
    throw new Error("DISCORD_BOT_TOKEN is required when discord.bot is enabled.");
  }
  const child = spawn("yarn", ["dev:local"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BOT_ORCHESTRATOR_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pushDiscordBotLog("stdout", chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    pushDiscordBotLog("stderr", chunk);
  });
  child.on("exit", (code, signal) => {
    appendDebugEvent({
      level: "warn",
      scope: "runtime",
      command: "discord.bot",
      message: `process exited (code=${String(code)}, signal=${String(signal)})`,
    });
    pushDiscordBotLog(
      "stderr",
      `[debug] discord bot process exited (code=${String(code)}, signal=${String(signal)})`,
    );
    if (discordBotProcess === child) {
      discordBotProcess = null;
    }
  });
  discordBotProcess = child;
  console.log(`[debug] discord bot started (pid=${child.pid}).`);
  appendDebugEvent({
    level: "info",
    scope: "runtime",
    command: "discord.bot",
    message: `started pid=${child.pid}`,
  });
  await ensureDiscordBotStarted(child);
}

async function ensureDiscordBotStarted(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, 800);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      reject(
        new Error(
          `discord bot exited immediately (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    };
    child.once("exit", onExit);
  });
}

async function stopDiscordBotProcess(): Promise<void> {
  const child = discordBotProcess;
  if (!child) {
    return;
  }
  discordBotProcess = null;
  console.log(`[debug] stopping discord bot (pid=${child.pid})...`);
  appendDebugEvent({
    level: "info",
    scope: "runtime",
    command: "discord.bot",
    message: `stopping pid=${child.pid}`,
  });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        console.log(
          `[debug] failed to SIGKILL discord bot: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGTERM");
    } catch (error) {
      console.log(
        `[debug] failed to SIGTERM discord bot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      clearTimeout(timer);
      resolve();
    }
  });
}

async function restartDiscordBotProcess(): Promise<void> {
  await stopDiscordBotProcess();
  await startDiscordBotProcess();
}

function resolveDiscordBotStatusLabel(): string {
  if (!currentConfig.components["discord.bot"]) {
    return "disabled";
  }
  if (!discordBotProcess) {
    return "stopped";
  }
  return `running(pid=${discordBotProcess.pid})`;
}

function pushDiscordBotLog(stream: "stdout" | "stderr", chunk: string): void {
  const lines = chunk
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const formatted = `[bot:${stream}] ${line}`;
    discordBotLogBuffer.push(formatted);
    if (discordBotLogBuffer.length > 1200) {
      discordBotLogBuffer.shift();
    }
    console.log(formatted);
  }
}

function printDiscordBotLogs(tail: number): void {
  if (discordBotLogBuffer.length === 0) {
    console.log("[debug] no discord bot logs captured yet.");
    return;
  }
  const size = Math.max(1, tail);
  for (const line of discordBotLogBuffer.slice(-size)) {
    console.log(line);
  }
}

async function printSocketStatus(): Promise<void> {
  const sockets = [
    currentConfig.settings.gatewayApiSocketPath,
    currentConfig.settings.agentRuntimeSocketPath,
  ];
  for (const socketPath of sockets) {
    if (!socketPath || socketPath.trim().length === 0) {
      continue;
    }
    if (!existsSync(socketPath)) {
      console.log(`[socket] missing ${socketPath}`);
      continue;
    }
    try {
      const info = await stat(socketPath);
      const listener = info.isSocket()
        ? await probeSocketListener(socketPath)
        : "no(non-socket)";
      console.log(
        `[socket] ${socketPath} type=${
          info.isSocket() ? "socket" : "non-socket"
        } owner=${info.uid}:${info.gid} mode=${(info.mode & 0o777).toString(
          8,
        )} listener=${listener}`,
      );
    } catch (error) {
      console.log(
        `[socket] stat failed ${socketPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function probeSocketListener(socketPath: string): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
        path: "/health",
        method: "GET",
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve(`yes(status=${res.statusCode ?? "unknown"})`);
        });
      },
    );
    req.setTimeout(2500, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => {
      const message = error.message || "unknown";
      resolve(`no(${message})`);
    });
    req.end();
  });
}

async function writeSnapshot(tag: string | undefined): Promise<void> {
  const baseDir = path.resolve("debug", debugSessionId);
  await mkdir(baseDir, { recursive: true });
  const fileName = tag && tag.length > 0 ? `snapshot-${tag}.json` : "snapshot.json";
  const filePath = path.join(baseDir, fileName);
  const health = runtimeSupervisor ? await runtimeSupervisor.snapshotHealth() : null;
  const payload = {
    session_id: debugSessionId,
    timestamp: new Date().toISOString(),
    config: currentConfig,
    runtime_failures: runtimeFailureState,
    discord_bot_status: resolveDiscordBotStatusLabel(),
    discord_bot_log_tail: discordBotLogBuffer.slice(-200),
    health,
    history: commandHistory.slice(-200),
    events: eventHistory.slice(-400),
    env: collectImportantEnvEntries(),
  };
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`[debug] snapshot written: ${filePath}`);
}

function printHistory(): void {
  const recentCommands = commandHistory.slice(-80);
  const recentEvents = eventHistory.slice(-80);
  if (recentCommands.length === 0 && recentEvents.length === 0) {
    console.log("[debug] no history.");
    return;
  }
  if (recentCommands.length > 0) {
    console.log("[history] commands:");
    for (const line of recentCommands) {
      console.log(`  ${line}`);
    }
  }
  if (recentEvents.length > 0) {
    console.log("[history] events:");
    for (const event of recentEvents) {
      console.log(
        `  ${event.timestamp} [${event.level}] ${event.scope}:${event.command} ${event.message}`,
      );
    }
  }
}

function printPreflightHelp(): void {
  console.log("preflight commands:");
  console.log("  help");
  console.log("  preflight");
  console.log("  components");
  console.log("  enable <component>");
  console.log("  disable <component>");
  console.log("  preset full|minimal|infra-only|api-only");
  console.log("  set <key> <value>");
  console.log("  unset <key>");
  console.log("  diff");
  console.log("  validate");
  console.log("  env [KEY|--all]");
  console.log("  config");
  console.log("  save-profile <name>");
  console.log("  load-profile <name>");
  console.log("  reset");
  console.log("  start [--yes]");
  console.log("  exit");
}

function printRuntimeHelp(): void {
  console.log("runtime commands:");
  console.log("  help");
  console.log("  status");
  console.log("  probe [all|gateway|agent|db]");
  console.log("  ps");
  console.log("  logs [all|agent|postgres|bot] [tail]");
  console.log("  restart [all|agent|postgres|bot]");
  console.log("  bot [status|start|stop|restart]");
  console.log("  up");
  console.log("  down [--yes]");
  console.log("  sockets");
  console.log("  env [KEY|--all]");
  console.log("  config");
  console.log("  history");
  console.log("  snapshot [tag]");
  console.log("  exit [--with-compose-down]");
}

async function confirmStart(
  rl: ReturnType<typeof createInterface>,
  args: string[],
): Promise<boolean> {
  const validation = validateConfig(currentConfig);
  if (validation.errors.length > 0) {
    printValidation();
    return false;
  }
  if (args.includes("--yes")) {
    return true;
  }
  const answerRaw = await readLineSafely(
    rl,
    "start with current preflight settings? [y/N]: ",
  );
  const answer = (answerRaw ?? "").trim();
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

async function confirmDownCommand(
  rl: ReturnType<typeof createInterface>,
  args: string[],
): Promise<boolean> {
  if (args.includes("--yes")) {
    return true;
  }
  const answerRaw = await readLineSafely(
    rl,
    "run compose down? this may remove debugging context [y/N]: ",
  );
  const answer = (answerRaw ?? "").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function saveProfile(nameRaw: string | undefined): Promise<void> {
  const name = normalizeProfileName(nameRaw);
  if (!name) {
    console.log("[debug] profile name is required.");
    return;
  }
  await mkdir(DEBUG_PROFILE_DIR, { recursive: true });
  const filePath = path.join(DEBUG_PROFILE_DIR, `${name}.json`);
  await writeFile(filePath, JSON.stringify(currentConfig, null, 2), "utf8");
  console.log(`[debug] profile saved: ${filePath}`);
}

async function loadProfile(nameRaw: string | undefined): Promise<void> {
  const name = normalizeProfileName(nameRaw);
  if (!name) {
    console.log("[debug] profile name is required.");
    return;
  }
  const filePath = path.join(DEBUG_PROFILE_DIR, `${name}.json`);
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  currentConfig = hydrateConfigFromProfile(parsed);
  console.log(`[debug] profile loaded: ${filePath}`);
  printPreflightSummary(currentConfig);
}

function normalizeProfileName(nameRaw: string | undefined): string | null {
  if (!nameRaw) {
    return null;
  }
  const name = nameRaw.trim();
  if (name.length === 0) {
    return null;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      "profile name must match /^[A-Za-z0-9._-]+$/ (no spaces or slashes)",
    );
  }
  return name;
}

function hydrateConfigFromProfile(input: unknown): DebugConfig {
  if (!input || typeof input !== "object") {
    throw new Error("invalid profile format: root object required");
  }
  const source = input as Record<string, unknown>;
  const next = cloneConfig(DEFAULT_CONFIG);
  const sourceComponents = source.components;
  if (sourceComponents && typeof sourceComponents === "object") {
    const components = sourceComponents as Record<string, unknown>;
    for (const key of Object.keys(next.components) as ComponentKey[]) {
      if (typeof components[key] === "boolean") {
        next.components[key] = components[key];
      }
    }
  }
  const sourceSettings = source.settings;
  if (sourceSettings && typeof sourceSettings === "object") {
    const settings = sourceSettings as Record<string, unknown>;
    for (const key of Object.keys(next.settings) as SettingKey[]) {
      const value = settings[key];
      if (value === undefined) {
        continue;
      }
      applyProfileSetting(next.settings, key, value);
    }
  }
  return next;
}

function applyProfileSetting(
  target: DebugSettings,
  key: SettingKey,
  value: unknown,
): void {
  switch (key) {
    case "composeBuild":
    case "autoRecoveryEnabled":
    case "stopComposeOnExit":
    case "snapshotOnFailure":
    case "envDumpOnStart":
      if (typeof value === "boolean") {
        target[key] = value;
      }
      return;
    case "monitorIntervalSec":
    case "failureThreshold":
    case "commandTimeoutSec":
    case "cleanupIntervalSec":
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        target[key] = Math.floor(value);
      }
      return;
    case "internalConnectionMode":
      if (value === "tcp" || value === "uds") {
        target.internalConnectionMode = value;
      }
      return;
    case "runtimeSocketDir":
    case "gatewayApiSocketPath":
    case "agentRuntimeSocketPath":
      if (typeof value === "string" && value.trim().length > 0) {
        target[key] = path.resolve(value);
      }
      return;
  }
}

function printPreflightSummary(config: DebugConfig): void {
  printComponents(config.components);
  printDiff();
  printValidation();
}

function printComponents(components: DebugComponents): void {
  console.log("components:");
  for (const key of Object.keys(components) as ComponentKey[]) {
    console.log(`  ${key}=${components[key] ? "enabled" : "disabled"}`);
  }
}

function updateComponent(componentRaw: string | undefined, enabled: boolean): void {
  if (!componentRaw) {
    console.log("[debug] component is required.");
    return;
  }
  if (!isComponentKey(componentRaw)) {
    console.log(`[debug] unknown component: ${componentRaw}`);
    return;
  }
  currentConfig.components[componentRaw] = enabled;
  console.log(
    `[debug] ${componentRaw} ${enabled ? "enabled" : "disabled"}.`,
  );
}

function applyPreset(presetRaw: string | undefined): void {
  const preset = (presetRaw ?? "").toLowerCase();
  if (preset === "full") {
    currentConfig.components = {
      "discord.bot": true,
      "compose.agent": true,
      "compose.postgres": true,
      "db.migrate": true,
      "gateway.api": true,
      "orchestrator.monitor": true,
      "orchestrator.cleanup": true,
    };
    console.log("[debug] preset applied: full");
    return;
  }
  if (preset === "minimal") {
    currentConfig.components = {
      "discord.bot": false,
      "compose.agent": false,
      "compose.postgres": false,
      "db.migrate": false,
      "gateway.api": true,
      "orchestrator.monitor": false,
      "orchestrator.cleanup": false,
    };
    console.log("[debug] preset applied: minimal");
    return;
  }
  if (preset === "infra-only") {
    currentConfig.components = {
      "discord.bot": false,
      "compose.agent": true,
      "compose.postgres": true,
      "db.migrate": true,
      "gateway.api": false,
      "orchestrator.monitor": true,
      "orchestrator.cleanup": true,
    };
    console.log("[debug] preset applied: infra-only");
    return;
  }
  if (preset === "api-only") {
    currentConfig.components = {
      "discord.bot": true,
      "compose.agent": false,
      "compose.postgres": false,
      "db.migrate": false,
      "gateway.api": true,
      "orchestrator.monitor": false,
      "orchestrator.cleanup": false,
    };
    console.log("[debug] preset applied: api-only");
    return;
  }
  console.log(`[debug] unknown preset: ${presetRaw}`);
}

function applySetting(keyRaw: string | undefined, valueRaw: string): void {
  if (!keyRaw) {
    console.log("[debug] setting key is required.");
    return;
  }
  if (!isSettingKey(keyRaw)) {
    console.log(`[debug] unknown setting: ${keyRaw}`);
    return;
  }
  const value = valueRaw.trim();
  if (value.length === 0) {
    console.log("[debug] setting value is required.");
    return;
  }
  try {
    switch (keyRaw) {
      case "composeBuild":
      case "autoRecoveryEnabled":
      case "stopComposeOnExit":
      case "snapshotOnFailure":
      case "envDumpOnStart":
        currentConfig.settings[keyRaw] = parseBoolOrThrow(value);
        break;
      case "monitorIntervalSec":
      case "failureThreshold":
      case "commandTimeoutSec":
      case "cleanupIntervalSec":
        currentConfig.settings[keyRaw] = parsePositiveIntOrThrow(value);
        break;
      case "internalConnectionMode":
        if (value !== "tcp" && value !== "uds") {
          throw new Error("must be tcp or uds");
        }
        currentConfig.settings.internalConnectionMode = value;
        break;
      case "runtimeSocketDir":
      case "gatewayApiSocketPath":
      case "agentRuntimeSocketPath":
        currentConfig.settings[keyRaw] = path.resolve(value);
        break;
    }
    console.log(`[debug] set ${keyRaw}=${currentConfig.settings[keyRaw]}`);
  } catch (error) {
    console.log(
      `[debug] failed to set ${keyRaw}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function unsetSetting(keyRaw: string | undefined): void {
  if (!keyRaw) {
    console.log("[debug] setting key is required.");
    return;
  }
  if (!isSettingKey(keyRaw)) {
    console.log(`[debug] unknown setting: ${keyRaw}`);
    return;
  }
  setDebugSetting(keyRaw, DEFAULT_CONFIG.settings[keyRaw]);
  console.log(`[debug] unset ${keyRaw} (default restored)`);
}

function printDiff(): void {
  const diff: string[] = [];
  for (const key of Object.keys(currentConfig.components) as ComponentKey[]) {
    if (currentConfig.components[key] !== DEFAULT_CONFIG.components[key]) {
      diff.push(
        `component.${key}: ${DEFAULT_CONFIG.components[key]} -> ${currentConfig.components[key]}`,
      );
    }
  }
  for (const key of Object.keys(currentConfig.settings) as SettingKey[]) {
    if (currentConfig.settings[key] !== DEFAULT_CONFIG.settings[key]) {
      diff.push(
        `setting.${key}: ${String(DEFAULT_CONFIG.settings[key])} -> ${String(
          currentConfig.settings[key],
        )}`,
      );
    }
  }
  if (diff.length === 0) {
    console.log("[debug] no diff from defaults.");
    return;
  }
  console.log("diff from defaults:");
  for (const line of diff) {
    console.log(`  ${line}`);
  }
}

function printValidation(): void {
  const { errors, warnings } = validateConfig(currentConfig);
  if (errors.length === 0 && warnings.length === 0) {
    console.log("[debug] validate: ok");
    return;
  }
  for (const warning of warnings) {
    console.log(`[debug][warn] ${warning}`);
  }
  for (const error of errors) {
    console.log(`[debug][error] ${error}`);
  }
}

function printEnv(arg: string | undefined): void {
  if (arg === "--all") {
    const keys = Object.keys(process.env).sort();
    for (const key of keys) {
      const value = process.env[key];
      if (typeof value !== "string") {
        continue;
      }
      console.log(`${key}=${maskEnvValue(key, value)}`);
    }
    return;
  }
  const importantEntries = collectImportantEnvEntries();
  if (arg && arg.length > 0) {
    const key = arg.trim();
    if (importantEntries[key]) {
      const entry = importantEntries[key];
      console.log(`${key}=${entry.value} (source=${entry.source})`);
      return;
    }
    const value = process.env[key];
    if (typeof value !== "string") {
      console.log(`${key}=<unset> (source=unset)`);
      return;
    }
    console.log(`${key}=${maskEnvValue(key, value)} (source=explicit env)`);
    return;
  }
  for (const [key, entry] of Object.entries(importantEntries)) {
    console.log(`${key}=${entry.value} (source=${entry.source})`);
  }
}

function printEffectiveConfig(): void {
  const payload = {
    components: currentConfig.components,
    settings: currentConfig.settings,
    compose_file: `docker-compose.${currentConfig.settings.internalConnectionMode}.yml`,
    compose_services: resolveSelectedComposeServices(currentConfig.components),
    stop_compose_on_exit: currentConfig.settings.stopComposeOnExit,
  };
  console.log(JSON.stringify(payload, null, 2));
}

function validateConfig(config: DebugConfig): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (config.components["discord.bot"] && !config.components["gateway.api"]) {
    errors.push("discord.bot requires gateway.api=true");
  }
  if (config.components["discord.bot"] && !process.env.DISCORD_BOT_TOKEN) {
    errors.push("discord.bot requires DISCORD_BOT_TOKEN");
  }
  if (config.components["db.migrate"] && !config.components["compose.postgres"]) {
    errors.push("db.migrate requires compose.postgres=true");
  }
  if (config.components["compose.agent"] && !config.components["compose.postgres"]) {
    errors.push("compose.agent requires compose.postgres=true");
  }
  if (
    config.components["orchestrator.monitor"] &&
    !config.components["discord.bot"] &&
    !config.components["compose.agent"] &&
    !config.components["compose.postgres"] &&
    !config.components["gateway.api"]
  ) {
    warnings.push("orchestrator.monitor is enabled but no runtime components are selected");
  }
  if (
    config.settings.internalConnectionMode === "uds" &&
    config.settings.runtimeSocketDir.trim().length === 0
  ) {
    errors.push("runtimeSocketDir must not be empty when INTERNAL_CONNECTION_MODE=uds");
  }
  if (config.settings.monitorIntervalSec <= 0) {
    errors.push("monitorIntervalSec must be positive");
  }
  if (config.settings.failureThreshold <= 0) {
    errors.push("failureThreshold must be positive");
  }
  if (config.settings.commandTimeoutSec <= 0) {
    errors.push("commandTimeoutSec must be positive");
  }
  if (config.settings.cleanupIntervalSec <= 0) {
    errors.push("cleanupIntervalSec must be positive");
  }
  return { errors, warnings };
}

function applySettingsToEnvironment(): void {
  process.env.INTERNAL_CONNECTION_MODE = currentConfig.settings.internalConnectionMode;
  process.env.RUNTIME_SOCKET_DIR = currentConfig.settings.runtimeSocketDir;
  process.env.GATEWAY_API_SOCKET_PATH = currentConfig.settings.gatewayApiSocketPath;
  process.env.AGENT_RUNTIME_SOCKET_PATH = currentConfig.settings.agentRuntimeSocketPath;
}

function collectImportantEnvEntries(): Record<string, EnvDisplayEntry> {
  const runtimeSocketDir = resolveDefaultRuntimeSocketDir();
  const runtimeSocketDirSource = process.env.RUNTIME_SOCKET_DIR
    ? "explicit env"
    : process.env.XDG_RUNTIME_DIR
      ? "derived"
      : "default";
  const mode = process.env.INTERNAL_CONNECTION_MODE;
  const entries: Record<string, EnvDisplayEntry> = {
    INTERNAL_CONNECTION_MODE: {
      value: maskEnvValue("INTERNAL_CONNECTION_MODE", mode ?? "tcp"),
      source: mode ? "explicit env" : "default",
    },
    RUNTIME_SOCKET_DIR: {
      value: maskEnvValue("RUNTIME_SOCKET_DIR", runtimeSocketDir),
      source: runtimeSocketDirSource,
    },
    GATEWAY_API_SOCKET_PATH: resolveEnvEntry(
      "GATEWAY_API_SOCKET_PATH",
      path.join(runtimeSocketDir, "gateway-api.sock"),
      "derived",
    ),
    AGENT_RUNTIME_SOCKET_PATH: resolveEnvEntry(
      "AGENT_RUNTIME_SOCKET_PATH",
      path.join(runtimeSocketDir, "agent-runtime.sock"),
      "derived",
    ),
    AGENT_SOCKET_PATH: resolveEnvEntry("AGENT_SOCKET_PATH"),
    BOT_MODE: resolveEnvEntry("BOT_MODE"),
    BOT_ORCHESTRATOR_ENABLED: resolveEnvEntry("BOT_ORCHESTRATOR_ENABLED"),
    BOT_ORCHESTRATOR_MONITOR_INTERVAL_SEC: resolveEnvEntry(
      "BOT_ORCHESTRATOR_MONITOR_INTERVAL_SEC",
    ),
    BOT_ORCHESTRATOR_FAILURE_THRESHOLD: resolveEnvEntry(
      "BOT_ORCHESTRATOR_FAILURE_THRESHOLD",
    ),
    BOT_ORCHESTRATOR_COMMAND_TIMEOUT_SEC: resolveEnvEntry(
      "BOT_ORCHESTRATOR_COMMAND_TIMEOUT_SEC",
    ),
    BOT_ORCHESTRATOR_CLEANUP_ENABLED: resolveEnvEntry(
      "BOT_ORCHESTRATOR_CLEANUP_ENABLED",
    ),
    BOT_ORCHESTRATOR_CLEANUP_INTERVAL_SEC: resolveEnvEntry(
      "BOT_ORCHESTRATOR_CLEANUP_INTERVAL_SEC",
    ),
    BOT_ORCHESTRATOR_COMPOSE_BUILD: resolveEnvEntry(
      "BOT_ORCHESTRATOR_COMPOSE_BUILD",
    ),
    DISCORD_BOT_TOKEN: resolveEnvEntry("DISCORD_BOT_TOKEN"),
    COPILOT_SDK_LOG_LEVEL: resolveEnvEntry("COPILOT_SDK_LOG_LEVEL"),
    STATE_STORE_DSN: resolveEnvEntry("STATE_STORE_DSN"),
    MEMORY_STORE_DSN: resolveEnvEntry("MEMORY_STORE_DSN"),
  };
  return entries;
}

function resolveEnvEntry(
  key: string,
  fallback?: string,
  fallbackSource: "default" | "derived" = "default",
): EnvDisplayEntry {
  const value = process.env[key];
  if (typeof value === "string") {
    return {
      value: maskEnvValue(key, value),
      source: "explicit env",
    };
  }
  if (fallback !== undefined) {
    return {
      value: maskEnvValue(key, fallback),
      source: fallbackSource,
    };
  }
  return {
    value: "<unset>",
    source: "unset",
  };
}

function maskEnvValue(key: string, value: string): string {
  if (/(TOKEN|PASSWORD|SECRET|KEY|DSN)/i.test(key)) {
    if (value.length <= 8) {
      return "***";
    }
    return `${value.slice(0, 4)}***${value.slice(-2)}`;
  }
  return value;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function createDefaultConfig(): DebugConfig {
  const mode = resolveInternalConnectionMode(
    process.env.INTERNAL_CONNECTION_MODE ?? "tcp",
  );
  const runtimeSocketDir = resolveDefaultRuntimeSocketDir();
  return {
    components: {
      "discord.bot": true,
      "compose.agent": true,
      "compose.postgres": true,
      "db.migrate": true,
      "gateway.api": true,
      "orchestrator.monitor": true,
      "orchestrator.cleanup": true,
    },
    settings: {
      composeBuild: process.env.BOT_ORCHESTRATOR_COMPOSE_BUILD !== "false",
      autoRecoveryEnabled: false,
      stopComposeOnExit: false,
      snapshotOnFailure: true,
      envDumpOnStart: false,
      monitorIntervalSec: parsePositiveInt(
        process.env.BOT_ORCHESTRATOR_MONITOR_INTERVAL_SEC,
        15,
      ),
      failureThreshold: parsePositiveInt(
        process.env.BOT_ORCHESTRATOR_FAILURE_THRESHOLD,
        3,
      ),
      commandTimeoutSec: parsePositiveInt(
        process.env.BOT_ORCHESTRATOR_COMMAND_TIMEOUT_SEC,
        240,
      ),
      cleanupIntervalSec: parsePositiveInt(
        process.env.BOT_ORCHESTRATOR_CLEANUP_INTERVAL_SEC,
        24 * 60 * 60,
      ),
      internalConnectionMode: mode,
      runtimeSocketDir,
      gatewayApiSocketPath:
        process.env.GATEWAY_API_SOCKET_PATH ??
        path.join(runtimeSocketDir, "gateway-api.sock"),
      agentRuntimeSocketPath:
        process.env.AGENT_RUNTIME_SOCKET_PATH ??
        path.join(runtimeSocketDir, "agent-runtime.sock"),
    },
  };
}

function resolveDefaultRuntimeSocketDir(): string {
  const configured = process.env.RUNTIME_SOCKET_DIR;
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured);
  }
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntimeDir && xdgRuntimeDir.trim().length > 0) {
    return path.resolve(xdgRuntimeDir, "yui-ai");
  }
  return path.resolve("/tmp/yui-ai");
}

function resolveSelectedComposeServices(components: DebugComponents): string[] {
  const result: string[] = [];
  if (components["compose.postgres"]) {
    result.push("postgres");
  }
  if (components["compose.agent"]) {
    result.push("agent");
  }
  return result;
}

function splitArgs(input: string): string[] {
  return input.trim().split(/\s+/).filter((value) => value.length > 0);
}

function parseBoolOrThrow(value: string): boolean {
  const normalized = value.toLowerCase();
  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }
  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  throw new Error("must be a boolean (true/false)");
}

function parsePositiveIntOrThrow(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("must be a positive integer");
  }
  return parsed;
}

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

function resolveInternalConnectionMode(raw: string): "tcp" | "uds" {
  const normalized = raw.toLowerCase();
  if (normalized === "tcp" || normalized === "uds") {
    return normalized;
  }
  return "tcp";
}

function isComponentKey(value: string): value is ComponentKey {
  return (
    value === "discord.bot" ||
    value === "compose.agent" ||
    value === "compose.postgres" ||
    value === "db.migrate" ||
    value === "gateway.api" ||
    value === "orchestrator.monitor" ||
    value === "orchestrator.cleanup"
  );
}

function isSettingKey(value: string): value is SettingKey {
  return (
    value === "composeBuild" ||
    value === "autoRecoveryEnabled" ||
    value === "stopComposeOnExit" ||
    value === "snapshotOnFailure" ||
    value === "envDumpOnStart" ||
    value === "monitorIntervalSec" ||
    value === "failureThreshold" ||
    value === "commandTimeoutSec" ||
    value === "cleanupIntervalSec" ||
    value === "internalConnectionMode" ||
    value === "runtimeSocketDir" ||
    value === "gatewayApiSocketPath" ||
    value === "agentRuntimeSocketPath"
  );
}

function setDebugSetting<K extends SettingKey>(
  key: K,
  value: DebugSettings[K],
): void {
  currentConfig.settings[key] = value;
}

function cloneConfig(input: DebugConfig): DebugConfig {
  return {
    components: { ...input.components },
    settings: { ...input.settings },
  };
}

function resolveComposeCurrentUserEnv(): Record<string, string> {
  return {
    CURRENT_UID:
      typeof process.getuid === "function" ? String(process.getuid()) : "1000",
    CURRENT_GID:
      typeof process.getgid === "function" ? String(process.getgid()) : "1000",
  };
}

main().catch((error) => {
  console.error("[debug] fatal shell failure:", error);
});
