import "dotenv/config";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentRuntimeClient,
  AgentRuntimeRunTaskInput,
  AgentRuntimeTaskSnapshot,
} from "./agent/runtimeClient.js";
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
  const agentRuntimeClient = createMockAgentRuntimeClient();
  const app = buildGatewayApiServer({
    logger: false,
    pool,
    agentRuntimeClient,
  });
  const reporter = new SmokeReporter();

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
    console.log("[api:smoke] request/response summary:");

    await app.ready();

    const healthResponse = await app.inject({
      method: "GET",
      url: "/health",
    });
    const healthBody = parseJsonBody(healthResponse.body);
    reporter.logHttp({
      label: "health",
      method: "GET",
      url: "/health",
      statusCode: healthResponse.statusCode,
      responseBody: healthBody,
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
    const startResponseBody = parseJsonBody(startResponse.body);
    reporter.logHttp({
      label: "mentions/start",
      method: "POST",
      url: "/v1/discord/mentions/start",
      payload: {
        userId,
        channelId,
        threadId,
        prompt: "P3 smoke start",
        attachmentNames: ["sample.txt"],
      },
      statusCode: startResponse.statusCode,
      responseBody: startResponseBody,
    });
    assertStatusCode(startResponse.statusCode, 201, "mentions/start");
    const startBody = startResponseBody as {
      session: { sessionId: string; status: string };
      taskId: string;
    };
    sessionId = startBody.session.sessionId;
    assert(startBody.session.status === "running", "session should start as running");

    const agentRunResponse = await app.inject({
      method: "POST",
      url: "/v1/agent/tasks/run",
      payload: {
        taskId: startBody.taskId,
        sessionId: startBody.session.sessionId,
        userId,
        prompt: "agent runtime smoke run",
        attachmentNames: ["sample.txt"],
        contextEnvelope: {
          behavior: {
            botMode: "standard",
            sessionStatus: "running",
            infrastructureStatus: "ready",
            toolRoutingPolicy: "gateway_only",
            approvalPolicy: "host_ops_require_explicit_approval",
            responseContract: "ja, concise, ask_when_ambiguous",
            executionContract: "no_external_mcp, no_unapproved_host_ops",
          },
          runtimeFeedback: {
            previousTaskTerminalStatus: "failed",
            previousToolErrors: ["approval_required: host.file_read needs approval"],
            retryHint: "approval granted; retrying",
            attachmentSources: [
              {
                name: "sample.txt",
                sourceUrl: "https://example.invalid/sample.txt",
              },
            ],
          },
        },
        toolCalls: [
          {
            toolName: "memory.upsert",
            executionTarget: "gateway_adapter",
            arguments: {
              namespace: "agent-smoke",
              key: "entry",
              value: { text: "hello" },
            },
            reason: "store state",
            delayMs: 20,
          },
        ],
      },
    });
    const agentRunResponseBody = parseJsonBody(agentRunResponse.body);
    reporter.logHttp({
      label: "agent/tasks/run",
      method: "POST",
      url: "/v1/agent/tasks/run",
        payload: {
          taskId: startBody.taskId,
          sessionId: startBody.session.sessionId,
          userId,
          prompt: "agent runtime smoke run",
          attachmentNames: ["sample.txt"],
          contextEnvelope: {
            behavior: {
              botMode: "standard",
            },
            runtimeFeedback: {
              previousTaskTerminalStatus: "failed",
              attachmentSources: [
                {
                  name: "sample.txt",
                  sourceUrl: "https://example.invalid/sample.txt",
                },
              ],
            },
          },
          toolCalls: [
            {
              toolName: "memory.upsert",
            },
          ],
      },
      statusCode: agentRunResponse.statusCode,
      responseBody: agentRunResponseBody,
    });
    assertStatusCode(agentRunResponse.statusCode, 200, "agent/tasks/run");
    const agentRunBody = agentRunResponseBody as {
      agentTask: {
        status: string;
      };
    };
    assert(
      agentRunBody.agentTask.status === "running",
      "agent run should start with running status",
    );

    const agentStatusCompleted = await waitForAgentTerminalStatus(
      app,
      reporter,
      startBody.taskId,
      20,
    );
    assert(
      agentStatusCompleted.agentTask.status === "completed",
      "agent status should become completed",
    );
    const runtimeAnswer = agentStatusCompleted.agentTask.result?.final_answer ?? "";
    assert(
      runtimeAnswer.includes("[Behavior Context]"),
      "runtime prompt should include behavior context envelope",
    );
    assert(
      runtimeAnswer.includes(
        "[User Prompt]\nagent runtime smoke run",
      ),
      "runtime prompt should keep original user prompt in envelope",
    );
    assert(
      runtimeAnswer.includes(
        "previous_task_terminal_status: failed",
      ),
      "runtime prompt should include runtime feedback context",
    );
    assert(
      runtimeAnswer.includes("[staged_attachments] sample.txt@"),
      "runtime should receive staged attachment paths",
    );

    const externalTargetResult = await callMcpTool(app, reporter, {
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

    const containerWriteResult = await callMcpTool(app, reporter, {
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

    const containerReadResult = await callMcpTool(app, reporter, {
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

    const outOfScopeReadResult = await callMcpTool(app, reporter, {
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

    const hostReadBeforeApproval = await callMcpTool(app, reporter, {
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
    const hostApprovalRequestResponseBody = parseJsonBody(
      hostApprovalRequestResponse.body,
    );
    reporter.logHttp({
      label: "threads/approvals/request(host)",
      method: "POST",
      url: `/v1/threads/${threadId}/approvals/request`,
      payload: {
        userId,
        operation: "read",
        path: hostFilePath,
      },
      statusCode: hostApprovalRequestResponse.statusCode,
      responseBody: hostApprovalRequestResponseBody,
    });
    assertStatusCode(
      hostApprovalRequestResponse.statusCode,
      200,
      "threads/approvals/request(host)",
    );
    const hostApprovalRequestBody = hostApprovalRequestResponseBody as {
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
    const hostApprovalRespondResponseBody = parseJsonBody(
      hostApprovalRespondResponse.body,
    );
    reporter.logHttp({
      label: "approvals/respond(host)",
      method: "POST",
      url: `/v1/approvals/${hostApprovalRequestBody.approval.approvalId}/respond`,
      payload: {
        userId,
        decision: "approved",
      },
      statusCode: hostApprovalRespondResponse.statusCode,
      responseBody: hostApprovalRespondResponseBody,
    });
    assertStatusCode(
      hostApprovalRespondResponse.statusCode,
      200,
      "approvals/respond(host)",
    );

    const hostReadAfterApproval = await callMcpTool(app, reporter, {
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

    const memoryUpsertResult = await callMcpTool(app, reporter, {
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

    const memoryGetResult = await callMcpTool(app, reporter, {
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

    const memorySearchResult = await callMcpTool(app, reporter, {
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

    const memoryDeleteResult = await callMcpTool(app, reporter, {
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
    const messageResponseBody = parseJsonBody(messageResponse.body);
    reporter.logHttp({
      label: "threads/messages",
      method: "POST",
      url: `/v1/threads/${threadId}/messages`,
      payload: {
        userId,
        prompt: "follow-up prompt",
        attachmentNames: [],
      },
      statusCode: messageResponse.statusCode,
      responseBody: messageResponseBody,
    });
    assertStatusCode(messageResponse.statusCode, 200, "threads/messages");
    const messageBody = messageResponseBody as {
      taskId: string;
    };

    const agentCancelRunResponse = await app.inject({
      method: "POST",
      url: "/v1/agent/tasks/run",
      payload: {
        taskId: messageBody.taskId,
        sessionId: startBody.session.sessionId,
        userId,
        prompt: "agent runtime cancel smoke run",
        toolCalls: [
          {
            toolName: "memory.search",
            executionTarget: "gateway_adapter",
            arguments: {
              namespace: "agent-smoke",
              query: "entry",
              limit: 5,
            },
            reason: "long run",
            delayMs: 500,
          },
        ],
      },
    });
    const agentCancelRunBody = parseJsonBody(agentCancelRunResponse.body);
    reporter.logHttp({
      label: "agent/tasks/run(cancel)",
      method: "POST",
      url: "/v1/agent/tasks/run",
      payload: {
        taskId: messageBody.taskId,
        sessionId: startBody.session.sessionId,
        userId,
        prompt: "agent runtime cancel smoke run",
        toolCalls: [{ toolName: "memory.search", delayMs: 500 }],
      },
      statusCode: agentCancelRunResponse.statusCode,
      responseBody: agentCancelRunBody,
    });
    assertStatusCode(
      agentCancelRunResponse.statusCode,
      200,
      "agent/tasks/run(cancel)",
    );

    const agentCancelResponse = await app.inject({
      method: "POST",
      url: `/v1/agent/tasks/${encodeURIComponent(messageBody.taskId)}/cancel`,
      payload: {
        userId,
      },
    });
    const agentCancelResponseBody = parseJsonBody(agentCancelResponse.body);
    reporter.logHttp({
      label: "agent/tasks/cancel",
      method: "POST",
      url: `/v1/agent/tasks/${encodeURIComponent(messageBody.taskId)}/cancel`,
      payload: {
        userId,
      },
      statusCode: agentCancelResponse.statusCode,
      responseBody: agentCancelResponseBody,
    });
    assertStatusCode(agentCancelResponse.statusCode, 200, "agent/tasks/cancel");

    const canceledStatus = await waitForAgentTerminalStatus(
      app,
      reporter,
      messageBody.taskId,
      20,
    );
    assert(
      canceledStatus.agentTask.status === "canceled",
      "agent cancel should lead to canceled status",
    );

    const requestApprovalResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/approvals/request`,
      payload: {
        userId,
        operation: "read",
        path: "/tmp/example.txt",
      },
    });
    const requestApprovalResponseBody = parseJsonBody(requestApprovalResponse.body);
    reporter.logHttp({
      label: "threads/approvals/request",
      method: "POST",
      url: `/v1/threads/${threadId}/approvals/request`,
      payload: {
        userId,
        operation: "read",
        path: "/tmp/example.txt",
      },
      statusCode: requestApprovalResponse.statusCode,
      responseBody: requestApprovalResponseBody,
    });
    assertStatusCode(
      requestApprovalResponse.statusCode,
      200,
      "threads/approvals/request",
    );
    const requestApprovalBody = requestApprovalResponseBody as {
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
    const respondApprovalResponseBody = parseJsonBody(respondApprovalResponse.body);
    reporter.logHttp({
      label: "approvals/respond",
      method: "POST",
      url: `/v1/approvals/${requestApprovalBody.approval.approvalId}/respond`,
      payload: {
        userId,
        decision: "approved",
      },
      statusCode: respondApprovalResponse.statusCode,
      responseBody: respondApprovalResponseBody,
    });
    assertStatusCode(
      respondApprovalResponse.statusCode,
      200,
      "approvals/respond",
    );
    const respondApprovalBody = respondApprovalResponseBody as {
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
    const statusResponseBody = parseJsonBody(statusResponse.body);
    reporter.logHttp({
      label: "threads/status",
      method: "GET",
      url: `/v1/threads/${threadId}/status`,
      statusCode: statusResponse.statusCode,
      responseBody: statusResponseBody,
    });
    assertStatusCode(statusResponse.statusCode, 200, "threads/status");

    const cancelResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/cancel`,
      payload: { userId },
    });
    const cancelResponseBody = parseJsonBody(cancelResponse.body);
    reporter.logHttp({
      label: "threads/cancel",
      method: "POST",
      url: `/v1/threads/${threadId}/cancel`,
      payload: { userId },
      statusCode: cancelResponse.statusCode,
      responseBody: cancelResponseBody,
    });
    assertStatusCode(cancelResponse.statusCode, 200, "threads/cancel");
    const cancelBody = cancelResponseBody as {
      session: { status: string };
      canceledTaskId: string | null;
    };
    assert(cancelBody.session.status === "idle_waiting", "cancel should move to idle_waiting");

    const closeResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/close`,
      payload: { userId },
    });
    const closeResponseBody = parseJsonBody(closeResponse.body);
    reporter.logHttp({
      label: "threads/close",
      method: "POST",
      url: `/v1/threads/${threadId}/close`,
      payload: { userId },
      statusCode: closeResponse.statusCode,
      responseBody: closeResponseBody,
    });
    assertStatusCode(closeResponse.statusCode, 200, "threads/close");
    const closeBody = closeResponseBody as {
      session: { status: string };
    };
    assert(closeBody.session.status === "closed_by_user", "close should set closed status");

    const listResponse = await app.inject({
      method: "GET",
      url: `/v1/sessions?userId=${encodeURIComponent(userId)}`,
    });
    const listResponseBody = parseJsonBody(listResponse.body);
    reporter.logHttp({
      label: "sessions/list",
      method: "GET",
      url: `/v1/sessions?userId=${encodeURIComponent(userId)}`,
      statusCode: listResponse.statusCode,
      responseBody: listResponseBody,
    });
    assertStatusCode(listResponse.statusCode, 200, "sessions/list");
    const listBody = listResponseBody as {
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
  reporter: SmokeReporter,
  payload: McpCallPayload,
): Promise<McpResult> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/mcp/tool-call",
    payload,
  });
  const responseBody = parseJsonBody(response.body);
  reporter.logHttp({
    label: `mcp/tool-call(${payload.tool_name})`,
    method: "POST",
    url: "/v1/mcp/tool-call",
    payload,
    statusCode: response.statusCode,
    responseBody,
  });
  assertStatusCode(response.statusCode, 200, `mcp/tool-call(${payload.tool_name})`);
  return responseBody as McpResult;
}

async function waitForAgentTerminalStatus(
  app: ReturnType<typeof buildGatewayApiServer>,
  reporter: SmokeReporter,
  taskId: string,
  maxAttempts: number,
): Promise<{
  agentTask: {
    status: string;
    result?: {
      final_answer: string;
      tool_results: unknown[];
    } | null;
  };
}> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/agent/tasks/${encodeURIComponent(taskId)}/status`,
    });
    const responseBody = parseJsonBody(response.body);
    reporter.logHttp({
      label: "agent/tasks/status",
      method: "GET",
      url: `/v1/agent/tasks/${encodeURIComponent(taskId)}/status`,
      statusCode: response.statusCode,
      responseBody,
    });
    assertStatusCode(response.statusCode, 200, "agent/tasks/status");
    const body = responseBody as {
      agentTask: {
        status: string;
      };
    };
    if (
      body.agentTask.status === "completed" ||
      body.agentTask.status === "failed" ||
      body.agentTask.status === "canceled"
    ) {
      return body;
    }
    await sleep(80);
  }

  throw new Error(
    `[api:smoke] agent task ${taskId} did not reach terminal status in time`,
  );
}

function createMockAgentRuntimeClient(): AgentRuntimeClient {
  const tasks = new Map<
    string,
    AgentRuntimeTaskSnapshot & {
      timer: NodeJS.Timeout | null;
    }
  >();
  const knownSessions = new Set<string>();
  const stagedAttachmentsByTaskId = new Map<
    string,
    {
      sessionId: string;
      mountPath: string;
      files: Array<{ name: string; path: string; bytes: number }>;
    }
  >();

  return {
    async stageTaskAttachments(input): ReturnType<AgentRuntimeClient["stageTaskAttachments"]> {
      const files = input.attachments.map((attachment) => ({
        name: attachment.name,
        path: `${input.attachment_mount_path}/${attachment.name}`,
        bytes: 128,
      }));
      stagedAttachmentsByTaskId.set(input.task_id, {
        sessionId: input.session_id,
        mountPath: input.attachment_mount_path,
        files,
      });
      return {
        task_id: input.task_id,
        session_id: input.session_id,
        attachment_mount_path: input.attachment_mount_path,
        staged_count: files.length,
        staged_files: files,
      };
    },

    async runTask(input: AgentRuntimeRunTaskInput): Promise<AgentRuntimeTaskSnapshot> {
      const now = new Date();
      const delayMs = Math.max(
        20,
        ...((input.tool_calls ?? []).map((toolCall) => toolCall.delay_ms ?? 0)),
      );
      const snapshot: AgentRuntimeTaskSnapshot & { timer: NodeJS.Timeout | null } = {
        task_id: input.task_id,
        session_id: input.session_id,
        status: "running",
        bootstrap_mode: knownSessions.has(input.session_id) ? "resume" : "create",
        send_and_wait_count: 0,
        started_at: now.toISOString(),
        updated_at: now.toISOString(),
        completed_at: null,
        result: null,
        error: null,
        timer: null,
      };

      snapshot.timer = setTimeout(() => {
        const current = tasks.get(input.task_id);
        if (!current || current.status !== "running") {
          return;
        }
        const doneAt = new Date();
        current.status = "completed";
        current.send_and_wait_count = 1;
        current.updated_at = doneAt.toISOString();
        current.completed_at = doneAt.toISOString();
        current.result = {
          final_answer: buildMockRuntimeAnswer(
            input.prompt,
            stagedAttachmentsByTaskId.get(input.task_id),
          ),
          tool_results: [],
        };
      }, delayMs);
      tasks.set(input.task_id, snapshot);
      knownSessions.add(input.session_id);

      return toSnapshot(snapshot);
    },

    async getTaskStatus(taskId: string): Promise<AgentRuntimeTaskSnapshot> {
      const current = tasks.get(taskId);
      if (!current) {
        return {
          task_id: taskId,
          session_id: "unknown",
          status: "failed",
          bootstrap_mode: "create",
          send_and_wait_count: 0,
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          result: null,
          error: {
            code: "task_not_found",
            message: "mock runtime task not found",
          },
        };
      }
      return toSnapshot(current);
    },

    async cancelTask(taskId: string): Promise<AgentRuntimeTaskSnapshot> {
      const current = tasks.get(taskId);
      if (!current) {
        return {
          task_id: taskId,
          session_id: "unknown",
          status: "failed",
          bootstrap_mode: "create",
          send_and_wait_count: 0,
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          result: null,
          error: {
            code: "task_not_found",
            message: "mock runtime task not found",
          },
        };
      }
      if (current.timer) {
        clearTimeout(current.timer);
        current.timer = null;
      }
      if (current.status === "running") {
        const canceledAt = new Date();
        current.status = "canceled";
        current.updated_at = canceledAt.toISOString();
        current.completed_at = canceledAt.toISOString();
        current.error = {
          code: "task_canceled",
          message: "mock runtime canceled",
        };
      }
      return toSnapshot(current);
    },
  };
}

function toSnapshot(
  value: AgentRuntimeTaskSnapshot & { timer: NodeJS.Timeout | null },
): AgentRuntimeTaskSnapshot {
  return {
    task_id: value.task_id,
    session_id: value.session_id,
    status: value.status,
    bootstrap_mode: value.bootstrap_mode,
    send_and_wait_count: value.send_and_wait_count,
    started_at: value.started_at,
    updated_at: value.updated_at,
    completed_at: value.completed_at ?? null,
    result: value.result ?? null,
    error: value.error ?? null,
  };
}

function buildMockRuntimeAnswer(
  prompt: string,
  staged:
    | {
        sessionId: string;
        mountPath: string;
        files: Array<{ name: string; path: string; bytes: number }>;
      }
    | undefined,
): string {
  if (!staged || staged.files.length === 0) {
    return `mock runtime completed: ${prompt}`;
  }
  const listed = staged.files.map((file) => `${file.name}@${file.path}`).join(", ");
  return `mock runtime completed: ${prompt}\n[staged_attachments] ${listed}`;
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

interface SmokeHttpLogInput {
  label: string;
  method: string;
  url: string;
  payload?: unknown;
  statusCode: number;
  responseBody: unknown;
}

class SmokeReporter {
  private step = 0;

  logHttp(input: SmokeHttpLogInput): void {
    this.step += 1;
    const step = String(this.step).padStart(2, "0");
    const payloadSummary = summarizeForLog(input.payload);
    const responseSummary = summarizeForLog(input.responseBody);
    const line =
      `[api:smoke][${step}] ${input.label} ` +
      `${input.method} ${input.url} ` +
      `req=${payloadSummary} -> ${input.statusCode} res=${responseSummary}`;
    console.log(line);
  }
}

function parseJsonBody(raw: string): unknown {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function summarizeForLog(value: unknown): string {
  if (value === undefined) {
    return "-";
  }

  const normalized = normalizeForLog(value, 0);
  const text = JSON.stringify(normalized);
  return truncateText(text, 240);
}

function normalizeForLog(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth >= 3) {
    return "[depth-limit]";
  }

  if (typeof value === "string") {
    return truncateText(value, 80);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const maxItems = 5;
    const items = value
      .slice(0, maxItems)
      .map((item) => normalizeForLog(item, depth + 1));
    if (value.length > maxItems) {
      items.push(`...(+${value.length - maxItems})`);
    }
    return items;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const maxKeys = 8;
    const normalized: Record<string, unknown> = {};
    for (const [key, current] of entries.slice(0, maxKeys)) {
      normalized[key] = normalizeForLog(current, depth + 1);
    }
    if (entries.length > maxKeys) {
      normalized.__more_keys = entries.length - maxKeys;
    }
    return normalized;
  }

  return String(value);
}

function truncateText(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, maxLength - 3)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error("[api:smoke] failed:", error);
  process.exit(1);
});
