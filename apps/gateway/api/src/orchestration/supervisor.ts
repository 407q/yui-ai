import type { FastifyInstance } from "fastify";
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
  gatewayApiHost: string;
  gatewayApiPort: number;
  agentRuntimeBaseUrl: string;
  composeBuild: boolean;
  monitorIntervalSec: number;
  failureThreshold: number;
  commandTimeoutSec: number;
  monitoringEnabled?: boolean;
  onLog?: (message: string) => void;
  onAlert?: (message: string) => Promise<void>;
  hooks?: RuntimeSupervisorHooks;
}

interface CommandSpec {
  command: string;
  args: string[];
}

export class RuntimeSupervisor {
  private gatewayApp: FastifyInstance | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private monitorInFlight = false;
  private consecutiveFailures = 0;
  private booted = false;

  constructor(private readonly options: RuntimeSupervisorOptions) {}

  async boot(): Promise<void> {
    if (this.booted) {
      return;
    }

    try {
      this.log("boot: compose up");
      await this.runCommand(
        this.options.composeBuild
          ? {
              command: "docker",
              args: ["compose", "up", "-d", "--build"],
            }
          : {
              command: "yarn",
              args: ["compose:up:local"],
            },
      );
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
    } catch (error) {
      this.stopMonitorLoop();
      await this.stopGatewayApi();
      this.booted = false;
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.stopMonitorLoop();
    await this.stopGatewayApi();
    this.consecutiveFailures = 0;
    this.booted = false;
    this.log("shutdown: runtime supervisor stopped");
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

    try {
      await this.restartGatewayApi();
    } catch (error) {
      this.log(
        `recovery: gateway restart failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const gatewayProbe = await this.probeRuntime();
    if (isHealthy(gatewayProbe)) {
      this.consecutiveFailures = 0;
      await this.alert("✅ [orchestrator] recovered after gateway-api restart.");
      return;
    }

    this.log(`recovery: gateway restart not enough: ${formatHealth(gatewayProbe)}`);
    await this.runCommand({
      command: "docker",
      args: ["compose", "restart", "agent", "postgres"],
    });
    await this.runCommand({
      command: "yarn",
      args: ["db:migrate:local"],
    });

    const composeProbe = await this.probeRuntime();
    if (isHealthy(composeProbe)) {
      this.consecutiveFailures = 0;
      await this.alert("✅ [orchestrator] recovered after compose restart.");
      return;
    }

    this.consecutiveFailures = this.options.failureThreshold;
    await this.alert(
      `🚨 [orchestrator] recovery failed, manual intervention required: ${formatHealth(
        composeProbe,
      )}`,
    );
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

    const [gateway, agent, compose] = await Promise.all([
      this.probeEndpoint(`${this.options.gatewayApiBaseUrl}/health`),
      this.probeEndpoint(`${this.options.agentRuntimeBaseUrl}/health`),
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

  private async probeComposeServices(): Promise<RuntimeComposeStatus> {
    const output = await this.runCommandRaw({
      command: "docker",
      args: ["compose", "ps", "--services", "--status", "running"],
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
    });
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
