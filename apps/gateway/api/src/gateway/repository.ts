import type { Pool, PoolClient } from "pg";
import type {
  ApprovalRecord,
  ApprovalStatus,
  SessionRecord,
  SessionStatus,
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
  grantPathPermission(
    sessionId: string,
    operation: string,
    path: string,
    grantedBy: string,
  ): Promise<void>;
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

function requireRow<T>(row: T | undefined, context: string): T {
  if (!row) {
    throw new Error(`Expected row is missing for ${context}.`);
  }

  return row;
}
