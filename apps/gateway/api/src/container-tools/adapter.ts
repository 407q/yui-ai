import { promises as fs } from "node:fs";
import path from "node:path";
import { execCommand } from "../mcp/exec.js";

const CANONICAL_CONTAINER_SESSION_ROOT = "/agent/session";

export interface ContainerToolAdapterOptions {
  sessionRoot: string;
  cliTimeoutSec: number;
  executionMode: "host" | "docker_exec";
  containerName: string;
  dockerCliTimeoutSec: number;
  dockerProjectRoot: string;
}

export interface ContainerCliInput {
  sessionId: string;
  command: string;
  args: string[];
  cwd?: string;
  timeoutSec?: number;
}

export interface ContainerFileStat {
  path: string;
  bytes: number;
}

export interface ContainerFileBase64Read {
  path: string;
  bytes: number;
  contentBase64: string;
}

export class ContainerToolAdapter {
  constructor(private readonly options: ContainerToolAdapterOptions) {}

  getSessionRoot(sessionId: string): string {
    return path.resolve(this.options.sessionRoot, sessionId);
  }

  private resolveCanonicalSessionAliasPath(
    sessionId: string,
    requestedPath: string,
  ): string | null {
    if (!path.isAbsolute(requestedPath)) {
      return null;
    }
    const requestedAbsolutePath = path.resolve(requestedPath);
    const canonicalSessionRoot = path.resolve(
      CANONICAL_CONTAINER_SESSION_ROOT,
      sessionId,
    );
    if (requestedAbsolutePath === canonicalSessionRoot) {
      return this.getSessionRoot(sessionId);
    }
    if (!requestedAbsolutePath.startsWith(`${canonicalSessionRoot}${path.sep}`)) {
      return null;
    }
    const relative = path.relative(canonicalSessionRoot, requestedAbsolutePath);
    return path.resolve(this.getSessionRoot(sessionId), relative);
  }

  resolveScopedPath(sessionId: string, requestedPath: string): string | null {
    const sessionRoot = this.getSessionRoot(sessionId);
    const resolved = path.isAbsolute(requestedPath)
      ? this.resolveCanonicalSessionAliasPath(sessionId, requestedPath) ??
        path.resolve(requestedPath)
      : path.resolve(sessionRoot, requestedPath);
    if (resolved === sessionRoot) {
      return resolved;
    }
    if (resolved.startsWith(`${sessionRoot}${path.sep}`)) {
      return resolved;
    }
    return null;
  }

  private resolveContainerPath(sessionId: string, requestedPath: string): string | null {
    const canonicalSessionRoot = path.posix.join(CANONICAL_CONTAINER_SESSION_ROOT, sessionId);
    if (path.isAbsolute(requestedPath)) {
      const normalized = path.posix.normalize(requestedPath);
      if (normalized === canonicalSessionRoot) {
        return normalized;
      }
      if (normalized.startsWith(`${canonicalSessionRoot}/`)) {
        return normalized;
      }
      return null;
    }

    const normalized = path.posix.normalize(
      path.posix.join(canonicalSessionRoot, requestedPath),
    );
    if (normalized === canonicalSessionRoot) {
      return normalized;
    }
    if (normalized.startsWith(`${canonicalSessionRoot}/`)) {
      return normalized;
    }
    return null;
  }

  private async statFileInAgentContainer(
    sessionId: string,
    requestedPath: string,
  ): Promise<ContainerFileStat> {
    const containerPath = this.resolveContainerPath(sessionId, requestedPath);
    if (!containerPath) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }
    const script = [
      "set -eu",
      `TARGET_PATH=${shellQuote(containerPath)}`,
      'if [ ! -e "$TARGET_PATH" ]; then',
      "  echo '__YUI_STAT__:not_found'",
      "  exit 0",
      "fi",
      'if [ ! -f "$TARGET_PATH" ]; then',
      "  echo '__YUI_STAT__:not_file'",
      "  exit 0",
      "fi",
      'BYTES=$(wc -c < "$TARGET_PATH")',
      "echo \"__YUI_STAT__:ok:$BYTES\"",
    ].join("\n");
    const executed = await execCommand({
      command: "docker",
      args: ["exec", "-i", this.options.containerName, "sh", "-lc", script],
      cwd: this.options.dockerProjectRoot,
      timeoutSec: this.options.dockerCliTimeoutSec,
    });
    if (executed.exitCode !== 0) {
      throw new Error(executed.stderr || executed.stdout || "container_file_stat_failed");
    }
    const marker = executed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("__YUI_STAT__:"));
    if (!marker) {
      throw new Error("container_file_stat_failed");
    }
    if (marker === "__YUI_STAT__:not_found") {
      throw new Error("container_path_not_found");
    }
    if (marker === "__YUI_STAT__:not_file") {
      throw new Error("container_path_not_file");
    }
    const match = marker.match(/^__YUI_STAT__:ok:(\d+)$/);
    if (!match || !match[1]) {
      throw new Error("container_file_stat_failed");
    }
    const bytes = Number.parseInt(match[1], 10);
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error("container_file_stat_failed");
    }
    return {
      path: containerPath,
      bytes,
    };
  }

  private async readFileBase64InAgentContainer(
    sessionId: string,
    requestedPath: string,
    maxBytes: number,
  ): Promise<ContainerFileBase64Read> {
    const stat = await this.statFileInAgentContainer(sessionId, requestedPath);
    if (stat.bytes > maxBytes) {
      throw new Error("container_file_too_large");
    }
    const script = [
      "set -eu",
      `TARGET_PATH=${shellQuote(stat.path)}`,
      'base64 < "$TARGET_PATH"',
    ].join("\n");
    const executed = await execCommand({
      command: "docker",
      args: ["exec", "-i", this.options.containerName, "sh", "-lc", script],
      cwd: this.options.dockerProjectRoot,
      timeoutSec: this.options.dockerCliTimeoutSec,
    });
    if (executed.exitCode !== 0) {
      throw new Error(executed.stderr || executed.stdout || "container_file_read_failed");
    }
    return {
      path: stat.path,
      bytes: stat.bytes,
      contentBase64: executed.stdout.replace(/\s+/g, ""),
    };
  }

  private async executeInAgentContainer(
    sessionId: string,
    command: string,
    args: string[],
    cwd?: string,
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }> {
    const containerCwd = this.resolveContainerPath(
      sessionId,
      cwd ?? path.posix.join("workspace"),
    );
    if (!containerCwd) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }

    const wrapperScript = [
      "set -eu",
      `mkdir -p ${shellQuote(containerCwd)}`,
      `cd ${shellQuote(containerCwd)}`,
      `${[command, ...args].map((entry) => shellQuote(entry)).join(" ")}`,
    ].join("\n");

    return execCommand({
      command: "docker",
      args: ["exec", "-i", this.options.containerName, "sh", "-lc", wrapperScript],
      cwd: this.options.dockerProjectRoot,
      timeoutSec: this.options.dockerCliTimeoutSec,
    });
  }

  private async readFileInAgentContainer(
    sessionId: string,
    requestedPath: string,
  ): Promise<{
    path: string;
    content: string;
  }> {
    const containerPath = this.resolveContainerPath(sessionId, requestedPath);
    if (!containerPath) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }
    const script = `set -eu\ncat ${shellQuote(containerPath)}`;
    const executed = await execCommand({
      command: "docker",
      args: ["exec", "-i", this.options.containerName, "sh", "-lc", script],
      cwd: this.options.dockerProjectRoot,
      timeoutSec: this.options.dockerCliTimeoutSec,
    });
    if (executed.exitCode !== 0) {
      throw new Error(executed.stderr || executed.stdout || "container_file_read_failed");
    }
    return {
      path: containerPath,
      content: executed.stdout,
    };
  }

  private async writeFileInAgentContainer(
    sessionId: string,
    requestedPath: string,
    content: string,
  ): Promise<{
    path: string;
    bytes: number;
  }> {
    const containerPath = this.resolveContainerPath(sessionId, requestedPath);
    if (!containerPath) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }
    const script = [
      "set -eu",
      `mkdir -p ${shellQuote(path.posix.dirname(containerPath))}`,
      `cat > ${shellQuote(containerPath)}`,
    ].join("\n");
    const executed = await execCommand({
      command: "docker",
      args: ["exec", "-i", this.options.containerName, "sh", "-lc", script],
      cwd: this.options.dockerProjectRoot,
      timeoutSec: this.options.dockerCliTimeoutSec,
      stdin: content,
    });
    if (executed.exitCode !== 0) {
      throw new Error(executed.stderr || executed.stdout || "container_file_write_failed");
    }
    return {
      path: containerPath,
      bytes: Buffer.byteLength(content, "utf8"),
    };
  }

  private async deleteFileInAgentContainer(
    sessionId: string,
    requestedPath: string,
  ): Promise<{
    path: string;
  }> {
    const containerPath = this.resolveContainerPath(sessionId, requestedPath);
    if (!containerPath) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }
    const script = `set -eu\nrm -rf ${shellQuote(containerPath)}`;
    const executed = await execCommand({
      command: "docker",
      args: ["exec", "-i", this.options.containerName, "sh", "-lc", script],
      cwd: this.options.dockerProjectRoot,
      timeoutSec: this.options.dockerCliTimeoutSec,
    });
    if (executed.exitCode !== 0) {
      throw new Error(executed.stderr || executed.stdout || "container_file_delete_failed");
    }
    return {
      path: containerPath,
    };
  }

  private async listFileInAgentContainer(
    sessionId: string,
    requestedPath: string,
  ): Promise<{
    path: string;
    entries: Array<{ name: string; type: "file" | "directory" | "other" }>;
  }> {
    const containerPath = this.resolveContainerPath(sessionId, requestedPath);
    if (!containerPath) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }
    const script = [
      "set -eu",
      `TARGET_PATH=${shellQuote(containerPath)}`,
      "[ -d \"$TARGET_PATH\" ]",
      "cd \"$TARGET_PATH\"",
      "for name in .[!.]* ..?* *; do",
      "  [ -e \"$name\" ] || continue",
      "  if [ -d \"$name\" ]; then",
      "    type=directory",
      "  elif [ -f \"$name\" ]; then",
      "    type=file",
      "  else",
      "    type=other",
      "  fi",
      "  printf '%s\\t%s\\n' \"$name\" \"$type\"",
      "done",
    ].join("\n");
    const executed = await execCommand({
      command: "docker",
      args: ["exec", "-i", this.options.containerName, "sh", "-lc", script],
      cwd: this.options.dockerProjectRoot,
      timeoutSec: this.options.dockerCliTimeoutSec,
    });
    if (executed.exitCode !== 0) {
      throw new Error(executed.stderr || executed.stdout || "container_file_list_failed");
    }
    const entries = executed.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf("\t");
        if (separator <= 0) {
          return null;
        }
        const name = line.slice(0, separator);
        const typeToken = line.slice(separator + 1);
        const type =
          typeToken === "directory" || typeToken === "file" || typeToken === "other"
            ? typeToken
            : "other";
        return { name, type };
      })
      .filter(
        (entry): entry is { name: string; type: "file" | "directory" | "other" } =>
          entry !== null,
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      path: containerPath,
      entries,
    };
  }

  private isDockerExecMode(): boolean {
    return this.options.executionMode === "docker_exec";
  }

  async fileRead(sessionId: string, requestedPath: string): Promise<{
    path: string;
    content: string;
  }> {
    if (this.isDockerExecMode()) {
      return this.readFileInAgentContainer(sessionId, requestedPath);
    }
    const scopedPath = this.resolveScopedPath(sessionId, requestedPath);
    if (!scopedPath) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }
    const content = await fs.readFile(scopedPath, "utf8");
    return { path: scopedPath, content };
  }

  async fileStat(sessionId: string, requestedPath: string): Promise<ContainerFileStat> {
    if (this.isDockerExecMode()) {
      return this.statFileInAgentContainer(sessionId, requestedPath);
    }
    const scopedPath = this.resolveScopedPath(sessionId, requestedPath);
    if (!scopedPath) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }
    let stats;
    try {
      stats = await fs.stat(scopedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("container_path_not_found");
      }
      throw error;
    }
    if (!stats.isFile()) {
      throw new Error("container_path_not_file");
    }
    return {
      path: scopedPath,
      bytes: stats.size,
    };
  }

  async fileReadBase64(
    sessionId: string,
    requestedPath: string,
    maxBytes: number,
  ): Promise<ContainerFileBase64Read> {
    if (this.isDockerExecMode()) {
      return this.readFileBase64InAgentContainer(sessionId, requestedPath, maxBytes);
    }
    const stat = await this.fileStat(sessionId, requestedPath);
    if (stat.bytes > maxBytes) {
      throw new Error("container_file_too_large");
    }
    const buffer = await fs.readFile(stat.path);
    return {
      path: stat.path,
      bytes: buffer.byteLength,
      contentBase64: buffer.toString("base64"),
    };
  }

  async fileWrite(
    sessionId: string,
    requestedPath: string,
    content: string,
  ): Promise<{
    path: string;
    bytes: number;
  }> {
    if (this.isDockerExecMode()) {
      return this.writeFileInAgentContainer(sessionId, requestedPath, content);
    }
    const scopedPath = this.resolveScopedPath(sessionId, requestedPath);
    if (!scopedPath) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }

    await fs.mkdir(path.dirname(scopedPath), { recursive: true });
    await fs.writeFile(scopedPath, content, "utf8");
    return {
      path: scopedPath,
      bytes: Buffer.byteLength(content, "utf8"),
    };
  }

  async fileDelete(sessionId: string, requestedPath: string): Promise<{
    path: string;
  }> {
    if (this.isDockerExecMode()) {
      return this.deleteFileInAgentContainer(sessionId, requestedPath);
    }
    const scopedPath = this.resolveScopedPath(sessionId, requestedPath);
    if (!scopedPath) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }
    await fs.rm(scopedPath, { recursive: true, force: false });
    return { path: scopedPath };
  }

  async fileList(
    sessionId: string,
    requestedPath: string,
  ): Promise<{
    path: string;
    entries: Array<{ name: string; type: "file" | "directory" | "other" }>;
  }> {
    if (this.isDockerExecMode()) {
      return this.listFileInAgentContainer(sessionId, requestedPath);
    }
    const scopedPath = this.resolveScopedPath(sessionId, requestedPath);
    if (!scopedPath) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }
    const entries = await fs.readdir(scopedPath, { withFileTypes: true });
    return {
      path: scopedPath,
      entries: entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      })),
    };
  }

  async cliExec(input: ContainerCliInput): Promise<{
    command: string;
    args: string[];
    cwd: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }> {
    if (this.isDockerExecMode()) {
      const executed = await this.executeInAgentContainer(
        input.sessionId,
        input.command,
        input.args,
        input.cwd,
      );
      return {
        command: input.command,
        args: input.args,
        cwd:
          this.resolveContainerPath(input.sessionId, input.cwd ?? "workspace") ??
          path.posix.join(CANONICAL_CONTAINER_SESSION_ROOT, input.sessionId, "workspace"),
        exitCode: executed.exitCode,
        stdout: executed.stdout,
        stderr: executed.stderr,
        timedOut: executed.timedOut,
      };
    }
    const defaultWorkingDir = path.resolve(this.getSessionRoot(input.sessionId), "workspace");
    const requestedCwd = input.cwd ?? defaultWorkingDir;
    const scopedCwd = this.resolveScopedPath(input.sessionId, requestedCwd);
    if (!scopedCwd) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }

    await fs.mkdir(scopedCwd, { recursive: true });
    const executed = await execCommand({
      command: input.command,
      args: input.args,
      cwd: scopedCwd,
      timeoutSec: input.timeoutSec ?? this.options.cliTimeoutSec,
    });
    return {
      command: input.command,
      args: input.args,
      cwd: scopedCwd,
      exitCode: executed.exitCode,
      stdout: executed.stdout,
      stderr: executed.stderr,
      timedOut: executed.timedOut,
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
