import { randomUUID } from "node:crypto";
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
