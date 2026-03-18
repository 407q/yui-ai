import "dotenv/config";
import {
  ActionRowBuilder,
  AnyThreadChannel,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Channel,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Message,
  type Snowflake,
} from "discord.js";

type SessionStatus =
  | "running"
  | "waiting_approval"
  | "idle_waiting"
  | "idle_paused"
  | "canceled"
  | "failed"
  | "closed_by_user";

type ApprovalDecision = "approved" | "rejected" | "timeout" | "canceled";
type SystemControlMode = "exit" | "reboot";

interface QueuedRun {
  prompt: string;
  attachmentNames: string[];
  triggeredByUserId: Snowflake;
}

interface ToolApprovalRequest {
  tool: string;
  operation: string;
  target: string;
}

interface MockSession {
  id: string;
  ownerUserId: Snowflake;
  channelId: Snowflake;
  threadId: Snowflake;
  gatewaySessionId?: string;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  idleDeadlineAt: Date;
  currentTaskId?: string;
  pendingApprovalId?: string;
  runSequence: number;
  cancelRequested: boolean;
  lastEvent: string;
  queuedRun?: QueuedRun;
}

interface PendingApproval {
  approvalId: string;
  sessionId: string;
  timeout: NodeJS.Timeout;
  resolve: (decision: ApprovalDecision) => void;
}

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_BOT_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN is required.");
}
const SYSTEM_ALERT_CHANNEL_ID = process.env.MOCK_SYSTEM_ALERT_CHANNEL_ID;
const GATEWAY_API_BASE_URL = process.env.GATEWAY_API_BASE_URL ?? "http://127.0.0.1:3800";

const IDLE_TIMEOUT_SEC = parsePositiveInt(process.env.MOCK_IDLE_TIMEOUT_SEC, 600);
const APPROVAL_TIMEOUT_SEC = parsePositiveInt(
  process.env.MOCK_APPROVAL_TIMEOUT_SEC,
  120,
);
const TYPING_PULSE_MS = 7000;
const REBOOT_EXIT_CODE = 75;
const SHUTDOWN_DELAY_MS = 700;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const sessionsById = new Map<string, MockSession>();
const sessionIdByThreadId = new Map<Snowflake, string>();
const sessionIdsByUserId = new Map<Snowflake, Set<string>>();
const pendingApprovals = new Map<string, PendingApproval>();
const idleTimerBySessionId = new Map<string, NodeJS.Timeout>();
const runningSessionIds = new Set<string>();
let isSystemControlPending = false;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface GatewayStartResponse {
  session: {
    sessionId: string;
    status: string;
  };
  taskId: string;
}

interface GatewayThreadMessageResponse {
  session: {
    sessionId: string;
    status: string;
  };
  taskId: string;
  resumedFromIdle: boolean;
}

interface GatewayApprovalRequestResponse {
  approval: {
    approvalId: string;
    status: string;
  };
  session: {
    sessionId: string;
    status: string;
  };
  task: {
    taskId: string;
    status: string;
  };
}

async function gatewayApiRequest<T>(
  method: "GET" | "POST",
  pathname: string,
  payload?: unknown,
): Promise<T> {
  const response = await fetch(`${GATEWAY_API_BASE_URL}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `[gateway-api] ${method} ${pathname} failed: ${response.status} ${response.statusText} ${text}`,
    );
  }

  return (await response.json()) as T;
}

async function ensureGatewayTaskForRun(
  session: MockSession,
  prompt: string,
  attachmentNames: string[],
): Promise<void> {
  if (!session.gatewaySessionId) {
    const started = await gatewayApiRequest<GatewayStartResponse>(
      "POST",
      "/v1/discord/mentions/start",
      {
        userId: session.ownerUserId,
        channelId: session.channelId,
        threadId: session.threadId,
        prompt,
        attachmentNames,
      },
    );
    session.gatewaySessionId = started.session.sessionId;
    session.currentTaskId = started.taskId;
    return;
  }

  const task = await gatewayApiRequest<GatewayThreadMessageResponse>(
    "POST",
    `/v1/threads/${session.threadId}/messages`,
    {
      userId: session.ownerUserId,
      prompt,
      attachmentNames,
    },
  );
  session.currentTaskId = task.taskId;
}

async function addReviewedReaction(message: Message): Promise<void> {
  try {
    await message.react("👀");
  } catch (error) {
    console.error("[mockup] failed to add reviewed reaction", error);
  }
}

function isThreadChannel(
  channel:
    | Channel
    | Message["channel"]
    | ChatInputCommandInteraction["channel"]
    | null,
): channel is AnyThreadChannel {
  return channel !== null && channel.isThread();
}

function extractPromptFromMention(message: Message, botUserId: Snowflake): string {
  const mentionPattern = new RegExp(`<@!?${botUserId}>`, "g");
  return message.content.replace(mentionPattern, "").trim();
}

function resolveSessionByThreadId(threadId: Snowflake): MockSession | undefined {
  const sessionId = sessionIdByThreadId.get(threadId);
  if (!sessionId) {
    return undefined;
  }

  return sessionsById.get(sessionId);
}

function attachSessionToUser(session: MockSession): void {
  const current = sessionIdsByUserId.get(session.ownerUserId) ?? new Set<string>();
  current.add(session.id);
  sessionIdsByUserId.set(session.ownerUserId, current);
}

function setSessionStatus(
  session: MockSession,
  status: SessionStatus,
  lastEvent: string,
): void {
  session.status = status;
  session.lastEvent = lastEvent;
  session.updatedAt = new Date();
}

function clearIdleTimer(sessionId: string): void {
  const timer = idleTimerBySessionId.get(sessionId);
  if (!timer) {
    return;
  }

  clearTimeout(timer);
  idleTimerBySessionId.delete(sessionId);
}

function shouldTrackIdle(session: MockSession): boolean {
  return session.status === "idle_waiting" || session.status === "idle_paused";
}

function touchSession(session: MockSession): void {
  const now = new Date();
  session.lastActivityAt = now;
  session.idleDeadlineAt = new Date(now.getTime() + IDLE_TIMEOUT_SEC * 1000);
  session.updatedAt = now;

  clearIdleTimer(session.id);
  if (session.status === "closed_by_user" || !shouldTrackIdle(session)) {
    return;
  }

  const timer = setTimeout(() => {
    void handleIdleTimeout(session.id);
  }, IDLE_TIMEOUT_SEC * 1000);
  idleTimerBySessionId.set(session.id, timer);
}

async function sendToThread(
  threadId: Snowflake,
  payload: Parameters<AnyThreadChannel["send"]>[0],
): Promise<void> {
  const channel = await client.channels.fetch(threadId);
  if (!isThreadChannel(channel)) {
    return;
  }

  await channel.send(payload);
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

async function sendSystemAlert(content: string): Promise<void> {
  if (!SYSTEM_ALERT_CHANNEL_ID) {
    return;
  }

  try {
    const channel = await client.channels.fetch(SYSTEM_ALERT_CHANNEL_ID);
    if (!channel || !("send" in channel)) {
      return;
    }

    await channel.send(content);
  } catch (error) {
    console.error("[mockup] system alert failed", error);
  }
}

async function reportRuntimeError(context: string, error: unknown): Promise<void> {
  const summary = summarizeError(error);
  console.error(`[mockup] ${context}`, error);
  await sendSystemAlert(`🚨 [mockup-error] ${context}\n${summary}`);
}

function startTypingLoop(threadId: Snowflake): () => void {
  let stopped = false;
  let interval: NodeJS.Timeout | undefined;

  void (async () => {
    const channel = await client.channels.fetch(threadId);
    if (!isThreadChannel(channel)) {
      return;
    }

    const pulse = async (): Promise<void> => {
      if (stopped) {
        return;
      }

      await channel.sendTyping();
    };

    await pulse();
    interval = setInterval(() => {
      void pulse().catch((error: unknown) => {
        console.error("[mockup] typing pulse failed", error);
      });
    }, TYPING_PULSE_MS);
  })().catch((error: unknown) => {
    console.error("[mockup] typing loop setup failed", error);
  });

  return () => {
    stopped = true;
    if (interval) {
      clearInterval(interval);
    }
  };
}

async function setOfflineImmediately(): Promise<void> {
  if (client.user) {
    await client.user.setStatus("invisible");
  }

  client.destroy();
}

async function handleIdleTimeout(sessionId: string): Promise<void> {
  const session = sessionsById.get(sessionId);
  if (!session) {
    return;
  }

  if (session.status === "closed_by_user" || session.status === "idle_paused") {
    return;
  }

  session.cancelRequested = true;
  session.runSequence += 1;
  if (session.pendingApprovalId) {
    settleApproval(session.pendingApprovalId, "canceled");
    session.pendingApprovalId = undefined;
  }

  setSessionStatus(
    session,
    "idle_paused",
    `thread inactive for ${IDLE_TIMEOUT_SEC} seconds`,
  );

  await sendToThread(
    session.threadId,
    `⏸️ セッションは ${IDLE_TIMEOUT_SEC} 秒の無発言で一時停止しました。` +
      `\n同じスレッドで再度メッセージを送ると自動再開します。`,
  );
}

async function relayLmMessage(threadId: Snowflake, rawMessage: string): Promise<void> {
  await sendToThread(threadId, rawMessage);
}

function buildStatusEmbed(session: MockSession): EmbedBuilder {
  const idleDeadline = `<t:${Math.floor(session.idleDeadlineAt.getTime() / 1000)}:R>`;
  const updatedAt = `<t:${Math.floor(session.updatedAt.getTime() / 1000)}:F>`;
  const createdAt = `<t:${Math.floor(session.createdAt.getTime() / 1000)}:F>`;

  return new EmbedBuilder()
    .setTitle("Mock Session Status")
    .setColor(0x5b8def)
    .addFields(
      { name: "status", value: `\`${session.status}\``, inline: true },
      { name: "last_event", value: session.lastEvent || "-" },
      { name: "idle_deadline", value: idleDeadline, inline: true },
      { name: "updated_at", value: updatedAt, inline: true },
      { name: "created_at", value: createdAt, inline: true },
    );
}

function buildListEmbed(userId: Snowflake): EmbedBuilder {
  const ids = [...(sessionIdsByUserId.get(userId) ?? new Set<string>())];
  const sessions = ids
    .map((id) => sessionsById.get(id))
    .filter((session): session is MockSession => session !== undefined)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 20);

  const description =
    sessions.length === 0
      ? "セッションはありません。"
      : sessions
          .map(
            (session) => `- <#${session.threadId}> | \`${session.status}\``,
          )
          .join("\n");

  return new EmbedBuilder()
    .setTitle("My Sessions (Mock)")
    .setColor(0x46c37b)
    .setDescription(description);
}

function settleApproval(approvalId: string, decision: ApprovalDecision): boolean {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    return false;
  }

  clearTimeout(pending.timeout);
  pendingApprovals.delete(approvalId);
  pending.resolve(decision);
  return true;
}

function isRunCanceled(session: MockSession, runSequence: number): boolean {
  return session.cancelRequested || runSequence !== session.runSequence;
}

async function requestApproval(
  session: MockSession,
  request: ToolApprovalRequest,
): Promise<ApprovalDecision> {
  const gatewayApproval = await gatewayApiRequest<GatewayApprovalRequestResponse>(
    "POST",
    `/v1/threads/${session.threadId}/approvals/request`,
    {
      userId: session.ownerUserId,
      operation: request.operation,
      path: request.target,
    },
  );
  const approvalId = gatewayApproval.approval.approvalId;
  session.pendingApprovalId = approvalId;
  session.currentTaskId = gatewayApproval.task.taskId;
  setSessionStatus(
    session,
    "waiting_approval",
    `approval requested: ${request.tool} ${request.operation} ${request.target}`,
  );
  touchSession(session);

  const approvalEmbed = new EmbedBuilder()
    .setTitle("Tool Approval Request (Mock)")
    .setDescription("以下の操作を実行してよいか確認してください。")
    .setColor(0xffb020)
    .addFields(
      { name: "使用したいツール", value: request.tool },
      { name: "行う操作", value: request.operation },
      { name: "ターゲットとなる場所", value: request.target },
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approval:${approvalId}:approve`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`approval:${approvalId}:reject`)
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger),
  );

  await sendToThread(session.threadId, {
    content: `<@${session.ownerUserId}> 確認依頼です。`,
    embeds: [approvalEmbed],
    components: [row],
  });

  return new Promise<ApprovalDecision>((resolve) => {
    const timeout = setTimeout(() => {
      const unresolved = pendingApprovals.get(approvalId);
      if (!unresolved) {
        return;
      }

      pendingApprovals.delete(approvalId);
      session.pendingApprovalId = undefined;
      void gatewayApiRequest(
        "POST",
        `/v1/approvals/${approvalId}/respond`,
        {
          decision: "timeout",
        },
      ).catch((error: unknown) => {
        console.error("[mockup] approval timeout sync failed", error);
      });
      resolve("timeout");
    }, APPROVAL_TIMEOUT_SEC * 1000);

    pendingApprovals.set(approvalId, {
      approvalId,
      sessionId: session.id,
      timeout,
      resolve,
    });
  });
}

async function runMockTask(
  session: MockSession,
  prompt: string,
  attachmentNames: string[],
  triggeredByUserId: Snowflake,
): Promise<void> {
  if (runningSessionIds.has(session.id)) {
    if (session.status === "idle_paused") {
      session.queuedRun = { prompt, attachmentNames, triggeredByUserId };
      await sendToThread(
        session.threadId,
        "▶️ 自動再開リクエストを受け付けました。停止処理後に再開します。",
      );
      return;
    }

    await sendToThread(
      session.threadId,
      "⚠️ すでに実行中のタスクがあります。完了後に再度お試しください。",
    );
    return;
  }

  runningSessionIds.add(session.id);
  session.runSequence += 1;
  const runSequence = session.runSequence;
  session.cancelRequested = false;
  session.queuedRun = undefined;
  setSessionStatus(
    session,
    "running",
    `task started by <@${triggeredByUserId}>`,
  );
  touchSession(session);
  let stopTyping: (() => void) | undefined;
  const startTyping = (): void => {
    if (stopTyping) {
      stopTyping();
    }
    stopTyping = startTypingLoop(session.threadId);
  };
  const clearTyping = (): void => {
    if (!stopTyping) {
      return;
    }

    stopTyping();
    stopTyping = undefined;
  };

  try {
    await ensureGatewayTaskForRun(session, prompt, attachmentNames);

    if (attachmentNames.length > 0) {
      await sendToThread(
        session.threadId,
        `📎 添付ファイル: ${attachmentNames.map((name) => `\`${name}\``).join(", ")}`,
      );
    }

    startTyping();
    await wait(700);
    clearTyping();
    if (isRunCanceled(session, runSequence)) {
      setSessionStatus(session, "idle_waiting", "run canceled before approval");
      await sendToThread(session.threadId, "🛑 タスクはキャンセルされました。");
      return;
    }

    const approvalDecision = await requestApproval(session, {
      tool: "host.file_read",
      operation: "ファイル内容の読み取り",
      target:
        attachmentNames.length > 0
          ? `添付ファイル: ${attachmentNames[0]}`
          : "/Users/example/Documents/report.md",
    });
    session.pendingApprovalId = undefined;
    touchSession(session);

    if (approvalDecision === "rejected") {
      setSessionStatus(session, "failed", "approval rejected");
      await sendToThread(
        session.threadId,
        "❌ 承認が拒否されたため、このモックタスクを停止しました。",
      );
      return;
    }

    if (approvalDecision === "timeout") {
      setSessionStatus(session, "failed", "approval timeout");
      await sendToThread(
        session.threadId,
        "⏰ 承認タイムアウトのため、このモックタスクを停止しました。",
      );
      return;
    }

    if (approvalDecision === "canceled" || isRunCanceled(session, runSequence)) {
      setSessionStatus(
        session,
        "idle_waiting",
        "run canceled while waiting approval",
      );
      await sendToThread(session.threadId, "🛑 タスクはキャンセルされました。");
      return;
    }

    setSessionStatus(session, "running", "approval granted, generating response");
    await sendToThread(session.threadId, "🔍 承認済み。モック解析を続行します...");

    startTyping();
    await wait(1000);
    clearTyping();
    if (isRunCanceled(session, runSequence)) {
      setSessionStatus(session, "idle_waiting", "run canceled during generation");
      await sendToThread(session.threadId, "🛑 タスクはキャンセルされました。");
      return;
    }

    const rawLmMessage = prompt || "(empty prompt)";
    await relayLmMessage(session.threadId, rawLmMessage);
    setSessionStatus(session, "idle_waiting", "waiting for next thread message");
    touchSession(session);
  } catch (error) {
    clearTyping();
    setSessionStatus(session, "failed", summarizeError(error));
    touchSession(session);
    await sendToThread(
      session.threadId,
      "❌ 実行中にエラーが発生しました。少し待ってから再試行してください。",
    );
    console.error("[mockup] run failed", error);
  } finally {
    clearTyping();
    runningSessionIds.delete(session.id);

    const queuedRun = sessionsById.get(session.id)?.queuedRun;
    if (
      queuedRun &&
      session.status !== "closed_by_user" &&
      !runningSessionIds.has(session.id)
    ) {
      session.queuedRun = undefined;
      void runMockTask(
        session,
        queuedRun.prompt,
        queuedRun.attachmentNames,
        queuedRun.triggeredByUserId,
      ).catch((error: unknown) => {
        console.error("[mockup] queued resume failed", error);
      });
    }
  }
}

async function handleApprovalButton(interaction: ButtonInteraction): Promise<void> {
  const [prefix, approvalId, action] = interaction.customId.split(":");
  if (prefix !== "approval" || !approvalId || !action) {
    return;
  }

  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    await interaction.reply({
      content: "この承認は既に処理済みか期限切れです。",
      ephemeral: true,
    });
    return;
  }

  const session = sessionsById.get(pending.sessionId);
  if (!session) {
    settleApproval(approvalId, "canceled");
    await interaction.reply({
      content: "対応するセッションが見つかりません。",
      ephemeral: true,
    });
    return;
  }

  if (interaction.user.id !== session.ownerUserId) {
    await interaction.reply({
      content: "この承認はセッション作成者のみ操作できます。",
      ephemeral: true,
    });
    return;
  }

  const decision: ApprovalDecision = action === "approve" ? "approved" : "rejected";
  try {
    await gatewayApiRequest(
      "POST",
      `/v1/approvals/${approvalId}/respond`,
      {
        userId: interaction.user.id,
        decision,
      },
    );
  } catch (error) {
    console.error("[mockup] approval response sync failed", error);
    await interaction.reply({
      content:
        "承認結果を Gateway API へ反映できませんでした。しばらく待ってから再試行してください。",
      ephemeral: true,
    });
    return;
  }

  if (!settleApproval(approvalId, decision)) {
    await interaction.reply({
      content: "この承認は既に処理済みか期限切れです。",
      ephemeral: true,
    });
    return;
  }

  await interaction.update({ components: [] });
  await interaction.followUp({
    content: decision === "approved" ? "✅ 承認しました。" : "❌ 拒否しました。",
  });

  touchSession(session);
}

function cancelSession(session: MockSession, by: Snowflake): void {
  session.cancelRequested = true;
  setSessionStatus(session, "idle_waiting", `task canceled by <@${by}>`);

  if (session.pendingApprovalId) {
    settleApproval(session.pendingApprovalId, "canceled");
    session.pendingApprovalId = undefined;
  }

  touchSession(session);
}

function closeSession(session: MockSession, by: Snowflake): void {
  session.cancelRequested = true;
  setSessionStatus(session, "closed_by_user", `closed by <@${by}>`);

  if (session.pendingApprovalId) {
    settleApproval(session.pendingApprovalId, "canceled");
    session.pendingApprovalId = undefined;
  }

  clearIdleTimer(session.id);
}

function closeAllSessions(by: Snowflake): number {
  let closedCount = 0;
  for (const session of sessionsById.values()) {
    if (session.status === "closed_by_user") {
      continue;
    }

    closeSession(session, by);
    closedCount += 1;
  }

  return closedCount;
}

async function executeSystemControl(
  mode: SystemControlMode,
  requestedBy: Snowflake,
  notify: (content: string) => Promise<unknown>,
): Promise<void> {
  if (isSystemControlPending) {
    await notify("⚠️ すでに終了処理中です。");
    return;
  }

  isSystemControlPending = true;
  const closedCount = closeAllSessions(requestedBy);

  const actionLabel = mode === "reboot" ? "再起動" : "終了";
  const exitCode = mode === "reboot" ? REBOOT_EXIT_CODE : 0;
  await notify(
    `⚠️ \`/${mode}\` を受け付けました。全 ${closedCount} セッションを終了し、システムを${actionLabel}します。`,
  );
  await sendSystemAlert(
    `⚠️ [mockup-control] /${mode} requested by <@${requestedBy}> ` +
      `(closed_sessions: ${closedCount})`,
  );

  if (mode === "exit") {
    await setOfflineImmediately();
    setTimeout(() => {
      process.exit(exitCode);
    }, 50);
    return;
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, SHUTDOWN_DELAY_MS);
}

async function startSessionFromMention(message: Message): Promise<void> {
  if (!message.inGuild() || !client.user) {
    return;
  }

  const prompt = extractPromptFromMention(message, client.user.id);
  const attachmentNames = [...message.attachments.values()].map(
    (attachment) => attachment.name ?? attachment.id,
  );

  if (!prompt && attachmentNames.length === 0) {
    await message.reply(
      "開始するには、メンションに続けてプロンプトか添付を指定してください。",
    );
    return;
  }

  const threadName = `task-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
  const thread = await message.startThread({
    name: threadName,
    autoArchiveDuration: 60,
    reason: "Discord UX mock session",
  });

  const now = new Date();
  const session: MockSession = {
    id: newId("ses"),
    ownerUserId: message.author.id,
    channelId: message.channelId,
    threadId: thread.id,
    status: "running",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    idleDeadlineAt: new Date(now.getTime() + IDLE_TIMEOUT_SEC * 1000),
    runSequence: 0,
    cancelRequested: false,
    lastEvent: "session created from mention",
  };

  sessionsById.set(session.id, session);
  sessionIdByThreadId.set(thread.id, session.id);
  attachSessionToUser(session);
  touchSession(session);
  await addReviewedReaction(message);
  await runMockTask(session, prompt, attachmentNames, message.author.id);
}

async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const { commandName } = interaction;
  if (commandName === "list") {
    await interaction.reply({
      embeds: [buildListEmbed(interaction.user.id)],
      ephemeral: true,
    });
    return;
  }

  if (commandName === "exit") {
    await executeSystemControl("exit", interaction.user.id, (content) =>
      interaction.reply({ content }),
    );
    return;
  }

  if (commandName === "reboot") {
    await executeSystemControl("reboot", interaction.user.id, (content) =>
      interaction.reply({ content }),
    );
    return;
  }

  if (!isThreadChannel(interaction.channel)) {
    await interaction.reply({
      content: "このコマンドはセッションスレッド内で実行してください。",
      ephemeral: true,
    });
    return;
  }

  const session = resolveSessionByThreadId(interaction.channel.id);
  if (!session) {
    await interaction.reply({
      content: "このスレッドに対応するセッションが見つかりません。",
      ephemeral: true,
    });
    return;
  }

  if (interaction.user.id !== session.ownerUserId) {
    await interaction.reply({
      content: "このセッションは作成者のみ操作できます。",
      ephemeral: true,
    });
    return;
  }

  touchSession(session);

  if (commandName === "status") {
    await interaction.reply({
      embeds: [buildStatusEmbed(session)],
      ephemeral: true,
    });
    return;
  }

  if (commandName === "cancel") {
    try {
      await gatewayApiRequest(
        "POST",
        `/v1/threads/${session.threadId}/cancel`,
        {
          userId: interaction.user.id,
        },
      );
    } catch (error) {
      console.error("[mockup] cancel sync failed", error);
      await interaction.reply({
        content:
          "Gateway API へのキャンセル反映に失敗しました。しばらく待ってから再試行してください。",
        ephemeral: true,
      });
      return;
    }

    cancelSession(session, interaction.user.id);
    await interaction.reply({ content: "🛑 タスクをキャンセルしました。" });
    return;
  }

  if (commandName === "close") {
    try {
      await gatewayApiRequest(
        "POST",
        `/v1/threads/${session.threadId}/close`,
        {
          userId: interaction.user.id,
        },
      );
    } catch (error) {
      console.error("[mockup] close sync failed", error);
      await interaction.reply({
        content:
          "Gateway API へのクローズ反映に失敗しました。しばらく待ってから再試行してください。",
        ephemeral: true,
      });
      return;
    }

    closeSession(session, interaction.user.id);
    await interaction.reply({ content: "🔒 セッションを終了しました。" });
  } else {
    await interaction.reply({
      content: "未対応のコマンドです。",
      ephemeral: true,
    });
  }
}

async function handleThreadMessage(message: Message): Promise<void> {
  if (!isThreadChannel(message.channel)) {
    return;
  }

  const session = resolveSessionByThreadId(message.channel.id);
  if (!session) {
    return;
  }

  if (message.author.id !== session.ownerUserId) {
    return;
  }

  touchSession(session);

  if (session.status === "closed_by_user") {
    await message.reply("このセッションは `/close` で終了済みです。");
    return;
  }

  if (session.status === "running" || session.status === "waiting_approval") {
    await message.reply("現在実行中です。完了を待ってから再送してください。");
    return;
  }

  const prompt = message.content.trim();
  const attachmentNames = [...message.attachments.values()].map(
    (attachment) => attachment.name ?? attachment.id,
  );

  if (!prompt && attachmentNames.length === 0) {
    await message.reply("プロンプトか添付を指定してください。");
    return;
  }

  await addReviewedReaction(message);

  if (session.status === "idle_paused") {
    await message.reply("▶️ セッションを自動再開します。");
  }

  await runMockTask(session, prompt, attachmentNames, message.author.id);
}

client.once(Events.ClientReady, (readyClient) => {
  void (async () => {
    const startupMessage =
      `[mockup] Logged in as ${readyClient.user.tag} | ` +
      `idle=${IDLE_TIMEOUT_SEC}s | approval=${APPROVAL_TIMEOUT_SEC}s`;
    console.log(startupMessage);
    await sendSystemAlert(`🟢 ${startupMessage}`);
  })().catch((error: unknown) => {
    console.error("[mockup] ready handler failed", error);
  });
});

client.on(Events.MessageCreate, (message) => {
  void (async () => {
    if (message.author.bot || !client.user) {
      return;
    }

    if (message.inGuild() && message.mentions.users.has(client.user.id) && !message.channel.isThread()) {
      await startSessionFromMention(message);
      return;
    }

    await handleThreadMessage(message);
  })().catch((error: unknown) => {
    void reportRuntimeError("message handler failed", error);
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  void (async () => {
    if (interaction.isButton()) {
      await handleApprovalButton(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    }
  })().catch((error: unknown) => {
    void reportRuntimeError("interaction handler failed", error);
  });
});

client.on(Events.Error, (error) => {
  void reportRuntimeError("client error event", error);
});

process.on("unhandledRejection", (reason: unknown) => {
  void reportRuntimeError("unhandledRejection", reason);
});

process.on("uncaughtException", (error: Error) => {
  void reportRuntimeError("uncaughtException", error).finally(() => {
    process.exit(1);
  });
});

void client.login(DISCORD_BOT_TOKEN);
