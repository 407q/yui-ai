export type ContextEnvelopeBotMode = "standard" | "mock" | "unknown";

export type ContextEnvelopeInfrastructureStatus =
  | "ready"
  | "booting"
  | "failed"
  | "unknown";

export type ContextEnvelopeTaskTerminalStatus =
  | "completed"
  | "failed"
  | "canceled";

export interface ContextEnvelopeBehaviorInput {
  botMode: ContextEnvelopeBotMode;
  sessionStatus: string;
  infrastructureStatus: ContextEnvelopeInfrastructureStatus;
  toolRoutingPolicy: "gateway_only";
  approvalPolicy: "host_ops_require_explicit_approval";
  responseContract: "ja, concise, ask_when_ambiguous";
  executionContract: "no_external_mcp, no_unapproved_host_ops";
}

export interface ContextEnvelopeRuntimeFeedbackInput {
  previousTaskTerminalStatus?: ContextEnvelopeTaskTerminalStatus;
  previousToolErrors?: string[];
  retryHint?: string;
}

export interface ContextEnvelopeAttachmentRuntimeInput {
  sessionWorkspaceRoot: string;
  attachmentMountPath: string;
  stagedFiles: Array<{
    name: string;
    path: string;
    bytes: number;
  }>;
}

export interface ContextEnvelopeInput {
  prompt: string;
  attachmentNames: string[];
  attachmentRuntime: ContextEnvelopeAttachmentRuntimeInput;
  behavior: ContextEnvelopeBehaviorInput;
  runtimeFeedback?: ContextEnvelopeRuntimeFeedbackInput;
}

const MAX_ATTACHMENT_LINES = 8;
const MAX_STAGED_FILE_LINES = 8;
const MAX_TOOL_ERROR_LINES = 3;
const MAX_VALUE_LENGTH = 160;

export function buildPromptWithContextEnvelope(input: ContextEnvelopeInput): string {
  const envelope = buildContextEnvelope({
    attachmentNames: input.attachmentNames,
    attachmentRuntime: input.attachmentRuntime,
    behavior: input.behavior,
    runtimeFeedback: input.runtimeFeedback,
  });
  return `${envelope}\n\n[User Prompt]\n${input.prompt}`;
}

export function buildContextEnvelope(
  input: Omit<ContextEnvelopeInput, "prompt">,
): string {
  const lines: string[] = [];
  lines.push("[Attachment Context]");
  lines.push(...buildAttachmentLines(input.attachmentNames));
  lines.push("");
  lines.push("[Attachment Runtime Context]");
  lines.push(...buildAttachmentRuntimeLines(input.attachmentRuntime));
  lines.push("");
  lines.push("[Behavior Context]");
  lines.push(...buildBehaviorLines(input.behavior));
  lines.push("");
  lines.push("[Runtime Feedback Context]");
  lines.push(...buildRuntimeFeedbackLines(input.runtimeFeedback));
  return lines.join("\n");
}

function buildAttachmentLines(attachmentNames: string[]): string[] {
  if (attachmentNames.length === 0) {
    return ["- attachments: none"];
  }

  const normalized = attachmentNames
    .map((name) => normalizeInline(name))
    .filter((name) => name.length > 0);
  if (normalized.length === 0) {
    return ["- attachments: none"];
  }

  const lines = [`- attachments_count: ${normalized.length}`];
  const listed = normalized.slice(0, MAX_ATTACHMENT_LINES);
  for (let index = 0; index < listed.length; index += 1) {
    lines.push(`- attachment_${index + 1}: ${listed[index]}`);
  }
  if (normalized.length > MAX_ATTACHMENT_LINES) {
    lines.push(`- attachments_omitted: ${normalized.length - MAX_ATTACHMENT_LINES}`);
  }
  return lines;
}

function buildAttachmentRuntimeLines(
  attachmentRuntime: ContextEnvelopeAttachmentRuntimeInput,
): string[] {
  const lines: string[] = [
    `- session_workspace_root: ${normalizeInline(attachmentRuntime.sessionWorkspaceRoot)}`,
    `- attachment_mount_path: ${normalizeInline(attachmentRuntime.attachmentMountPath)}`,
    `- staged_files_count: ${attachmentRuntime.stagedFiles.length}`,
  ];

  const listed = attachmentRuntime.stagedFiles.slice(0, MAX_STAGED_FILE_LINES);
  for (let index = 0; index < listed.length; index += 1) {
    const staged = listed[index];
    if (!staged) {
      continue;
    }
    lines.push(
      `- staged_file_${index + 1}: ${normalizeInline(staged.name)} => ${normalizeInline(staged.path)} (${staged.bytes} bytes)`,
    );
  }
  if (attachmentRuntime.stagedFiles.length > MAX_STAGED_FILE_LINES) {
    lines.push(
      `- staged_files_omitted: ${attachmentRuntime.stagedFiles.length - MAX_STAGED_FILE_LINES}`,
    );
  }
  lines.push(
    "- attachment_search_priority: attachment_mount_path > session_workspace_root > do_not_use_root_copilot_session_state",
  );
  lines.push(
    "- working_directory_contract: use_session_workspace_root_as_primary_cwd",
  );
  return lines;
}

function buildBehaviorLines(behavior: ContextEnvelopeBehaviorInput): string[] {
  return [
    `- bot_mode: ${normalizeInline(behavior.botMode)}`,
    `- session_status: ${normalizeInline(behavior.sessionStatus)}`,
    `- infrastructure_status: ${normalizeInline(behavior.infrastructureStatus)}`,
    `- tool_routing_policy: ${normalizeInline(behavior.toolRoutingPolicy)}`,
    `- approval_policy: ${normalizeInline(behavior.approvalPolicy)}`,
    `- response_contract: ${normalizeInline(behavior.responseContract)}`,
    `- execution_contract: ${normalizeInline(behavior.executionContract)}`,
  ];
}

function buildRuntimeFeedbackLines(
  runtimeFeedback: ContextEnvelopeRuntimeFeedbackInput | undefined,
): string[] {
  const terminalStatus =
    runtimeFeedback?.previousTaskTerminalStatus !== undefined
      ? normalizeInline(runtimeFeedback.previousTaskTerminalStatus)
      : "none";
  const toolErrors = (runtimeFeedback?.previousToolErrors ?? [])
    .map((entry) => normalizeInline(entry))
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_TOOL_ERROR_LINES);
  const retryHint =
    runtimeFeedback?.retryHint && runtimeFeedback.retryHint.trim().length > 0
      ? normalizeInline(runtimeFeedback.retryHint)
      : "none";

  return [
    `- previous_task_terminal_status: ${terminalStatus}`,
    `- previous_tool_errors: ${toolErrors.length > 0 ? toolErrors.join(" | ") : "none"}`,
    `- retry_hint: ${retryHint}`,
  ];
}

function normalizeInline(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_VALUE_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_VALUE_LENGTH - 3)}...`;
}
