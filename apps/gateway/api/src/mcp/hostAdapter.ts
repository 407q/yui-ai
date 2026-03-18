import { promises as fs } from "node:fs";
import path from "node:path";
import { execCommand } from "./exec.js";

export interface HostToolAdapterOptions {
  cliTimeoutSec: number;
  httpTimeoutSec: number;
}

export interface HostCliInput {
  command: string;
  args: string[];
  cwd?: string;
  timeoutSec?: number;
}

export interface HostHttpRequestInput {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutSec?: number;
}

export class HostToolAdapter {
  constructor(private readonly options: HostToolAdapterOptions) {}

  async fileRead(requestedPath: string): Promise<{ path: string; content: string }> {
    const resolvedPath = normalizePath(requestedPath);
    const content = await fs.readFile(resolvedPath, "utf8");
    return {
      path: resolvedPath,
      content,
    };
  }

  async fileWrite(
    requestedPath: string,
    content: string,
  ): Promise<{ path: string; bytes: number }> {
    const resolvedPath = normalizePath(requestedPath);
    await fs.writeFile(resolvedPath, content, "utf8");
    return {
      path: resolvedPath,
      bytes: Buffer.byteLength(content, "utf8"),
    };
  }

  async fileDelete(requestedPath: string): Promise<{ path: string }> {
    const resolvedPath = normalizePath(requestedPath);
    await fs.rm(resolvedPath, { recursive: true, force: false });
    return { path: resolvedPath };
  }

  async fileList(requestedPath: string): Promise<{
    path: string;
    entries: Array<{ name: string; type: "file" | "directory" | "other" }>;
  }> {
    const resolvedPath = normalizePath(requestedPath);
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    return {
      path: resolvedPath,
      entries: entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      })),
    };
  }

  async cliExec(input: HostCliInput): Promise<{
    command: string;
    args: string[];
    cwd: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }> {
    const cwd = input.cwd ?? process.cwd();
    const executed = await execCommand({
      command: input.command,
      args: input.args,
      cwd,
      timeoutSec: input.timeoutSec ?? this.options.cliTimeoutSec,
    });
    return {
      command: input.command,
      args: input.args,
      cwd,
      exitCode: executed.exitCode,
      stdout: executed.stdout,
      stderr: executed.stderr,
      timedOut: executed.timedOut,
    };
  }

  async httpRequest(input: HostHttpRequestInput): Promise<{
    url: string;
    method: string;
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    const timeoutMs = (input.timeoutSec ?? this.options.httpTimeoutSec) * 1000;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: controller.signal,
      });
      const body = await response.text();
      const headers: Record<string, string> = {};
      for (const [key, value] of response.headers.entries()) {
        headers[key] = value;
      }
      return {
        url: input.url,
        method: input.method,
        status: response.status,
        headers,
        body,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizePath(requestedPath: string): string {
  return path.resolve(requestedPath);
}
