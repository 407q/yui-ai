export type SessionStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "idle_waiting"
  | "idle_paused"
  | "completed"
  | "failed"
  | "closed_by_user"
  | "canceled";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "canceled";

export type ApprovalStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "timeout"
  | "canceled";

export interface SessionRecord {
  sessionId: string;
  userId: string;
  channelId: string;
  threadId: string;
  status: SessionStatus;
  lastThreadActivityAt: Date;
  idleDeadlineAt: Date | null;
  closedReason: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskRecord {
  taskId: string;
  sessionId: string;
  userId: string;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalRecord {
  approvalId: string;
  taskId: string;
  sessionId: string;
  operation: string;
  path: string;
  status: ApprovalStatus;
  requestedAt: Date;
  respondedAt: Date | null;
  responderId: string | null;
}

export interface ThreadStatusResponse {
  session: SessionRecord;
  latestTask: TaskRecord | null;
  pendingApproval: ApprovalRecord | null;
}

export interface SessionPathPermissionRecord {
  sessionId: string;
  operation: string;
  path: string;
  grantedBy: string;
  grantedAt: Date;
  expiresAt: Date | null;
}

export interface MemoryEntryRecord {
  memoryId: string;
  userId: string;
  namespace: string;
  key: string;
  valueJson: Record<string, unknown>;
  tagsJson: string[];
  updatedAt: Date;
}
