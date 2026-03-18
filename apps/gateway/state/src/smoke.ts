import "dotenv/config";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../../memory/src/memoryStore.js";
import { createMemoryPool, createStatePool } from "./db.js";
import { runMigrations } from "./migrate.js";
import { StateStore } from "./stateStore.js";

async function main(): Promise<void> {
  const statePool = createStatePool();
  const memoryPool = createMemoryPool();

  const sessionId = newId("sess");
  const taskId = newId("task");
  const approvalId = newId("approval");
  const eventId = newId("event");
  const snapshotId = newId("snapshot");
  const logId = newId("log");
  const userId = `user_${randomUUID()}`;
  const channelId = "channel_smoke";
  const threadId = `thread_${randomUUID()}`;
  const namespace = "smoke";
  const key = `entry_${randomUUID()}`;
  const memoryId = newId("memory");
  const correlationId = newId("corr");

  try {
    await runMigrations(statePool);

    const stateStore = new StateStore(statePool);
    const memoryStore = new MemoryStore(memoryPool);

    const now = new Date();
    const idleDeadlineAt = new Date(now.getTime() + 10 * 60 * 1000);

    await stateStore.createSession({
      sessionId,
      userId,
      channelId,
      threadId,
      status: "running",
      lastThreadActivityAt: now,
      idleDeadlineAt,
    });

    const createdSession = await stateStore.getSessionById(sessionId);
    assert(createdSession !== null, "session should exist after create");

    await stateStore.updateSessionActivity(
      sessionId,
      new Date(),
      new Date(Date.now() + 5 * 60 * 1000),
    );

    await stateStore.createTask({
      taskId,
      sessionId,
      userId,
      status: "running",
    });
    await stateStore.appendTaskEvent({
      eventId,
      taskId,
      eventType: "smoke_started",
      payloadJson: {
        source: "db:smoke",
      },
    });

    await stateStore.createApproval({
      approvalId,
      taskId,
      sessionId,
      operation: "host.file_read",
      path: "/tmp/sample.txt",
      status: "requested",
    });
    await stateStore.resolveApproval(approvalId, "approved", userId);

    await stateStore.grantPathPermission({
      sessionId,
      operation: "host.file_read",
      path: "/tmp/sample.txt",
      grantedBy: userId,
    });

    const permissions = await stateStore.listPathPermissions(sessionId);
    assert(permissions.length > 0, "path permission should be persisted");

    await stateStore.saveSnapshot(snapshotId, sessionId, {
      status: "running",
      cursor: "token-smoke",
    });

    await stateStore.appendAuditLog({
      logId,
      correlationId,
      actor: "smoke-test",
      decision: "allow",
      reason: "verification",
      raw: {
        sessionId,
      },
    });

    await memoryStore.upsert({
      memoryId,
      userId,
      namespace,
      key,
      valueJson: {
        note: "smoke-value",
      },
      tagsJson: ["smoke", "p2"],
    });

    const memory = await memoryStore.get(userId, namespace, key);
    assert(memory !== null, "memory entry should exist after upsert");

    const memorySearch = await memoryStore.search({
      userId,
      namespace,
      keyPrefix: "entry_",
      limit: 10,
    });
    assert(memorySearch.length > 0, "memory search should return at least one row");

    await memoryStore.delete(userId, namespace, key);
    const deletedMemory = await memoryStore.get(userId, namespace, key);
    assert(deletedMemory === null, "memory entry should be deleted");

    await stateStore.updateSessionStatus(sessionId, "closed_by_user", {
      closedReason: "smoke",
      closedAt: new Date(),
    });
    const listed = await stateStore.listSessionsByUser(userId, 5);
    assert(listed.length > 0, "session list should include inserted row");

    console.log("[db:smoke] state/memory CRUD checks passed.");
  } finally {
    await swallowDbError(statePool.query("DELETE FROM audit_logs WHERE log_id = $1", [logId]));
    await swallowDbError(
      statePool.query("DELETE FROM sessions WHERE session_id = $1", [sessionId]),
    );
    await swallowDbError(
      memoryPool.query(
        `
        DELETE FROM memory_entries
        WHERE user_id = $1
          AND namespace = $2
          AND "key" = $3
        `,
        [userId, namespace, key],
      ),
    );
    await statePool.end();
    await memoryPool.end();
  }
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[db:smoke] assertion failed: ${message}`);
  }
}

async function swallowDbError(queryPromise: Promise<unknown>): Promise<void> {
  try {
    await queryPromise;
  } catch {
    return;
  }
}

main().catch((error) => {
  console.error("[db:smoke] failed:", error);
  process.exit(1);
});
