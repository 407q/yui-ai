import type { Pool, PoolClient } from "pg";
import type {
  ApprovalRecord,
  ApprovalStatus,
  MemoryEntryRecord,
  SessionRecord,
  SessionPathPermissionRecord,
  SessionStatus,
  TaskEventRecord,
  TaskRecord,
  TaskStatus,
} from "./types.js";

export interface CreateSessionAndTaskInput {
  sessionId: string;
  taskId: string;
  userId: string;
  channelId: string;
  threadId: string;
  sessionStatus: SessionStatus;
  taskStatus: TaskStatus;
  now: Date;
  idleDeadlineAt: Date | null;
}

export interface CreateTaskInput {
  taskId: string;
  sessionId: string;
  userId: string;
  status: TaskStatus;
}

export interface AppendTaskEventInput {
  eventId: string;
  taskId: string;
  eventType: string;
  payloadJson: Record<string, unknown>;
  timestamp?: Date;
}

export interface CreateApprovalInput {
  approvalId: string;
  taskId: string;
  sessionId: string;
  operation: string;
  path: string;
}

export interface AppendAuditLogInput {
  logId: string;
  correlationId: string;
  actor: string;
  decision: string;
  reason?: string | null;
  raw: Record<string, unknown>;
  timestamp?: Date;
}

export interface UpsertMemoryInput {
  memoryId: string;
  userId: string;
  namespace: string;
  key: string;
  valueJson: Record<string, unknown>;
  tagsJson?: string[];
}

export interface SearchMemoryInput {
  userId: string;
  namespace: string;
  query?: string;
  limit: number;
}

export interface GatewayRepository {
  ping(): Promise<void>;
  createSessionAndTask(
    input: CreateSessionAndTaskInput,
  ): Promise<{ session: SessionRecord; task: TaskRecord }>;
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  appendTaskEvent(input: AppendTaskEventInput): Promise<void>;
  findSessionByThreadId(threadId: string): Promise<SessionRecord | null>;
  updateSessionActivity(
    sessionId: string,
    lastThreadActivityAt: Date,
    idleDeadlineAt: Date | null,
  ): Promise<void>;
  findSessionById(sessionId: string): Promise<SessionRecord | null>;
  updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    options?: {
      closedReason?: string | null;
      closedAt?: Date | null;
    },
  ): Promise<void>;
  findLatestTaskBySessionId(sessionId: string): Promise<TaskRecord | null>;
  findLatestActiveTaskBySessionId(sessionId: string): Promise<TaskRecord | null>;
  findTaskById(taskId: string): Promise<TaskRecord | null>;
  listTaskEventsByTaskId(
    taskId: string,
    options?: {
      eventTypes?: string[];
      afterTimestamp?: Date;
      limit?: number;
    },
  ): Promise<TaskEventRecord[]>;
  updateTaskStatus(taskId: string, status: TaskStatus): Promise<void>;
  createApproval(input: CreateApprovalInput): Promise<ApprovalRecord>;
  findApprovalById(approvalId: string): Promise<ApprovalRecord | null>;
  findLatestPendingApprovalBySessionId(
    sessionId: string,
  ): Promise<ApprovalRecord | null>;
  resolveApproval(
    approvalId: string,
    status: ApprovalStatus,
    responderId: string | null,
  ): Promise<void>;
  findLatestApprovalByScope(
    sessionId: string,
    operation: string,
    path: string,
  ): Promise<ApprovalRecord | null>;
  grantPathPermission(
    sessionId: string,
    operation: string,
    path: string,
    grantedBy: string,
  ): Promise<void>;
  listPathPermissions(
    sessionId: string,
    operation: string,
  ): Promise<SessionPathPermissionRecord[]>;
  appendAuditLog(input: AppendAuditLogInput): Promise<void>;
  upsertMemory(input: UpsertMemoryInput): Promise<MemoryEntryRecord>;
  getMemory(
    userId: string,
    namespace: string,
    key: string,
  ): Promise<MemoryEntryRecord | null>;
  searchMemory(input: SearchMemoryInput): Promise<MemoryEntryRecord[]>;
  deleteMemory(userId: string, namespace: string, key: string): Promise<void>;
  listSessionsByUser(userId: string, limit: number): Promise<SessionRecord[]>;
}

export class PostgresGatewayRepository implements GatewayRepository {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async createSessionAndTask(
    input: CreateSessionAndTaskInput,
  ): Promise<{ session: SessionRecord; task: TaskRecord }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await insertSession(client, input);
      const task = await insertTask(client, {
        taskId: input.taskId,
        sessionId: input.sessionId,
        userId: input.userId,
        status: input.taskStatus,
      });
      await client.query("COMMIT");
      return { session, task };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    return insertTask(this.pool, input);
  }

  async appendTaskEvent(input: AppendTaskEventInput): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO task_events (
        event_id,
        task_id,
        event_type,
        payload_json,
        "timestamp"
      )
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        input.eventId,
        input.taskId,
        input.eventType,
        JSON.stringify(input.payloadJson),
        input.timestamp ?? new Date(),
      ],
    );
  }

  async findSessionByThreadId(threadId: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `
      SELECT *
      FROM sessions
      WHERE thread_id = $1
      `,
      [threadId],
    );
    if (rows.length === 0) {
      return null;
    }

    return toSessionRecord(requireRow(rows[0], "session by thread_id"));
  }

  async findSessionById(sessionId: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `
      SELECT *
      FROM sessions
      WHERE session_id = $1
      `,
      [sessionId],
    );
    if (rows.length === 0) {
      return null;
    }

    return toSessionRecord(requireRow(rows[0], "session by session_id"));
  }

  async updateSessionActivity(
    sessionId: string,
    lastThreadActivityAt: Date,
    idleDeadlineAt: Date | null,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE sessions
      SET
        last_thread_activity_at = $2,
        idle_deadline_at = $3,
        updated_at = NOW()
      WHERE session_id = $1
      `,
      [sessionId, lastThreadActivityAt, idleDeadlineAt],
    );
  }

  async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    options?: {
      closedReason?: string | null;
      closedAt?: Date | null;
    },
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE sessions
      SET
        status = $2,
        closed_reason = $3,
        closed_at = $4,
        updated_at = NOW()
      WHERE session_id = $1
      `,
      [
        sessionId,
        status,
        options?.closedReason ?? null,
        options?.closedAt ?? null,
      ],
    );
  }

  async findLatestTaskBySessionId(sessionId: string): Promise<TaskRecord | null> {
    const { rows } = await this.pool.query<TaskRow>(
      `
      SELECT *
      FROM tasks
      WHERE session_id = $1
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
      `,
      [sessionId],
    );
    if (rows.length === 0) {
      return null;
    }

    return toTaskRecord(requireRow(rows[0], "latest task by session_id"));
  }

  async findLatestActiveTaskBySessionId(
    sessionId: string,
  ): Promise<TaskRecord | null> {
    const activeStatuses: TaskStatus[] = ["queued", "running", "waiting_approval"];
    const { rows } = await this.pool.query<TaskRow>(
      `
      SELECT *
      FROM tasks
      WHERE session_id = $1
        AND status = ANY($2::TEXT[])
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
      `,
      [sessionId, activeStatuses],
    );
    if (rows.length === 0) {
      return null;
    }

    return toTaskRecord(
      requireRow(rows[0], "latest active task by session_id"),
    );
  }

  async findTaskById(taskId: string): Promise<TaskRecord | null> {
    const { rows } = await this.pool.query<TaskRow>(
      `
      SELECT *
      FROM tasks
      WHERE task_id = $1
      `,
      [taskId],
    );
    if (rows.length === 0) {
      return null;
    }

    return toTaskRecord(requireRow(rows[0], "task by task_id"));
  }

  async listTaskEventsByTaskId(
    taskId: string,
    options?: {
      eventTypes?: string[];
      afterTimestamp?: Date;
      limit?: number;
    },
  ): Promise<TaskEventRecord[]> {
    const eventTypes = options?.eventTypes ?? [];
    const afterTimestamp = options?.afterTimestamp ?? null;
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const useEventTypes = eventTypes.length > 0;
    const { rows } = await this.pool.query<TaskEventRow>(
      `
      SELECT *
      FROM task_events
      WHERE task_id = $1
        AND ($2::boolean = false OR event_type = ANY($3::text[]))
        AND ($4::timestamptz IS NULL OR "timestamp" > $4)
      ORDER BY "timestamp" ASC
      LIMIT $5
      `,
      [taskId, useEventTypes, eventTypes, afterTimestamp, limit],
    );
    return rows.map(toTaskEventRecord);
  }

  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    await this.pool.query(
      `
      UPDATE tasks
      SET
        status = $2,
        updated_at = NOW()
      WHERE task_id = $1
      `,
      [taskId, status],
    );
  }

  async createApproval(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const { rows } = await this.pool.query<ApprovalRow>(
      `
      INSERT INTO approvals (
        approval_id,
        task_id,
        session_id,
        operation,
        path,
        status,
        requested_at
      )
      VALUES ($1, $2, $3, $4, $5, 'requested', NOW())
      RETURNING *
      `,
      [
        input.approvalId,
        input.taskId,
        input.sessionId,
        input.operation,
        input.path,
      ],
    );

    return toApprovalRecord(requireRow(rows[0], "inserted approval"));
  }

  async findApprovalById(approvalId: string): Promise<ApprovalRecord | null> {
    const { rows } = await this.pool.query<ApprovalRow>(
      `
      SELECT *
      FROM approvals
      WHERE approval_id = $1
      `,
      [approvalId],
    );
    if (rows.length === 0) {
      return null;
    }

    return toApprovalRecord(requireRow(rows[0], "approval by approval_id"));
  }

  async findLatestPendingApprovalBySessionId(
    sessionId: string,
  ): Promise<ApprovalRecord | null> {
    const { rows } = await this.pool.query<ApprovalRow>(
      `
      SELECT *
      FROM approvals
      WHERE session_id = $1
        AND status = 'requested'
      ORDER BY requested_at DESC
      LIMIT 1
      `,
      [sessionId],
    );
    if (rows.length === 0) {
      return null;
    }

    return toApprovalRecord(
      requireRow(rows[0], "latest pending approval by session_id"),
    );
  }

  async resolveApproval(
    approvalId: string,
    status: ApprovalStatus,
    responderId: string | null,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE approvals
      SET
        status = $2,
        responded_at = NOW(),
        responder_id = $3
      WHERE approval_id = $1
      `,
      [approvalId, status, responderId],
    );
  }

  async findLatestApprovalByScope(
    sessionId: string,
    operation: string,
    path: string,
  ): Promise<ApprovalRecord | null> {
    const { rows } = await this.pool.query<ApprovalRow>(
      `
      SELECT *
      FROM approvals
      WHERE session_id = $1
        AND operation = $2
        AND path = $3
      ORDER BY requested_at DESC
      LIMIT 1
      `,
      [sessionId, operation, path],
    );
    if (rows.length === 0) {
      return null;
    }

    return toApprovalRecord(requireRow(rows[0], "latest approval by scope"));
  }

  async grantPathPermission(
    sessionId: string,
    operation: string,
    path: string,
    grantedBy: string,
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO session_path_permissions (
        session_id,
        operation,
        path,
        granted_by,
        granted_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (session_id, operation, path)
      DO UPDATE SET
        granted_by = EXCLUDED.granted_by,
        granted_at = EXCLUDED.granted_at
      `,
      [sessionId, operation, path, grantedBy],
    );
  }

  async listPathPermissions(
    sessionId: string,
    operation: string,
  ): Promise<SessionPathPermissionRecord[]> {
    const { rows } = await this.pool.query<SessionPathPermissionRow>(
      `
      SELECT *
      FROM session_path_permissions
      WHERE session_id = $1
        AND operation = $2
      ORDER BY granted_at DESC
      `,
      [sessionId, operation],
    );
    return rows.map(toSessionPathPermissionRecord);
  }

  async appendAuditLog(input: AppendAuditLogInput): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO audit_logs (
        log_id,
        correlation_id,
        actor,
        decision,
        reason,
        raw,
        "timestamp"
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        input.logId,
        input.correlationId,
        input.actor,
        input.decision,
        input.reason ?? null,
        JSON.stringify(input.raw),
        input.timestamp ?? new Date(),
      ],
    );
  }

  async upsertMemory(input: UpsertMemoryInput): Promise<MemoryEntryRecord> {
    const { rows } = await this.pool.query<MemoryEntryRow>(
      `
      INSERT INTO memory_entries (
        memory_id,
        user_id,
        namespace,
        "key",
        value_json,
        tags_json,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (user_id, namespace, "key")
      DO UPDATE SET
        value_json = EXCLUDED.value_json,
        tags_json = EXCLUDED.tags_json,
        updated_at = NOW()
      RETURNING *
      `,
      [
        input.memoryId,
        input.userId,
        input.namespace,
        input.key,
        JSON.stringify(input.valueJson),
        JSON.stringify(input.tagsJson ?? []),
      ],
    );
    return toMemoryEntryRecord(requireRow(rows[0], "upserted memory entry"));
  }

  async getMemory(
    userId: string,
    namespace: string,
    key: string,
  ): Promise<MemoryEntryRecord | null> {
    const { rows } = await this.pool.query<MemoryEntryRow>(
      `
      SELECT *
      FROM memory_entries
      WHERE user_id = $1
        AND namespace = $2
        AND "key" = $3
      `,
      [userId, namespace, key],
    );
    if (rows.length === 0) {
      return null;
    }
    return toMemoryEntryRecord(requireRow(rows[0], "memory by key"));
  }

  async searchMemory(input: SearchMemoryInput): Promise<MemoryEntryRecord[]> {
    const normalizedLimit = Math.min(Math.max(input.limit, 1), 100);
    if (!input.query || input.query.trim().length === 0) {
      const { rows } = await this.pool.query<MemoryEntryRow>(
        `
        SELECT *
        FROM memory_entries
        WHERE user_id = $1
          AND namespace = $2
        ORDER BY updated_at DESC
        LIMIT $3
        `,
        [input.userId, input.namespace, normalizedLimit],
      );
      return rows.map(toMemoryEntryRecord);
    }

    const search = `%${input.query}%`;
    const { rows } = await this.pool.query<MemoryEntryRow>(
      `
      SELECT *
      FROM memory_entries
      WHERE user_id = $1
        AND namespace = $2
        AND (
          "key" ILIKE $3
          OR value_json::TEXT ILIKE $3
          OR tags_json::TEXT ILIKE $3
        )
      ORDER BY updated_at DESC
      LIMIT $4
      `,
      [input.userId, input.namespace, search, normalizedLimit],
    );
    return rows.map(toMemoryEntryRecord);
  }

  async deleteMemory(
    userId: string,
    namespace: string,
    key: string,
  ): Promise<void> {
    await this.pool.query(
      `
      DELETE FROM memory_entries
      WHERE user_id = $1
        AND namespace = $2
        AND "key" = $3
      `,
      [userId, namespace, key],
    );
  }

  async listSessionsByUser(userId: string, limit: number): Promise<SessionRecord[]> {
    const { rows } = await this.pool.query<SessionRow>(
      `
      SELECT *
      FROM sessions
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT $2
      `,
      [userId, limit],
    );
    return rows.map(toSessionRecord);
  }
}

async function insertSession(
  executor: Pool | PoolClient,
  input: CreateSessionAndTaskInput,
): Promise<SessionRecord> {
  const { rows } = await executor.query<SessionRow>(
    `
    INSERT INTO sessions (
      session_id,
      user_id,
      channel_id,
      thread_id,
      status,
      last_thread_activity_at,
      idle_deadline_at,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
    RETURNING *
    `,
    [
      input.sessionId,
      input.userId,
      input.channelId,
      input.threadId,
      input.sessionStatus,
      input.now,
      input.idleDeadlineAt,
      input.now,
    ],
  );
  return toSessionRecord(requireRow(rows[0], "inserted session"));
}

async function insertTask(
  executor: Pool | PoolClient,
  input: CreateTaskInput,
): Promise<TaskRecord> {
  const { rows } = await executor.query<TaskRow>(
    `
    INSERT INTO tasks (
      task_id,
      session_id,
      user_id,
      status
    )
    VALUES ($1, $2, $3, $4)
    RETURNING *
    `,
    [input.taskId, input.sessionId, input.userId, input.status],
  );
  return toTaskRecord(requireRow(rows[0], "inserted task"));
}

interface SessionRow {
  session_id: string;
  user_id: string;
  channel_id: string;
  thread_id: string;
  status: SessionStatus;
  last_thread_activity_at: Date;
  idle_deadline_at: Date | null;
  closed_reason: string | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface TaskRow {
  task_id: string;
  session_id: string;
  user_id: string;
  status: TaskStatus;
  created_at: Date;
  updated_at: Date;
}

interface TaskEventRow {
  event_id: string;
  task_id: string;
  event_type: string;
  payload_json: Record<string, unknown>;
  timestamp: Date;
}

interface ApprovalRow {
  approval_id: string;
  task_id: string;
  session_id: string;
  operation: string;
  path: string;
  status: ApprovalStatus;
  requested_at: Date;
  responded_at: Date | null;
  responder_id: string | null;
}

interface SessionPathPermissionRow {
  session_id: string;
  operation: string;
  path: string;
  granted_by: string;
  granted_at: Date;
  expires_at: Date | null;
}

interface MemoryEntryRow {
  memory_id: string;
  user_id: string;
  namespace: string;
  key: string;
  value_json: Record<string, unknown>;
  tags_json: string[];
  updated_at: Date;
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    status: row.status,
    lastThreadActivityAt: row.last_thread_activity_at,
    idleDeadlineAt: row.idle_deadline_at,
    closedReason: row.closed_reason,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTaskRecord(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id,
    sessionId: row.session_id,
    userId: row.user_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTaskEventRecord(row: TaskEventRow): TaskEventRecord {
  return {
    eventId: row.event_id,
    taskId: row.task_id,
    eventType: row.event_type,
    payloadJson: row.payload_json,
    timestamp: row.timestamp,
  };
}

function toApprovalRecord(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    operation: row.operation,
    path: row.path,
    status: row.status,
    requestedAt: row.requested_at,
    respondedAt: row.responded_at,
    responderId: row.responder_id,
  };
}

function toSessionPathPermissionRecord(
  row: SessionPathPermissionRow,
): SessionPathPermissionRecord {
  return {
    sessionId: row.session_id,
    operation: row.operation,
    path: row.path,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
  };
}

function toMemoryEntryRecord(row: MemoryEntryRow): MemoryEntryRecord {
  return {
    memoryId: row.memory_id,
    userId: row.user_id,
    namespace: row.namespace,
    key: row.key,
    valueJson: row.value_json,
    tagsJson: row.tags_json,
    updatedAt: row.updated_at,
  };
}

function requireRow<T>(row: T | undefined, context: string): T {
  if (!row) {
    throw new Error(`Expected row is missing for ${context}.`);
  }

  return row;
}
