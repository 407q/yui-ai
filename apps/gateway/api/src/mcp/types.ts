export interface ToolCallRequest {
  taskId: string;
  sessionId: string;
  callId: string;
  toolName: string;
  executionTarget: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface ToolCallSuccessResult {
  task_id: string;
  call_id: string;
  status: "ok";
  result: Record<string, unknown>;
}

export interface ToolCallErrorResult {
  task_id: string;
  call_id: string;
  status: "error";
  error_code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ToolCallResult = ToolCallSuccessResult | ToolCallErrorResult;

export interface PathPermissionRecord {
  operation: string;
  path: string;
  expiresAt: Date | null;
}

export interface ApprovalScopeRecord {
  approvalId: string;
  status: "requested" | "approved" | "rejected" | "timeout" | "canceled";
}

export interface MemoryEntryRecord {
  memoryId: string;
  userId: string;
  namespace: string;
  key: string;
  valueJson: Record<string, unknown>;
  tagsJson: string[];
  isSystem: boolean;
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
