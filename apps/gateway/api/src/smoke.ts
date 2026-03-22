import "dotenv/config";
import { Buffer } from "node:buffer";
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
    containerExecutionMode: "host",
    memoryNamespaceValidationMode: "warn",
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
  let dbMigrated = false;

  try {
    await pool.query(`
      ALTER TABLE memory_entries
      ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false
    `);
    dbMigrated = true;
    await pool.query(
      `
      INSERT INTO memory_entries (
        memory_id,
        user_id,
        namespace,
        "key",
        value_json,
        tags_json,
        is_system,
        updated_at
      )
      VALUES ($1, '__system__', 'system.policy', 'core_rules_smoke', $2::jsonb, '["system","policy"]'::jsonb, true, NOW())
      ON CONFLICT (user_id, namespace, "key")
      DO UPDATE SET
        value_json = EXCLUDED.value_json,
        tags_json = EXCLUDED.tags_json,
        is_system = true,
        updated_at = NOW()
      `,
      [
        "sys_policy_core_rules_smoke",
        JSON.stringify({
          execution: ["complete tasks safely"],
          safety: ["deny harmful requests"],
        }),
      ],
    );

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
        username: "smoke-user",
        nickname: "smoke-nick",
        channelId,
        channelName: "smoke-channel",
        threadId,
        threadName: "smoke-thread",
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
        username: "smoke-user",
        nickname: "smoke-nick",
        channelId,
        channelName: "smoke-channel",
        threadId,
        threadName: "smoke-thread",
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
            toolRoutingPolicy: "hybrid_container_builtin_gateway_host",
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
          discord: {
            userId,
            username: "smoke-user",
            nickname: "smoke-nick",
            channelId,
            channelName: "smoke-channel",
            threadId,
            threadName: "smoke-thread",
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
            discord: {
              userId,
              threadId,
              channelId,
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
      runtimeAnswer.includes("[Attachment Runtime Context]"),
      "runtime prompt should include attachment runtime context",
    );
    assert(
      runtimeAnswer.includes("attachment_mount_path: /agent/session/"),
      "runtime prompt should include session-level attachment mount path",
    );
    assert(
      runtimeAnswer.includes("working_directory_contract: use_session_workspace_root_as_primary_cwd"),
      "runtime prompt should include workspace contract",
    );
    assert(
      runtimeAnswer.includes("[Behavior Context]"),
      "runtime prompt should include behavior context envelope",
    );
    assert(
      runtimeAnswer.includes("[Discord Context]"),
      "runtime prompt should include discord context envelope",
    );
    assert(
      runtimeAnswer.includes("system_memory_refs"),
      "runtime prompt should include system memory refs in runtime feedback context",
    );
    assert(
      runtimeAnswer.includes(`discord_user_id: ${userId}`),
      "runtime prompt should include discord user id",
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

    const containerDeliverResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "container.file_deliver",
      execution_target: "gateway_adapter",
      arguments: {
        path: "workspace/note.txt",
        maxBytes: 1024 * 1024,
      },
      reason: "deliver container file",
    });
    assert(
      containerDeliverResult.status === "ok",
      "container.file_deliver should succeed",
    );
    const deliverPayload = containerDeliverResult.result as {
      path: string;
      file_name: string;
      bytes: number;
      content_base64: string;
    };
    assert(
      deliverPayload.path.endsWith("/workspace/note.txt"),
      "container.file_deliver should return resolved path",
    );
    assert(
      deliverPayload.file_name === "note.txt",
      "container.file_deliver should return file_name",
    );
    assert(
      deliverPayload.bytes === Buffer.byteLength("container smoke content", "utf8"),
      "container.file_deliver should return byte size",
    );
    assert(
      Buffer.from(deliverPayload.content_base64, "base64").toString("utf8") ===
        "container smoke content",
      "container.file_deliver should return base64 content",
    );

    const containerDeliverTooLargeResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "container.file_deliver",
      execution_target: "gateway_adapter",
      arguments: {
        path: "workspace/note.txt",
        maxBytes: 4,
      },
      reason: "deliver too large should fail",
    });
    assert(
      containerDeliverTooLargeResult.status === "error",
      "container.file_deliver too large should fail",
    );
    assert(
      containerDeliverTooLargeResult.error_code === "container_file_too_large",
      "container.file_deliver too large should return container_file_too_large",
    );

    const canonicalAliasReadResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "container.file_read",
      execution_target: "gateway_adapter",
      arguments: {
        path: `/agent/session/${startBody.session.sessionId}/workspace/note.txt`,
      },
      reason: "read via canonical session alias path",
    });
    assert(
      canonicalAliasReadResult.status === "ok",
      "canonical /agent/session alias path should resolve to scoped container root",
    );
    assert(
      (canonicalAliasReadResult.result as { content: string }).content ===
        "container smoke content",
      "canonical alias read should return file content",
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

    const foreignSessionAliasReadResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "container.file_read",
      execution_target: "gateway_adapter",
      arguments: {
        path: `/agent/session/${randomUUID()}/workspace/note.txt`,
      },
      reason: "reject foreign session alias path",
    });
    assert(
      foreignSessionAliasReadResult.status === "error",
      "foreign /agent/session alias path should fail",
    );
    assert(
      foreignSessionAliasReadResult.error_code === "container_path_out_of_scope",
      "foreign session alias read should return container_path_out_of_scope",
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

    const memorySourceUpsertResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "memory.upsert",
      execution_target: "gateway_adapter",
      arguments: {
        namespace: "conversation.fact",
        key: "entry-base",
        value: {
          content: "source-memory",
        },
        tags: ["smoke", "source"],
      },
      reason: "memory source upsert",
    });
    assert(
      memorySourceUpsertResult.status === "ok",
      "memory source upsert should succeed",
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
        backlinks: [
          {
            namespace: "conversation.fact",
            key: "entry-base",
            relation: "derived_from",
          },
        ],
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
      entry:
        | {
            value: { content: string };
            backlinks?: Array<{
              source_key: string;
              source_namespace: string;
              relation: string;
            }>;
          }
        | null;
    };
    assert(memoryGetPayload.found, "memory.get should return found=true");
    assert(
      memoryGetPayload.entry?.value.content === "hello-memory",
      "memory.get should return stored value",
    );
    assert(
      Array.isArray(memoryGetPayload.entry?.backlinks),
      "memory.get should include backlinks array",
    );
    assert(
      memoryGetPayload.entry?.backlinks?.some(
        (backlink) =>
          backlink.source_namespace === "conversation.fact" &&
          backlink.source_key === "entry-base" &&
          backlink.relation === "derived_from",
      ),
      "memory.get should include expected backlink",
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
      entries: Array<{ key: string; backlinks?: unknown[] }>;
    };
    assert(
      memorySearchPayload.entries.some((entry) => entry.key === "entry1"),
      "memory.search should include upserted key",
    );
    assert(
      memorySearchPayload.entries.some(
        (entry) => entry.key === "entry1" && Array.isArray(entry.backlinks),
      ),
      "memory.search should include backlinks for matching entry",
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

    const systemMemoryGetResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "memory.get",
      execution_target: "gateway_adapter",
      arguments: {
        namespace: "system.policy",
        key: "core_rules_smoke",
      },
      reason: "system memory get",
    });
    assert(systemMemoryGetResult.status === "ok", "memory.get should read system memory");
    const systemMemoryGetPayload = systemMemoryGetResult.result as {
      found: boolean;
      entry: {
        namespace: string;
        key: string;
        is_system: boolean;
      } | null;
    };
    assert(systemMemoryGetPayload.found, "system memory entry should be found");
    assert(
      systemMemoryGetPayload.entry?.is_system === true,
      "memory.get should expose is_system=true for system entry",
    );

    const systemMemorySearchResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "memory.search",
      execution_target: "gateway_adapter",
      arguments: {
        namespace: "system.policy",
        query: "core_rules_smoke",
        limit: 5,
      },
      reason: "system memory search",
    });
    assert(
      systemMemorySearchResult.status === "ok",
      "memory.search should include system memory entries",
    );
    const systemMemorySearchPayload = systemMemorySearchResult.result as {
      entries: Array<{ key: string; is_system: boolean }>;
    };
    assert(
      systemMemorySearchPayload.entries.some(
        (entry) => entry.key === "core_rules_smoke" && entry.is_system === true,
      ),
      "memory.search should return system entry with is_system=true",
    );

    const systemMemoryUpsertDenied = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "memory.upsert",
      execution_target: "gateway_adapter",
      arguments: {
        namespace: "system.policy",
        key: "core_rules_smoke",
        value: {
          execution: ["tamper"],
        },
      },
      reason: "system memory upsert denied",
    });
    assert(
      systemMemoryUpsertDenied.status === "error" &&
        systemMemoryUpsertDenied.error_code === "memory_system_entry_read_only",
      "memory.upsert should reject writes to system memory",
    );

    const systemMemoryDeleteDenied = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "memory.delete",
      execution_target: "gateway_adapter",
      arguments: {
        namespace: "system.policy",
        key: "core_rules_smoke",
      },
      reason: "system memory delete denied",
    });
    assert(
      systemMemoryDeleteDenied.status === "error" &&
        systemMemoryDeleteDenied.error_code === "memory_system_entry_read_only",
      "memory.delete should reject deletes of system memory",
    );

    const discordChannelHistoryResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "discord.channel_history",
      execution_target: "gateway_adapter",
      arguments: {
        limit: 10,
        role: "all",
      },
      reason: "discord channel history",
    });
    assert(
      discordChannelHistoryResult.status === "error" &&
        discordChannelHistoryResult.error_code === "approval_required",
      "discord.channel_history should require approval before granted",
    );
    const discordChannelHistoryScope =
      (discordChannelHistoryResult as McpResultError).details?.scope;
    assert(
      typeof discordChannelHistoryScope === "string",
      "discord.channel_history approval_required should include scope",
    );
    const discordChannelHistoryApprovalRequestResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/approvals/request`,
      payload: {
        userId,
        operation: "discord_channel_history",
        path: discordChannelHistoryScope,
      },
    });
    const discordChannelHistoryApprovalRequestBody = parseJsonBody(
      discordChannelHistoryApprovalRequestResponse.body,
    ) as {
      approval: { approvalId: string; status: string };
    };
    assertStatusCode(
      discordChannelHistoryApprovalRequestResponse.statusCode,
      200,
      "threads/approvals/request(discord_channel_history)",
    );
    assert(
      discordChannelHistoryApprovalRequestBody.approval.status === "requested",
      "discord channel history approval should be requested",
    );
    const discordChannelHistoryApprovalRespondResponse = await app.inject({
      method: "POST",
      url: `/v1/approvals/${discordChannelHistoryApprovalRequestBody.approval.approvalId}/respond`,
      payload: {
        userId,
        decision: "approved",
      },
    });
    assertStatusCode(
      discordChannelHistoryApprovalRespondResponse.statusCode,
      200,
      "approvals/respond(discord_channel_history)",
    );
    const discordChannelHistoryGrantedResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "discord.channel_history",
      execution_target: "gateway_adapter",
      arguments: {
        limit: 10,
        role: "all",
      },
      reason: "discord channel history after approval",
    });
    assert(
      discordChannelHistoryGrantedResult.status === "ok",
      "discord.channel_history should succeed",
    );
    const discordChannelHistoryPayload = (discordChannelHistoryGrantedResult as McpResultSuccess)
      .result as {
      channel_id: string;
      channel_name: string | null;
      source: "discord_api" | "repository";
      entries_source: "discord_api" | "repository";
      fallback_reason: string | null;
      entries: Array<{
        attachmentUrls: string[];
        reference: {
          messageId: string;
          channelId: string | null;
          guildId: string | null;
        } | null;
        replyTo: {
          messageId: string;
          channelId: string | null;
          userId: string | null;
          username: string | null;
          content: string | null;
          attachmentUrls: string[];
        } | null;
        forwardFrom: {
          messageId: string | null;
          channelId: string | null;
          guildId: string | null;
          userId: string | null;
          username: string | null;
          content: string | null;
          attachmentUrls: string[];
        } | null;
      }>;
      note: string;
    };
    assert(
      discordChannelHistoryPayload.channel_id === channelId,
      "discord.channel_history should return current channel",
    );
    assert(
      Array.isArray(discordChannelHistoryPayload.entries),
      "discord.channel_history should return entries",
    );
    assert(
      discordChannelHistoryPayload.entries_source === "repository" ||
        discordChannelHistoryPayload.entries_source === "discord_api",
      "discord.channel_history should return valid entries source",
    );
    assert(
      discordChannelHistoryPayload.entries.every(
        (entry) =>
          Array.isArray(entry.attachmentUrls) &&
          Object.prototype.hasOwnProperty.call(entry, "reference") &&
          Object.prototype.hasOwnProperty.call(entry, "replyTo") &&
          Object.prototype.hasOwnProperty.call(entry, "forwardFrom"),
      ),
      "discord.channel_history should include attachment/reference/forward fields",
    );
    assert(
      discordChannelHistoryPayload.note.includes("non-thread context"),
      "discord.channel_history should explain channel metadata usage",
    );

    const discordChannelListResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "discord.channel_list",
      execution_target: "gateway_adapter",
      arguments: {
        limit: 20,
      },
      reason: "discord channel list",
    });
    assert(
      discordChannelListResult.status === "error" &&
        discordChannelListResult.error_code === "approval_required",
      "discord.channel_list should require approval before granted",
    );
    const discordChannelListScope =
      (discordChannelListResult as McpResultError).details?.scope;
    assert(
      typeof discordChannelListScope === "string",
      "discord.channel_list approval_required should include scope",
    );
    const discordChannelListApprovalRequestResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/approvals/request`,
      payload: {
        userId,
        operation: "discord_channel_list",
        path: discordChannelListScope,
      },
    });
    const discordChannelListApprovalRequestBody = parseJsonBody(
      discordChannelListApprovalRequestResponse.body,
    ) as {
      approval: { approvalId: string; status: string };
    };
    assertStatusCode(
      discordChannelListApprovalRequestResponse.statusCode,
      200,
      "threads/approvals/request(discord_channel_list)",
    );
    const discordChannelListApprovalRespondResponse = await app.inject({
      method: "POST",
      url: `/v1/approvals/${discordChannelListApprovalRequestBody.approval.approvalId}/respond`,
      payload: {
        userId,
        decision: "approved",
      },
    });
    assertStatusCode(
      discordChannelListApprovalRespondResponse.statusCode,
      200,
      "approvals/respond(discord_channel_list)",
    );
    const discordChannelListGrantedResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "discord.channel_list",
      execution_target: "gateway_adapter",
      arguments: {
        limit: 20,
      },
      reason: "discord channel list after approval",
    });
    assert(
      discordChannelListGrantedResult.status === "ok",
      "discord.channel_list should succeed after approval",
    );
    const discordChannelListPayload = (discordChannelListGrantedResult as McpResultSuccess)
      .result as {
      source: "discord_api" | "repository";
      channels: Array<{ channel_id: string }>;
    };
    assert(
      Array.isArray(discordChannelListPayload.channels),
      "discord.channel_list should return channels array",
    );
    assert(
      discordChannelListPayload.channels.length > 0,
      "discord.channel_list should return at least one channel",
    );
    if (discordChannelListPayload.source === "repository") {
      assert(
        discordChannelListPayload.channels.some(
          (channel) => channel.channel_id === channelId,
        ),
        "repository-based discord.channel_list should include current session channel",
      );
    }

    const placeholderDiscordHistoryApprovalRequestResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/approvals/request`,
      payload: {
        userId,
        operation: "discord_channel_history",
        path: "discord_channel:__session_channel__",
      },
    });
    const placeholderDiscordHistoryApprovalRequestBody = parseJsonBody(
      placeholderDiscordHistoryApprovalRequestResponse.body,
    ) as {
      approval: {
        approvalId: string;
        status: string;
      } | null;
    };
    assertStatusCode(
      placeholderDiscordHistoryApprovalRequestResponse.statusCode,
      200,
      "threads/approvals/request(discord_channel_history placeholder)",
    );
    assert(
      placeholderDiscordHistoryApprovalRequestBody.approval?.status === "requested",
      "placeholder discord history approval should be requested",
    );

    const placeholderDiscordHistoryRespondResponse = await app.inject({
      method: "POST",
      url: `/v1/approvals/${placeholderDiscordHistoryApprovalRequestBody.approval?.approvalId ?? ""}/respond`,
      payload: {
        userId,
        decision: "approved",
      },
    });
    assertStatusCode(
      placeholderDiscordHistoryRespondResponse.statusCode,
      200,
      "approvals/respond(discord_channel_history placeholder)",
    );

    const placeholderDiscordHistoryGrantedResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "discord.channel_history",
      execution_target: "gateway_adapter",
      arguments: {
        limit: 10,
        role: "all",
      },
      reason: "discord history after placeholder approval",
    });
    assert(
      placeholderDiscordHistoryGrantedResult.status === "ok",
      "discord.channel_history should succeed after placeholder approval",
    );

    const placeholderDiscordListApprovalRequestResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/approvals/request`,
      payload: {
        userId,
        operation: "discord_channel_list",
        path: "discord_guild:__session_guild__",
      },
    });
    const placeholderDiscordListApprovalRequestBody = parseJsonBody(
      placeholderDiscordListApprovalRequestResponse.body,
    ) as {
      approval: {
        approvalId: string;
        status: string;
      } | null;
    };
    assertStatusCode(
      placeholderDiscordListApprovalRequestResponse.statusCode,
      200,
      "threads/approvals/request(discord_channel_list placeholder)",
    );
    assert(
      placeholderDiscordListApprovalRequestBody.approval?.status === "requested",
      "placeholder discord list approval should be requested",
    );

    const placeholderDiscordListRespondResponse = await app.inject({
      method: "POST",
      url: `/v1/approvals/${placeholderDiscordListApprovalRequestBody.approval?.approvalId ?? ""}/respond`,
      payload: {
        userId,
        decision: "approved",
      },
    });
    assertStatusCode(
      placeholderDiscordListRespondResponse.statusCode,
      200,
      "approvals/respond(discord_channel_list placeholder)",
    );

    const placeholderDiscordListGrantedResult = await callMcpTool(app, reporter, {
      task_id: startBody.taskId,
      session_id: startBody.session.sessionId,
      call_id: `call_${randomUUID()}`,
      tool_name: "discord.channel_list",
      execution_target: "gateway_adapter",
      arguments: {
        limit: 20,
      },
      reason: "discord list after placeholder approval",
    });
    assert(
      placeholderDiscordListGrantedResult.status === "ok",
      "discord.channel_list should succeed after placeholder approval",
    );

    const messageResponse = await app.inject({
      method: "POST",
      url: `/v1/threads/${threadId}/messages`,
      payload: {
        userId,
        username: "smoke-user",
        nickname: "smoke-nick",
        channelName: "smoke-channel",
        threadName: "smoke-thread",
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
        username: "smoke-user",
        nickname: "smoke-nick",
        channelName: "smoke-channel",
        threadName: "smoke-thread",
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
    if (dbMigrated) {
      await pool.query(
        "DELETE FROM memory_entries WHERE user_id = '__system__' AND namespace = 'system.policy' AND key = 'core_rules_smoke'",
      );
    }
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
        current.tool_events = [];
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
          tool_events: [],
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
          tool_events: [],
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
    tool_events: value.tool_events ?? [],
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
