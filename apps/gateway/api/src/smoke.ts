import "dotenv/config";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createGatewayPool } from "./gateway/db.js";
import { buildGatewayApiServer } from "./server.js";

async function main(): Promise<void> {
  const containerSessionRoot = path.resolve(
    process.cwd(),
    ".tmp",
    "api-smoke-container",
  );
  process.env.CONTAINER_SESSION_ROOT = containerSessionRoot;

  const pool = createGatewayPool();
  const app = buildGatewayApiServer({
    logger: false,
    pool,
  });

  const userId = `user_${randomUUID()}`;
  const threadId = `thread_${randomUUID()}`;
  const channelId = `channel_${randomUUID()}`;
  const hostFilePath = path.resolve(
    process.cwd(),
    ".tmp",
    `host-smoke-${randomUUID()}.txt`,
  );
  let sessionId: string | null = null;

  try {
    await fs.mkdir(path.dirname(hostFilePath), { recursive: true });
    await fs.writeFile(hostFilePath, "host smoke content", "utf8");

    await app.ready();

    const healthResponse = await app.inject({
      method: "GET",
      url: "/health",
    });
    assertStatusCode(healthResponse.statusCode, 200, "health");

    const startResponse = await app.inject({
      method: "POST",
      url: "/v1/discord/mentions/start",
      payload: {
        userId,
        channelId,
        threadId,
        prompt: "P3 smoke start",
        attachmentNames: ["sample.txt"],
      },
    });
    assertStatusCode(startResponse.statusCode, 201, "mentions/start");
    const startBody = startResponse.json() as {
      session: { sessionId: string; status: string };
      taskId: string;
    };
    sessionId = startBody.session.sessionId;
    assert(startBody.session.status === "running", "session should start as running");

    const externalTargetResult = await callMcpTool(app, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "container.file_list",
      execution_target: "external_mcp",
      arguments: {
        path: ".",
      },
      reason: "reject external target",
    });
    assert(externalTargetResult.status === "error", "external target should fail");
    assert(
      externalTargetResult.error_code === "external_mcp_disabled",
      "external target should return external_mcp_disabled",
    );

    const containerWriteResult = await callMcpTool(app, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "container.file_write",
      execution_target: "gateway_adapter",
      arguments: {
        path: "workspace/note.txt",
        content: "container smoke content",
      },
      reason: "write container file",
    });
    assert(containerWriteResult.status === "ok", "container.file_write should succeed");

    const containerReadResult = await callMcpTool(app, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "container.file_read",
      execution_target: "gateway_adapter",
      arguments: {
        path: "workspace/note.txt",
      },
      reason: "read container file",
    });
    assert(containerReadResult.status === "ok", "container.file_read should succeed");
    assert(
      (containerReadResult.result as { content: string }).content ===
        "container smoke content",
      "container file content should match written value",
    );

    const outOfScopeReadResult = await callMcpTool(app, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "container.file_read",
      execution_target: "gateway_adapter",
      arguments: {
        path: "../outside.txt",
      },
      reason: "scope check",
    });
    assert(outOfScopeReadResult.status === "error", "out-of-scope read should fail");
    assert(
      outOfScopeReadResult.error_code === "container_path_out_of_scope",
      "out-of-scope read should return container_path_out_of_scope",
    );

    const hostReadBeforeApproval = await callMcpTool(app, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "host.file_read",
      execution_target: "gateway_adapter",
      arguments: {
        path: hostFilePath,
      },
      reason: "host read requires approval",
    });
    assert(
      hostReadBeforeApproval.status === "error",
      "host.file_read should require approval before granted",
    );
    assert(
      hostReadBeforeApproval.error_code === "approval_required",
      "host.file_read should return approval_required before approval",
    );

    const hostApprovalRequestResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/approvals/request`,
      payload: {
        userId,
        operation: "read",
        path: hostFilePath,
      },
    });
    assertStatusCode(
      hostApprovalRequestResponse.statusCode,
      200,
      "threads/approvals/request(host)",
    );
    const hostApprovalRequestBody = hostApprovalRequestResponse.json() as {
      approval: { approvalId: string; status: string };
    };
    assert(
      hostApprovalRequestBody.approval.status === "requested",
      "host approval should start as requested",
    );

    const hostApprovalRespondResponse = await app.inject({
      method: "POST",
      url: `/v1/approvals/${hostApprovalRequestBody.approval.approvalId}/respond`,
      payload: {
        userId,
        decision: "approved",
      },
    });
    assertStatusCode(
      hostApprovalRespondResponse.statusCode,
      200,
      "approvals/respond(host)",
    );

    const hostReadAfterApproval = await callMcpTool(app, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "host.file_read",
      execution_target: "gateway_adapter",
      arguments: {
        path: hostFilePath,
      },
      reason: "host read after approval",
    });
    assert(
      hostReadAfterApproval.status === "ok",
      "host.file_read should succeed after approval",
    );
    assert(
      (hostReadAfterApproval.result as { content: string }).content ===
        "host smoke content",
      "host read should return file content",
    );

    const memoryUpsertResult = await callMcpTool(app, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "memory.upsert",
      execution_target: "gateway_adapter",
      arguments: {
        namespace: "smoke",
        key: "entry1",
        value: {
          content: "hello-memory",
        },
        tags: ["smoke"],
      },
      reason: "memory upsert",
    });
    assert(memoryUpsertResult.status === "ok", "memory.upsert should succeed");

    const memoryGetResult = await callMcpTool(app, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "memory.get",
      execution_target: "gateway_adapter",
      arguments: {
        namespace: "smoke",
        key: "entry1",
      },
      reason: "memory get",
    });
    assert(memoryGetResult.status === "ok", "memory.get should succeed");
    const memoryGetPayload = memoryGetResult.result as {
      found: boolean;
      entry: { value: { content: string } } | null;
    };
    assert(memoryGetPayload.found, "memory.get should return found=true");
    assert(
      memoryGetPayload.entry?.value.content === "hello-memory",
      "memory.get should return stored value",
    );

    const memorySearchResult = await callMcpTool(app, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "memory.search",
      execution_target: "gateway_adapter",
      arguments: {
        namespace: "smoke",
        query: "entry1",
        limit: 10,
      },
      reason: "memory search",
    });
    assert(memorySearchResult.status === "ok", "memory.search should succeed");
    const memorySearchPayload = memorySearchResult.result as {
      entries: Array<{ key: string }>;
    };
    assert(
      memorySearchPayload.entries.some((entry) => entry.key === "entry1"),
      "memory.search should include upserted key",
    );

    const memoryDeleteResult = await callMcpTool(app, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "memory.delete",
      execution_target: "gateway_adapter",
      arguments: {
        namespace: "smoke",
        key: "entry1",
      },
      reason: "memory delete",
    });
    assert(memoryDeleteResult.status === "ok", "memory.delete should succeed");

    const messageResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/messages`,
      payload: {
        userId,
        prompt: "follow-up prompt",
        attachmentNames: [],
      },
    });
    assertStatusCode(messageResponse.statusCode, 200, "threads/messages");

    const requestApprovalResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/approvals/request`,
      payload: {
        userId,
        operation: "read",
        path: "/tmp/example.txt",
      },
    });
    assertStatusCode(
      requestApprovalResponse.statusCode,
      200,
      "threads/approvals/request",
    );
    const requestApprovalBody = requestApprovalResponse.json() as {
      session: { status: string };
      task: { status: string };
      approval: { approvalId: string; status: string };
    };
    assert(
      requestApprovalBody.session.status === "waiting_approval",
      "approval request should move session to waiting_approval",
    );
    assert(
      requestApprovalBody.approval.status === "requested",
      "approval should start as requested",
    );

    const respondApprovalResponse = await app.inject({
      method: "POST",
      url: `/v1/approvals/${requestApprovalBody.approval.approvalId}/respond`,
      payload: {
        userId,
        decision: "approved",
      },
    });
    assertStatusCode(
      respondApprovalResponse.statusCode,
      200,
      "approvals/respond",
    );
    const respondApprovalBody = respondApprovalResponse.json() as {
      session: { status: string };
      task: { status: string };
      approval: { status: string };
    };
    assert(
      respondApprovalBody.session.status === "running",
      "approved response should move session to running",
    );
    assert(
      respondApprovalBody.approval.status === "approved",
      "approval should be approved",
    );

    const statusResponse = await app.inject({
      method: "GET",
      url: `/v1/threads/${threadId}/status`,
    });
    assertStatusCode(statusResponse.statusCode, 200, "threads/status");

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/cancel`,
      payload: { userId },
    });
    assertStatusCode(cancelResponse.statusCode, 200, "threads/cancel");
    const cancelBody = cancelResponse.json() as {
      session: { status: string };
      canceledTaskId: string | null;
    };
    assert(cancelBody.session.status === "idle_waiting", "cancel should move to idle_waiting");

    const closeResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/close`,
      payload: { userId },
    });
    assertStatusCode(closeResponse.statusCode, 200, "threads/close");
    const closeBody = closeResponse.json() as {
      session: { status: string };
    };
    assert(closeBody.session.status === "closed_by_user", "close should set closed status");

    const listResponse = await app.inject({
      method: "GET",
      url: `/v1/sessions?userId=${encodeURIComponent(userId)}`,
    });
    assertStatusCode(listResponse.statusCode, 200, "sessions/list");
    const listBody = listResponse.json() as {
      sessions: Array<{ sessionId: string }>;
    };
    assert(
      listBody.sessions.some((session) => session.sessionId === sessionId),
      "list should contain created session",
    );

    console.log("[api:smoke] gateway API checks passed.");
  } finally {
    if (sessionId) {
      await pool.query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
    }
    await fs.rm(containerSessionRoot, { recursive: true, force: true });
    await fs.rm(hostFilePath, { force: true });
    await app.close();
    await pool.end();
  }
}

interface McpResultSuccess {
  task_id: string;
  call_id: string;
  status: "ok";
  result: Record<string, unknown>;
}

interface McpResultError {
  task_id: string;
  call_id: string;
  status: "error";
  error_code: string;
  message: string;
  details?: Record<string, unknown>;
}

type McpResult = McpResultSuccess | McpResultError;

interface McpCallPayload {
  task_id: string;
  session_id: string;
  call_id: string;
  tool_name: string;
  execution_target: string;
  arguments: Record<string, unknown>;
  reason: string;
}

async function callMcpTool(
  app: ReturnType<typeof buildGatewayApiServer>,
  payload: McpCallPayload,
): Promise<McpResult> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/mcp/tool-call",
    payload,
  });
  assertStatusCode(response.statusCode, 200, `mcp/tool-call(${payload.tool_name})`);
  return response.json() as McpResult;
}

function assertStatusCode(
  actual: number,
  expected: number,
  target: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `[api:smoke] ${target} expected status ${expected}, got ${actual}`,
    );
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[api:smoke] assertion failed: ${message}`);
  }
}

main().catch((error) => {
  console.error("[api:smoke] failed:", error);
  process.exit(1);
});
