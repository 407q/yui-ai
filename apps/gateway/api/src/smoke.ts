import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createGatewayPool } from "./gateway/db.js";
import { buildGatewayApiServer } from "./server.js";

async function main(): Promise<void> {
  const pool = createGatewayPool();
  const app = buildGatewayApiServer({
    logger: false,
    pool,
  });

  const userId = `user_${randomUUID()}`;
  const threadId = `thread_${randomUUID()}`;
  const channelId = `channel_${randomUUID()}`;
  let sessionId: string | null = null;

  try {
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
    await app.close();
    await pool.end();
  }
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
