import { promises as fs } from "node:fs";
import path from "node:path";
import { execCommand } from "../mcp/exec.js";

const CANONICAL_CONTAINER_SESSION_ROOT = "/agent/session";

export interface ContainerToolAdapterOptions {
  sessionRoot: string;
  cliTimeoutSec: number;
}

export interface ContainerCliInput {
  sessionId: string;
  command: string;
  args: string[];
  cwd?: string;
  timeoutSec?: number;
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

  async fileRead(sessionId: string, requestedPath: string): Promise<{
    path: string;
    content: string;
  }> {
    const scopedPath = this.resolveScopedPath(sessionId, requestedPath);
    if (!scopedPath) {
      return Promise.reject(new Error("container_path_out_of_scope"));
    }
    const content = await fs.readFile(scopedPath, "utf8");
    return { path: scopedPath, content };
  }

  async fileWrite(
    sessionId: string,
    requestedPath: string,
    content: string,
  ): Promise<{
    path: string;
    bytes: number;
  }> {
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
