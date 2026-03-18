import type { Pool } from "pg";

export interface SessionRecord {
  sessionId: string;
  userId: string;
  channelId: string;
  threadId: string;
  status: string;
  lastThreadActivityAt: Date;
  idleDeadlineAt: Date | null;
  closedReason: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSessionInput {
  sessionId: string;
  userId: string;
  channelId: string;
  threadId: string;
  status: string;
  lastThreadActivityAt?: Date;
  idleDeadlineAt?: Date | null;
}

export interface CreateTaskInput {
  taskId: string;
  sessionId: string;
  userId: string;
  status: string;
}

export interface TaskEventInput {
  eventId: string;
  taskId: string;
  eventType: string;
  payloadJson: Record<string, unknown>;
  timestamp?: Date;
}

export interface ApprovalInput {
  approvalId: string;
  taskId: string;
  sessionId: string;
  operation: string;
  path: string;
  status: string;
}

export interface PathPermissionInput {
  sessionId: string;
  operation: string;
  path: string;
  grantedBy: string;
  grantedAt?: Date;
  expiresAt?: Date | null;
}

export interface AuditLogInput {
  logId: string;
  correlationId: string;
  actor: string;
  decision: string;
  reason?: string | null;
  raw: Record<string, unknown>;
  timestamp?: Date;
}

export interface PathPermissionRecord {
  sessionId: string;
  operation: string;
  path: string;
  grantedBy: string;
  grantedAt: Date;
  expiresAt: Date | null;
}

export class StateStore {
  constructor(private readonly pool: Pool) {}

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const lastThreadActivityAt = input.lastThreadActivityAt ?? new Date();
    const { rows } = await this.pool.query<SessionRow>(
      `
      INSERT INTO sessions (
        session_id,
        user_id,
        channel_id,
        thread_id,
        status,
        last_thread_activity_at,
        idle_deadline_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        input.sessionId,
        input.userId,
        input.channelId,
        input.threadId,
        input.status,
        lastThreadActivityAt,
        input.idleDeadlineAt ?? null,
      ],
    );

    return toSessionRecord(rows[0]);
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<SessionRow>(
      "SELECT * FROM sessions WHERE session_id = $1",
      [sessionId],
    );
    return rows.length > 0 ? toSessionRecord(rows[0]) : null;
  }

  async getSessionByThreadId(threadId: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<SessionRow>(
      "SELECT * FROM sessions WHERE thread_id = $1",
      [threadId],
    );
    return rows.length > 0 ? toSessionRecord(rows[0]) : null;
  }

  async listSessionsByUser(
    userId: string,
    limit = 20,
  ): Promise<SessionRecord[]> {
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
    status: string,
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

  async createTask(input: CreateTaskInput): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO tasks (
        task_id,
        session_id,
        user_id,
        status
      )
      VALUES ($1, $2, $3, $4)
      `,
      [input.taskId, input.sessionId, input.userId, input.status],
    );
  }

  async updateTaskStatus(taskId: string, status: string): Promise<void> {
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

  async appendTaskEvent(input: TaskEventInput): Promise<void> {
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
        input.payloadJson,
        input.timestamp ?? new Date(),
      ],
    );
  }

  async createApproval(input: ApprovalInput): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO approvals (
        approval_id,
        task_id,
        session_id,
        operation,
        path,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        input.approvalId,
        input.taskId,
        input.sessionId,
        input.operation,
        input.path,
        input.status,
      ],
    );
  }

  async resolveApproval(
    approvalId: string,
    status: string,
    responderId?: string,
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
      [approvalId, status, responderId ?? null],
    );
  }

  async grantPathPermission(input: PathPermissionInput): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO session_path_permissions (
        session_id,
        operation,
        path,
        granted_by,
        granted_at,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (session_id, operation, path)
      DO UPDATE SET
        granted_by = EXCLUDED.granted_by,
        granted_at = EXCLUDED.granted_at,
        expires_at = EXCLUDED.expires_at
      `,
      [
        input.sessionId,
        input.operation,
        input.path,
        input.grantedBy,
        input.grantedAt ?? new Date(),
        input.expiresAt ?? null,
      ],
    );
  }

  async listPathPermissions(sessionId: string): Promise<PathPermissionRecord[]> {
    const { rows } = await this.pool.query<PathPermissionRow>(
      `
      SELECT *
      FROM session_path_permissions
      WHERE session_id = $1
      ORDER BY granted_at DESC
      `,
      [sessionId],
    );
    return rows.map(toPathPermissionRecord);
  }

  async saveSnapshot(
    snapshotId: string,
    sessionId: string,
    snapshotJson: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO session_snapshots (
        snapshot_id,
        session_id,
        snapshot_json
      )
      VALUES ($1, $2, $3)
      `,
      [snapshotId, sessionId, snapshotJson],
    );
  }

  async appendAuditLog(input: AuditLogInput): Promise<void> {
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
        input.raw,
        input.timestamp ?? new Date(),
      ],
    );
  }
}

interface SessionRow {
  session_id: string;
  user_id: string;
  channel_id: string;
  thread_id: string;
  status: string;
  last_thread_activity_at: Date;
  idle_deadline_at: Date | null;
  closed_reason: string | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface PathPermissionRow {
  session_id: string;
  operation: string;
  path: string;
  granted_by: string;
  granted_at: Date;
  expires_at: Date | null;
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

function toPathPermissionRecord(
  row: PathPermissionRow,
): PathPermissionRecord {
  return {
    sessionId: row.session_id,
    operation: row.operation,
    path: row.path,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
  };
}
