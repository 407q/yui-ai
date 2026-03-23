import { spawn } from "node:child_process";

export interface ExecCommandInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutSec: number;
  stdin?: string;
  envAllowlist?: string[];
  extraEnv?: Record<string, string>;
  inheritProcessEnv?: boolean;
}

export interface ExecCommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function execCommand(
  input: ExecCommandInput,
): Promise<ExecCommandOutput> {
  return new Promise<ExecCommandOutput>((resolve, reject) => {
    const childEnv = buildCommandEnvironment(input);
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutSec * 1000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.stdin.on("error", () => {
      // Ignore broken pipe errors when the process exits before consuming stdin.
    });
    if (typeof input.stdin === "string") {
      child.stdin.write(input.stdin);
    }
    child.stdin.end();

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "SHLVL",
  "COLORTERM",
  "NO_COLOR",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "COMPOSE_PROJECT_NAME",
  "COMPOSE_PROFILES",
] as const;

function buildCommandEnvironment(input: ExecCommandInput): NodeJS.ProcessEnv {
  if (
    input.inheritProcessEnv !== false &&
    input.envAllowlist === undefined &&
    input.extraEnv === undefined
  ) {
    return process.env;
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of DEFAULT_ENV_ALLOWLIST) {
    copyEnvValueIfPresent(env, key);
  }
  for (const key of input.envAllowlist ?? []) {
    if (!isValidEnvKey(key)) {
      continue;
    }
    copyEnvValueIfPresent(env, key);
  }
  if (input.extraEnv) {
    for (const [key, value] of Object.entries(input.extraEnv)) {
      if (!isValidEnvKey(key)) {
        continue;
      }
      env[key] = value;
    }
  }
  return env;
}

function copyEnvValueIfPresent(target: NodeJS.ProcessEnv, key: string): void {
  const value = process.env[key];
  if (typeof value === "string") {
    target[key] = value;
  }
}

function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}
