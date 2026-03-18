import { randomUUID } from "node:crypto";
import type {
  AgentRuntimeClient,
  AgentRuntimeTaskStatus,
  AgentRuntimeToolCall,
} from "../agent/runtimeClient.js";
import { GatewayApiError } from "./errors.js";
import type {
  GatewayRepository,
  CreateSessionAndTaskInput,
} from "./repository.js";
import type {
  ApprovalRecord,
  ApprovalStatus,
  SessionRecord,
  SessionStatus,
  TaskRecord,
  TaskStatus,
  ThreadStatusResponse,
} from "./types.js";

export interface GatewayApiServiceOptions {
  sessionIdleTimeoutSec: number;
  agentRuntimeClient?: AgentRuntimeClient;
}

export interface MentionStartInput {
  userId: string;
  channelId: string;
  threadId: string;
  prompt: string;
  attachmentNames: string[];
}

export interface ThreadMessageInput {
  threadId: string;
  userId: string;
  prompt: string;
  attachmentNames: string[];
}

export interface ThreadCancelInput {
  threadId: string;
  userId: string;
}

export interface ThreadCloseInput {
  threadId: string;
  userId: string;
}

export interface ApprovalRequestInput {
  threadId: string;
  userId: string;
  operation: string;
  path: string;
}

export interface ApprovalRespondInput {
  approvalId: string;
  decision: "approved" | "rejected" | "timeout";
  responderId?: string | null;
}

export interface AgentTaskRunInput {
  taskId: string;
  sessionId: string;
  userId: string;
  prompt: string;
  attachmentMountPath?: string;
  toolCalls?: AgentRuntimeToolCall[];
}

export interface AgentTaskStatusInput {
  taskId: string;
}

export interface AgentTaskCancelInput {
  taskId: string;
  userId: string;
}

export class GatewayApiService {
  constructor(
    private readonly repository: GatewayRepository,
    private readonly options: GatewayApiServiceOptions,
  ) {}

  async ping(): Promise<void> {
    await this.repository.ping();
  }

  async startFromMention(input: MentionStartInput): Promise<{
    session: SessionRecord;
    taskId: string;
  }> {
    const existing = await this.repository.findSessionByThreadId(input.threadId);
    if (existing) {
      throw new GatewayApiError(
        409,
        "session_exists_for_thread",
        "A session already exists for the provided thread.",
        { threadId: input.threadId, sessionId: existing.sessionId },
      );
    }

    const now = new Date();
    const idleDeadlineAt = this.calculateIdleDeadline(now);
    const sessionId = newId("sess");
    const taskId = newId("task");

    const payload: CreateSessionAndTaskInput = {
      sessionId,
      taskId,
      userId: input.userId,
      channelId: input.channelId,
      threadId: input.threadId,
      sessionStatus: "running",
      taskStatus: "running",
      now,
      idleDeadlineAt,
    };

    const { session } = await this.repository.createSessionAndTask(payload);
    await this.repository.appendTaskEvent({
      eventId: newId("event"),
      taskId,
      eventType: "thread.task.start",
      payloadJson: {
        prompt: input.prompt,
        attachmentNames: input.attachmentNames,
        requestedBy: input.userId,
      },
      timestamp: now,
    });

    return {
      session,
      taskId,
    };
  }

  async handleThreadMessage(input: ThreadMessageInput): Promise<{
    session: SessionRecord;
    taskId: string;
    resumedFromIdle: boolean;
  }> {
    let session = await this.requireSessionByThreadId(input.threadId);
    session = await this.refreshIdleStatusIfNeeded(session);

    if (session.status === "closed_by_user") {
      throw new GatewayApiError(
        409,
        "session_closed",
        "The session is already closed.",
        { threadId: input.threadId, sessionId: session.sessionId },
      );
    }

    const resumedFromIdle = session.status === "idle_paused";
    const now = new Date();
    const idleDeadlineAt = this.calculateIdleDeadline(now);
    await this.repository.updateSessionActivity(
      session.sessionId,
      now,
      idleDeadlineAt,
    );
    if (session.status !== "running") {
      await this.repository.updateSessionStatus(session.sessionId, "running");
    }

    const task = await this.repository.createTask({
      taskId: newId("task"),
      sessionId: session.sessionId,
      userId: input.userId,
      status: "running",
    });
    await this.repository.appendTaskEvent({
      eventId: newId("event"),
      taskId: task.taskId,
      eventType: "thread.message.received",
      payloadJson: {
        prompt: input.prompt,
        attachmentNames: input.attachmentNames,
        requestedBy: input.userId,
        resumedFromIdle,
      },
      timestamp: now,
    });

    return {
      session: {
        ...session,
        status: "running",
        lastThreadActivityAt: now,
        idleDeadlineAt,
        updatedAt: now,
      },
      taskId: task.taskId,
      resumedFromIdle,
    };
  }

  async getThreadStatus(threadId: string): Promise<ThreadStatusResponse> {
    let session = await this.requireSessionByThreadId(threadId);
    session = await this.refreshIdleStatusIfNeeded(session);

    const latestTask = await this.repository.findLatestTaskBySessionId(
      session.sessionId,
    );
    const pendingApproval = await this.repository.findLatestPendingApprovalBySessionId(
      session.sessionId,
    );
    return {
      session,
      latestTask,
      pendingApproval,
    };
  }

  async requestApproval(input: ApprovalRequestInput): Promise<{
    session: SessionRecord;
    task: TaskRecord;
    approval: ApprovalRecord;
  }> {
    let session = await this.requireSessionByThreadId(input.threadId);
    session = await this.refreshIdleStatusIfNeeded(session);
    this.assertSessionOpen(session);

    const now = new Date();
    const idleDeadlineAt = this.calculateIdleDeadline(now);
    await this.repository.updateSessionActivity(
      session.sessionId,
      now,
      idleDeadlineAt,
    );

    const pendingApproval = await this.repository.findLatestPendingApprovalBySessionId(
      session.sessionId,
    );
    if (pendingApproval) {
      throw new GatewayApiError(
        409,
        "approval_already_pending",
        "A pending approval already exists for this session.",
        {
          sessionId: session.sessionId,
          approvalId: pendingApproval.approvalId,
        },
      );
    }

    let task = await this.repository.findLatestActiveTaskBySessionId(
      session.sessionId,
    );
    if (!task) {
      task = await this.repository.createTask({
        taskId: newId("task"),
        sessionId: session.sessionId,
        userId: input.userId,
        status: "running",
      });
    }

    const approval = await this.repository.createApproval({
      approvalId: newId("apr"),
      taskId: task.taskId,
      sessionId: session.sessionId,
      operation: input.operation,
      path: input.path,
    });

    await this.repository.updateTaskStatus(task.taskId, "waiting_approval");
    await this.repository.updateSessionStatus(session.sessionId, "waiting_approval");
    await this.repository.appendTaskEvent({
      eventId: newId("event"),
      taskId: task.taskId,
      eventType: "approval.requested",
      payloadJson: {
        approvalId: approval.approvalId,
        operation: input.operation,
        path: input.path,
        requestedBy: input.userId,
      },
      timestamp: now,
    });

    return {
      session: {
        ...session,
        status: "waiting_approval",
        lastThreadActivityAt: now,
        idleDeadlineAt,
        updatedAt: now,
      },
      task: {
        ...task,
        status: "waiting_approval",
        updatedAt: now,
      },
      approval,
    };
  }

  async respondApproval(input: ApprovalRespondInput): Promise<{
    session: SessionRecord;
    task: TaskRecord;
    approval: ApprovalRecord;
  }> {
    const approval = await this.repository.findApprovalById(input.approvalId);
    if (!approval) {
      throw new GatewayApiError(
        404,
        "approval_not_found",
        "No approval request was found.",
        { approvalId: input.approvalId },
      );
    }

    if (approval.status !== "requested") {
      throw new GatewayApiError(
        409,
        "approval_already_resolved",
        "Approval request is already resolved.",
        {
          approvalId: approval.approvalId,
          status: approval.status,
        },
      );
    }

    const session = await this.repository.findSessionById(approval.sessionId);
    if (!session) {
      throw new GatewayApiError(
        404,
        "session_not_found",
        "Approval target session was not found.",
        { approvalId: approval.approvalId, sessionId: approval.sessionId },
      );
    }

    const task = await this.repository.findTaskById(approval.taskId);
    if (!task) {
      throw new GatewayApiError(
        404,
        "task_not_found",
        "Approval target task was not found.",
        { approvalId: approval.approvalId, taskId: approval.taskId },
      );
    }

    const now = new Date();
    const approvalStatus = mapDecisionToApprovalStatus(input.decision);
    const taskStatus: TaskStatus =
      input.decision === "approved" ? "running" : "failed";
    const sessionStatus: SessionStatus =
      input.decision === "approved" ? "running" : "idle_waiting";
    const idleDeadlineAt =
      sessionStatus === "idle_waiting" ? this.calculateIdleDeadline(now) : null;

    await this.repository.resolveApproval(
      approval.approvalId,
      approvalStatus,
      input.responderId ?? null,
    );
    await this.repository.updateTaskStatus(task.taskId, taskStatus);
    await this.repository.updateSessionStatus(session.sessionId, sessionStatus);
    await this.repository.updateSessionActivity(
      session.sessionId,
      now,
      idleDeadlineAt,
    );
    await this.repository.appendTaskEvent({
      eventId: newId("event"),
      taskId: task.taskId,
      eventType: `approval.${approvalStatus}`,
      payloadJson: {
        approvalId: approval.approvalId,
        decision: input.decision,
        responderId: input.responderId ?? null,
      },
      timestamp: now,
    });

    if (input.decision === "approved") {
      await this.repository.grantPathPermission(
        approval.sessionId,
        approval.operation,
        approval.path,
        input.responderId ?? "system",
      );
    }

    return {
      session: {
        ...session,
        status: sessionStatus,
        lastThreadActivityAt: now,
        idleDeadlineAt,
        updatedAt: now,
      },
      task: {
        ...task,
        status: taskStatus,
        updatedAt: now,
      },
      approval: {
        ...approval,
        status: approvalStatus,
        respondedAt: now,
        responderId: input.responderId ?? null,
      },
    };
  }

  async cancelThreadTask(input: ThreadCancelInput): Promise<{
    session: SessionRecord;
    canceledTaskId: string | null;
  }> {
    let session = await this.requireSessionByThreadId(input.threadId);
    session = await this.refreshIdleStatusIfNeeded(session);

    if (session.status === "closed_by_user") {
      throw new GatewayApiError(
        409,
        "session_closed",
        "The session is already closed.",
        { threadId: input.threadId, sessionId: session.sessionId },
      );
    }

    const activeTask = await this.repository.findLatestActiveTaskBySessionId(
      session.sessionId,
    );
    const pendingApproval = await this.repository.findLatestPendingApprovalBySessionId(
      session.sessionId,
    );
    const now = new Date();
    const idleDeadlineAt = this.calculateIdleDeadline(now);

    if (activeTask) {
      await this.repository.updateTaskStatus(activeTask.taskId, "canceled");
      await this.repository.appendTaskEvent({
        eventId: newId("event"),
        taskId: activeTask.taskId,
        eventType: "thread.task.canceled",
        payloadJson: {
          requestedBy: input.userId,
        },
        timestamp: now,
      });
    }

    if (pendingApproval) {
      await this.repository.resolveApproval(
        pendingApproval.approvalId,
        "canceled",
        input.userId,
      );
      await this.repository.appendTaskEvent({
        eventId: newId("event"),
        taskId: pendingApproval.taskId,
        eventType: "approval.canceled",
        payloadJson: {
          approvalId: pendingApproval.approvalId,
          requestedBy: input.userId,
        },
        timestamp: now,
      });
    }

    await this.repository.updateSessionActivity(
      session.sessionId,
      now,
      idleDeadlineAt,
    );
    await this.repository.updateSessionStatus(session.sessionId, "idle_waiting");

    return {
      session: {
        ...session,
        status: "idle_waiting",
        lastThreadActivityAt: now,
        idleDeadlineAt,
        updatedAt: now,
      },
      canceledTaskId: activeTask?.taskId ?? null,
    };
  }

  async closeThreadSession(input: ThreadCloseInput): Promise<{
    session: SessionRecord;
  }> {
    let session = await this.requireSessionByThreadId(input.threadId);
    if (session.status === "closed_by_user") {
      return { session };
    }

    session = await this.refreshIdleStatusIfNeeded(session);
    const now = new Date();

    const activeTask = await this.repository.findLatestActiveTaskBySessionId(
      session.sessionId,
    );
    const pendingApproval = await this.repository.findLatestPendingApprovalBySessionId(
      session.sessionId,
    );
    if (activeTask) {
      await this.repository.updateTaskStatus(activeTask.taskId, "canceled");
      await this.repository.appendTaskEvent({
        eventId: newId("event"),
        taskId: activeTask.taskId,
        eventType: "thread.session.closed",
        payloadJson: {
          requestedBy: input.userId,
        },
        timestamp: now,
      });
    }

    if (pendingApproval) {
      await this.repository.resolveApproval(
        pendingApproval.approvalId,
        "canceled",
        input.userId,
      );
      await this.repository.appendTaskEvent({
        eventId: newId("event"),
        taskId: pendingApproval.taskId,
        eventType: "approval.canceled",
        payloadJson: {
          approvalId: pendingApproval.approvalId,
          requestedBy: input.userId,
        },
        timestamp: now,
      });
    }

    await this.repository.updateSessionStatus(session.sessionId, "closed_by_user", {
      closedReason: "closed_by_user",
      closedAt: now,
    });

    return {
      session: {
        ...session,
        status: "closed_by_user",
        closedReason: "closed_by_user",
        closedAt: now,
        updatedAt: now,
      },
    };
  }

  async listUserSessions(userId: string, limit = 20): Promise<SessionRecord[]> {
    return this.repository.listSessionsByUser(userId, limit);
  }

  async runAgentTask(input: AgentTaskRunInput): Promise<{
    session: SessionRecord;
    task: TaskRecord;
    agentTask: {
      task_id: string;
      session_id: string;
      status: AgentRuntimeTaskStatus;
      bootstrap_mode: "create" | "resume";
      send_and_wait_count: number;
      started_at: string;
      updated_at: string;
    };
  }> {
    const runtimeClient = this.requireAgentRuntimeClient();
    const task = await this.repository.findTaskById(input.taskId);
    if (!task) {
      throw new GatewayApiError(404, "task_not_found", "Task was not found.", {
        taskId: input.taskId,
      });
    }
    const session = await this.repository.findSessionById(input.sessionId);
    if (!session) {
      throw new GatewayApiError(
        404,
        "session_not_found",
        "Session was not found.",
        {
          sessionId: input.sessionId,
        },
      );
    }
    if (task.sessionId !== session.sessionId) {
      throw new GatewayApiError(
        409,
        "task_session_mismatch",
        "Task and session association is invalid.",
        {
          taskId: task.taskId,
          taskSessionId: task.sessionId,
          sessionId: session.sessionId,
        },
      );
    }

    const now = new Date();
    const idleDeadlineAt = this.calculateIdleDeadline(now);
    if (task.status !== "running") {
      await this.repository.updateTaskStatus(task.taskId, "running");
    }
    if (session.status !== "running") {
      await this.repository.updateSessionStatus(session.sessionId, "running");
    }
    await this.repository.updateSessionActivity(session.sessionId, now, idleDeadlineAt);
    await this.repository.appendTaskEvent({
      eventId: newId("event"),
      taskId: task.taskId,
      eventType: "agent.run.requested",
      payloadJson: {
        requestedBy: input.userId,
      },
      timestamp: now,
    });

    const agentTask = await runtimeClient.runTask({
      task_id: task.taskId,
      session_id: session.sessionId,
      prompt: input.prompt,
      thread_context: {
        channel_id: session.channelId,
        thread_id: session.threadId,
      },
      attachment_mount_path:
        input.attachmentMountPath ??
        `/agent/session/${session.sessionId}/attachments`,
      runtime_policy: {
        tool_routing: {
          mode: "gateway_only",
          allow_external_mcp: false,
        },
      },
      tool_calls: input.toolCalls ?? [],
    });

    await this.repository.appendTaskEvent({
      eventId: newId("event"),
      taskId: task.taskId,
      eventType: "agent.run.accepted",
      payloadJson: {
        bootstrapMode: agentTask.bootstrap_mode,
      },
      timestamp: new Date(),
    });

    return {
      session: {
        ...session,
        status: "running",
        lastThreadActivityAt: now,
        idleDeadlineAt,
        updatedAt: now,
      },
      task: {
        ...task,
        status: "running",
        updatedAt: now,
      },
      agentTask: {
        task_id: agentTask.task_id,
        session_id: agentTask.session_id,
        status: agentTask.status,
        bootstrap_mode: agentTask.bootstrap_mode,
        send_and_wait_count: agentTask.send_and_wait_count,
        started_at: agentTask.started_at,
        updated_at: agentTask.updated_at,
      },
    };
  }

  async getAgentTaskStatus(input: AgentTaskStatusInput): Promise<{
    session: SessionRecord;
    task: TaskRecord;
    agentTask: {
      task_id: string;
      session_id: string;
      status: AgentRuntimeTaskStatus;
      bootstrap_mode: "create" | "resume";
      send_and_wait_count: number;
      started_at: string;
      updated_at: string;
      completed_at: string | null;
      result: {
        final_answer: string;
        tool_results: unknown[];
      } | null;
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      } | null;
    };
  }> {
    const runtimeClient = this.requireAgentRuntimeClient();
    const task = await this.repository.findTaskById(input.taskId);
    if (!task) {
      throw new GatewayApiError(404, "task_not_found", "Task was not found.", {
        taskId: input.taskId,
      });
    }
    const session = await this.repository.findSessionById(task.sessionId);
    if (!session) {
      throw new GatewayApiError(
        404,
        "session_not_found",
        "Session for task was not found.",
        {
          taskId: task.taskId,
          sessionId: task.sessionId,
        },
      );
    }

    const agentTask = await runtimeClient.getTaskStatus(task.taskId);
    const updated = await this.syncTaskStatusFromRuntime(task, session, agentTask.status);

    return {
      session: updated.session,
      task: updated.task,
      agentTask: {
        task_id: agentTask.task_id,
        session_id: agentTask.session_id,
        status: agentTask.status,
        bootstrap_mode: agentTask.bootstrap_mode,
        send_and_wait_count: agentTask.send_and_wait_count,
        started_at: agentTask.started_at,
        updated_at: agentTask.updated_at,
        completed_at: agentTask.completed_at ?? null,
        result: agentTask.result ?? null,
        error: agentTask.error ?? null,
      },
    };
  }

  async cancelAgentTask(input: AgentTaskCancelInput): Promise<{
    session: SessionRecord;
    task: TaskRecord;
    agentTask: {
      task_id: string;
      session_id: string;
      status: AgentRuntimeTaskStatus;
      bootstrap_mode: "create" | "resume";
      send_and_wait_count: number;
      started_at: string;
      updated_at: string;
      completed_at: string | null;
      result: {
        final_answer: string;
        tool_results: unknown[];
      } | null;
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      } | null;
    };
  }> {
    const runtimeClient = this.requireAgentRuntimeClient();
    const task = await this.repository.findTaskById(input.taskId);
    if (!task) {
      throw new GatewayApiError(404, "task_not_found", "Task was not found.", {
        taskId: input.taskId,
      });
    }
    const session = await this.repository.findSessionById(task.sessionId);
    if (!session) {
      throw new GatewayApiError(
        404,
        "session_not_found",
        "Session for task was not found.",
        {
          taskId: task.taskId,
          sessionId: task.sessionId,
        },
      );
    }

    const canceled = await runtimeClient.cancelTask(task.taskId);
    await this.repository.appendTaskEvent({
      eventId: newId("event"),
      taskId: task.taskId,
      eventType: "agent.run.cancel_requested",
      payloadJson: {
        requestedBy: input.userId,
      },
      timestamp: new Date(),
    });

    const updated = await this.syncTaskStatusFromRuntime(task, session, canceled.status);
    return {
      session: updated.session,
      task: updated.task,
      agentTask: {
        task_id: canceled.task_id,
        session_id: canceled.session_id,
        status: canceled.status,
        bootstrap_mode: canceled.bootstrap_mode,
        send_and_wait_count: canceled.send_and_wait_count,
        started_at: canceled.started_at,
        updated_at: canceled.updated_at,
        completed_at: canceled.completed_at ?? null,
        result: canceled.result ?? null,
        error: canceled.error ?? null,
      },
    };
  }

  private assertSessionOpen(session: SessionRecord): void {
    if (session.status === "closed_by_user") {
      throw new GatewayApiError(
        409,
        "session_closed",
        "The session is already closed.",
        {
          sessionId: session.sessionId,
          threadId: session.threadId,
        },
      );
    }
  }

  private async requireSessionByThreadId(threadId: string): Promise<SessionRecord> {
    const session = await this.repository.findSessionByThreadId(threadId);
    if (!session) {
      throw new GatewayApiError(
        404,
        "session_not_found",
        "No session is associated with the provided thread.",
        { threadId },
      );
    }
    return session;
  }

  private async refreshIdleStatusIfNeeded(
    session: SessionRecord,
  ): Promise<SessionRecord> {
    if (session.status !== "idle_waiting" || !session.idleDeadlineAt) {
      return session;
    }

    const now = new Date();
    if (session.idleDeadlineAt.getTime() > now.getTime()) {
      return session;
    }

    const updatedStatus: SessionStatus = "idle_paused";
    await this.repository.updateSessionStatus(session.sessionId, updatedStatus);
    return {
      ...session,
      status: updatedStatus,
      updatedAt: now,
    };
  }

  private calculateIdleDeadline(base: Date): Date {
    return new Date(base.getTime() + this.options.sessionIdleTimeoutSec * 1000);
  }

  private requireAgentRuntimeClient(): AgentRuntimeClient {
    if (!this.options.agentRuntimeClient) {
      throw new GatewayApiError(
        503,
        "agent_runtime_unconfigured",
        "Agent runtime client is not configured.",
      );
    }
    return this.options.agentRuntimeClient;
  }

  private async syncTaskStatusFromRuntime(
    task: TaskRecord,
    session: SessionRecord,
    runtimeStatus: AgentRuntimeTaskStatus,
  ): Promise<{ session: SessionRecord; task: TaskRecord }> {
    const now = new Date();
    const mappedTaskStatus = this.mapRuntimeStatusToTaskStatus(runtimeStatus);
    const mappedSessionStatus = this.mapRuntimeStatusToSessionStatus(runtimeStatus);
    const idleDeadlineAt =
      mappedSessionStatus === "idle_waiting" ? this.calculateIdleDeadline(now) : null;

    if (mappedTaskStatus !== task.status) {
      await this.repository.updateTaskStatus(task.taskId, mappedTaskStatus);
      await this.repository.appendTaskEvent({
        eventId: newId("event"),
        taskId: task.taskId,
        eventType: `agent.run.${runtimeStatus}`,
        payloadJson: {
          runtimeStatus,
        },
        timestamp: now,
      });
    }

    if (mappedSessionStatus !== session.status) {
      await this.repository.updateSessionStatus(session.sessionId, mappedSessionStatus);
    }

    if (
      mappedSessionStatus === "idle_waiting" ||
      mappedSessionStatus === "running" ||
      mappedSessionStatus === "failed"
    ) {
      await this.repository.updateSessionActivity(
        session.sessionId,
        now,
        idleDeadlineAt,
      );
    }

    return {
      session: {
        ...session,
        status: mappedSessionStatus,
        lastThreadActivityAt: now,
        idleDeadlineAt,
        updatedAt: now,
      },
      task: {
        ...task,
        status: mappedTaskStatus,
        updatedAt: now,
      },
    };
  }

  private mapRuntimeStatusToTaskStatus(status: AgentRuntimeTaskStatus): TaskStatus {
    if (status === "queued" || status === "running") {
      return "running";
    }
    if (status === "completed") {
      return "completed";
    }
    if (status === "canceled") {
      return "canceled";
    }
    return "failed";
  }

  private mapRuntimeStatusToSessionStatus(status: AgentRuntimeTaskStatus): SessionStatus {
    if (status === "queued" || status === "running") {
      return "running";
    }
    if (status === "failed") {
      return "failed";
    }
    return "idle_waiting";
  }
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}_${randomUUID().slice(0, 8)}`;
}

function mapDecisionToApprovalStatus(
  decision: ApprovalRespondInput["decision"],
): ApprovalStatus {
  if (decision === "approved") {
    return "approved";
  }

  if (decision === "rejected") {
    return "rejected";
  }

  return "timeout";
}
