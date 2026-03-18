import type { ExecCommandInput, ExecCommandOutput } from "../mcp/exec.js";
import {
  RuntimeSupervisor,
  type RuntimeHealthSnapshot,
} from "./supervisor.js";

interface SupervisorHarness {
  commands: string[];
  alerts: string[];
  logs: string[];
  starts: number;
  stops: number;
  nextProbe: () => RuntimeHealthSnapshot;
}

async function main(): Promise<void> {
  await runBootScenario();
  await runRecoveryScenario();
  console.log("[orchestrator:smoke] runtime supervisor checks passed.");
}

async function runBootScenario(): Promise<void> {
  const harness = createHarness([healthySnapshot()]);
  const supervisor = createSupervisor(harness, 2);

  await supervisor.boot();
  await supervisor.shutdown();

  assert(
    harness.commands.some(
      (command) => command === "docker compose up -d --build",
    ),
    "boot should call compose up",
  );
  assert(
    harness.commands.some((command) => command === "yarn db:migrate:local"),
    "boot should call db migrate",
  );
  assert(harness.starts >= 1, "boot should start gateway-api");
  assert(harness.stops >= 1, "shutdown should stop gateway-api");
}

async function runRecoveryScenario(): Promise<void> {
  const harness = createHarness([
    healthySnapshot(),
    unhealthySnapshot(),
    unhealthySnapshot(),
    unhealthySnapshot(),
    healthySnapshot(),
  ]);
  const supervisor = createSupervisor(harness, 2);

  await supervisor.boot();
  await supervisor.runMonitorCycleNow();
  await supervisor.runMonitorCycleNow();
  await supervisor.shutdown();

  assert(
    harness.commands.includes("docker compose restart agent postgres"),
    "recovery should restart compose services",
  );
  const migrateCount = harness.commands.filter(
    (command) => command === "yarn db:migrate:local",
  ).length;
  assert(
    migrateCount >= 2,
    "recovery should run db migrate again after compose restart",
  );
  assert(
    harness.alerts.some((message) => message.includes("recovered")),
    "recovery scenario should emit recovered alert",
  );
}

function createHarness(initialProbes: RuntimeHealthSnapshot[]): SupervisorHarness {
  const probes = [...initialProbes];
  let last = probes.at(-1) ?? healthySnapshot();

  return {
    commands: [],
    alerts: [],
    logs: [],
    starts: 0,
    stops: 0,
    nextProbe: () => {
      const next = probes.shift() ?? last;
      last = next;
      return next;
    },
  };
}

function createSupervisor(
  harness: SupervisorHarness,
  failureThreshold: number,
): RuntimeSupervisor {
  return new RuntimeSupervisor({
    projectRoot: process.cwd(),
    gatewayApiBaseUrl: "http://127.0.0.1:3800",
    gatewayApiHost: "127.0.0.1",
    gatewayApiPort: 3800,
    agentRuntimeBaseUrl: "http://127.0.0.1:3801",
    composeBuild: true,
    monitorIntervalSec: 1,
    failureThreshold,
    commandTimeoutSec: 30,
    monitoringEnabled: false,
    onLog: (message) => {
      harness.logs.push(message);
    },
    onAlert: async (message) => {
      harness.alerts.push(message);
    },
    hooks: {
      execCommand: async (input: ExecCommandInput): Promise<ExecCommandOutput> => {
        harness.commands.push(`${input.command} ${input.args.join(" ")}`.trim());
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
        };
      },
      probeRuntime: async () => harness.nextProbe(),
      startGatewayApi: async () => {
        harness.starts += 1;
      },
      stopGatewayApi: async () => {
        harness.stops += 1;
      },
    },
  });
}

function healthySnapshot(): RuntimeHealthSnapshot {
  return {
    gateway: {
      ok: true,
      statusCode: 200,
      detail: "ok",
    },
    agent: {
      ok: true,
      statusCode: 200,
      detail: "ok",
    },
    compose: {
      ok: true,
      runningServices: ["postgres", "agent"],
      missingServices: [],
      detail: "ok",
    },
  };
}

function unhealthySnapshot(): RuntimeHealthSnapshot {
  return {
    gateway: {
      ok: false,
      statusCode: null,
      detail: "connection refused",
    },
    agent: {
      ok: false,
      statusCode: null,
      detail: "connection refused",
    },
    compose: {
      ok: false,
      runningServices: ["postgres"],
      missingServices: ["agent"],
      detail: "missing=agent",
    },
  };
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[orchestrator:smoke] assertion failed: ${message}`);
  }
}

main().catch((error) => {
  console.error("[orchestrator:smoke] failed:", error);
  process.exit(1);
});
