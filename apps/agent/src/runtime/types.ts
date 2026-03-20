export type AgentTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type SessionBootstrapMode = "create" | "resume";

export interface AgentThreadContext {
  channel_id: string;
  thread_id: string;
}

export interface AgentToolRoutingPolicy {
  mode: "gateway_only";
  allow_external_mcp: boolean;
}

export interface AgentRuntimePolicy {
  tool_routing: AgentToolRoutingPolicy;
}

export interface AgentLifecyclePolicy {
  explicit_close_command: string;
  idle_timeout_sec: number;
  on_idle_timeout: "idle_pause";
  resume_trigger: "thread_user_message";
}

export interface AgentToolCallSpec {
  tool_name: string;
  execution_target?: string;
  arguments: Record<string, unknown>;
  reason: string;
  delay_ms?: number;
}

export interface AgentAttachmentSource {
  name: string;
  source_url: string;
}

export interface AgentRunRequest {
  task_id: string;
  session_id: string;
  prompt: string;
  sdk_execution_mode?: "single_send_and_wait";
  session_bootstrap_mode?: "create_or_resume";
  session_lifecycle_policy?: AgentLifecyclePolicy;
  thread_context?: AgentThreadContext;
  attachment_mount_path?: string;
  runtime_policy?: AgentRuntimePolicy;
  tool_calls?: AgentToolCallSpec[];
}

export interface AgentStagedAttachmentFile {
  name: string;
  path: string;
  bytes: number;
}

export interface AgentStageAttachmentsRequest {
  task_id: string;
  session_id: string;
  attachment_mount_path: string;
  attachments: AgentAttachmentSource[];
}

export interface AgentStageAttachmentsResponse {
  task_id: string;
  session_id: string;
  attachment_mount_path: string;
  staged_count: number;
  staged_files: AgentStagedAttachmentFile[];
}

export interface AgentTaskStatusResponse {
  task_id: string;
  session_id: string;
  status: AgentTaskStatus;
  bootstrap_mode: SessionBootstrapMode;
  send_and_wait_count: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  result: {
    final_answer: string;
    tool_results: ToolCallResult[];
  } | null;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  } | null;
}

export interface AgentRunAcceptedResponse {
  task_id: string;
  session_id: string;
  status: AgentTaskStatus;
  bootstrap_mode: SessionBootstrapMode;
  send_and_wait_count: number;
  started_at: string;
  updated_at: string;
}

export interface ToolCallRequestPayload {
  task_id: string;
  session_id: string;
  call_id: string;
  tool_name: string;
  execution_target: string;
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

export interface PermissionRequestInput {
  task_id: string;
  session_id: string;
  tool_name: string;
  reason: string;
  arguments: Record<string, unknown>;
}

export interface PermissionRequestResult {
  decision: "allow" | "deny";
  reason: string;
}
