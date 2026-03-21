import type { Pool, PoolClient } from "pg";
import type {
  ApprovalRecord,
  ApprovalStatus,
  DiscordRecentMessageRecord,
  MemoryBacklinkRecord,
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
  backlinks?: Array<{
    namespace: string;
    key: string;
    relation?: string;
  }>;
}

export interface SearchMemoryInput {
  userId: string;
  namespace: string;
  query?: string;
  limit: number;
}

export interface ResolveMemoryBacklinkInput {
  userId: string;
  namespace: string;
  key: string;
}

export interface ListDiscordRecentMessagesInput {
  threadId?: string;
  channelId?: string;
  limit: number;
}

export interface ListKnownDiscordChannelsInput {
  limit: number;
}

export interface DiscordKnownChannelRecord {
  channelId: string;
  channelName: string | null;
  lastSeenAt: Date | null;
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
  resolveMemoryBacklinks(
    input: ResolveMemoryBacklinkInput,
  ): Promise<MemoryBacklinkRecord[]>;
  deleteMemory(userId: string, namespace: string, key: string): Promise<void>;
  listKnownDiscordChannels(
    input: ListKnownDiscordChannelsInput,
  ): Promise<DiscordKnownChannelRecord[]>;
  listDiscordRecentMessages(
    input: ListDiscordRecentMessagesInput,
  ): Promise<DiscordRecentMessageRecord[]>;
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<MemoryEntryRow>(
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
      const stored = toMemoryEntryRecord(requireRow(rows[0], "upserted memory entry"));

      if (input.backlinks !== undefined) {
        await client.query(
          `
          DELETE FROM memory_links
          WHERE target_user_id = $1
            AND target_namespace = $2
            AND target_key = $3
          `,
          [input.userId, input.namespace, input.key],
        );

        const seen = new Set<string>();
        for (const backlink of input.backlinks) {
          const sourceNamespace = backlink.namespace.trim();
          const sourceKey = backlink.key.trim();
          const relation =
            backlink.relation && backlink.relation.trim().length > 0
              ? backlink.relation.trim()
              : "related";
          const dedupeKey = `${sourceNamespace}\u0000${sourceKey}\u0000${relation}`;
          if (seen.has(dedupeKey)) {
            continue;
          }
          seen.add(dedupeKey);

          const sourceResult = await client.query<{
            memory_id: string;
          }>(
            `
            SELECT memory_id
            FROM memory_entries
            WHERE user_id = $1
              AND namespace = $2
              AND "key" = $3
            `,
            [input.userId, sourceNamespace, sourceKey],
          );
          const source = sourceResult.rows[0];
          if (!source) {
            throw new Error(
              `memory_backlink_source_not_found:${sourceNamespace}:${sourceKey}`,
            );
          }

          await client.query(
            `
            INSERT INTO memory_links (
              source_memory_id,
              source_user_id,
              source_namespace,
              source_key,
              target_user_id,
              target_namespace,
              target_key,
              relation,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            ON CONFLICT (
              source_user_id,
              source_namespace,
              source_key,
              target_user_id,
              target_namespace,
              target_key,
              relation
            ) DO UPDATE SET
              created_at = NOW()
            `,
            [
              source.memory_id,
              input.userId,
              sourceNamespace,
              sourceKey,
              input.userId,
              input.namespace,
              input.key,
              relation,
            ],
          );
        }
      }

      await client.query("COMMIT");
      return stored;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
    const entry = toMemoryEntryRecord(requireRow(rows[0], "memory by key"));
    const backlinks = await this.resolveMemoryBacklinks({
      userId: entry.userId,
      namespace: entry.namespace,
      key: entry.key,
    });
    return {
      ...entry,
      backlinks,
    };
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
      const entries = rows.map(toMemoryEntryRecord);
      return this.attachBacklinks(entries);
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
    const entries = rows.map(toMemoryEntryRecord);
    return this.attachBacklinks(entries);
  }

  async resolveMemoryBacklinks(
    input: ResolveMemoryBacklinkInput,
  ): Promise<MemoryBacklinkRecord[]> {
    const { rows } = await this.pool.query<MemoryBacklinkRow>(
      `
      SELECT
        source_memory_id,
        source_namespace,
        source_key,
        relation,
        created_at
      FROM memory_links
      WHERE target_user_id = $1
        AND target_namespace = $2
        AND target_key = $3
      ORDER BY created_at DESC
      `,
      [input.userId, input.namespace, input.key],
    );
    return rows.map(toMemoryBacklinkRecord);
  }

  private async attachBacklinks(
    entries: MemoryEntryRecord[],
  ): Promise<MemoryEntryRecord[]> {
    if (entries.length === 0) {
      return entries;
    }
    const resolved = await Promise.all(
      entries.map(async (entry) => {
        const backlinks = await this.resolveMemoryBacklinks({
          userId: entry.userId,
          namespace: entry.namespace,
          key: entry.key,
        });
        return {
          ...entry,
          backlinks,
        };
      }),
    );
    return resolved;
  }

  async deleteMemory(
    userId: string,
    namespace: string,
    key: string,
  ): Promise<void> {
    await this.pool.query(
      `
      DELETE FROM memory_links
      WHERE target_user_id = $1
        AND target_namespace = $2
        AND target_key = $3
      `,
      [userId, namespace, key],
    );
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

  async listDiscordRecentMessages(
    input: ListDiscordRecentMessagesInput,
  ): Promise<DiscordRecentMessageRecord[]> {
    const normalizedLimit = Math.min(Math.max(input.limit, 1), 50);
    const threadId = input.threadId?.trim();
    const channelId = input.channelId?.trim();
    if (!threadId && !channelId) {
      return [];
    }
    const { rows } = await this.pool.query<DiscordRecentMessageRow>(
      `
      SELECT
        e.event_id,
        e.task_id,
        t.session_id,
        s.thread_id,
        s.channel_id,
        (e.payload_json ->> 'userId') AS user_id,
        NULLIF(e.payload_json ->> 'username', '') AS username,
        NULLIF(e.payload_json ->> 'nickname', '') AS nickname,
        COALESCE(NULLIF(e.payload_json ->> 'role', ''), 'assistant') AS role,
        COALESCE(e.payload_json ->> 'content', '') AS content,
        e."timestamp"
      FROM task_events e
      INNER JOIN tasks t ON t.task_id = e.task_id
      INNER JOIN sessions s ON s.session_id = t.session_id
      WHERE e.event_type = 'discord.message.logged'
        AND ($1::text IS NULL OR s.thread_id = $1)
        AND ($2::text IS NULL OR s.channel_id = $2)
      ORDER BY e."timestamp" DESC
      LIMIT $3
      `,
      [threadId ?? null, channelId ?? null, normalizedLimit],
    );
    return rows.map(toDiscordRecentMessageRecord).reverse();
  }

  async listKnownDiscordChannels(
    input: ListKnownDiscordChannelsInput,
  ): Promise<DiscordKnownChannelRecord[]> {
    const normalizedLimit = Math.min(Math.max(input.limit, 1), 200);
    const { rows } = await this.pool.query<DiscordKnownChannelRow>(
      `
      SELECT
        s.channel_id,
        (
          ARRAY_REMOVE(
            ARRAY_AGG(
              NULLIF(e.payload_json ->> 'channelName', '')
              ORDER BY e."timestamp" DESC
            ),
            NULL
          )
        )[1] AS channel_name,
        MAX(e."timestamp") AS last_seen_at
      FROM sessions s
      LEFT JOIN tasks t ON t.session_id = s.session_id
      LEFT JOIN task_events e ON e.task_id = t.task_id
        AND e.event_type IN ('thread.task.start', 'thread.message.received')
      GROUP BY s.channel_id
      ORDER BY MAX(e."timestamp") DESC NULLS LAST, s.channel_id ASC
      LIMIT $1
      `,
      [normalizedLimit],
    );
    return rows.map(toDiscordKnownChannelRecord);
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

interface MemoryBacklinkRow {
  source_memory_id: string;
  source_namespace: string;
  source_key: string;
  relation: string;
  created_at: Date;
}

interface DiscordRecentMessageRow {
  event_id: string;
  session_id: string;
  task_id: string;
  thread_id: string;
  channel_id: string;
  user_id: string;
  username: string | null;
  nickname: string | null;
  role: string;
  content: string;
  timestamp: Date;
}

interface DiscordKnownChannelRow {
  channel_id: string;
  channel_name: string | null;
  last_seen_at: Date | null;
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

function toMemoryBacklinkRecord(row: MemoryBacklinkRow): MemoryBacklinkRecord {
  return {
    sourceMemoryId: row.source_memory_id,
    sourceNamespace: row.source_namespace,
    sourceKey: row.source_key,
    relation: row.relation,
    createdAt: row.created_at,
  };
}

function toDiscordRecentMessageRecord(
  row: DiscordRecentMessageRow,
): DiscordRecentMessageRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    threadId: row.thread_id,
    channelId: row.channel_id,
    userId: row.user_id,
    username: row.username,
    nickname: row.nickname,
    role: row.role === "user" ? "user" : "assistant",
    content: row.content,
    timestamp: row.timestamp,
  };
}

function toDiscordKnownChannelRecord(
  row: DiscordKnownChannelRow,
): DiscordKnownChannelRecord {
  return {
    channelId: row.channel_id,
    channelName: row.channel_name,
    lastSeenAt: row.last_seen_at,
  };
}

function requireRow<T>(row: T | undefined, context: string): T {
  if (!row) {
    throw new Error(`Expected row is missing for ${context}.`);
  }

  return row;
}
