import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import {
  RuntimeSupervisor,
  type RuntimeHealthSnapshot,
} from "../orchestration/supervisor.js";
import { execCommand } from "../mcp/exec.js";

type ComponentKey =
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
  | "monitorIntervalSec"
  | "failureThreshold"
  | "commandTimeoutSec"
  | "cleanupIntervalSec"
  | "internalConnectionMode"
  | "runtimeSocketDir"
  | "gatewayApiSocketPath"
  | "agentRuntimeSocketPath";

interface DebugComponents {
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

const DEFAULT_CONFIG = createDefaultConfig();
let currentConfig = cloneConfig(DEFAULT_CONFIG);
let runtimeSupervisor: RuntimeSupervisor | null = null;
const commandHistory: string[] = [];
const debugSessionId = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\..+/, "")
  .replace("T", "-");

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "[debug] interactive mode requires TTY. use yarn dev(:local) for non-interactive run.",
    );
    process.exit(1);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  console.log(`[debug] session=${debugSessionId}`);
  console.log("[debug] preflight mode started. type 'help' for commands.");
  printPreflightSummary(currentConfig);

  try {
    await runPreflightLoop(rl);
    await startInfrastructure();
    console.log("[debug] infrastructure started. runtime console is ready.");
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
): Promise<void> {
  for (;;) {
    const line = (await rl.question("debug(preflight)> ")).trim();
    if (!line) {
      continue;
    }
    commandHistory.push(`preflight: ${line}`);
    const [command, ...rawArgs] = splitArgs(line);
    if (!command) {
      continue;
    }

    switch (command) {
      case "help":
        printPreflightHelp();
        break;
      case "preflight":
        printPreflightSummary(currentConfig);
        break;
      case "components":
        printComponents(currentConfig.components);
        break;
      case "enable":
        updateComponent(rawArgs[0], true);
        break;
      case "disable":
        updateComponent(rawArgs[0], false);
        break;
      case "preset":
        applyPreset(rawArgs[0]);
        break;
      case "set":
        applySetting(rawArgs[0], rawArgs.slice(1).join(" "));
        break;
      case "unset":
        unsetSetting(rawArgs[0]);
        break;
      case "diff":
        printDiff();
        break;
      case "env":
        printEnv(rawArgs[0]);
        break;
      case "config":
        printEffectiveConfig();
        break;
      case "validate":
        printValidation();
        break;
      case "reset":
        currentConfig = cloneConfig(DEFAULT_CONFIG);
        console.log("[debug] preflight settings reset.");
        break;
      case "start":
        if (!(await confirmStart(rl, rawArgs))) {
          break;
        }
        return;
      case "exit":
        process.exit(0);
      default:
        console.log(`[debug] unknown command: ${command}`);
    }
  }
}

async function runRuntimeLoop(
  rl: ReturnType<typeof createInterface>,
): Promise<void> {
  printRuntimeHelp();
  for (;;) {
    const line = (await rl.question("debug(runtime)> ")).trim();
    if (!line) {
      continue;
    }
    commandHistory.push(`runtime: ${line}`);
    const [command, ...rawArgs] = splitArgs(line);
    if (!command) {
      continue;
    }

    switch (command) {
      case "help":
        printRuntimeHelp();
        break;
      case "status":
      case "probe":
        await printRuntimeStatus();
        break;
      case "ps":
        await runComposeAndPrint(["ps"]);
        break;
      case "logs":
        await handleLogsCommand(rawArgs);
        break;
      case "restart":
        await handleRestartCommand(rawArgs[0]);
        break;
      case "up":
        await handleUpCommand();
        break;
      case "down":
        await runComposeAndPrint(["down", "--remove-orphans"]);
        break;
      case "sockets":
        await printSocketStatus();
        break;
      case "env":
        printEnv(rawArgs[0]);
        break;
      case "config":
        printEffectiveConfig();
        break;
      case "history":
        printHistory();
        break;
      case "snapshot":
        await writeSnapshot(rawArgs[0]);
        break;
      case "exit":
        if (rawArgs.includes("--with-compose-down")) {
          currentConfig.settings.stopComposeOnExit = true;
        }
        return;
      default:
        console.log(`[debug] unknown command: ${command}`);
    }
  }
}

async function startInfrastructure(): Promise<void> {
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
    onLog: (message) => {
      console.log(`[orchestrator] ${message}`);
    },
    onAlert: async (message) => {
      console.log(`[alert] ${message}`);
    },
    onFatal: async (reason) => {
      console.log(`[fatal] ${reason}`);
    },
  });
  await runtimeSupervisor.boot();
}

async function shutdownInfrastructure(input: { stopCompose: boolean }): Promise<void> {
  if (!runtimeSupervisor) {
    return;
  }
  await runtimeSupervisor.shutdown({
    stopCompose: input.stopCompose,
  });
  runtimeSupervisor = null;
}

async function printRuntimeStatus(): Promise<void> {
  if (!runtimeSupervisor) {
    console.log("[debug] runtime supervisor is not started.");
    return;
  }
  const snapshot = await runtimeSupervisor.snapshotHealth();
  printHealthSnapshot(snapshot);
}

function printHealthSnapshot(snapshot: RuntimeHealthSnapshot): void {
  console.log(
    [
      `gateway=${snapshot.gateway.ok ? "ok" : "ng"}(${snapshot.gateway.detail})`,
      `agent=${snapshot.agent.ok ? "ok" : "ng"}(${snapshot.agent.detail})`,
      `compose=${snapshot.compose.ok ? "ok" : "ng"}(${snapshot.compose.detail})`,
    ].join(" "),
  );
}

async function handleLogsCommand(args: string[]): Promise<void> {
  const target = args[0] ?? "all";
  const tail = parsePositiveInt(args[1], 120);
  if (target === "all") {
    await runComposeAndPrint(["logs", "--tail", String(tail)]);
    return;
  }
  if (target !== "agent" && target !== "postgres") {
    console.log("[debug] logs target must be one of: all | agent | postgres");
    return;
  }
  await runComposeAndPrint(["logs", target, "--tail", String(tail)]);
}

async function handleRestartCommand(targetRaw: string | undefined): Promise<void> {
  const target = targetRaw ?? "all";
  if (target === "all") {
    const services = resolveSelectedComposeServices(currentConfig.components);
    if (services.length === 0) {
      console.log("[debug] no compose services are enabled.");
      return;
    }
    await runComposeAndPrint(["restart", ...services]);
    return;
  }
  if (target !== "agent" && target !== "postgres") {
    console.log("[debug] restart target must be one of: all | agent | postgres");
    return;
  }
  await runComposeAndPrint(["restart", target]);
}

async function handleUpCommand(): Promise<void> {
  const services = resolveSelectedComposeServices(currentConfig.components);
  if (services.length === 0) {
    console.log("[debug] no compose services are enabled.");
    return;
  }
  await runComposeAndPrint([
    "up",
    "-d",
    ...(currentConfig.settings.composeBuild ? ["--build"] : []),
    ...services,
  ]);
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
  if (output.exitCode !== 0) {
    console.log(`[debug] command failed (exit=${output.exitCode})`);
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
      console.log(
        `[socket] ${socketPath} type=${
          info.isSocket() ? "socket" : "non-socket"
        } mode=${(info.mode & 0o777).toString(8)}`,
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
    health,
    history: commandHistory.slice(-200),
    env: collectImportantEnv(),
  };
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`[debug] snapshot written: ${filePath}`);
}

function printHistory(): void {
  const recent = commandHistory.slice(-100);
  if (recent.length === 0) {
    console.log("[debug] no command history.");
    return;
  }
  for (const line of recent) {
    console.log(line);
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
  console.log("  reset");
  console.log("  start [--yes]");
  console.log("  exit");
}

function printRuntimeHelp(): void {
  console.log("runtime commands:");
  console.log("  help");
  console.log("  status | probe");
  console.log("  ps");
  console.log("  logs [all|agent|postgres] [tail]");
  console.log("  restart [all|agent|postgres]");
  console.log("  up");
  console.log("  down");
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
  const answer = (
    await rl.question("start with current preflight settings? [y/N]: ")
  ).trim();
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
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
  if (arg && arg.length > 0) {
    const value = process.env[arg];
    if (typeof value !== "string") {
      console.log(`${arg}=<unset>`);
      return;
    }
    console.log(`${arg}=${maskEnvValue(arg, value)}`);
    return;
  }
  const entries = collectImportantEnv();
  for (const [key, value] of Object.entries(entries)) {
    console.log(`${key}=${value}`);
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
  if (config.components["db.migrate"] && !config.components["compose.postgres"]) {
    errors.push("db.migrate requires compose.postgres=true");
  }
  if (config.components["compose.agent"] && !config.components["compose.postgres"]) {
    errors.push("compose.agent requires compose.postgres=true");
  }
  if (
    config.components["orchestrator.monitor"] &&
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

function collectImportantEnv(): Record<string, string> {
  const keys = [
    "INTERNAL_CONNECTION_MODE",
    "RUNTIME_SOCKET_DIR",
    "GATEWAY_API_SOCKET_PATH",
    "AGENT_RUNTIME_SOCKET_PATH",
    "AGENT_SOCKET_PATH",
    "BOT_MODE",
    "BOT_ORCHESTRATOR_ENABLED",
    "BOT_ORCHESTRATOR_MONITOR_INTERVAL_SEC",
    "BOT_ORCHESTRATOR_FAILURE_THRESHOLD",
    "BOT_ORCHESTRATOR_COMMAND_TIMEOUT_SEC",
    "BOT_ORCHESTRATOR_CLEANUP_ENABLED",
    "BOT_ORCHESTRATOR_CLEANUP_INTERVAL_SEC",
    "BOT_ORCHESTRATOR_COMPOSE_BUILD",
    "COPILOT_SDK_LOG_LEVEL",
    "STATE_STORE_DSN",
    "MEMORY_STORE_DSN",
  ];
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    result[key] =
      typeof value === "string" ? maskEnvValue(key, value) : "<unset>";
  }
  return result;
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

function createDefaultConfig(): DebugConfig {
  const mode = resolveInternalConnectionMode(
    process.env.INTERNAL_CONNECTION_MODE ?? "tcp",
  );
  const runtimeSocketDir = resolveDefaultRuntimeSocketDir();
  return {
    components: {
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
  console.error("[debug] startup failed:", error);
  process.exit(1);
});
