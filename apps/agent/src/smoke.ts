import "dotenv/config";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildAgentServer } from "./server.js";

interface MockMcpServerContext {
  server: http.Server;
  approvalRequests: Array<Record<string, unknown>>;
}

async function main(): Promise<void> {
  process.env.BOT_MODE ??= "mock";
  const sessionRootDir = path.resolve(
    process.cwd(),
    ".tmp",
    "agent-smoke-session-root",
  );
  process.env.AGENT_SESSION_ROOT_DIR = sessionRootDir;
  const mockMcp = createMockMcpServer();
  const mcpServer = mockMcp.server;
  await new Promise<void>((resolve, reject) => {
    mcpServer.listen(0, "127.0.0.1", () => resolve());
    mcpServer.once("error", reject);
  });

  const address = mcpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("[agent:smoke] failed to resolve mock MCP server address");
  }
  const gatewayBaseUrl = `http://127.0.0.1:${address.port}`;

  const app = buildAgentServer({
    logger: false,
    gatewayBaseUrl,
  });

  try {
    await app.ready();

    const healthResponse = await app.inject({
      method: "GET",
      url: "/health",
    });
    assertStatusCode(healthResponse.statusCode, 200, "health");

    const stagedSessionId = `sess_${randomUUID()}`;
    const stagedTaskId = `task_${randomUUID()}`;
    const stageResponse = await app.inject({
      method: "POST",
      url: `/v1/tasks/${stagedTaskId}/attachments/stage`,
      payload: {
        session_id: stagedSessionId,
        attachment_mount_path: `${sessionRootDir}/${stagedSessionId}`,
        attachments: [
          {
            name: "sample.txt",
            source_url: `http://127.0.0.1:${address.port}/fixtures/sample.txt`,
          },
        ],
      },
    });
    assertStatusCode(stageResponse.statusCode, 200, "attachments/stage");
    const stageBody = stageResponse.json() as {
      staged_count: number;
      staged_files: Array<{ path: string }>;
    };
    assert(stageBody.staged_count === 1, "attachments/stage should stage one file");
    const stagedPath = stageBody.staged_files[0]?.path;
    assert(typeof stagedPath === "string", "attachments/stage should return file path");
    const stagedText = await fs.readFile(stagedPath, "utf8");
    assert(stagedText === "sample fixture content", "staged file content should match source");

    const sessionId = `sess_${randomUUID()}`;
    const taskId1 = `task_${randomUUID()}`;
    const runResponse1 = await app.inject({
      method: "POST",
      url: "/v1/tasks/run",
      payload: {
        task_id: taskId1,
        session_id: sessionId,
        prompt: "P6 smoke create-session run",
        runtime_policy: {
          tool_routing: {
            mode: "hybrid_container_builtin_gateway_host",
            allow_external_mcp: false,
          },
        },
        tool_calls: [
          {
            tool_name: "memory.upsert",
            execution_target: "gateway_adapter",
            arguments: {
              namespace: "agent-smoke",
              key: "entry1",
              value: {
                content: "hello",
              },
            },
            reason: "store memory",
          },
        ],
      },
    });
    assertStatusCode(runResponse1.statusCode, 202, "tasks/run(create)");

    const completed1 = await waitUntilTerminal(app, taskId1);
    assert(completed1.status === "completed", "first run should complete");
    assert(completed1.bootstrap_mode === "create", "first run should create session");
    assert(
      completed1.send_and_wait_count === 1,
      "first run should execute sendAndWait exactly once",
    );
    const hasSystemMemoryPreload =
      completed1.result?.tool_results?.some(
        (result) =>
          result.status === "ok" &&
          result.tool_name === "memory.get" &&
          (result.arguments as { namespace?: string } | undefined)?.namespace ===
            "system.persona",
      ) ?? false;
    assert(
      hasSystemMemoryPreload,
      "first run should preload system memory via memory.get",
    );

    const taskId2 = `task_${randomUUID()}`;
    const runResponse2 = await app.inject({
      method: "POST",
      url: "/v1/tasks/run",
      payload: {
        task_id: taskId2,
        session_id: sessionId,
        prompt: "P6 smoke resume-session run",
        runtime_policy: {
          tool_routing: {
            mode: "hybrid_container_builtin_gateway_host",
            allow_external_mcp: false,
          },
        },
      },
    });
    assertStatusCode(runResponse2.statusCode, 202, "tasks/run(resume)");

    const completed2 = await waitUntilTerminal(app, taskId2);
    assert(completed2.status === "completed", "second run should complete");
    assert(completed2.bootstrap_mode === "resume", "second run should resume session");
    assert(
      completed2.send_and_wait_count === 1,
      "second run should execute sendAndWait exactly once",
    );

    const taskIdApproval = `task_${randomUUID()}`;
    const runApprovalResponse = await app.inject({
      method: "POST",
      url: "/v1/tasks/run",
      payload: {
        task_id: taskIdApproval,
        session_id: sessionId,
        prompt: "P6 smoke approval request run",
        runtime_policy: {
          tool_routing: {
            mode: "hybrid_container_builtin_gateway_host",
            allow_external_mcp: false,
          },
        },
        tool_calls: [
          {
            tool_name: "discord.channel_history",
            execution_target: "gateway_adapter",
            arguments: {
              channelId: "smoke-channel-id",
              limit: 5,
              role: "all",
            },
            reason: "approval payload contract check",
          },
        ],
      },
    });
    assertStatusCode(
      runApprovalResponse.statusCode,
      202,
      "tasks/run(approval)",
    );

    const completedApproval = await waitUntilTerminal(app, taskIdApproval);
    assert(
      completedApproval.status === "completed",
      "approval run should complete",
    );
    const hasApprovedDiscordToolResult =
      completedApproval.result?.tool_results?.some(
        (result) =>
          result.status === "ok" &&
          result.tool_name === "discord.channel_history",
      ) ?? false;
    assert(
      hasApprovedDiscordToolResult,
      "approval run should execute discord.channel_history after approval",
    );
    const approvalRequest = mockMcp.approvalRequests.find(
      (request) =>
        request.taskId === taskIdApproval && request.sessionId === sessionId,
    );
    assert(
      Boolean(approvalRequest),
      "approval request should be sent with taskId/sessionId",
    );
    assert(
      approvalRequest !== undefined &&
        !("task_id" in approvalRequest) &&
        !("session_id" in approvalRequest) &&
        !("timeout_sec" in approvalRequest),
      "approval request payload should not use snake_case keys",
    );

    const taskId3 = `task_${randomUUID()}`;
    const runResponse3 = await app.inject({
      method: "POST",
      url: "/v1/tasks/run",
      payload: {
        task_id: taskId3,
        session_id: sessionId,
        prompt: "P6 smoke cancel run",
        runtime_policy: {
          tool_routing: {
            mode: "hybrid_container_builtin_gateway_host",
            allow_external_mcp: false,
          },
        },
        tool_calls: [
          {
            tool_name: "memory.search",
            execution_target: "gateway_adapter",
            arguments: {
              namespace: "agent-smoke",
              query: "entry",
              limit: 10,
            },
            reason: "search memory",
            delay_ms: 500,
          },
        ],
      },
    });
    assertStatusCode(runResponse3.statusCode, 202, "tasks/run(cancel)");

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId3}/cancel`,
    });
    assertStatusCode(cancelResponse.statusCode, 200, "tasks/cancel");

    const canceled = await waitUntilTerminal(app, taskId3);
    assert(canceled.status === "canceled", "cancelled run should become canceled");

    console.log("[agent:smoke] agent runtime checks passed.");
  } finally {
    await app.close();
    await fs.rm(sessionRootDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      mcpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function createMockMcpServer(): MockMcpServerContext {
  const approvalRequests: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    if (!request.url || request.method !== "POST") {
      if (request.url === "/fixtures/sample.txt" && request.method === "GET") {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("sample fixture content");
        return;
      }
      writeJson(response, 404, {
        error: "not_found",
      });
      return;
    }

    if (
      request.url !== "/v1/mcp/tool-call" &&
      request.url !== "/v1/agent/approvals/request-and-wait"
    ) {
      writeJson(response, 404, {
        error: "not_found",
      });
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (request.url === "/v1/agent/approvals/request-and-wait") {
        const isValid =
          typeof payload.taskId === "string" &&
          payload.taskId.length > 0 &&
          typeof payload.sessionId === "string" &&
          payload.sessionId.length > 0 &&
          typeof payload.operation === "string" &&
          payload.operation.length > 0 &&
          typeof payload.path === "string" &&
          payload.path.length > 0 &&
          typeof payload.timeoutSec === "number" &&
          Number.isInteger(payload.timeoutSec) &&
          payload.timeoutSec > 0;
        if (!isValid) {
          writeJson(response, 400, {
            error: "invalid_agent_approval_request",
            message: "Invalid request payload.",
            details: {
              payload,
            },
          });
          return;
        }
        approvalRequests.push(payload);
        writeJson(response, 200, {
          decision: "approved",
          approval: {
            approval_id: `apr_${randomUUID().slice(0, 8)}`,
            status: "approved",
            operation: String(payload.operation),
            path: String(payload.path),
          },
        });
        return;
      }

      const taskId = String(payload.task_id ?? "");
      const callId = String(payload.call_id ?? "");
      const toolName = String(payload.tool_name ?? "");

      writeJson(response, 200, {
        task_id: taskId,
        call_id: callId,
        status: "ok",
        result: {
          mock: true,
          tool_name: toolName,
        },
      });
    });
  });
  return {
    server,
    approvalRequests,
  };
}

async function waitUntilTerminal(
  app: ReturnType<typeof buildAgentServer>,
  taskId: string,
): Promise<{
  status: string;
  bootstrap_mode: string;
  send_and_wait_count: number;
  result?: {
    tool_results?: Array<{
      status: string;
      tool_name?: string;
      arguments?: Record<string, unknown>;
    }>;
  } | null;
}> {
  const maxAttempts = 50;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const statusResponse = await app.inject({
      method: "GET",
      url: `/v1/tasks/${taskId}`,
    });
    assertStatusCode(statusResponse.statusCode, 200, "tasks/status");
    const body = statusResponse.json() as {
      status: string;
      bootstrap_mode: string;
      send_and_wait_count: number;
      result?: {
        tool_results?: Array<{
          status: string;
          tool_name?: string;
          arguments?: Record<string, unknown>;
        }>;
      } | null;
    };
    if (
      body.status === "completed" ||
      body.status === "failed" ||
      body.status === "canceled"
    ) {
      return body;
    }
    await sleep(100);
  }

  throw new Error(`[agent:smoke] task ${taskId} did not reach terminal state`);
}

function writeJson(
  response: http.ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function assertStatusCode(actual: number, expected: number, target: string): void {
  if (actual !== expected) {
    throw new Error(
      `[agent:smoke] ${target} expected status ${expected}, got ${actual}`,
    );
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[agent:smoke] assertion failed: ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error("[agent:smoke] failed:", error);
  process.exit(1);
});
