import type { FastifyInstance } from "fastify";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  execCommand,
  type ExecCommandInput,
  type ExecCommandOutput,
} from "../mcp/exec.js";
import { buildGatewayApiServer } from "../server.js";

export interface RuntimeHealthEndpointStatus {
  ok: boolean;
  statusCode: number | null;
  detail: string;
}

export interface RuntimeComposeStatus {
  ok: boolean;
  runningServices: string[];
  missingServices: string[];
  detail: string;
}

export interface RuntimeHealthSnapshot {
  gateway: RuntimeHealthEndpointStatus;
  agent: RuntimeHealthEndpointStatus;
  compose: RuntimeComposeStatus;
}

interface RuntimeSupervisorHooks {
  execCommand?: (input: ExecCommandInput) => Promise<ExecCommandOutput>;
  probeRuntime?: () => Promise<RuntimeHealthSnapshot>;
  startGatewayApi?: () => Promise<void>;
  stopGatewayApi?: () => Promise<void>;
}

export interface RuntimeSupervisorOptions {
  projectRoot: string;
  gatewayApiBaseUrl: string;
  gatewayApiSocketPath?: string;
  gatewayApiHost: string;
  gatewayApiPort: number;
  agentRuntimeBaseUrl: string;
  agentRuntimeSocketPath?: string;
  composeBuild: boolean;
  monitorIntervalSec: number;
  failureThreshold: number;
  commandTimeoutSec: number;
  cleanupEnabled?: boolean;
  cleanupIntervalSec?: number;
  monitoringEnabled?: boolean;
  onLog?: (message: string) => void;
  onAlert?: (message: string) => Promise<void>;
  onFatal?: (reason: string) => Promise<void>;
  hooks?: RuntimeSupervisorHooks;
}

interface CommandSpec {
  command: string;
  args: string[];
  extraEnv?: Record<string, string>;
}

export interface RuntimeSupervisorShutdownOptions {
  stopCompose?: boolean;
}

export class RuntimeSupervisor {
  private gatewayApp: FastifyInstance | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private monitorInFlight = false;
  private cleanupInFlight = false;
  private consecutiveFailures = 0;
  private booted = false;
  private fatalTriggered = false;
  private readonly composeExtraEnv = resolveComposeCurrentUserEnv();

  constructor(private readonly options: RuntimeSupervisorOptions) {}

  async boot(): Promise<void> {
    if (this.booted) {
      return;
    }

    try {
      this.prepareRuntimeSocketArtifacts();
      this.log("boot: compose up");
      await this.runCommand(this.composeUpCommand());
      this.log("boot: db migrate");
      await this.runCommand({
        command: "yarn",
        args: ["db:migrate:local"],
      });
      this.log("boot: gateway-api start");
      await this.startGatewayApi();

      const probe = await this.probeRuntime();
      if (!isHealthy(probe)) {
        throw new Error(`Boot health check failed: ${formatHealth(probe)}`);
      }

      this.booted = true;
      this.consecutiveFailures = 0;
      this.log("boot: infrastructure is healthy");
      if (this.options.monitoringEnabled ?? true) {
        this.startMonitorLoop();
      }
      if (this.options.cleanupEnabled ?? true) {
        this.startCleanupLoop();
      }
    } catch (error) {
      this.stopMonitorLoop();
      this.stopCleanupLoop();
      this.booted = false;
      await this.runBootRollback();
      throw error;
    }
  }

  async shutdown(options: RuntimeSupervisorShutdownOptions = {}): Promise<void> {
    this.stopMonitorLoop();
    this.stopCleanupLoop();
    await this.stopGatewayApiBestEffort("shutdown");
    if (options.stopCompose) {
      await this.runCommandBestEffort(
        {
          command: "docker",
          args: [
            "compose",
            "-f",
            `docker-compose.${resolveInternalConnectionMode()}.yml`,
            "down",
            "--remove-orphans",
          ],
          extraEnv: this.composeExtraEnv,
        },
        "shutdown: compose down",
      );
    }
    this.consecutiveFailures = 0;
    this.booted = false;
    this.fatalTriggered = false;
    this.log(
      `shutdown: runtime supervisor stopped${
        options.stopCompose ? " (compose stopped)" : ""
      }`,
    );
  }

  async runMonitorCycleNow(): Promise<void> {
    await this.monitorCycle();
  }

  private startMonitorLoop(): void {
    if (this.monitorTimer) {
      return;
    }

    const intervalMs = Math.max(1, this.options.monitorIntervalSec) * 1000;
    this.monitorTimer = setInterval(() => {
      void this.monitorCycle().catch((error: unknown) => {
        this.log(
          `monitor cycle error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, intervalMs);
    this.log(`monitor: started (interval=${this.options.monitorIntervalSec}s)`);
  }

  private stopMonitorLoop(): void {
    if (!this.monitorTimer) {
      return;
    }

    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    this.log("monitor: stopped");
  }

  private startCleanupLoop(): void {
    if (this.cleanupTimer) {
      return;
    }
    const intervalSec = Math.max(60, this.options.cleanupIntervalSec ?? 24 * 60 * 60);
    const intervalMs = intervalSec * 1000;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupCycle().catch((error: unknown) => {
        this.log(
          `cleanup cycle error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, intervalMs);
    this.log(`cleanup: started (interval=${intervalSec}s)`);
  }

  private stopCleanupLoop(): void {
    if (!this.cleanupTimer) {
      return;
    }
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.log("cleanup: stopped");
  }

  private async cleanupCycle(): Promise<void> {
    if (this.cleanupInFlight) {
      return;
    }
    this.cleanupInFlight = true;
    try {
      await this.runCommand({
        command: "yarn",
        args: ["db:cleanup:local"],
      });
      this.log("cleanup: completed");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.alert(`🚨 [orchestrator] cleanup failed: ${detail}`);
    } finally {
      this.cleanupInFlight = false;
    }
  }

  private async monitorCycle(): Promise<void> {
    if (this.monitorInFlight) {
      return;
    }

    this.monitorInFlight = true;
    try {
      const probe = await this.probeRuntime();
      if (isHealthy(probe)) {
        if (this.consecutiveFailures > 0) {
          this.log("monitor: recovered");
        }
        this.consecutiveFailures = 0;
        return;
      }

      this.consecutiveFailures += 1;
      this.log(
        `monitor: health failed (${this.consecutiveFailures}/${this.options.failureThreshold}) ${formatHealth(
          probe,
        )}`,
      );

      if (this.consecutiveFailures < this.options.failureThreshold) {
        return;
      }

      await this.recoverFromFailure(probe);
    } finally {
      this.monitorInFlight = false;
    }
  }

  private async recoverFromFailure(lastProbe: RuntimeHealthSnapshot): Promise<void> {
    await this.alert(
      `⚠️ [orchestrator] health degraded, starting recovery: ${formatHealth(lastProbe)}`,
    );

    const targetedProbe = await this.tryTargetedRestart(lastProbe);
    if (isHealthy(targetedProbe)) {
      this.consecutiveFailures = 0;
      await this.alert("✅ [orchestrator] recovered after targeted restart.");
      return;
    }

    await this.alert(
      `⚠️ [orchestrator] targeted restart failed, trying full restart: ${formatHealth(
        targetedProbe,
      )}`,
    );
    const fullRestartProbe = await this.tryFullRestart();
    if (isHealthy(fullRestartProbe)) {
      this.consecutiveFailures = 0;
      await this.alert("✅ [orchestrator] recovered after full restart.");
      return;
    }

    this.consecutiveFailures = this.options.failureThreshold;
    const fatalReason = `🚨 [orchestrator] recovery failed after full restart: ${formatHealth(
      fullRestartProbe,
    )}`;
    await this.alert(fatalReason);
    await this.triggerFatal(
      `${fatalReason}. runtime supervisor will stop and request graceful shutdown.`,
    );
  }

  private async triggerFatal(reason: string): Promise<void> {
    if (this.fatalTriggered) {
      return;
    }
    this.fatalTriggered = true;
    this.stopMonitorLoop();
    this.booted = false;
    if (!this.options.onFatal) {
      return;
    }
    await this.options.onFatal(reason);
  }

  private async tryTargetedRestart(
    lastProbe: RuntimeHealthSnapshot,
  ): Promise<RuntimeHealthSnapshot> {
    let attempted = false;

    if (!lastProbe.gateway.ok) {
      attempted = true;
      try {
        this.log("recovery: restarting gateway-api");
        await this.restartGatewayApi();
      } catch (error) {
        this.log(
          `recovery: gateway restart failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (!lastProbe.agent.ok || !lastProbe.compose.ok) {
      attempted = true;
      try {
        this.log("recovery: restarting compose services (agent/postgres)");
        await this.runCommand({
          command: "docker",
          args: [
            "compose",
            "-f",
            `docker-compose.${resolveInternalConnectionMode()}.yml`,
            "restart",
            "agent",
            "postgres",
          ],
          extraEnv: this.composeExtraEnv,
        });
        await this.runCommand({
          command: "yarn",
          args: ["db:migrate:local"],
        });
      } catch (error) {
        this.log(
          `recovery: compose service restart failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (!attempted) {
      this.log("recovery: no targeted restart candidates");
    }
    return this.probeRuntime();
  }

  private async tryFullRestart(): Promise<RuntimeHealthSnapshot> {
    try {
      this.log("recovery: full restart begin");
      await this.stopGatewayApiBestEffort("recovery: full restart gateway stop");
      await this.runCommand({
        command: "docker",
        args: [
          "compose",
          "-f",
          `docker-compose.${resolveInternalConnectionMode()}.yml`,
          "down",
          "--remove-orphans",
        ],
        extraEnv: this.composeExtraEnv,
      });
      await this.runCommand(this.composeUpCommand());
      await this.runCommand({
        command: "yarn",
        args: ["db:migrate:local"],
      });
      await this.startGatewayApi();
    } catch (error) {
      this.log(
        `recovery: full restart failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return this.probeRuntime();
  }

  private composeUpCommand(): CommandSpec {
    return this.options.composeBuild
      ? {
          command: "docker",
          args: [
            "compose",
            "-f",
            `docker-compose.${resolveInternalConnectionMode()}.yml`,
            "up",
            "-d",
            "--build",
          ],
          extraEnv: this.composeExtraEnv,
        }
      : {
          command: "yarn",
          args: ["compose:up:local"],
        };
  }

  private async runBootRollback(): Promise<void> {
    await this.stopGatewayApiBestEffort("boot rollback: gateway stop");
    await this.runCommandBestEffort(
      {
        command: "docker",
        args: [
          "compose",
          "-f",
          `docker-compose.${resolveInternalConnectionMode()}.yml`,
          "down",
          "--remove-orphans",
        ],
        extraEnv: this.composeExtraEnv,
      },
      "boot rollback: compose down",
    );
  }

  private async stopGatewayApiBestEffort(context: string): Promise<void> {
    try {
      await this.stopGatewayApi();
    } catch (error) {
      this.log(
        `${context} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async runCommandBestEffort(
    spec: CommandSpec,
    context: string,
  ): Promise<void> {
    try {
      await this.runCommand(spec);
    } catch (error) {
      this.log(
        `${context} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async restartGatewayApi(): Promise<void> {
    await this.stopGatewayApi();
    await this.startGatewayApi();
  }

  private async startGatewayApi(): Promise<void> {
    if (this.options.hooks?.startGatewayApi) {
      await this.options.hooks.startGatewayApi();
      return;
    }

    if (this.gatewayApp) {
      return;
    }

    this.gatewayApp = buildGatewayApiServer();
    if (
      this.options.gatewayApiSocketPath &&
      this.options.gatewayApiSocketPath.trim().length > 0
    ) {
      prepareSocketPath(this.options.gatewayApiSocketPath);
      await this.gatewayApp.listen({
        path: this.options.gatewayApiSocketPath,
      });
      return;
    }
    await this.gatewayApp.listen({
      host: this.options.gatewayApiHost,
      port: this.options.gatewayApiPort,
    });
  }

  private async stopGatewayApi(): Promise<void> {
    if (this.options.hooks?.stopGatewayApi) {
      await this.options.hooks.stopGatewayApi();
      return;
    }

    if (!this.gatewayApp) {
      return;
    }

    const app = this.gatewayApp;
    this.gatewayApp = null;
    await app.close();
  }

  private async probeRuntime(): Promise<RuntimeHealthSnapshot> {
    if (this.options.hooks?.probeRuntime) {
      return this.options.hooks.probeRuntime();
    }

    const gatewayProbe = this.options.gatewayApiSocketPath
      ? this.probeEndpointViaSocket(this.options.gatewayApiSocketPath, "/health")
      : this.probeEndpoint(`${this.options.gatewayApiBaseUrl}/health`);
    const agentProbe = this.options.agentRuntimeSocketPath
      ? this.probeEndpointViaSocket(this.options.agentRuntimeSocketPath, "/health")
      : this.probeEndpoint(`${this.options.agentRuntimeBaseUrl}/health`);

    const [gateway, agent, compose] = await Promise.all([
      gatewayProbe,
      agentProbe,
      this.probeComposeServices(),
    ]);

    return {
      gateway,
      agent,
      compose,
    };
  }

  private async probeEndpoint(url: string): Promise<RuntimeHealthEndpointStatus> {
    const timeoutSec = Math.min(10, Math.max(1, this.options.commandTimeoutSec));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutSec * 1000);

    try {
      const response = await fetch(url, { signal: controller.signal });
      const text = await response.text();
      const detail = response.ok
        ? `status=${response.status}`
        : `status=${response.status} body=${truncate(text, 120)}`;
      return {
        ok: response.ok,
        statusCode: response.status,
        detail,
      };
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : `unexpected: ${String(error)}`;
      return {
        ok: false,
        statusCode: null,
        detail,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async probeEndpointViaSocket(
    socketPath: string,
    pathname: string,
  ): Promise<RuntimeHealthEndpointStatus> {
    const timeoutSec = Math.min(10, Math.max(1, this.options.commandTimeoutSec));
    try {
      const response = await requestTextViaUnixSocket({
        socketPath,
        pathname,
        timeoutSec,
      });
      const ok = response.statusCode >= 200 && response.statusCode < 300;
      const detail = ok
        ? `status=${response.statusCode}`
        : `status=${response.statusCode} body=${truncate(response.bodyText, 120)}`;
      return {
        ok,
        statusCode: response.statusCode,
        detail,
      };
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : `unexpected: ${String(error)}`;
      return {
        ok: false,
        statusCode: null,
        detail,
      };
    }
  }

  private async probeComposeServices(): Promise<RuntimeComposeStatus> {
    const output = await this.runCommandRaw({
      command: "docker",
      args: [
        "compose",
        "-f",
        `docker-compose.${resolveInternalConnectionMode()}.yml`,
        "ps",
        "--services",
        "--status",
        "running",
      ],
      extraEnv: this.composeExtraEnv,
    });
    if (output.timedOut) {
      return {
        ok: false,
        runningServices: [],
        missingServices: ["agent", "postgres"],
        detail: "docker compose ps timed out",
      };
    }
    if (output.exitCode !== 0) {
      return {
        ok: false,
        runningServices: [],
        missingServices: ["agent", "postgres"],
        detail: truncate(output.stderr || output.stdout, 160),
      };
    }

    const runningServices = output.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const required = ["agent", "postgres"];
    const missingServices = required.filter(
      (service) => !runningServices.includes(service),
    );
    return {
      ok: missingServices.length === 0,
      runningServices,
      missingServices,
      detail:
        missingServices.length === 0
          ? "agent/postgres running"
          : `missing=${missingServices.join(",")}`,
    };
  }

  private async runCommand(spec: CommandSpec): Promise<void> {
    const output = await this.runCommandRaw(spec);
    if (output.timedOut) {
      throw new Error(`${spec.command} ${spec.args.join(" ")} timed out`);
    }
    if (output.exitCode !== 0) {
      throw new Error(
        `${spec.command} ${spec.args.join(" ")} failed: ${truncate(
          output.stderr || output.stdout,
          200,
        )}`,
      );
    }
  }

  private async runCommandRaw(spec: CommandSpec): Promise<ExecCommandOutput> {
    const execute = this.options.hooks?.execCommand ?? execCommand;
    return execute({
      command: spec.command,
      args: spec.args,
      cwd: this.options.projectRoot,
      timeoutSec: this.options.commandTimeoutSec,
      extraEnv: spec.extraEnv,
    });
  }

  private prepareRuntimeSocketArtifacts(): void {
    if (resolveInternalConnectionMode() !== "uds") {
      return;
    }

    const socketPaths = [
      this.options.gatewayApiSocketPath,
      this.options.agentRuntimeSocketPath,
    ]
      .filter((value): value is string => Boolean(value && value.trim().length > 0))
      .map((value) => path.resolve(value));
    if (socketPaths.length === 0) {
      return;
    }

    this.log(`boot: prepare uds sockets (${socketPaths.length})`);
    for (const socketPath of socketPaths) {
      try {
        ensureSocketPlaceholder(socketPath);
      } catch (error) {
        throw new Error(
          `failed to prepare socket path: ${socketPath} (${toErrorMessage(error)})`,
        );
      }
    }
  }

  private log(message: string): void {
    if (!this.options.onLog) {
      return;
    }
    this.options.onLog(message);
  }

  private async alert(message: string): Promise<void> {
    this.log(message);
    if (!this.options.onAlert) {
      return;
    }
    await this.options.onAlert(message);
  }
}

function isHealthy(snapshot: RuntimeHealthSnapshot): boolean {
  return snapshot.gateway.ok && snapshot.agent.ok && snapshot.compose.ok;
}

function formatHealth(snapshot: RuntimeHealthSnapshot): string {
  return [
    `gateway=${snapshot.gateway.ok ? "ok" : `ng(${snapshot.gateway.detail})`}`,
    `agent=${snapshot.agent.ok ? "ok" : `ng(${snapshot.agent.detail})`}`,
    `compose=${snapshot.compose.ok ? "ok" : `ng(${snapshot.compose.detail})`}`,
  ].join(" ");
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function prepareSocketPath(socketPath: string): void {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  if (!existsSync(socketPath)) {
    return;
  }
  unlinkSync(socketPath);
}

function ensureSocketPlaceholder(socketPath: string): void {
  mkdirSync(path.dirname(socketPath), {
    recursive: true,
    mode: 0o700,
  });
  if (existsSync(socketPath)) {
    return;
  }
  const fd = openSync(socketPath, "a", 0o600);
  closeSync(fd);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function resolveComposeCurrentUserEnv(): Record<string, string> {
  return {
    CURRENT_UID: resolveCurrentUid(),
    CURRENT_GID: resolveCurrentGid(),
  };
}

function resolveCurrentUid(): string {
  if (typeof process.getuid === "function") {
    return String(process.getuid());
  }
  return "1000";
}

function resolveCurrentGid(): string {
  if (typeof process.getgid === "function") {
    return String(process.getgid());
  }
  return "1000";
}

interface UnixSocketHealthRequestInput {
  socketPath: string;
  pathname: string;
  timeoutSec: number;
}

interface UnixSocketHealthResponse {
  statusCode: number;
  bodyText: string;
}

function requestTextViaUnixSocket(
  input: UnixSocketHealthRequestInput,
): Promise<UnixSocketHealthResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: input.socketPath,
        path: input.pathname,
        method: "GET",
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
            bodyText: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(input.timeoutSec * 1000, () => {
      req.destroy(new Error("socket probe timeout"));
    });
    req.end();
  });
}

function resolveInternalConnectionMode(): "tcp" | "uds" {
  const mode = (process.env.INTERNAL_CONNECTION_MODE ?? "").toLowerCase();
  if (mode === "tcp" || mode === "uds") {
    return mode;
  }
  throw new Error(
    "INTERNAL_CONNECTION_MODE is required and must be either 'tcp' or 'uds'.",
  );
}
