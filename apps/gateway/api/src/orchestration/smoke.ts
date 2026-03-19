import type { ExecCommandInput, ExecCommandOutput } from "../mcp/exec.js";
import {
  RuntimeSupervisor,
  type RuntimeHealthSnapshot,
} from "./supervisor.js";

interface SupervisorHarness {
  commands: string[];
  alerts: string[];
  logs: string[];
  fatalReasons: string[];
  starts: number;
  stops: number;
  nextProbe: () => RuntimeHealthSnapshot;
}

async function main(): Promise<void> {
  await runBootScenario();
  await runBootFailureRollbackScenario();
  await runTargetedRecoveryScenario();
  await runFullRestartRecoveryScenario();
  await runFatalRecoveryScenario();
  console.log("[orchestrator:smoke] runtime supervisor checks passed.");
}

async function runBootScenario(): Promise<void> {
  const harness = createHarness([healthySnapshot()]);
  const supervisor = createSupervisor(harness, 2);

  await supervisor.boot();
  await supervisor.shutdown();

  assertIncludes(
    harness.commands,
    "docker compose up -d --build",
    "boot should call compose up",
  );
  assertIncludes(
    harness.commands,
    "yarn db:migrate:local",
    "boot should call db migrate",
  );
  assert(harness.starts >= 1, "boot should start gateway-api");
  assert(harness.stops >= 1, "shutdown should stop gateway-api");
}

async function runBootFailureRollbackScenario(): Promise<void> {
  const harness = createHarness([unhealthySnapshot()]);
  const supervisor = createSupervisor(harness, 2);

  let failed = false;
  try {
    await supervisor.boot();
  } catch {
    failed = true;
  }

  assert(failed, "boot should fail when initial health check fails");
  assertIncludes(
    harness.commands,
    "docker compose down --remove-orphans",
    "boot failure should roll back compose",
  );
  assert(harness.starts >= 1, "boot failure scenario should start gateway-api once");
  assert(harness.stops >= 1, "boot failure scenario should stop gateway-api");
}

async function runTargetedRecoveryScenario(): Promise<void> {
  const harness = createHarness([
    healthySnapshot(),
    unhealthySnapshot(),
    unhealthySnapshot(),
    healthySnapshot(),
  ]);
  const supervisor = createSupervisor(harness, 2);

  await supervisor.boot();
  await supervisor.runMonitorCycleNow();
  await supervisor.runMonitorCycleNow();
  await supervisor.shutdown();

  assertIncludes(
    harness.commands,
    "docker compose restart agent postgres",
    "targeted recovery should restart compose services",
  );
  const migrateCount = harness.commands.filter(
    (command) => command === "yarn db:migrate:local",
  ).length;
  assert(
    migrateCount >= 2,
    "targeted recovery should run db migrate after service restart",
  );
  assert(
    harness.alerts.some((message) => message.includes("recovered after targeted restart")),
    "targeted recovery should emit recovered alert",
  );
}

async function runFullRestartRecoveryScenario(): Promise<void> {
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

  assertIncludes(
    harness.commands,
    "docker compose down --remove-orphans",
    "full recovery should include compose down",
  );
  const composeUpCount = harness.commands.filter(
    (command) => command === "docker compose up -d --build",
  ).length;
  assert(composeUpCount >= 2, "full recovery should compose up again");
  assert(
    harness.alerts.some((message) => message.includes("recovered after full restart")),
    "full recovery should emit recovered alert",
  );
}

async function runFatalRecoveryScenario(): Promise<void> {
  const harness = createHarness([
    healthySnapshot(),
    unhealthySnapshot(),
    unhealthySnapshot(),
    unhealthySnapshot(),
    unhealthySnapshot(),
  ]);
  const supervisor = createSupervisor(harness, 2);

  await supervisor.boot();
  await supervisor.runMonitorCycleNow();
  await supervisor.runMonitorCycleNow();
  await supervisor.shutdown();

  assert(harness.fatalReasons.length === 1, "fatal recovery should invoke onFatal once");
  const fatalReason = harness.fatalReasons[0] ?? "";
  assert(
    fatalReason.includes("recovery failed after full restart"),
    "fatal reason should mention full restart failure",
  );
  assert(
    harness.alerts.some((message) => message.includes("recovery failed after full restart")),
    "fatal recovery should emit failure alert",
  );
}

function createHarness(initialProbes: RuntimeHealthSnapshot[]): SupervisorHarness {
  const probes = [...initialProbes];
  let last = probes.at(-1) ?? healthySnapshot();

  return {
    commands: [],
    alerts: [],
    logs: [],
    fatalReasons: [],
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
    onFatal: async (reason) => {
      harness.fatalReasons.push(reason);
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

function assertIncludes(haystack: string[], expected: string, message: string): void {
  assert(haystack.includes(expected), `${message} (missing: ${expected})`);
}

main().catch((error) => {
  console.error("[orchestrator:smoke] failed:", error);
  process.exit(1);
});
