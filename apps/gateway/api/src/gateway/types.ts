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

export interface ThreadStatusResponse {
  session: SessionRecord;
  latestTask: TaskRecord | null;
}
