import type { Pool, PoolClient } from "pg";
import type {
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
  updateTaskStatus(taskId: string, status: TaskStatus): Promise<void>;
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

function requireRow<T>(row: T | undefined, context: string): T {
  if (!row) {
    throw new Error(`Expected row is missing for ${context}.`);
  }

  return row;
}
