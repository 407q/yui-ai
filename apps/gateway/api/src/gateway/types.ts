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

export interface TaskEventRecord {
  eventId: string;
  taskId: string;
  eventType: string;
  payloadJson: Record<string, unknown>;
  timestamp: Date;
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
  backlinks?: MemoryBacklinkRecord[];
  updatedAt: Date;
}

export interface MemoryBacklinkRecord {
  sourceMemoryId: string;
  sourceNamespace: string;
  sourceKey: string;
  relation: string;
  createdAt: Date;
}

export interface DiscordRecentMessageRecord {
  eventId: string;
  sessionId: string;
  taskId: string;
  threadId: string;
  channelId: string;
  userId: string;
  username: string | null;
  nickname: string | null;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}
