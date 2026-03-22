import { randomUUID } from "node:crypto";
import type {
  AgentRuntimeClient,
  AgentRuntimeAttachmentSource,
  AgentRuntimeTaskStatus,
  AgentRuntimeToolCall,
} from "../agent/runtimeClient.js";
import {
  buildPromptWithContextEnvelope,
  type ContextEnvelopeAttachmentRuntimeInput,
  type ContextEnvelopeBotMode,
  type ContextEnvelopeDiscordInput,
  type ContextEnvelopeInfrastructureStatus,
  type ContextEnvelopeTaskTerminalStatus,
} from "../prompt/contextEnvelope.js";
import {
  SYSTEM_MEMORY_REFERENCE_ENTRIES,
} from "./memoryPolicy.js";
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
  TaskEventRecord,
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
  username?: string;
  nickname?: string;
  channelId: string;
  channelName?: string;
  threadId: string;
  threadName?: string;
  prompt: string;
  attachmentNames: string[];
}

export interface ThreadMessageInput {
  threadId: string;
  userId: string;
  username?: string;
  nickname?: string;
  channelName?: string;
  threadName?: string;
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

export interface AgentApprovalRequestAndWaitInput {
  taskId: string;
  sessionId: string;
  toolName?: string;
  operation: string;
  path: string;
  timeoutSec: number;
}

export interface AgentTaskRunInput {
  taskId: string;
  sessionId: string;
  userId: string;
  prompt: string;
  attachmentNames?: string[];
  attachmentMountPath?: string;
  contextEnvelope?: {
    behavior?: {
      botMode?: ContextEnvelopeBotMode;
      sessionStatus?: string;
      infrastructureStatus?: ContextEnvelopeInfrastructureStatus;
      toolRoutingPolicy?:
        | "gateway_only"
        | "hybrid_container_builtin_gateway_host";
      approvalPolicy?:
        | "host_ops_require_explicit_approval";
      responseContract?: "ja, concise, ask_when_ambiguous";
      executionContract?: "no_external_mcp, no_unapproved_host_ops";
    };
    runtimeFeedback?: {
      previousTaskTerminalStatus?: ContextEnvelopeTaskTerminalStatus;
      previousToolErrors?: string[];
      retryHint?: string;
      attachmentSources?: AgentTaskAttachment[];
      systemMemoryReferences?: AgentTaskSystemMemoryReference[];
    };
    discord?: {
      userId: string;
      username?: string;
      nickname?: string;
      channelId: string;
      channelName?: string;
      threadId: string;
      threadName?: string;
    };
  };
  toolCalls?: AgentRuntimeToolCall[];
}

export interface AgentTaskAttachment {
  name: string;
  sourceUrl: string;
}

export interface AgentTaskSystemMemoryReference {
  namespace: string;
  key: string;
  reason?: string;
}

interface AgentTaskStagedAttachmentFile {
  name: string;
  path: string;
  bytes: number;
}

interface AgentTaskRuntimeResult {
  final_answer: string;
  tool_results: unknown[];
}

export interface AgentTaskStatusInput {
  taskId: string;
  includeTaskEvents?: boolean;
  afterTimestamp?: string;
  eventTypes?: string[];
  eventsLimit?: number;
}

interface NormalizedSystemMemoryReference {
  namespace: string;
  key: string;
  reason: string;
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
        username: input.username ?? null,
        nickname: input.nickname ?? null,
        channelName: input.channelName ?? null,
        threadName: input.threadName ?? null,
      },
      timestamp: now,
    });
    const normalizedPrompt = normalizeDiscordMessageContent(input.prompt);
    if (normalizedPrompt.length > 0) {
      await this.repository.appendTaskEvent({
        eventId: newId("event"),
        taskId,
        eventType: "discord.message.logged",
        payloadJson: {
          role: "user",
          userId: input.userId,
          username: input.username ?? null,
          nickname: input.nickname ?? null,
          content: normalizedPrompt,
        },
        timestamp: now,
      });
    }

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
        username: input.username ?? null,
        nickname: input.nickname ?? null,
        channelName: input.channelName ?? null,
        threadName: input.threadName ?? null,
        resumedFromIdle,
      },
      timestamp: now,
    });
    const normalizedPrompt = normalizeDiscordMessageContent(input.prompt);
    if (normalizedPrompt.length > 0) {
      await this.repository.appendTaskEvent({
        eventId: newId("event"),
        taskId: task.taskId,
        eventType: "discord.message.logged",
        payloadJson: {
          role: "user",
          userId: input.userId,
          username: input.username ?? null,
          nickname: input.nickname ?? null,
          content: normalizedPrompt,
        },
        timestamp: now,
      });
    }

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

    const attachmentMountPath =
      input.attachmentMountPath ??
      `/agent/session/${session.sessionId}`;
    const sessionWorkspaceRoot = `/agent/session/${session.sessionId}`;
    const systemMemoryRefs = normalizeSystemMemoryReferences(
      input.contextEnvelope?.runtimeFeedback?.systemMemoryReferences,
    );
    const attachmentNames = input.attachmentNames ?? [];
    const attachmentsToStage = toAgentRuntimeAttachmentSources(
      attachmentNames,
      input.contextEnvelope?.runtimeFeedback?.attachmentSources,
    );
    if (attachmentNames.length !== attachmentsToStage.length) {
      const stagedNames = new Set(attachmentsToStage.map((attachment) => attachment.name));
      const missingSources = attachmentNames.filter(
        (name) => !stagedNames.has(name.trim()),
      );
      throw new GatewayApiError(
        400,
        "attachment_source_missing",
        "Attachment source URL is required for every attachment.",
        {
          taskId: task.taskId,
          attachmentNames,
          missingSources,
        },
      );
    }
    let stagedFiles: AgentTaskStagedAttachmentFile[] = [];
    if (attachmentsToStage.length > 0) {
      const staged = await runtimeClient.stageTaskAttachments({
        task_id: task.taskId,
        session_id: session.sessionId,
        attachment_mount_path: attachmentMountPath,
        attachments: attachmentsToStage,
      });
      stagedFiles = staged.staged_files.map((file) => ({
        name: file.name,
        path: file.path,
        bytes: file.bytes,
      }));
      await this.repository.appendTaskEvent({
        eventId: newId("event"),
        taskId: task.taskId,
        eventType: "agent.attachments.staged",
        payloadJson: {
          stagedCount: staged.staged_count,
          stagedFiles,
        },
        timestamp: new Date(),
      });
    }
    const runtimePrompt = await this.buildRuntimePromptWithContextEnvelope(
      input,
      session,
      task,
      systemMemoryRefs,
      {
        sessionWorkspaceRoot,
        attachmentMountPath,
        stagedFiles,
      },
    );
    const agentTask = await runtimeClient.runTask({
      task_id: task.taskId,
      session_id: session.sessionId,
      prompt: runtimePrompt,
      thread_context: {
        channel_id: session.channelId,
        thread_id: session.threadId,
      },
      session_workspace_root: sessionWorkspaceRoot,
      attachment_mount_path: attachmentMountPath,
      runtime_policy: {
        tool_routing: {
          mode: "hybrid_container_builtin_gateway_host",
          allow_external_mcp: false,
        },
      },
      system_memory_refs: systemMemoryRefs,
      tool_calls: input.toolCalls ?? [],
    });

    await this.repository.appendTaskEvent({
      eventId: newId("event"),
      taskId: task.taskId,
      eventType: "agent.run.accepted",
      payloadJson: {
        bootstrapMode: agentTask.bootstrap_mode,
        systemMemoryRefs,
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

  private async buildRuntimePromptWithContextEnvelope(
    input: AgentTaskRunInput,
    session: SessionRecord,
    task: TaskRecord,
    systemMemoryRefs: NormalizedSystemMemoryReference[],
    attachmentRuntime: ContextEnvelopeAttachmentRuntimeInput,
  ): Promise<string> {
    try {
      const behavior = input.contextEnvelope?.behavior;
      const runtimeFeedbackInput = input.contextEnvelope?.runtimeFeedback;
      const discordInput = input.contextEnvelope?.discord;
      const runtimeFeedback =
        runtimeFeedbackInput &&
        (runtimeFeedbackInput.previousTaskTerminalStatus !== undefined ||
          (runtimeFeedbackInput.previousToolErrors?.length ?? 0) > 0 ||
          runtimeFeedbackInput.retryHint !== undefined)
          ? {
              previousTaskTerminalStatus:
                runtimeFeedbackInput.previousTaskTerminalStatus,
              previousToolErrors: runtimeFeedbackInput.previousToolErrors ?? [],
              retryHint: runtimeFeedbackInput.retryHint,
              systemMemoryReferences: systemMemoryRefs,
            }
          : undefined;
      const discord: ContextEnvelopeDiscordInput | undefined =
        discordInput &&
        discordInput.userId.trim().length > 0 &&
        discordInput.channelId.trim().length > 0 &&
        discordInput.threadId.trim().length > 0
          ? {
              userId: discordInput.userId,
              username: discordInput.username,
              nickname: discordInput.nickname,
              channelId: discordInput.channelId,
              channelName: discordInput.channelName,
              threadId: discordInput.threadId,
              threadName: discordInput.threadName,
            }
          : undefined;
      const attachmentRuntimeInput = attachmentRuntime ?? {
        sessionWorkspaceRoot: `/agent/session/${session.sessionId}`,
        attachmentMountPath: `/agent/session/${session.sessionId}`,
        stagedFiles: [],
      };

      return buildPromptWithContextEnvelope({
        prompt: input.prompt,
        attachmentNames: input.attachmentNames ?? [],
        attachmentRuntime: attachmentRuntimeInput,
        behavior: {
          botMode: behavior?.botMode ?? "unknown",
          sessionStatus: behavior?.sessionStatus ?? session.status,
          infrastructureStatus: behavior?.infrastructureStatus ?? "unknown",
          toolRoutingPolicy:
            behavior?.toolRoutingPolicy ??
            "hybrid_container_builtin_gateway_host",
          approvalPolicy: "host_ops_require_explicit_approval",
          responseContract: "ja, concise, ask_when_ambiguous",
          executionContract: "no_external_mcp, no_unapproved_host_ops",
        },
        runtimeFeedback,
        discord,
      });
    } catch (error) {
      await this.repository.appendAuditLog({
        logId: newId("audit"),
        correlationId: `${task.taskId}:context-envelope`,
        actor: "gateway_api",
        decision: "context_envelope_fallback",
        reason: summarizeError(error),
        raw: {
          taskId: task.taskId,
          sessionId: session.sessionId,
          promptLength: input.prompt.length,
          attachmentCount: input.attachmentNames?.length ?? 0,
          hasBehaviorContext: input.contextEnvelope?.behavior !== undefined,
          hasRuntimeFeedback:
            input.contextEnvelope?.runtimeFeedback !== undefined,
          hasDiscordContext: input.contextEnvelope?.discord !== undefined,
          systemMemoryReferenceCount:
            input.contextEnvelope?.runtimeFeedback?.systemMemoryReferences?.length ?? 0,
        },
      });
      return input.prompt;
    }
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
      tool_events?: Array<{
        call_id: string;
        tool_name: string;
        execution_target: string;
        phase: "start" | "result";
        status?: "ok" | "error";
        error_code?: string;
        message?: string;
        arguments?: Record<string, unknown>;
        reason?: string;
        result?: Record<string, unknown>;
        details?: Record<string, unknown>;
        timestamp: string;
      }> | null;
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      } | null;
    };
    pendingApproval: ApprovalRecord | null;
    taskEvents?: TaskEventRecord[];
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
    const updated = await this.syncTaskStatusFromRuntime(
      task,
      session,
      agentTask.status,
      agentTask.result ?? null,
    );
    const pendingApproval = await this.repository.findLatestPendingApprovalBySessionId(
      session.sessionId,
    );

    let taskEvents: TaskEventRecord[] | undefined;
    if (input.includeTaskEvents) {
      taskEvents = await this.repository.listTaskEventsByTaskId(task.taskId, {
        eventTypes:
          input.eventTypes && input.eventTypes.length > 0
            ? input.eventTypes
            : ["mcp.tool.call", "mcp.tool.result"],
        afterTimestamp: parseOptionalDate(input.afterTimestamp),
        limit: input.eventsLimit ?? 100,
      });
    }

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
        tool_events: agentTask.tool_events ?? [],
        error: agentTask.error ?? null,
      },
      pendingApproval,
      taskEvents,
    };
  }

  async requestAgentApprovalAndWait(input: AgentApprovalRequestAndWaitInput): Promise<{
    decision: "approved" | "rejected" | "timeout" | "canceled";
    approval: ApprovalRecord | null;
  }> {
    if (!input.operation || !input.path) {
      throw new GatewayApiError(
        400,
        "invalid_approval_request",
        "Approval operation and path are required.",
        {
          operation: input.operation,
          path: input.path,
        },
      );
    }
    const timeoutSec = Math.min(Math.max(input.timeoutSec, 1), 600);
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

    this.assertSessionOpen(session);
    const pending = await this.ensureRuntimePendingApproval({
      task,
      session,
      toolName: input.toolName,
      operation: input.operation,
      path: input.path,
    });
    const decision = await this.waitForApprovalDecision(
      pending.approvalId,
      timeoutSec,
    );
    const resolved = await this.repository.findApprovalById(pending.approvalId);
    return {
      decision,
      approval: resolved,
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

    const updated = await this.syncTaskStatusFromRuntime(
      task,
      session,
      canceled.status,
      canceled.result ?? null,
    );
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
    runtimeResult?: AgentTaskRuntimeResult | null,
  ): Promise<{ session: SessionRecord; task: TaskRecord }> {
    const now = new Date();
    const pendingApproval = await this.repository.findLatestPendingApprovalBySessionId(
      session.sessionId,
    );
    let mappedTaskStatus = this.mapRuntimeStatusToTaskStatus(runtimeStatus);
    let mappedSessionStatus = this.mapRuntimeStatusToSessionStatus(runtimeStatus);
    if (
      pendingApproval &&
      (runtimeStatus === "queued" || runtimeStatus === "running")
    ) {
      mappedTaskStatus = "waiting_approval";
      mappedSessionStatus = "waiting_approval";
    }
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
      if (runtimeStatus === "completed") {
        const answer = normalizeDiscordMessageContent(
          runtimeResult?.final_answer ?? "",
          8000,
        );
        if (answer.length > 0) {
          await this.repository.appendTaskEvent({
            eventId: newId("event"),
            taskId: task.taskId,
            eventType: "discord.message.logged",
            payloadJson: {
              role: "assistant",
              userId: "assistant",
              username: "assistant",
              nickname: null,
              content: answer,
            },
            timestamp: now,
          });
        }
      }
    }

    if (mappedSessionStatus !== session.status) {
      await this.repository.updateSessionStatus(session.sessionId, mappedSessionStatus);
    }

    if (
      mappedSessionStatus === "idle_waiting" ||
      mappedSessionStatus === "running" ||
      mappedSessionStatus === "failed" ||
      mappedSessionStatus === "waiting_approval"
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

  private async ensureRuntimePendingApproval(input: {
    task: TaskRecord;
    session: SessionRecord;
    toolName?: string;
    operation: string;
    path: string;
  }): Promise<ApprovalRecord> {
    const now = new Date();
    const idleDeadlineAt = this.calculateIdleDeadline(now);
    await this.repository.updateSessionActivity(
      input.session.sessionId,
      now,
      idleDeadlineAt,
    );

    const pendingApproval = await this.repository.findLatestPendingApprovalBySessionId(
      input.session.sessionId,
    );
    if (pendingApproval) {
      if (
        pendingApproval.operation === input.operation &&
        pendingApproval.path === input.path
      ) {
        return pendingApproval;
      }
      throw new GatewayApiError(
        409,
        "approval_already_pending",
        "A pending approval already exists for this session.",
        {
          sessionId: input.session.sessionId,
          approvalId: pendingApproval.approvalId,
          operation: pendingApproval.operation,
          path: pendingApproval.path,
        },
      );
    }

    const approval = await this.repository.createApproval({
      approvalId: newId("apr"),
      taskId: input.task.taskId,
      sessionId: input.session.sessionId,
      operation: input.operation,
      path: input.path,
    });
    await this.repository.updateTaskStatus(input.task.taskId, "waiting_approval");
    await this.repository.updateSessionStatus(
      input.session.sessionId,
      "waiting_approval",
    );
    await this.repository.appendTaskEvent({
      eventId: newId("event"),
      taskId: input.task.taskId,
      eventType: "approval.requested",
      payloadJson: {
        approvalId: approval.approvalId,
        toolName: input.toolName ?? null,
        operation: input.operation,
        path: input.path,
        requestedBy: input.session.userId,
        source: "runtime_permission_hook",
      },
      timestamp: now,
    });
    return approval;
  }

  private async waitForApprovalDecision(
    approvalId: string,
    timeoutSec: number,
  ): Promise<"approved" | "rejected" | "timeout" | "canceled"> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() <= deadline) {
      const approval = await this.repository.findApprovalById(approvalId);
      if (!approval) {
        throw new GatewayApiError(
          404,
          "approval_not_found",
          "No approval request was found.",
          { approvalId },
        );
      }
      if (approval.status !== "requested") {
        return mapApprovalStatusToDecision(approval.status);
      }
      await sleep(500);
    }

    try {
      const timedOut = await this.respondApproval({
        approvalId,
        decision: "timeout",
        responderId: null,
      });
      return mapApprovalStatusToDecision(timedOut.approval.status);
    } catch (error) {
      if (
        error instanceof GatewayApiError &&
        error.code === "approval_already_resolved"
      ) {
        const resolved = await this.repository.findApprovalById(approvalId);
        if (resolved) {
          return mapApprovalStatusToDecision(resolved.status);
        }
      }
      throw error;
    }
  }
}

function parseOptionalDate(value: string | undefined): Date | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
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

function mapApprovalStatusToDecision(
  status: ApprovalStatus,
): "approved" | "rejected" | "timeout" | "canceled" {
  if (status === "approved") {
    return "approved";
  }
  if (status === "rejected") {
    return "rejected";
  }
  if (status === "canceled") {
    return "canceled";
  }
  return "timeout";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeDiscordMessageContent(
  value: string,
  maxLength = 4000,
): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3)}...`;
}

function toAgentRuntimeAttachmentSources(
  attachmentNames: string[] | undefined,
  attachmentSources: AgentTaskAttachment[] | undefined,
): AgentRuntimeAttachmentSource[] {
  if (
    !attachmentNames ||
    attachmentNames.length === 0 ||
    !attachmentSources ||
    attachmentSources.length === 0
  ) {
    return [];
  }

  const sourceMap = new Map<string, string>();
  for (const source of attachmentSources) {
    const name = source.name.trim();
    const sourceUrl = source.sourceUrl.trim();
    if (!name || !sourceUrl) {
      continue;
    }
    sourceMap.set(name, sourceUrl);
  }

  const result: AgentRuntimeAttachmentSource[] = [];
  for (const name of attachmentNames) {
    const source = sourceMap.get(name.trim());
    if (!source) {
      continue;
    }
    result.push({
      name,
      source_url: source,
    });
  }
  return result;
}

function normalizeSystemMemoryReferences(
  refs: AgentTaskSystemMemoryReference[] | undefined,
): NormalizedSystemMemoryReference[] {
  const source = refs && refs.length > 0 ? refs : [...SYSTEM_MEMORY_REFERENCE_ENTRIES];
  const seen = new Set<string>();
  const normalized: NormalizedSystemMemoryReference[] = [];
  for (const ref of source) {
    const namespace = ref.namespace.trim();
    const key = ref.key.trim();
    const reason =
      ref.reason && ref.reason.trim().length > 0
        ? ref.reason.trim()
        : "load required system memory";
    if (!namespace || !key) {
      continue;
    }
    const dedupe = `${namespace}\u0000${key}`;
    if (seen.has(dedupe)) {
      continue;
    }
    seen.add(dedupe);
    normalized.push({
      namespace,
      key,
      reason,
    });
  }
  return normalized;
}
