import type { Database } from "bun:sqlite";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  type Message,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type AnyThreadChannel,
  type Client,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { JsonRpcClient } from "./codex/jsonrpc-client";
import type {
  CodexAgentMessageItem,
  CodexCommandExecutionItem,
  ApprovalRequestEvent,
  CodexThread,
  CodexThreadStatus,
  CodexTurn,
  CodexTurnItem,
  CodexUserMessageItem,
  RoutedEventMap,
  StartTurnParams,
  ThreadReadResult,
} from "./codex/protocol-types";
import { type AppConfig, parseConfig, type WorkdirConfig } from "./config";
import { createDatabaseClient } from "./db/client";
import { applyMigrations } from "./db/migrate";
import { createApprovalRepo, type ApprovalRecord } from "./db/repos/approvals";
import { createSessionRepo, type SessionRecord } from "./db/repos/sessions";
import { createWorkdirRepo } from "./db/repos/workdirs";
import { createWorkspaceRepo } from "./db/repos/workspaces";
import type { ApprovalStatus } from "./domain/approval-service";
import { shouldDegradeDiscordToReadOnly } from "./domain/external-modification";
import {
  canControlSession,
  coercePersistedSessionRuntimeState,
  inferSyncedSessionRuntimeState,
  resolveResumeSessionState,
  resolveSyncSessionState,
  resolveSessionAccessMode,
} from "./domain/session-service";
import type {
  SessionLifecycleState,
  SessionPersistedRuntimeState,
  SessionResumeState,
  SessionRuntimeState,
} from "./domain/types";
import { applyApprovalResolutionSignal, renderApprovalUi } from "./discord/approval-ui";
import { createDiscordBot } from "./discord/bot";
import {
  buildControlChannelCommands,
  type DiscordCommandResult,
  type DiscordCommandServices,
} from "./discord/commands";
import { buildDiscordRestOptions } from "./discord/rest";
import {
  renderDegradationActionText,
  renderDegradationBannerPayload,
  renderSessionStartedPayload,
  renderStatusCardText,
} from "./discord/renderers";
import {
  appendProcessStep,
  buildCommandProcessStep,
  collectComparableTranscriptItemIds,
  collectTranscriptEntries,
  collectTranscriptItemIds,
  getAssistantTranscriptEntryId,
  type DiscordMessagePayload,
  getProcessTranscriptEntryId,
  getUserTranscriptEntryId,
  isDiscordMessagePayloadEmpty,
  type ProcessFooterText,
  normalizeProcessStepText,
  renderTranscriptEntry,
  renderTranscriptMessages,
} from "./discord/transcript";
import {
  decideArchivedThreadResume,
  decideThreadTurn,
  type CodexTurnInput,
} from "./discord/thread-handler";
import { logger } from "./logger";

const approvalButtonPrefix = "approval";

type ApprovalAction = "approve" | "decline" | "cancel";
type DiscordMessageComponents = ActionRowBuilder<ButtonBuilder>[];
type DiscordChannelMessagePayload = DiscordMessagePayload & {
  components?: DiscordMessageComponents;
};
type ApprovalButtonMessage = {
  edit(payload: { content: string; components: [] }): Promise<ApprovalButtonMessage>;
};
type ApprovalLifecycleMessage = {
  content: string;
  edit(payload: DiscordChannelMessagePayload): Promise<ApprovalLifecycleMessage>;
};
type ApprovalLifecycleState = {
  message?: ApprovalLifecycleMessage;
  pendingMessage?: Promise<ApprovalLifecycleMessage | undefined>;
};
type StreamingTranscriptMessage = Message<boolean>;
export type EditableStatusCardMessage = {
  edit(payload: { content: string }): Promise<EditableStatusCardMessage>;
  content: string;
};
type StatusCardCandidate = {
  id: string;
  content: string;
  editable: boolean;
  author?: {
    bot?: boolean;
    id?: string;
  };
};
type SendableChannel = {
  send(payload: DiscordChannelMessagePayload): Promise<Message<boolean>>;
};
type StatusCardRecoverableChannel = {
  messages: {
    fetch(options: { limit: number; before?: string }): Promise<Iterable<Message<boolean>> | Map<string, Message<boolean>>>;
  };
};
type ThreadStarterMessage = Message<boolean> & {
  startThread(options: {
    name: string;
    autoArchiveDuration: ThreadAutoArchiveDuration;
    reason?: string;
  }): Promise<AnyThreadChannel>;
};
type ArchiveableThreadChannel = {
  setArchived(archived?: boolean, reason?: string): Promise<unknown>;
};
type TranscriptRuntime = {
  seenItemIds: Set<string>;
  finalizingItemIds: Set<string>;
  pendingDiscordInputs: string[];
  trustedExternalTurnIds: Set<string>;
  closedTurnIds: Set<string>;
  typingActive: boolean;
  typingTimeout?: ReturnType<typeof setTimeout>;
  turnProcessMessages: Map<
    string,
    {
      steps: string[];
      liveCommentaryItemId?: string;
      liveCommentaryText?: string;
      footer?: ProcessFooterText;
      message?: StreamingTranscriptMessage;
      pendingCreate?: Promise<StreamingTranscriptMessage | undefined>;
      pendingUpdate?: Promise<void>;
      nextPayload?: DiscordMessagePayload;
    }
  >;
  itemTurnIds: Map<string, string>;
  activeTurnId?: string;
  statusMessage?: EditableStatusCardMessage;
  statusActivity?: string;
  statusCommand?: string;
  attemptedStatusRecovery: boolean;
  pendingStatusUpdate?: Promise<EditableStatusCardMessage | undefined>;
};

const sessionSnapshotPollIntervalMs = 15_000;
const discordTypingPulseIntervalMs = 8_000;

export const shouldRenderLiveAssistantTranscriptBubble = (
  phase: string | null | undefined,
) => {
  return phase !== "commentary";
};

export const shouldRenderCommandExecutionStartMessage = () => {
  return false;
};

export const shouldShowDiscordTypingIndicator = (
  state: SessionRuntimeState,
) => {
  return state === "running";
};

const createTurnProcessMessageState = () => {
  return {
    steps: [] as string[],
    liveCommentaryItemId: undefined as string | undefined,
    liveCommentaryText: undefined as string | undefined,
    footer: undefined as ProcessFooterText | undefined,
    message: undefined as StreamingTranscriptMessage | undefined,
    pendingCreate: undefined as Promise<StreamingTranscriptMessage | undefined> | undefined,
    pendingUpdate: undefined as Promise<void> | undefined,
    nextPayload: undefined as DiscordMessagePayload | undefined,
  };
};

export const shouldSkipStaleLiveTurnProcessUpdate = ({
  activeTurnId,
  closedTurnIds,
  turnId,
  deleteIfEmpty,
}: {
  activeTurnId?: string;
  closedTurnIds?: Set<string>;
  turnId?: string;
  deleteIfEmpty?: boolean;
}) => {
  if (deleteIfEmpty || !turnId) {
    return false;
  }

  if (closedTurnIds?.has(turnId)) {
    return true;
  }

  if (activeTurnId === undefined) {
    return false;
  }

  return activeTurnId !== turnId;
};

const ensureTurnProcessMessageState = (
  runtime: Pick<TranscriptRuntime, "turnProcessMessages">,
  turnId: string,
) => {
  const current = runtime.turnProcessMessages.get(turnId);

  if (current) {
    return current;
  }

  const created = createTurnProcessMessageState();
  runtime.turnProcessMessages.set(turnId, created);
  return created;
};

const getFooterForSessionState = (
  state: SessionRuntimeState,
): ProcessFooterText | undefined => {
  if (state === "waiting-approval") {
    return "Waiting for approval";
  }

  return undefined;
};

export const renderLiveTurnProcessMessage = ({
  turnId: _turnId,
  steps: _steps,
  liveCommentaryText: _liveCommentaryText,
  footer: _footer,
}: {
  turnId: string;
  steps: string[];
  liveCommentaryText?: string;
  footer?: ProcessFooterText;
}) => {
  return undefined;
};

export const finalizeLiveTurnProcessMessage = async ({
  currentMessage,
  currentMessagePromise,
  rendered,
  sendRendered,
}: {
  currentMessage?: {
    delete(): Promise<unknown>;
    edit(payload: DiscordMessagePayload): Promise<unknown>;
  };
  currentMessagePromise?: Promise<{
    delete(): Promise<unknown>;
    edit(payload: DiscordMessagePayload): Promise<unknown>;
  } | undefined>;
  rendered?: DiscordMessagePayload;
  sendRendered: (payload: DiscordMessagePayload) => Promise<unknown>;
}) => {
  const message = currentMessage ?? await currentMessagePromise;

  if (isDiscordMessagePayloadEmpty(rendered)) {
    if (message) {
      await message.delete();
    }

    return;
  }

  const payload = rendered as DiscordMessagePayload;

  if (message) {
    await message.edit(payload);
    return;
  }

  await sendRendered(payload);
};

export const shouldPollSnapshotForSessionState = (state: SessionRuntimeState) => {
  return state === "idle";
};

export const shouldPollRecoveryProbeForSessionState = (
  state: SessionRuntimeState,
) => {
  return state === "running" || state === "waiting-approval";
};

export const isExpectedPreMaterializationIncludeTurnsError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalizedMessage = error.message.toLowerCase();

  return (
    (normalizedMessage.includes("includeturns")
      && normalizedMessage.includes("before first user message"))
    || (normalizedMessage.includes("includeturns")
      && normalizedMessage.includes("not yet materialized"))
  );
};

export const shouldLogSnapshotReconciliationWarning = (error: unknown) => {
  return !isExpectedPreMaterializationIncludeTurnsError(error);
};

export const isMissingCodexThreadError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalizedMessage = error.message.toLowerCase();

  return normalizedMessage.includes("thread not found")
    || normalizedMessage.includes("no rollout found for thread id");
};

export const isNotLoadedCodexThreadError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.toLowerCase().includes("thread not loaded");
};

export const getSnapshotReconciliationFailureDisposition = (error: unknown) => {
  if (isMissingCodexThreadError(error)) {
    return "degrade-thread-missing" as const;
  }

  if (!shouldLogSnapshotReconciliationWarning(error)) {
    return "ignore" as const;
  }

  return "warn" as const;
};

const shouldRetryCodexThreadOperationAfterResume = (error: unknown) => {
  return isNotLoadedCodexThreadError(error) || isMissingCodexThreadError(error);
};

const retryCodexThreadOperationAfterResume = async <TResult>({
  threadId,
  operation,
  resumeThread,
}: {
  threadId: string;
  operation: () => Promise<TResult>;
  resumeThread: (params: { threadId: string }) => Promise<unknown>;
}) => {
  try {
    return await operation();
  } catch (error) {
    if (!shouldRetryCodexThreadOperationAfterResume(error)) {
      throw error;
    }

    await resumeThread({
      threadId,
    });

    return operation();
  }
};

export const startTurnWithThreadResumeRetry = async <TResult>({
  request,
  startTurn,
  resumeThread,
}: {
  request: StartTurnParams;
  startTurn: (request: StartTurnParams) => Promise<TResult>;
  resumeThread: (params: { threadId: string }) => Promise<unknown>;
}) => {
  return retryCodexThreadOperationAfterResume({
    threadId: request.threadId,
    operation: () => startTurn(request),
    resumeThread,
  });
};

const isRecoverableStaleStatusMessageError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalizedMessage = error.message.toLowerCase();

  return normalizedMessage.includes("unknown message")
    || normalizedMessage.includes("message not found")
    || normalizedMessage.includes("not found")
    || normalizedMessage.includes("deleted");
};

export const hasHandledTranscriptItem = (
  runtime: {
    seenItemIds: Set<string>;
    finalizingItemIds: Set<string>;
  },
  itemId: string,
) => {
  return runtime.seenItemIds.has(itemId) || runtime.finalizingItemIds.has(itemId);
};

export const shouldSkipTranscriptSnapshotItem = (
  runtime: {
    seenItemIds: Set<string>;
    finalizingItemIds: Set<string>;
  },
  itemId: string,
) => {
  return runtime.seenItemIds.has(itemId) || runtime.finalizingItemIds.has(itemId);
};

export const shouldSkipTranscriptRelayEntry = ({
  runtime,
  itemId,
  source,
}: {
  runtime: {
    seenItemIds: Set<string>;
    finalizingItemIds: Set<string>;
  };
  itemId: string;
  source: "live" | "snapshot";
}) => {
  if (source === "snapshot") {
    return shouldSkipTranscriptSnapshotItem(runtime, itemId);
  }

  return runtime.seenItemIds.has(itemId);
};

export const shouldDegradeForSnapshotMismatch = ({
  runtime,
  turns,
}: {
  runtime: {
    seenItemIds: Set<string>;
    finalizingItemIds: Set<string>;
    pendingDiscordInputs: string[];
    trustedExternalTurnIds?: Set<string>;
  };
  turns: CodexTurn[] | undefined;
}) => {
  const pendingDiscordInputsProbe = [...runtime.pendingDiscordInputs];
  const trustedExternalTurnIds = runtime.trustedExternalTurnIds ?? new Set<string>();
  const unseenItemIds = collectComparableTranscriptItemIds(turns, {
    pendingDiscordInputs: pendingDiscordInputsProbe,
  }).filter(
    (itemId) =>
      !shouldSkipTranscriptSnapshotItem(runtime, itemId)
      && !trustedExternalTurnIds.has(readTurnIdFromTranscriptEntryId(itemId) ?? ""),
  );

  if (unseenItemIds.length === 0) {
    return false;
  }

  if (runtime.pendingDiscordInputs.length === 0) {
    return true;
  }

  return pendingDiscordInputsProbe.length === runtime.pendingDiscordInputs.length;
};

export const shouldHoldSnapshotTranscriptForManualSync = ({
  runtime,
  turns,
  degradeOnUnexpectedItems,
}: {
  runtime: {
    seenItemIds: Set<string>;
    finalizingItemIds: Set<string>;
    pendingDiscordInputs: string[];
    trustedExternalTurnIds?: Set<string>;
  };
  turns: CodexTurn[] | undefined;
  degradeOnUnexpectedItems: boolean;
}) => {
  return degradeOnUnexpectedItems && shouldDegradeForSnapshotMismatch({
    runtime,
    turns,
  });
};

export const canReuseStatusCardMessage = ({
  content,
  editable,
  author,
  botUserId,
}: StatusCardCandidate & {
  botUserId?: string;
}) => {
  return (
    content.startsWith("CodeHelm status: ")
    && editable
    && author?.bot === true
    && (botUserId === undefined || author.id === botUserId)
  );
};

export const findReusableStatusCardMessage = <T extends StatusCardCandidate>({
  messages,
  botUserId,
}: {
  messages: T[];
  botUserId?: string;
}) => {
  return messages.find((message) =>
    canReuseStatusCardMessage({
      ...message,
      botUserId,
    }));
};

export const recoverStatusCardMessageFromHistory = async <T extends StatusCardCandidate>({
  fetchPage,
  botUserId,
  pageSize = 50,
  maxPages = 5,
}: {
  fetchPage: (options: { limit: number; before?: string }) => Promise<T[]>;
  botUserId?: string;
  pageSize?: number;
  maxPages?: number;
}) => {
  let before: string | undefined;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const messages = await fetchPage({
      limit: pageSize,
      before,
    });
    const recovered = findReusableStatusCardMessage({
      messages,
      botUserId,
    });

    if (recovered) {
      return recovered;
    }

    if (messages.length === 0) {
      return undefined;
    }

    before = messages.at(-1)?.id;

    if (!before || messages.length < pageSize) {
      return undefined;
    }
  }

  return undefined;
};

export const upsertStatusCardMessage = async ({
  currentMessage,
  recoverMessage,
  content,
  sendMessage,
}: {
  currentMessage?: EditableStatusCardMessage;
  recoverMessage: () => Promise<EditableStatusCardMessage | undefined>;
  content: string;
  sendMessage: (content: string) => Promise<EditableStatusCardMessage | undefined>;
}) => {
  const message = currentMessage ?? await recoverMessage();

  if (message) {
    if (message.content === content) {
      return message;
    }

    return message.edit({ content });
  }

  return sendMessage(content);
};

export const applyStatusCardUpdate = async ({
  runtime,
  content,
  recoverMessage,
  sendMessage,
}: {
  runtime: {
    attemptedStatusRecovery: boolean;
    statusMessage?: EditableStatusCardMessage;
    pendingStatusUpdate?: Promise<EditableStatusCardMessage | undefined>;
  };
  content: string;
  recoverMessage: () => Promise<EditableStatusCardMessage | undefined>;
  sendMessage: (content: string) => Promise<EditableStatusCardMessage | undefined>;
}) => {
  const previousUpdate = runtime.pendingStatusUpdate;
  const operation = (async () => {
    if (previousUpdate) {
      try {
        await previousUpdate;
      } catch {
        // Let the next update retry recovery/send after a failed prior attempt.
      }
    }

    try {
      const recoveredStatusMessage = await tryRecoverStatusCardMessage({
        runtime,
        recoverMessage,
      });

      runtime.statusMessage = await upsertStatusCardMessage({
        currentMessage: runtime.statusMessage ?? recoveredStatusMessage,
        recoverMessage: async () => undefined,
        content,
        sendMessage,
      });
    } catch (error) {
      if (!runtime.statusMessage || !isRecoverableStaleStatusMessageError(error)) {
        throw error;
      }

      runtime.statusMessage = undefined;
      runtime.attemptedStatusRecovery = false;
      const recoveredStatusMessage = await tryRecoverStatusCardMessage({
        runtime,
        recoverMessage,
      });

      runtime.statusMessage = await upsertStatusCardMessage({
        currentMessage: runtime.statusMessage ?? recoveredStatusMessage,
        recoverMessage: async () => undefined,
        content,
        sendMessage,
      });
    }

    return runtime.statusMessage;
  })();

  runtime.pendingStatusUpdate = operation;

  try {
    return await operation;
  } finally {
    if (runtime.pendingStatusUpdate === operation) {
      runtime.pendingStatusUpdate = undefined;
    }
  }
};

export const tryRecoverStatusCardMessage = async ({
  runtime,
  recoverMessage,
}: {
  runtime: {
    attemptedStatusRecovery: boolean;
    statusMessage?: EditableStatusCardMessage;
  };
  recoverMessage: () => Promise<EditableStatusCardMessage | undefined>;
}) => {
  if (runtime.statusMessage || runtime.attemptedStatusRecovery) {
    return runtime.statusMessage;
  }

  const recovered = await recoverMessage();
  runtime.attemptedStatusRecovery = true;
  runtime.statusMessage = recovered;

  return recovered;
};

export const readThreadForSnapshotReconciliation = async ({
  codexClient,
  threadId,
}: {
  codexClient: Pick<JsonRpcClient, "readThread" | "resumeThread">;
  threadId: string;
}): Promise<ThreadReadResult> => {
  try {
    return await retryCodexThreadOperationAfterResume({
      threadId,
      operation: () =>
        codexClient.readThread({
          threadId,
          includeTurns: true,
        }),
      resumeThread: ({ threadId: nextThreadId }) =>
        codexClient.resumeThread({
          threadId: nextThreadId,
        }),
    });
  } catch (error) {
    if (!isExpectedPreMaterializationIncludeTurnsError(error)) {
      throw error;
    }

    const snapshot = await codexClient.readThread({
      threadId,
    });

    return {
      ...snapshot,
      thread: {
        ...snapshot.thread,
        turns: snapshot.thread.turns ?? [],
      },
    };
  }
};

export const getSessionRecoveryProbeOutcome = ({
  sessionState,
  threadStatus,
}: {
  sessionState: SessionRuntimeState;
  threadStatus: CodexThreadStatus;
}) => {
  const nextState = inferSessionStateFromThreadStatus(threadStatus);

  return {
    nextState,
    shouldUpdateSessionState: nextState !== sessionState,
    shouldUpdateStatusCard: nextState !== sessionState,
    shouldSyncTranscriptSnapshot:
      sessionState !== "idle" && nextState === "idle",
  };
};

export const pollSessionRecovery = async ({
  session,
  sessionState,
  readThread,
  updateSessionState,
  updateStatusCard,
  syncTranscriptSnapshot,
}: {
  session: {
    codexThreadId: string;
    discordThreadId: string;
    state: string;
  };
  sessionState: SessionRuntimeState;
  readThread: (threadId: string) => Promise<ThreadReadResult>;
  updateSessionState: (nextState: SessionRuntimeState) => Promise<void> | void;
  updateStatusCard: (nextState: SessionRuntimeState) => Promise<void>;
  syncTranscriptSnapshot: () => Promise<void>;
}) => {
  const probe = await readThread(session.codexThreadId);
  const outcome = getSessionRecoveryProbeOutcome({
    sessionState,
    threadStatus: probe.thread.status,
  });

  if (outcome.shouldUpdateSessionState) {
    await updateSessionState(outcome.nextState);
  }

  if (outcome.shouldUpdateStatusCard) {
    await updateStatusCard(outcome.nextState);
  }

  if (outcome.shouldSyncTranscriptSnapshot) {
    await syncTranscriptSnapshot();
  }
};

const coerceSessionRuntimeState = (state: string): SessionRuntimeState => {
  return coercePersistedSessionRuntimeState(state);
};

const maxStatusActivityLength = 62;

const truncateStatusActivity = (value: string) => {
  return value.length > maxStatusActivityLength
    ? `${value.slice(0, Math.max(0, maxStatusActivityLength - 3))}...`
    : value;
};

export const summarizeStatusActivity = (value: string) => {
  const normalized = value
    .split("\n")[0]
    ?.replace(/\s+/g, " ")
    .trim() ?? "";

  return truncateStatusActivity(normalized);
};

const isFailedCommandExecutionItem = (item: CodexCommandExecutionItem) => {
  if (typeof item.exitCode === "number") {
    return item.exitCode !== 0;
  }

  return item.status === "failed" || item.status === "error";
};

export const shouldRelayLiveCompletedItemToTranscript = (item: CodexTurnItem) => {
  if (!isCommandExecutionItem(item)) {
    return true;
  }

  return false;
};

export const shouldTrackLiveCompletedItemAsFinalizing = (item: CodexTurnItem) => {
  return isCommandExecutionItem(item) && shouldRelayLiveCompletedItemToTranscript(item);
};

export const shouldDeleteLiveAssistantTranscriptBubbleOnCompletion = (
  _startedPhase: string | null | undefined,
  completedPhase: string | null | undefined,
) => {
  return completedPhase === "commentary";
};

export const shouldMarkAssistantItemSeenOnCompletion = (
  startedPhase: string | null | undefined,
  completedPhase: string | null | undefined,
) => {
  return !shouldDeleteLiveAssistantTranscriptBubbleOnCompletion(
    startedPhase,
    completedPhase,
  );
};

export const finalizeLiveAssistantTranscriptBubble = async ({
  currentMessage,
  currentMessagePromise,
  startedPhase,
  completedPhase,
  rendered,
  sendRendered,
}: {
  currentMessage?: {
    delete(): Promise<unknown>;
    edit(payload: DiscordMessagePayload): Promise<unknown>;
  };
  currentMessagePromise?: Promise<{
    delete(): Promise<unknown>;
    edit(payload: DiscordMessagePayload): Promise<unknown>;
  } | undefined>;
  startedPhase: string | null | undefined;
  completedPhase: string | null | undefined;
  rendered: DiscordMessagePayload;
  sendRendered: (payload: DiscordMessagePayload) => Promise<unknown>;
}) => {
  const message = currentMessage ?? await currentMessagePromise;

  if (shouldDeleteLiveAssistantTranscriptBubbleOnCompletion(startedPhase, completedPhase)) {
    if (message) {
      await message.delete();
    }

    return;
  }

  if (message) {
    await message.edit(rendered);
    return;
  }

  await sendRendered(rendered);
};

export const upsertStreamingTranscriptMessage = async <T extends {
  edit(payload: DiscordMessagePayload): Promise<unknown>;
}>({
  state,
  payload,
  sendMessage,
}: {
  state: {
    message?: T;
    pendingCreate?: Promise<T | undefined>;
    pendingUpdate?: Promise<void>;
    nextPayload?: DiscordMessagePayload;
  };
  payload: DiscordMessagePayload;
  sendMessage: (payload: DiscordMessagePayload) => Promise<T | undefined>;
}) => {
  const queueEdit = async (message: T, nextPayload: DiscordMessagePayload) => {
    if (state.pendingUpdate) {
      state.nextPayload = nextPayload;
      await state.pendingUpdate;
      return message;
    }

    const updatePromise = (async () => {
      let payloadToApply: DiscordMessagePayload | undefined = nextPayload;

      while (payloadToApply) {
        await message.edit(payloadToApply);
        payloadToApply = state.nextPayload;
        state.nextPayload = undefined;
      }
    })();

    state.pendingUpdate = updatePromise;

    try {
      await updatePromise;
      return message;
    } finally {
      if (state.pendingUpdate === updatePromise) {
        state.pendingUpdate = undefined;
        state.nextPayload = undefined;
      }
    }
  };

  if (state.message) {
    return queueEdit(state.message, payload);
  }

  if (state.pendingCreate) {
    const message = await state.pendingCreate;

    if (message) {
      state.message = message;
      return queueEdit(message, payload);
    }

    return message;
  }

  const createPromise = sendMessage(payload);
  state.pendingCreate = createPromise;

  try {
    const message = await createPromise;

    if (message) {
      state.message = message;
    }

    return message;
  } finally {
    if (state.pendingCreate === createPromise) {
      state.pendingCreate = undefined;
    }
  }
};

export const renderApprovalLifecycleMessage = ({
  requestId,
  status,
}: {
  requestId: string;
  status: ApprovalStatus;
}) => {
  if (status === "pending") {
    return `Approval \`${requestId}\`: pending.`;
  }

  return `Approval \`${requestId}\`: ${status}.`;
};

export const renderApprovalLifecyclePayload = ({
  requestId,
  status,
}: {
  requestId: string;
  status: ApprovalStatus;
}) => {
  return {
    content: renderApprovalLifecycleMessage({
      requestId,
      status,
    }),
    components: status === "pending" ? buildApprovalComponents(requestId) : [],
  };
};

export const shouldAcceptApprovalInteraction = (
  status: ApprovalStatus,
) => {
  return status === "pending";
};

export const upsertApprovalLifecycleMessage = async ({
  currentMessage,
  currentMessagePromise,
  recoverMessage,
  payload,
  sendMessage,
}: {
  currentMessage?: ApprovalLifecycleMessage;
  currentMessagePromise?: Promise<ApprovalLifecycleMessage | undefined>;
  recoverMessage: () => Promise<ApprovalLifecycleMessage | undefined>;
  payload: DiscordChannelMessagePayload;
  sendMessage: (payload: DiscordChannelMessagePayload) => Promise<ApprovalLifecycleMessage | undefined>;
}) => {
  const message = currentMessage ?? await currentMessagePromise ?? await recoverMessage();

  if (message) {
    if (message.content === payload.content && payload.components === undefined) {
      return message;
    }

    return message.edit(payload);
  }

  return sendMessage(payload);
};

export const canReuseApprovalLifecycleMessage = ({
  requestId,
  content,
  editable,
  author,
  botUserId,
}: StatusCardCandidate & {
  requestId: string;
  botUserId?: string;
}) => {
  return (
    content.startsWith(`Approval \`${requestId}\`:`)
    && editable
    && author?.bot === true
    && (botUserId === undefined || author.id === botUserId)
  );
};

export const recoverApprovalLifecycleMessageFromHistory = async <
  T extends StatusCardCandidate,
>({
  requestId,
  fetchPage,
  botUserId,
  pageSize = 50,
  maxPages = 5,
}: {
  requestId: string;
  fetchPage: (options: { limit: number; before?: string }) => Promise<T[]>;
  botUserId?: string;
  pageSize?: number;
  maxPages?: number;
}) => {
  let before: string | undefined;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const messages = await fetchPage({
      limit: pageSize,
      before,
    });
    const recovered = messages.find((message) =>
      canReuseApprovalLifecycleMessage({
        ...message,
        requestId,
        botUserId,
      }));

    if (recovered) {
      return recovered;
    }

    if (messages.length === 0) {
      return undefined;
    }

    before = messages.at(-1)?.id;

    if (!before || messages.length < pageSize) {
      return undefined;
    }
  }

  return undefined;
};

export const finalizeApprovalLifecycleMessageState = async ({
  state,
  operation,
}: {
  state: ApprovalLifecycleState;
  operation: Promise<ApprovalLifecycleMessage | undefined>;
}) => {
  state.pendingMessage = operation;

  try {
    const message = await operation;

    if (message) {
      state.message = message;
    }

    return message;
  } finally {
    if (state.pendingMessage === operation) {
      state.pendingMessage = undefined;
    }
  }
};

const toRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
};

const readString = (value: unknown, key: string) => {
  const record = toRecord(value);
  const candidate = record[key];

  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
};

const readNestedString = (value: unknown, keys: string[]) => {
  let cursor: unknown = value;

  for (const key of keys) {
    cursor = toRecord(cursor)[key];
  }

  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
};

const coerceActiveFlags = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [] as Array<"waitingOnApproval" | "waitingOnUserInput">;
  }

  return value.filter(
    (entry): entry is "waitingOnApproval" | "waitingOnUserInput" =>
      entry === "waitingOnApproval" || entry === "waitingOnUserInput",
  );
};

const coerceCodexThreadStatus = (value: unknown): CodexThreadStatus | undefined => {
  if (typeof value === "string") {
    if (value === "idle") {
      return { type: "idle" };
    }

    if (value === "notLoaded") {
      return { type: "notLoaded" };
    }

    if (value === "systemError") {
      return { type: "systemError" };
    }

    if (value === "waitingOnApproval") {
      return { type: "active", activeFlags: ["waitingOnApproval"] };
    }

    if (value === "active" || value === "running") {
      return { type: "active", activeFlags: [] };
    }

    return undefined;
  }

  const type = readString(value, "type");

  if (!type) {
    return undefined;
  }

  if (type === "active") {
    return {
      type: "active",
      activeFlags: coerceActiveFlags(toRecord(value).activeFlags),
    };
  }

  if (type === "idle" || type === "notLoaded" || type === "systemError") {
    return { type };
  }

  return undefined;
};

export const inferSessionStateFromThreadStatus = (
  status: CodexThreadStatus,
): SessionRuntimeState => {
  if (status.type === "systemError") {
    return "degraded";
  }

  if (status.type === "active") {
    return status.activeFlags.includes("waitingOnApproval")
      ? "waiting-approval"
      : "running";
  }

  return "idle";
};

export const describeCodexThreadStatus = (status: CodexThreadStatus) => {
  if (status.type !== "active") {
    return status.type;
  }

  if (status.activeFlags.length === 0) {
    return "active";
  }

  return `active(${status.activeFlags.join(", ")})`;
};

const readThreadIdFromEvent = (params: unknown) => {
  return readString(params, "threadId") ?? readNestedString(params, ["thread", "id"]);
};

const readTurnIdFromEvent = (params: unknown) => {
  return readString(params, "turnId") ?? readNestedString(params, ["turn", "id"]);
};

const readEventItem = (params: unknown) => {
  const candidate = toRecord(params).item;

  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as CodexTurnItem)
    : undefined;
};

const hasItemId = (item: CodexTurnItem | undefined): item is CodexTurnItem & {
  id: string;
} => {
  return !!item && typeof item.id === "string" && item.id.length > 0;
};

const isUserMessageItem = (item: CodexTurnItem | undefined): item is CodexUserMessageItem => {
  return hasItemId(item) && item.type === "userMessage";
};

const isAgentMessageItem = (item: CodexTurnItem | undefined): item is CodexAgentMessageItem => {
  return hasItemId(item) && item.type === "agentMessage" && typeof item.text === "string";
};

const isCommandExecutionItem = (
  item: CodexTurnItem | undefined,
): item is CodexCommandExecutionItem => {
  return hasItemId(item) && item.type === "commandExecution" && typeof item.command === "string";
};

const buildTranscriptRuntime = (): TranscriptRuntime => {
  return {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(),
    pendingDiscordInputs: [],
    trustedExternalTurnIds: new Set<string>(),
    closedTurnIds: new Set<string>(),
    typingActive: false,
    typingTimeout: undefined,
    turnProcessMessages: new Map(),
    itemTurnIds: new Map(),
    activeTurnId: undefined,
    statusMessage: undefined,
    statusActivity: undefined,
    statusCommand: undefined,
    attemptedStatusRecovery: false,
    pendingStatusUpdate: undefined,
  };
};

const readTurnIdFromTranscriptEntryId = (itemId: string) => {
  const separatorIndex = itemId.indexOf(":");

  if (separatorIndex < 0 || separatorIndex === itemId.length - 1) {
    return undefined;
  }

  return itemId.slice(separatorIndex + 1);
};

export const noteTrustedLiveExternalTurnStart = ({
  runtime,
  turnId,
}: {
  runtime: Pick<TranscriptRuntime, "pendingDiscordInputs" | "trustedExternalTurnIds">;
  turnId?: string;
}) => {
  if (!turnId || runtime.pendingDiscordInputs.length > 0) {
    return;
  }

  runtime.trustedExternalTurnIds.add(turnId);
};

export const markTranscriptItemsSeen = ({
  runtime,
  turns,
  source,
}: {
  runtime: Pick<TranscriptRuntime, "seenItemIds" | "finalizingItemIds">;
  turns: CodexTurn[] | undefined;
  source: "live" | "snapshot";
}) => {
  for (const itemId of collectTranscriptItemIds(turns)) {
    if (source === "snapshot" && shouldSkipTranscriptSnapshotItem(runtime, itemId)) {
      continue;
    }

    runtime.seenItemIds.add(itemId);
  }

  for (const itemId of collectComparableTranscriptItemIds(turns)) {
    runtime.seenItemIds.add(itemId);
  }
};

export const seedTranscriptRuntimeSeenItemsFromSnapshot = ({
  runtime,
  turns,
}: {
  runtime: Pick<TranscriptRuntime, "seenItemIds" | "finalizingItemIds">;
  turns: CodexTurn[] | undefined;
}) => {
  markTranscriptItemsSeen({
    runtime,
    turns,
    source: "snapshot",
  });
};

const relayTranscriptEntries = async ({
  client,
  channelId,
  runtime,
  turns,
  source,
  activeTurnId,
  activeTurnFooter,
}: {
  client: Client;
  channelId: string;
  runtime: TranscriptRuntime;
  turns: CodexTurn[] | undefined;
  source: "live" | "snapshot";
  activeTurnId?: string;
  activeTurnFooter?: ProcessFooterText;
}) => {
  const entries = collectTranscriptEntries(turns, {
    source,
    pendingDiscordInputs: runtime.pendingDiscordInputs,
    activeTurnId,
    activeTurnFooter,
  }).filter((entry) =>
    !shouldSkipTranscriptRelayEntry({
      runtime,
      itemId: entry.itemId,
      source,
    })
  );

  for (const renderedMessage of renderTranscriptMessages(entries)) {
    const rendered = renderedMessage.payload;
    if (!isDiscordMessagePayloadEmpty(rendered)) {
      await sendChannelMessage(client, channelId, rendered);
    }

    for (const itemId of renderedMessage.itemIds) {
      runtime.seenItemIds.add(itemId);
    }
  }

  markTranscriptItemsSeen({
    runtime,
    turns,
    source,
  });
};

const isSendableChannel = (value: unknown): value is SendableChannel => {
  return (
    !!value &&
    typeof value === "object" &&
    "send" in value &&
    typeof (value as { send?: unknown }).send === "function"
  );
};

const isStatusCardRecoverableChannel = (
  value: unknown,
): value is StatusCardRecoverableChannel => {
  return (
    !!value
    && typeof value === "object"
    && "messages" in value
    && typeof (value as { messages?: { fetch?: unknown } }).messages?.fetch === "function"
  );
};

const isArchiveableThreadChannel = (
  value: unknown,
): value is ArchiveableThreadChannel => {
  return (
    !!value
    && typeof value === "object"
    && "setArchived" in value
    && typeof (value as { setArchived?: unknown }).setArchived === "function"
  );
};

const buildApprovalCustomId = (requestId: string, action: ApprovalAction) => {
  return `${approvalButtonPrefix}|${encodeURIComponent(requestId)}|${action}`;
};

const parseApprovalCustomId = (customId: string) => {
  const [prefix, encodedRequestId, action] = customId.split("|");

  if (
    prefix !== approvalButtonPrefix ||
    !encodedRequestId ||
    (action !== "approve" && action !== "decline" && action !== "cancel")
  ) {
    return null;
  }

  return {
    requestId: decodeURIComponent(encodedRequestId),
    action,
  } as const;
};

const approvalDecision = (action: ApprovalAction): {
  providerDecision: "accept" | "decline" | "cancel";
  status: ApprovalStatus;
} => {
  if (action === "approve") {
    return {
      providerDecision: "accept",
      status: "approved",
    };
  }

  if (action === "decline") {
    return {
      providerDecision: "decline",
      status: "declined",
    };
  }

  return {
    providerDecision: "cancel",
    status: "canceled",
  };
};

export const describeSessionAccessMode = (
  session: Pick<SessionRecord, "state" | "lifecycleState">,
) => {
  return resolveSessionAccessMode({
    lifecycleState: session.lifecycleState,
    runtimeState: coercePersistedSessionRuntimeState(session.state),
  });
};

export const canAcceptManagedSessionThreadInput = (
  session: Pick<SessionRecord, "lifecycleState">,
) => {
  return session.lifecycleState === "active";
};

export const shouldProjectManagedSessionDiscordSurface = (
  session: Pick<SessionRecord, "lifecycleState">,
) => {
  return session.lifecycleState === "active";
};

export const handleManagedThreadDeletion = ({
  threadId,
  sessionRepo,
}: {
  threadId: string;
  sessionRepo: Pick<ReturnType<typeof createSessionRepo>, "getByDiscordThreadId" | "markDeleted">;
}) => {
  const session = sessionRepo.getByDiscordThreadId(threadId);

  if (!session) {
    return false;
  }

  sessionRepo.markDeleted(threadId);
  return true;
};

export const handleArchivedManagedSessionThreadMessage = async ({
  authorId,
  ownerId,
  content,
  codexThreadId,
  resumeSession,
  forwardMessage,
  rearchiveSession,
}: {
  authorId: string;
  ownerId: string;
  content: string;
  codexThreadId?: string;
  resumeSession: () => Promise<SessionResumeState>;
  forwardMessage: (input: CodexTurnInput) => Promise<void>;
  rearchiveSession: () => Promise<void>;
}) => {
  const decision = decideArchivedThreadResume({
    authorId,
    ownerId,
    content,
    sessionState: "idle",
    codexThreadId: codexThreadId ?? "implicit-resume",
  });

  if (decision.kind === "noop") {
    await rearchiveSession();
    return {
      kind: "ignored" as const,
      reason: decision.reason,
    };
  }

  try {
    const outcome = await resumeSession();

    if (outcome.kind === "untrusted") {
      await rearchiveSession();
      return {
        kind: "failed-closed" as const,
        reason: "resume-untrusted" as const,
      };
    }

    if (outcome.kind === "ready" && outcome.session.runtimeState === "idle") {
      await forwardMessage(decision.request.input);
      return {
        kind: "forwarded" as const,
        session: outcome.session,
      };
    }

    return {
      kind: outcome.kind,
      session: outcome.session,
    };
  } catch (error) {
    await rearchiveSession();
    throw error;
  }
};

export const applyManagedTurnCompletion = async ({
  session,
  markIdle,
  updateStatusCard,
  syncTranscriptSnapshot,
}: {
  session: Pick<SessionRecord, "lifecycleState">;
  markIdle: () => void;
  updateStatusCard: () => Promise<void>;
  syncTranscriptSnapshot: () => Promise<void>;
}) => {
  markIdle();

  if (!shouldProjectManagedSessionDiscordSurface(session)) {
    return;
  }

  await updateStatusCard();
  await syncTranscriptSnapshot();
};

const formatManagedSessionThreadReference = (
  session: Pick<SessionRecord, "discordThreadId" | "lifecycleState">,
) => {
  if (session.lifecycleState === "deleted") {
    return `deleted (\`${session.discordThreadId}\`)`;
  }

  return `<#${session.discordThreadId}>`;
};

export const formatManagedSessionList = (
  sessions: Array<
    Pick<
      SessionRecord,
      "discordThreadId"
      | "codexThreadId"
      | "workdirId"
      | "lifecycleState"
      | "state"
    >
  >,
) => {
  if (sessions.length === 0) {
    return "No managed sessions found.";
  }

  return sessions
    .map((session) =>
      [
        `- Discord ${formatManagedSessionThreadReference(session)}`,
        `Codex \`${session.codexThreadId}\``,
        `workdir \`${session.workdirId}\``,
        `lifecycle \`${session.lifecycleState}\``,
        `runtime \`${session.state}\``,
        `access \`${describeSessionAccessMode(session)}\``,
      ].join(" | "),
    )
    .join("\n");
};

export const resolveCloseSessionCommand = ({
  actorId,
  session,
}: {
  actorId: string;
  session:
    | Pick<SessionRecord, "discordThreadId" | "ownerDiscordUserId">
    | null;
}): DiscordCommandResult => {
  if (!session) {
    return {
      reply: {
        content: "Use this command in a managed session thread.",
        ephemeral: true,
      },
    };
  }

  if (session.ownerDiscordUserId !== actorId) {
    return {
      reply: {
        content: "Only the session owner can close this session.",
        ephemeral: true,
      },
    };
  }

  return {
    reply: {
      content:
        `Close is wired for <#${session.discordThreadId}> ` +
        "but archive behavior is not implemented yet.",
      ephemeral: true,
    },
  };
};

export const resolveSyncSessionCommand = ({
  actorId,
  session,
}: {
  actorId: string;
  session:
    | Pick<
        SessionRecord,
        "codexThreadId"
        | "discordThreadId"
        | "ownerDiscordUserId"
        | "lifecycleState"
        | "state"
      >
    | null;
}): DiscordCommandResult => {
  if (!session) {
    return {
      reply: {
        content: "Use this command in a managed session thread.",
        ephemeral: true,
      },
    };
  }

  if (session.ownerDiscordUserId !== actorId) {
    return {
      reply: {
        content: "Only the session owner can sync this session.",
        ephemeral: true,
      },
    };
  }

  if (session.lifecycleState === "deleted") {
    return {
      reply: {
        content: `Session \`${session.codexThreadId}\` no longer has a syncable Discord thread.`,
        ephemeral: true,
      },
    };
  }

  if (session.lifecycleState !== "active") {
    return {
      reply: {
        content:
          `Session \`${session.codexThreadId}\` is currently \`${session.lifecycleState}\`, ` +
          "not `active`.",
        ephemeral: true,
      },
    };
  }

  if (coercePersistedSessionRuntimeState(session.state) !== "degraded") {
    return {
      reply: {
        content:
          `Session \`${session.codexThreadId}\` is currently \`${session.state}\`, ` +
          "not `degraded`.",
        ephemeral: true,
      },
    };
  }

  return {
    reply: {
      content:
        `Sync is wired for \`${session.codexThreadId}\` ` +
        `(${formatManagedSessionThreadReference(session)}) ` +
        "but manual re-sync behavior is not implemented yet.",
      ephemeral: true,
    },
  };
};

export const closeManagedSession = async ({
  archiveThread,
  unarchiveThread,
  persistLifecycleState,
}: {
  archiveThread: () => Promise<void>;
  unarchiveThread: () => Promise<void>;
  persistLifecycleState: (
    lifecycleState: Extract<SessionLifecycleState, "archived">,
  ) => Promise<void> | void;
}) => {
  await archiveThread();

  try {
    await persistLifecycleState("archived");
  } catch (error) {
    try {
      await unarchiveThread();
    } catch (rollbackError) {
      logger.warn(
        "Failed to restore Discord thread after close lifecycle persistence failed",
        rollbackError,
      );
    }

    throw error;
  }

  return {
    lifecycleState: "archived" as const,
  };
};

export const reconcileResumedApprovalState = async ({
  runtimeState,
  pendingApprovals,
  latestApproval,
  upsertApprovalMessage,
  ensureOwnerControls,
}: {
  runtimeState: SessionRuntimeState;
  pendingApprovals: Array<Pick<ApprovalRecord, "requestId" | "status">>;
  latestApproval?: Pick<ApprovalRecord, "requestId" | "status"> | null;
  upsertApprovalMessage: (
    requestId: string,
    status: Extract<ApprovalStatus, "pending">,
  ) => Promise<void> | void;
  ensureOwnerControls?: (
    requestId: string,
    status: Extract<ApprovalStatus, "pending">,
  ) => Promise<void> | void;
}) => {
  if (runtimeState !== "waiting-approval") {
    return undefined;
  }

  const pendingApproval = pendingApprovals.find((approval) => approval.status === "pending");

  if (!pendingApproval) {
    if (latestApproval && latestApproval.status !== "pending") {
      return undefined;
    }

    throw new Error(
      "waiting-approval session has no pending approval to reconcile",
    );
  }

  await upsertApprovalMessage(pendingApproval.requestId, "pending");
  await ensureOwnerControls?.(pendingApproval.requestId, "pending");
  return pendingApproval.requestId;
};

export const reconcileApprovalResolutionSurface = async ({
  requestId,
  status,
  session,
  currentThreadMessage,
  currentThreadMessagePromise,
  recoverThreadMessage,
  sendThreadMessage,
  dmMessage,
}: {
  requestId: string;
  status: ApprovalStatus;
  session?: Pick<SessionRecord, "lifecycleState"> | null;
  currentThreadMessage?: ApprovalLifecycleMessage;
  currentThreadMessagePromise?: Promise<ApprovalLifecycleMessage | undefined>;
  recoverThreadMessage: () => Promise<ApprovalLifecycleMessage | undefined>;
  sendThreadMessage: (payload: DiscordChannelMessagePayload) => Promise<ApprovalLifecycleMessage | undefined>;
  dmMessage?: ApprovalButtonMessage;
}) => {
  if (dmMessage) {
    await dmMessage.edit({
      content: `Approval resolved: \`${status}\`.`,
      components: [],
    });
  }

  return upsertApprovalLifecycleMessage({
    currentMessage: currentThreadMessage,
    currentMessagePromise: currentThreadMessagePromise,
    recoverMessage: recoverThreadMessage,
    payload: renderApprovalLifecyclePayload({
      requestId,
      status,
    }),
    sendMessage:
      session && shouldProjectManagedSessionDiscordSurface(session)
        ? sendThreadMessage
        : async () => undefined,
  });
};

export const resumeManagedSession = async ({
  session,
  readThread,
  archiveThread,
  persistRuntimeState,
  reconcileApprovalState,
  unarchiveThread,
  persistLifecycleState,
  syncReadOnlySurface,
  updateStatusCard,
  syncTranscriptSnapshot,
}: {
  session: Pick<SessionRecord, "state" | "lifecycleState" | "degradationReason">;
  readThread: () => Promise<ThreadReadResult>;
  archiveThread: () => Promise<void>;
  persistRuntimeState: (
    runtimeState: SessionPersistedRuntimeState,
  ) => Promise<void> | void;
  reconcileApprovalState?: (
    outcome: Exclude<SessionResumeState, { kind: "untrusted" }>,
  ) => Promise<void> | void;
  unarchiveThread: () => Promise<void>;
  persistLifecycleState: (
    lifecycleState: Extract<SessionLifecycleState, "active">,
  ) => Promise<void> | void;
  syncReadOnlySurface?: (
    outcome: Extract<SessionResumeState, { kind: "read-only" }>,
  ) => Promise<void>;
  updateStatusCard: (
    runtimeState: Extract<SessionPersistedRuntimeState, "idle" | "running" | "waiting-approval">,
  ) => Promise<void>;
  syncTranscriptSnapshot: (readResult: ThreadReadResult) => Promise<void>;
}): Promise<SessionResumeState> => {
  const readResult = await readThread();
  const syncedRuntimeState = inferSyncedSessionRuntimeState(readResult.thread);
  const outcome = resolveResumeSessionState({
    lifecycleState: session.lifecycleState,
    persistedRuntimeState: coercePersistedSessionRuntimeState(session.state),
    degradationReason: session.degradationReason,
    syncedRuntimeState,
  });

  if (outcome.kind === "untrusted") {
    return outcome;
  }

  await reconcileApprovalState?.(outcome);
  await persistRuntimeState(outcome.persistedRuntimeState);
  if (outcome.kind === "read-only") {
    await syncReadOnlySurface?.(outcome);
  } else if (outcome.statusCardState) {
    await updateStatusCard(outcome.statusCardState);
  }

  await syncTranscriptSnapshot(readResult);
  await unarchiveThread();
  try {
    await persistLifecycleState("active");
  } catch (error) {
    try {
      await archiveThread();
    } catch (rollbackError) {
      logger.warn(
        "Failed to restore Discord thread after resume lifecycle persistence failed",
        rollbackError,
      );
    }

    throw error;
  }

  return outcome;
};

export const syncManagedSession = async ({
  session,
  readThread,
  detectReadOnlyReason,
  persistSessionState,
  syncReadOnlySurface,
  updateStatusCard,
  syncTranscriptSnapshot,
}: {
  session: Pick<SessionRecord, "state" | "lifecycleState" | "degradationReason">;
  readThread: () => Promise<ThreadReadResult>;
  detectReadOnlyReason?: (
    readResult: ThreadReadResult,
  ) => Promise<string | null> | string | null;
  persistSessionState: (
    runtimeState: SessionPersistedRuntimeState,
    degradationReason: string | null,
  ) => Promise<void> | void;
  syncReadOnlySurface?: (
    outcome: Extract<SessionResumeState, { kind: "read-only" | "error" }>,
  ) => Promise<void>;
  updateStatusCard: (
    runtimeState: Extract<SessionPersistedRuntimeState, "idle" | "running" | "waiting-approval">,
  ) => Promise<void>;
  syncTranscriptSnapshot: (readResult: ThreadReadResult) => Promise<void>;
}): Promise<SessionResumeState> => {
  const readResult = await readThread();
  const syncedRuntimeState = inferSyncedSessionRuntimeState(readResult.thread);
  let outcome = resolveSyncSessionState({
    syncedRuntimeState,
  });

  if (outcome.kind === "untrusted") {
    return outcome;
  }

  const canReconcileWritableState = outcome.kind === "ready" || outcome.kind === "busy";

  if (canReconcileWritableState) {
    await syncTranscriptSnapshot(readResult);
  }

  const detectedReadOnlyReason = canReconcileWritableState
    ? await detectReadOnlyReason?.(readResult) ?? null
    : null;

  if (detectedReadOnlyReason) {
    outcome = {
      kind: "read-only",
      session: {
        lifecycleState: "active",
        runtimeState: outcome.session.runtimeState,
        accessMode: "read-only",
      },
      persistedRuntimeState: "degraded",
      statusCardState: undefined,
    };
  }

  await persistSessionState(
    outcome.persistedRuntimeState,
    outcome.kind === "read-only" ? detectedReadOnlyReason : null,
  );

  if (outcome.kind === "read-only" || outcome.kind === "error") {
    await syncReadOnlySurface?.(outcome);
  } else if (outcome.statusCardState) {
    await updateStatusCard(outcome.statusCardState);
  }

  if (!canReconcileWritableState) {
    await syncTranscriptSnapshot(readResult);
  }

  return outcome;
};

const ensureWorkspaceSeeded = (
  db: Database,
  config: AppConfig,
) => {
  const workspaceRepo = createWorkspaceRepo(db);
  const workdirRepo = createWorkdirRepo(db);

  if (!workspaceRepo.getById(config.workspace.id)) {
    workspaceRepo.insert({
      id: config.workspace.id,
      name: config.workspace.name,
      rootPath: config.workspace.rootPath,
    });
  }

  for (const workdir of config.workdirs) {
    if (!workdirRepo.getById(workdir.id)) {
      workdirRepo.insert({
        id: workdir.id,
        workspaceId: config.workspace.id,
        label: workdir.label,
        absolutePath: workdir.absolutePath,
      });
    }
  }
};

const requireConfiguredControlChannel = (
  config: AppConfig,
  guildId: string,
  channelId: string,
): DiscordCommandResult | null => {
  if (guildId !== config.discord.guildId) {
    return {
      reply: {
        content: `This daemon is bound to guild \`${config.discord.guildId}\`.`,
        ephemeral: true,
      },
    };
  }

  if (channelId !== config.discord.controlChannelId) {
    return {
      reply: {
        content: `Use this command in <#${config.discord.controlChannelId}>.`,
        ephemeral: true,
      },
    };
  }

  return null;
};

const requireConfiguredGuild = (
  config: AppConfig,
  guildId: string,
): DiscordCommandResult | null => {
  if (guildId !== config.discord.guildId) {
    return {
      reply: {
        content: `This daemon is bound to guild \`${config.discord.guildId}\`.`,
        ephemeral: true,
      },
    };
  }

  return null;
};

const findConfiguredWorkdir = (config: AppConfig, workdirId: string) => {
  return config.workdirs.find((workdir) => workdir.id === workdirId);
};

export const filterConfiguredWorkdirs = (
  workdirs: AppConfig["workdirs"],
  query: string,
) => {
  const normalizedQuery = query.trim().toLowerCase();

  return workdirs
    .filter((workdir) => {
      if (!normalizedQuery) {
        return true;
      }

      return (
        workdir.id.toLowerCase().includes(normalizedQuery)
        || workdir.label.toLowerCase().includes(normalizedQuery)
        || workdir.absolutePath.toLowerCase().includes(normalizedQuery)
      );
    })
    .slice(0, 25)
    .map((workdir) => ({
      name: `${workdir.label} (${workdir.id})`,
      value: workdir.id,
    }));
};

export const sortResumePickerThreads = (threads: CodexThread[]) => {
  return [...threads].sort((left, right) => {
    const leftUpdatedAt = left.updatedAt ?? Number.NEGATIVE_INFINITY;
    const rightUpdatedAt = right.updatedAt ?? Number.NEGATIVE_INFINITY;

    if (leftUpdatedAt !== rightUpdatedAt) {
      return rightUpdatedAt - leftUpdatedAt;
    }

    const leftCreatedAt = left.createdAt ?? Number.NEGATIVE_INFINITY;
    const rightCreatedAt = right.createdAt ?? Number.NEGATIVE_INFINITY;

    if (leftCreatedAt !== rightCreatedAt) {
      return rightCreatedAt - leftCreatedAt;
    }

    return left.id.localeCompare(right.id);
  });
};

const formatResumeThreadTitle = (thread: CodexThread) => {
  const preview = thread.preview.trim();
  const name = typeof thread.name === "string" ? thread.name.trim() : "";

  return preview || name || thread.id;
};

const formatResumeThreadIdSuffix = (threadId: string) => {
  const shortIdLength = 9;

  if (threadId.length <= shortIdLength) {
    return threadId;
  }

  return `…${threadId.slice(-shortIdLength)}`;
};

export const formatResumeSessionAutocompleteChoice = (thread: CodexThread) => {
  const statusText = describeCodexThreadStatus(thread.status);
  const threadIdSuffix = formatResumeThreadIdSuffix(thread.id);
  const maxNameLength = 100;
  const separator = " · ";
  const titlePrefix = `${statusText}${separator}`;
  const titleSuffix = `${separator}${threadIdSuffix}`;
  const maxTitleLength = maxNameLength - titlePrefix.length - titleSuffix.length;
  const title = formatResumeThreadTitle(thread);
  const safeTitle =
    maxTitleLength <= 0
      ? ""
      : title.length <= maxTitleLength
        ? title
        : maxTitleLength === 1
          ? "…"
          : `${title.slice(0, maxTitleLength - 1)}…`;

  return {
    name: safeTitle.length > 0
      ? `${titlePrefix}${safeTitle}${titleSuffix}`
      : `${statusText}${titleSuffix}`,
    value: thread.id,
  };
};

export const resolveResumeAttachmentKind = ({
  existingSession,
  discordThreadUsable,
}: {
  existingSession: { lifecycleState: SessionLifecycleState } | null;
  discordThreadUsable: boolean;
}) => {
  if (!existingSession) {
    return "create";
  }

  if (!discordThreadUsable || existingSession.lifecycleState === "deleted") {
    return "rebind";
  }

  if (existingSession.lifecycleState === "archived") {
    return "reopen";
  }

  return "reuse";
};

export const buildResumeSessionAutocompleteChoices = async ({
  codexClient,
  query,
  workdir,
}: {
  codexClient: Pick<JsonRpcClient, "listThreads">;
  query: string;
  workdir?: WorkdirConfig;
}) => {
  if (!workdir) {
    return [];
  }

  const searchTerm = query.trim() || null;
  const threads: CodexThread[] = [];
  let cursor: string | null = null;

  do {
    const result = await codexClient.listThreads({
      cwd: workdir.absolutePath,
      searchTerm,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });

    threads.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor);

  return sortResumePickerThreads(threads)
    .slice(0, 25)
    .map(formatResumeSessionAutocompleteChoice);
};

const attachedSessionErrorSurfaceText =
  "CodeHelm attached this thread as an error surface. Review the latest Codex state before sending more input.";

const describeAttachedSessionResult = (result: SessionResumeState) => {
  switch (result.kind) {
    case "ready":
      return "Session is writable.";
    case "busy":
      return `Session remains \`${result.session.runtimeState}\`.`;
    case "read-only":
      return "Session remains read-only.";
    case "error":
      return "Session remains read-only because Codex reports an error state.";
    case "untrusted":
      return null;
  }
};

type BoundSessionThread = {
  id: string;
  send(payload: DiscordChannelMessagePayload): Promise<unknown>;
  delete(reason?: string): Promise<unknown>;
};

type CreateControlChannelServicesDeps = {
  config: AppConfig;
  codexClient: Pick<JsonRpcClient, "listThreads" | "startThread">;
  sessionRepo: Pick<
    ReturnType<typeof createSessionRepo>,
    | "getByDiscordThreadId"
    | "getByCodexThreadId"
    | "insert"
    | "markDeleted"
    | "rebindDiscordThread"
    | "updateLifecycleState"
  >;
  getDiscordClient: () => Client;
  createVisibleSessionThread: (input: {
    client: Client;
    controlChannelId: string;
    title: string;
    starterText: string;
  }) => Promise<BoundSessionThread>;
  ensureTranscriptRuntime: (codexThreadId: string) => void;
  updateStatusCard: (input: {
    discord: Client;
    session: NonNullable<ReturnType<CreateControlChannelServicesDeps["sessionRepo"]["getByCodexThreadId"]>>;
    state: SessionRuntimeState;
  }) => Promise<void>;
  closeManagedSession: (
    session: NonNullable<ReturnType<CreateControlChannelServicesDeps["sessionRepo"]["getByDiscordThreadId"]>>,
  ) => Promise<void>;
  syncManagedSessionIntoDiscordThread: (
    session: NonNullable<ReturnType<CreateControlChannelServicesDeps["sessionRepo"]["getByCodexThreadId"]>>,
  ) => Promise<SessionResumeState>;
  resumeManagedSessionIntoDiscordThread: (
    session: NonNullable<ReturnType<CreateControlChannelServicesDeps["sessionRepo"]["getByCodexThreadId"]>>,
  ) => Promise<SessionResumeState>;
  sendTextToChannel: (
    client: Client,
    channelId: string,
    payload: string | DiscordChannelMessagePayload,
  ) => Promise<unknown>;
  isManagedDiscordThreadUsable: (input: {
    client: Client;
    threadId: string;
  }) => Promise<boolean>;
  readThreadForSnapshotReconciliation: (input: {
    threadId: string;
  }) => Promise<ThreadReadResult>;
};

const createAttachedSessionThread = async ({
  client,
  controlChannelId,
  createVisibleSessionThread,
  workdir,
  codexThreadId,
  title,
  starterText,
  onBound,
  onRollback,
}: {
  client: Client;
  controlChannelId: string;
  createVisibleSessionThread: CreateControlChannelServicesDeps["createVisibleSessionThread"];
  workdir: WorkdirConfig;
  codexThreadId: string;
  title: string;
  starterText: string;
  onBound: (thread: BoundSessionThread) => Promise<void>;
  onRollback?: (thread: BoundSessionThread) => Promise<void>;
}) => {
  let thread: BoundSessionThread | undefined;

  try {
    thread = await createVisibleSessionThread({
      client,
      controlChannelId,
      title,
      starterText,
    });
    await onBound(thread);
    await thread.send({
      ...renderSessionStartedPayload({
        type: "session.started",
        params: {
          workdirLabel: workdir.label,
          codexThreadId,
        },
      }),
    });

    return thread;
  } catch (error) {
    if (thread) {
      try {
        await thread.delete("CodeHelm failed to bind the attached session");
      } catch (deleteError) {
        logger.warn("Failed to clean up orphan Discord thread after session attachment", deleteError);
      }

      if (onRollback) {
        try {
          await onRollback(thread);
        } catch (rollbackError) {
          logger.warn("Failed to roll back session attachment binding", rollbackError);
        }
      }
    }

    throw error;
  }
};

export const createControlChannelServices = ({
  config,
  codexClient,
  sessionRepo,
  getDiscordClient,
  createVisibleSessionThread,
  ensureTranscriptRuntime,
  updateStatusCard,
  closeManagedSession,
  syncManagedSessionIntoDiscordThread,
  resumeManagedSessionIntoDiscordThread,
  sendTextToChannel,
  isManagedDiscordThreadUsable,
  readThreadForSnapshotReconciliation,
}: CreateControlChannelServicesDeps): DiscordCommandServices => {
  return {
    async createSession({ actorId, guildId, channelId, workdirId }) {
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return contextError;
      }

      const workdir = findConfiguredWorkdir(config, workdirId);

      if (!workdir) {
        return {
          reply: {
            content: `Unknown workdir \`${workdirId}\`.`,
            ephemeral: true,
          },
        };
      }

      const started = await codexClient.startThread({
        cwd: workdir.absolutePath,
      });
      const codexThreadId = started.thread.id;
      const discord = getDiscordClient();
      let thread: BoundSessionThread | undefined;
      const rollbackBinding = async (boundThread: BoundSessionThread) => {
        sessionRepo.markDeleted(boundThread.id);
      };

      try {
        thread = await createAttachedSessionThread({
          client: discord,
          controlChannelId: config.discord.controlChannelId,
          createVisibleSessionThread,
          workdir,
          codexThreadId,
          title: `${workdir.label}-session`,
          starterText: `Opening session for \`${workdir.label}\`.`,
          onBound: async (boundThread) => {
            sessionRepo.insert({
              discordThreadId: boundThread.id,
              codexThreadId,
              ownerDiscordUserId: actorId,
              workdirId: workdir.id,
              state: "idle",
            });
            ensureTranscriptRuntime(codexThreadId);
          },
          onRollback: rollbackBinding,
        });
        const session = sessionRepo.getByDiscordThreadId(thread.id);

        if (!session) {
          throw new Error(`Managed session ${codexThreadId} disappeared after creation`);
        }

        await updateStatusCard({
          discord,
          session,
          state: "idle",
        });
      } catch (error) {
        if (thread) {
          try {
            await thread.delete("CodeHelm failed to bind the new session");
          } catch (deleteError) {
            logger.warn("Failed to clean up orphan Discord thread after session creation", deleteError);
          }

          try {
            await rollbackBinding(thread);
          } catch (rollbackError) {
            logger.warn("Failed to roll back session creation binding", rollbackError);
          }
        }

        throw error;
      }

      return {
        reply: {
          content: `Created session <#${thread.id}> for \`${workdir.label}\`.`,
        },
      };
    },
    async closeSession({ actorId, guildId, channelId }) {
      const guildError = requireConfiguredGuild(config, guildId);

      if (guildError) {
        return guildError;
      }

      const session = sessionRepo.getByDiscordThreadId(channelId);

      if (!session) {
        return resolveCloseSessionCommand({
          actorId,
          session: null,
        });
      }

      if (!canControlSession({
        viewerId: actorId,
        ownerId: session.ownerDiscordUserId,
      })) {
        return resolveCloseSessionCommand({
          actorId,
          session,
        });
      }

      await closeManagedSession(session);

      return {
        reply: {
          content: `Archived session <#${session.discordThreadId}>.`,
        },
      };
    },
    async syncSession({ actorId, guildId, channelId }) {
      const guildError = requireConfiguredGuild(config, guildId);

      if (guildError) {
        return guildError;
      }

      const session = sessionRepo.getByDiscordThreadId(channelId);
      const validation = resolveSyncSessionCommand({
        actorId,
        session,
      });

      if (
        !session
        || !canControlSession({
          viewerId: actorId,
          ownerId: session.ownerDiscordUserId,
        })
        || session.lifecycleState !== "active"
        || coercePersistedSessionRuntimeState(session.state) !== "degraded"
      ) {
        return validation;
      }

      let result: SessionResumeState;

      try {
        result = await syncManagedSessionIntoDiscordThread(session);
      } catch (error) {
        return {
          reply: {
            content:
              error instanceof Error
                ? `Sync failed for \`${session.codexThreadId}\`: ${error.message}.`
                : `Sync failed for \`${session.codexThreadId}\`.`,
            ephemeral: true,
          },
        };
      }

      if (result.kind === "untrusted") {
        return {
          reply: {
            content:
              `Sync aborted for \`${session.codexThreadId}\` because CodeHelm could not ` +
              "establish a trustworthy synced session view.",
            ephemeral: true,
          },
        };
      }

      const summary =
        result.kind === "ready"
          ? "Session is writable."
          : result.kind === "busy"
            ? `Session is now \`${result.session.runtimeState}\`.`
            : result.kind === "error"
              ? "Session remains read-only because Codex reports an error state."
              : "Session remains read-only.";

      return {
        reply: {
          content: `Synced session <#${session.discordThreadId}>. ${summary}`,
        },
      };
    },
    async autocompleteResumeWorkdirs({ guildId, channelId, query }) {
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return [];
      }

      return filterConfiguredWorkdirs(config.workdirs, query);
    },
    async autocompleteResumeSessions({
      guildId,
      channelId,
      workdirId,
      query,
    }) {
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return [];
      }

      const workdir = workdirId
        ? findConfiguredWorkdir(config, workdirId)
        : undefined;

      return buildResumeSessionAutocompleteChoices({
        codexClient,
        query,
        workdir,
      });
    },
    async resumeSession({ actorId, guildId, channelId, workdirId, codexThreadId }) {
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return contextError;
      }

      const workdir = findConfiguredWorkdir(config, workdirId);

      if (!workdir) {
        return {
          reply: {
            content: `Unknown workdir \`${workdirId}\`.`,
            ephemeral: true,
          },
        };
      }

      try {
        const snapshot = await readThreadForSnapshotReconciliation({
          threadId: codexThreadId,
        });

        if (snapshot.thread.cwd !== workdir.absolutePath) {
          return {
            reply: {
              content:
                `Session \`${codexThreadId}\` belongs to \`${snapshot.thread.cwd}\`, ` +
                `not workdir \`${workdir.id}\`.`,
              ephemeral: true,
            },
          };
        }

        const discord = getDiscordClient();
        const existingSession = sessionRepo.getByCodexThreadId(codexThreadId);

        if (
          existingSession
          && !canControlSession({
            viewerId: actorId,
            ownerId: existingSession.ownerDiscordUserId,
          })
        ) {
          return {
            reply: {
              content: "Only the session owner can attach this session.",
              ephemeral: true,
            },
          };
        }

        const discordThreadUsable = existingSession
          ? await isManagedDiscordThreadUsable({
              client: discord,
              threadId: existingSession.discordThreadId,
            })
          : true;
        const attachmentKind = resolveResumeAttachmentKind({
          existingSession,
          discordThreadUsable,
        });
        let attachedSession = existingSession;
        let rollbackAttach:
          | (() => Promise<void>)
          | undefined;

        if (attachmentKind === "create") {
          const rollbackBinding = async (thread: BoundSessionThread) => {
            sessionRepo.markDeleted(thread.id);
          };
          const thread = await createAttachedSessionThread({
            client: discord,
            controlChannelId: config.discord.controlChannelId,
            createVisibleSessionThread,
            workdir,
            codexThreadId,
            title: `${workdir.label}-session`,
            starterText: `Attaching Codex session \`${codexThreadId}\` for \`${workdir.label}\`.`,
            onBound: async (boundThread) => {
              sessionRepo.insert({
                discordThreadId: boundThread.id,
                codexThreadId,
                ownerDiscordUserId: actorId,
                workdirId: workdir.id,
                state: inferSessionStateFromThreadStatus(snapshot.thread.status),
              });
              ensureTranscriptRuntime(codexThreadId);
            },
            onRollback: rollbackBinding,
          });
          attachedSession = sessionRepo.getByDiscordThreadId(thread.id);
          rollbackAttach = async () => {
            await thread.delete("CodeHelm rolled back an untrusted session attach");
            await rollbackBinding(thread);
          };
        } else if (attachmentKind === "rebind") {
          const previousThreadId = existingSession?.discordThreadId;
          const previousLifecycleState = existingSession?.lifecycleState;

          if (!previousThreadId) {
            throw new Error(`Managed session ${codexThreadId} is missing a Discord thread binding`);
          }

          const rollbackBinding = async (thread: BoundSessionThread) => {
            sessionRepo.rebindDiscordThread({
              currentDiscordThreadId: thread.id,
              nextDiscordThreadId: previousThreadId,
            });

            if (previousLifecycleState) {
              sessionRepo.updateLifecycleState(previousThreadId, previousLifecycleState);
            }
          };
          const thread = await createAttachedSessionThread({
            client: discord,
            controlChannelId: config.discord.controlChannelId,
            createVisibleSessionThread,
            workdir,
            codexThreadId,
            title: `${workdir.label}-session`,
            starterText: `Attaching Codex session \`${codexThreadId}\` for \`${workdir.label}\`.`,
            onBound: async (boundThread) => {
              sessionRepo.rebindDiscordThread({
                currentDiscordThreadId: previousThreadId,
                nextDiscordThreadId: boundThread.id,
              });
              sessionRepo.updateLifecycleState(boundThread.id, "active");
            },
            onRollback: rollbackBinding,
          });
          attachedSession = sessionRepo.getByDiscordThreadId(thread.id);
          rollbackAttach = async () => {
            await thread.delete("CodeHelm rolled back an untrusted replacement attach");
            await rollbackBinding(thread);
          };
        }

        if (!attachedSession) {
          throw new Error(`Managed session ${codexThreadId} disappeared during attach`);
        }

        const shouldResumeIntoDiscordThread =
          attachmentKind === "reopen"
          || inferSyncedSessionRuntimeState(snapshot.thread) === "waiting-approval";
        const result =
          shouldResumeIntoDiscordThread
            ? await resumeManagedSessionIntoDiscordThread(attachedSession)
            : await syncManagedSessionIntoDiscordThread(attachedSession);

        if (result.kind === "untrusted") {
          const untrustedReply = {
            reply: {
              content:
                `Attach aborted for \`${codexThreadId}\` because CodeHelm could not ` +
                "establish a trustworthy synced session view.",
              ephemeral: true,
            },
          };

          if (rollbackAttach) {
            try {
              await rollbackAttach();
            } catch (rollbackError) {
              logger.warn(
                `Failed to roll back untrusted attach for ${codexThreadId}`,
                rollbackError,
              );
            }
          }

          return untrustedReply;
        }

        if (result.kind === "error") {
          await sendTextToChannel(
            discord,
            attachedSession.discordThreadId,
            attachedSessionErrorSurfaceText,
          );
        }

        const summary = describeAttachedSessionResult(result);

        if (!summary) {
          throw new Error(`Unhandled attach result for ${codexThreadId}`);
        }

        const threadPrefix =
          attachmentKind === "rebind"
            ? `Attached session in replacement thread <#${attachedSession.discordThreadId}>.`
            : `Attached session <#${attachedSession.discordThreadId}>.`;

        return {
          reply: {
            content: `${threadPrefix} ${summary}`,
          },
        };
      } catch (error) {
        return {
          reply: {
            content:
              error instanceof Error
                ? `Attach failed for \`${codexThreadId}\`: ${error.message}.`
                : `Attach failed for \`${codexThreadId}\`.`,
            ephemeral: true,
          },
        };
      }
    },
  };
};

const registerGuildCommands = async (
  config: AppConfig,
  commands: RESTPostAPIChatInputApplicationCommandsJSONBody[],
) => {
  const rest = new REST({
    version: "10",
    ...buildDiscordRestOptions(),
  }).setToken(config.discord.botToken);

  await rest.put(
    Routes.applicationGuildCommands(
      config.discord.appId,
      config.discord.guildId,
    ),
    {
      body: commands,
    },
  );
};

const requireDiscordClient = (client: Client | undefined) => {
  if (!client) {
    throw new Error("Discord client is not ready");
  }

  return client;
};

const createVisibleSessionThread = async ({
  client,
  controlChannelId,
  title,
  starterText,
}: {
  client: Client;
  controlChannelId: string;
  title: string;
  starterText: string;
}) => {
  const controlChannel = await client.channels.fetch(controlChannelId);

  if (!isSendableChannel(controlChannel)) {
    throw new Error("Configured control channel does not support sending messages");
  }

  const starter = await controlChannel.send({ content: starterText });

  if (!("startThread" in starter) || typeof starter.startThread !== "function") {
    throw new Error("Configured control channel does not support public threads");
  }

  return (starter as ThreadStarterMessage).startThread({
    name: title,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: starterText,
  });
};

const sendTextToChannel = async (
  client: Client,
  channelId: string,
  payload: string | DiscordChannelMessagePayload,
) => {
  return sendChannelMessage(
    client,
    channelId,
    typeof payload === "string" ? { content: payload } : payload,
  );
};

const sendChannelMessage = async (
  client: Client,
  channelId: string,
  payload: DiscordChannelMessagePayload,
) => {
  const channel = await client.channels.fetch(channelId);

  if (!isSendableChannel(channel)) {
    return undefined;
  }

  return channel.send(payload);
};

const setThreadArchivedState = async ({
  client,
  threadId,
  archived,
  reason,
}: {
  client: Client;
  threadId: string;
  archived: boolean;
  reason: string;
}) => {
  const channel = await client.channels.fetch(threadId);

  if (!isArchiveableThreadChannel(channel)) {
    throw new Error(`Managed session thread ${threadId} is not archivable`);
  }

  await channel.setArchived(archived, reason);
};

const isManagedDiscordThreadUsable = async ({
  client,
  threadId,
}: {
  client: Client;
  threadId: string;
}) => {
  try {
    const channel = await client.channels.fetch(threadId);

    return isSendableChannel(channel) && isArchiveableThreadChannel(channel);
  } catch {
    return false;
  }
};

const recoverStatusCardMessage = async (
  client: Client,
  channelId: string,
) => {
  const channel = await client.channels.fetch(channelId);

  if (!isStatusCardRecoverableChannel(channel)) {
    return undefined;
  }

  return recoverStatusCardMessageFromHistory({
    botUserId: client.user?.id,
    fetchPage: async (options) => {
      const fetched = await channel.messages.fetch(options);
      const messages = fetched instanceof Map ? [...fetched.values()] : [...fetched];

      return messages.map((message) => ({
        id: message.id,
        content: message.content,
        editable: message.editable,
        author: {
          bot: message.author?.bot,
          id: message.author?.id,
        },
        edit: message.edit.bind(message),
      }));
    },
  });
};

const recoverApprovalLifecycleMessage = async (
  client: Client,
  channelId: string,
  requestId: string,
) => {
  const channel = await client.channels.fetch(channelId);

  if (!isStatusCardRecoverableChannel(channel)) {
    return undefined;
  }

  return recoverApprovalLifecycleMessageFromHistory({
    requestId,
    botUserId: client.user?.id,
    fetchPage: async (options) => {
      const fetched = await channel.messages.fetch(options);
      const messages = fetched instanceof Map ? [...fetched.values()] : [...fetched];

      return messages.map((message) => ({
        id: message.id,
        content: message.content,
        editable: message.editable,
        author: {
          bot: message.author?.bot,
          id: message.author?.id,
        },
        edit: message.edit.bind(message),
      }));
    },
  });
};

const buildApprovalComponents = (requestId: string) => {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildApprovalCustomId(requestId, "approve"))
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(buildApprovalCustomId(requestId, "decline"))
        .setLabel("Decline")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(buildApprovalCustomId(requestId, "cancel"))
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
};

const maybeSendApprovalDm = async ({
  client,
  requestId,
  ownerId,
  threadId,
}: {
  client: Client;
  requestId: string;
  ownerId: string;
  threadId: string;
}) => {
  const approval = {
    requestId: String(requestId),
    status: "pending" as const,
  };
  const ui = renderApprovalUi({
    approval,
    viewerId: ownerId,
    ownerId,
  });

  if (ui.kind !== "controls") {
    return undefined;
  }

  const owner = await client.users.fetch(ownerId);

  return owner.send({
    content: `Approval pending for session <#${threadId}>.\nRequest: \`${approval.requestId}\`.`,
    components: buildApprovalComponents(approval.requestId),
  });
};

export const handleApprovalInteraction = async ({
  interaction,
  client,
  sessionRepo,
  approvalRepo,
  inFlightRequestIds,
}: {
  interaction: ButtonInteraction;
  client: JsonRpcClient;
  sessionRepo: ReturnType<typeof createSessionRepo>;
  approvalRepo: ReturnType<typeof createApprovalRepo>;
  inFlightRequestIds?: Set<string>;
}) => {
  const parsed = parseApprovalCustomId(interaction.customId);

  if (!parsed) {
    return false;
  }

  const approvalRecord = approvalRepo.getByRequestId(parsed.requestId);

  if (!approvalRecord) {
    await interaction.reply({
      content: "That approval is no longer available.",
      ephemeral: true,
    });
    return true;
  }

  const session = sessionRepo.getByDiscordThreadId(approvalRecord.discordThreadId);

  if (!session || session.ownerDiscordUserId !== interaction.user.id) {
    await interaction.reply({
      content: "Only the session owner can resolve this approval.",
      ephemeral: true,
    });
    return true;
  }

  if (session.state === "degraded") {
    await interaction.reply({
      content: "This session is read-only because it was modified outside the supported flow.",
      ephemeral: true,
    });
    return true;
  }

  if (!shouldAcceptApprovalInteraction(approvalRecord.status)) {
    await interaction.reply({
      content: "That approval is no longer pending.",
      ephemeral: true,
    });
    return true;
  }

  const nextDecision = approvalDecision(parsed.action);
  const requestId = String(parsed.requestId);

  if (inFlightRequestIds?.has(requestId)) {
    await interaction.reply({
      content: "That approval is already being resolved.",
      ephemeral: true,
    });
    return true;
  }

  inFlightRequestIds?.add(requestId);

  try {
    await interaction.deferUpdate();
    await client.replyToServerRequest({
      requestId: parsed.requestId,
      decision: nextDecision.providerDecision,
    });
    approvalRepo.insert({
      requestId: parsed.requestId,
      discordThreadId: approvalRecord.discordThreadId,
      status: nextDecision.status,
      resolvedByDiscordUserId: interaction.user.id,
      resolution: nextDecision.status,
    });
  } finally {
    inFlightRequestIds?.delete(requestId);
  }

  return true;
};

export const startCodeHelm = async (
  env: Record<string, string | undefined> = Bun.env,
) => {
  const config = parseConfig(env);
  const db = createDatabaseClient(config.databasePath);

  applyMigrations(db);
  ensureWorkspaceSeeded(db, config);

  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);
  const codexClient = new JsonRpcClient(config.codex.appServerUrl);
  const approvalDmMessages = new Map<string, ApprovalButtonMessage>();
  const approvalThreadMessages = new Map<string, ApprovalLifecycleState>();
  const approvalResolutionsInFlight = new Set<string>();
  const transcriptRuntimes = new Map<string, TranscriptRuntime>();
  let discordClient: Client | undefined;
  let shuttingDown = false;

  const ensureTranscriptRuntime = (codexThreadId: string) => {
    const existing = transcriptRuntimes.get(codexThreadId);

    if (existing) {
      return existing;
    }

    const runtime = buildTranscriptRuntime();
    transcriptRuntimes.set(codexThreadId, runtime);
    return runtime;
  };

  const stopDiscordTypingPulse = (runtime: TranscriptRuntime) => {
    runtime.typingActive = false;

    if (runtime.typingTimeout) {
      clearTimeout(runtime.typingTimeout);
      runtime.typingTimeout = undefined;
    }
  };

  const sendTypingToChannel = async (client: Client, channelId: string) => {
    const channel = await client.channels.fetch(channelId);

    if (
      channel
      && typeof channel === "object"
      && "sendTyping" in channel
      && typeof channel.sendTyping === "function"
    ) {
      await channel.sendTyping();
    }
  };

  const ensureDiscordTypingPulse = ({
    client,
    channelId,
    runtime,
  }: {
    client: Client;
    channelId: string;
    runtime: TranscriptRuntime;
  }) => {
    if (runtime.typingActive) {
      return;
    }

    runtime.typingActive = true;

    const pulse = async () => {
      if (!runtime.typingActive || shuttingDown) {
        return;
      }

      try {
        await sendTypingToChannel(client, channelId);
      } catch {}

      if (!runtime.typingActive || shuttingDown) {
        return;
      }

      runtime.typingTimeout = setTimeout(() => {
        void pulse();
      }, discordTypingPulseIntervalMs);
    };

    void pulse();
  };

  const updateSessionStateIfWritable = (
    session: ReturnType<typeof sessionRepo.getByCodexThreadId>,
    nextState: SessionRuntimeState,
  ) => {
    if (!session || session.state === "degraded") {
      return;
    }

    sessionRepo.updateState(session.discordThreadId, nextState);
  };

  const renderSessionStatusCard = ({
    state,
    runtime,
  }: {
    state: SessionRuntimeState;
    runtime: TranscriptRuntime;
  }) => {
    return renderStatusCardText({
      state: state === "waiting-approval" ? "waiting-approval" : state === "idle" ? "idle" : "running",
      activity: runtime.statusActivity,
      command: runtime.statusCommand,
    });
  };

  const updateStatusCard = async ({
    discord,
    session,
    state,
    activity,
    command,
  }: {
    discord: Client;
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    state?: SessionRuntimeState;
    activity?: string | null;
    command?: string | null;
  }) => {
    const runtime = ensureTranscriptRuntime(session.codexThreadId);

    if (!shouldProjectManagedSessionDiscordSurface(session)) {
      stopDiscordTypingPulse(runtime);
      return;
    }

    const currentSessionState = coerceSessionRuntimeState(session.state);
    const nextState = state ?? currentSessionState;

    if (currentSessionState === "degraded" || nextState === "degraded") {
      stopDiscordTypingPulse(runtime);
      return;
    }

    if (activity !== undefined) {
      runtime.statusActivity = activity ?? undefined;
    }

    if (command !== undefined) {
      runtime.statusCommand = command ?? undefined;
    }

    if (nextState !== "running") {
      runtime.statusActivity = undefined;
      runtime.statusCommand = undefined;
    }

    if (shouldShowDiscordTypingIndicator(nextState)) {
      ensureDiscordTypingPulse({
        client: discord,
        channelId: session.discordThreadId,
        runtime,
      });
    } else {
      stopDiscordTypingPulse(runtime);
    }

    const content = renderSessionStatusCard({
      state: nextState,
      runtime,
    });

    await applyStatusCardUpdate({
      runtime,
      content,
      recoverMessage: async () =>
        recoverStatusCardMessage(
          discord,
          session.discordThreadId,
        ),
      sendMessage: async (nextContent) =>
        sendTextToChannel(discord, session.discordThreadId, nextContent),
    });
  };

  const degradeSessionToReadOnly = async ({
    discord,
    session,
    reason,
  }: {
    discord: Client;
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    reason: string;
  }) => {
    stopDiscordTypingPulse(ensureTranscriptRuntime(session.codexThreadId));

    if (session.state === "degraded") {
      return;
    }

    sessionRepo.markExternallyModified(session.discordThreadId, reason);
    await sendTextToChannel(
      discord,
      session.discordThreadId,
      renderDegradationActionText({
        type: "session.degraded",
        params: { reason },
      }),
    );
    await sendTextToChannel(
      discord,
      session.discordThreadId,
      renderDegradationBannerPayload({
        type: "session.degraded",
        params: { reason },
      }),
    );
  };

  const syncTranscriptSnapshotFromReadResult = async ({
    discord,
    session,
    snapshot,
    degradeOnUnexpectedItems,
  }: {
    discord: Client;
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    snapshot: ThreadReadResult;
    degradeOnUnexpectedItems: boolean;
  }) => {
    const runtime = ensureTranscriptRuntime(session.codexThreadId);
    const turns = snapshot.thread.turns;

    if (
      shouldHoldSnapshotTranscriptForManualSync({
        runtime,
        turns,
        degradeOnUnexpectedItems,
      })
      && shouldDegradeDiscordToReadOnly({ controlSurface: "codex-remote" })
    ) {
      await degradeSessionToReadOnly({
        discord,
        session,
        reason: "snapshot_mismatch",
      });
      return;
    }

    const activeRuntimeState = inferSessionStateFromThreadStatus(snapshot.thread.status);
    const activeTurnId =
      activeRuntimeState === "running" || activeRuntimeState === "waiting-approval"
        ? snapshot.thread.turns?.at(-1)?.id
        : undefined;

    await relayTranscriptEntries({
      client: discord,
      channelId: session.discordThreadId,
      runtime,
      turns,
      source: "snapshot",
      activeTurnId,
      activeTurnFooter: activeTurnId
        ? getFooterForSessionState(activeRuntimeState)
        : undefined,
    });
  };

  const syncTranscriptSnapshot = async ({
    discord,
    session,
    degradeOnUnexpectedItems,
  }: {
    discord: Client;
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    degradeOnUnexpectedItems: boolean;
  }) => {
    const snapshot = await readThreadForSnapshotReconciliation({
      codexClient,
      threadId: session.codexThreadId,
    });
    await syncTranscriptSnapshotFromReadResult({
      discord,
      session,
      snapshot,
      degradeOnUnexpectedItems,
    });
  };

  const seedTranscriptRuntimeFromSnapshot = async (session: {
    codexThreadId: string;
  }) => {
    const runtime = ensureTranscriptRuntime(session.codexThreadId);
    const snapshot = await readThreadForSnapshotReconciliation({
      codexClient,
      threadId: session.codexThreadId,
    });
    seedTranscriptRuntimeSeenItemsFromSnapshot({
      runtime,
      turns: snapshot.thread.turns,
    });
  };

  const startTurnFromDiscordInput = async ({
    session,
    content,
    request,
  }: {
    session: Pick<SessionRecord, "codexThreadId" | "state" | "discordThreadId">;
    content: string;
    request: Omit<StartTurnParams, "input"> & {
      input: CodexTurnInput;
    };
  }) => {
    const runtime = ensureTranscriptRuntime(session.codexThreadId);

    runtime.pendingDiscordInputs.push(content);

    try {
      await startTurnWithThreadResumeRetry({
        request,
        startTurn: async (params) => codexClient.startTurn(params),
        resumeThread: async ({ threadId }) => codexClient.resumeThread({
          threadId,
        }),
      });
      const refreshedSession = sessionRepo.getByCodexThreadId(session.codexThreadId);

      if (refreshedSession) {
        updateSessionStateIfWritable(refreshedSession, "running");
      } else {
        sessionRepo.updateState(session.discordThreadId, "running");
      }
    } catch (error) {
      if (runtime.pendingDiscordInputs.at(-1) === content) {
        runtime.pendingDiscordInputs.pop();
      }
      throw error;
    }
  };

  const resumeManagedSessionIntoDiscordThread = async (
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>,
  ) => {
    const discord = requireDiscordClient(discordClient);

    return resumeManagedSession({
      session,
      readThread: async () =>
        readThreadForSnapshotReconciliation({
          codexClient,
          threadId: session.codexThreadId,
        }),
      archiveThread: async () =>
        setThreadArchivedState({
          client: discord,
          threadId: session.discordThreadId,
          archived: true,
          reason: "CodeHelm restored the managed session after resume persistence failed",
        }),
      persistRuntimeState: async (runtimeState) => {
        sessionRepo.updateState(session.discordThreadId, runtimeState);
      },
      reconcileApprovalState: async (outcome) => {
        await reconcileResumedApprovalState({
          runtimeState: outcome.session.runtimeState,
          pendingApprovals: approvalRepo.listPendingByDiscordThreadId(
            session.discordThreadId,
          ),
          latestApproval: approvalRepo.getLatestByDiscordThreadId(
            session.discordThreadId,
          ),
          upsertApprovalMessage: async (requestId) => {
            const lifecycleState = approvalThreadMessages.get(requestId) ?? {};
            const pendingMessagePromise = upsertApprovalLifecycleMessage({
              currentMessage: lifecycleState.message,
              currentMessagePromise: lifecycleState.pendingMessage,
              recoverMessage: async () =>
                recoverApprovalLifecycleMessage(
                  discord,
                  session.discordThreadId,
                  requestId,
                ),
              payload: renderApprovalLifecyclePayload({
                requestId,
                status: "pending",
              }),
              sendMessage: async (payload) =>
                sendTextToChannel(
                  discord,
                  session.discordThreadId,
                  payload,
                ),
            });
            approvalThreadMessages.set(requestId, lifecycleState);
            const threadMessage = await finalizeApprovalLifecycleMessageState({
              state: lifecycleState,
              operation: pendingMessagePromise,
            });

            if (threadMessage) {
              lifecycleState.message = threadMessage;
            }
          },
          ensureOwnerControls: async (requestId) => {
            if (approvalDmMessages.has(requestId)) {
              return;
            }

            try {
              const dmMessage = await maybeSendApprovalDm({
                client: bot.client,
                requestId,
                ownerId: session.ownerDiscordUserId,
                threadId: session.discordThreadId,
              });

              if (dmMessage) {
                approvalDmMessages.set(requestId, dmMessage);
              }
            } catch (error) {
              logger.warn(
                `Could not DM approval controls to ${session.ownerDiscordUserId}; local codex resume --remote remains the fallback path.`,
                error,
              );
            }
          },
        });
      },
      unarchiveThread: async () =>
        setThreadArchivedState({
          client: discord,
          threadId: session.discordThreadId,
          archived: false,
          reason: "CodeHelm resumed the managed session",
        }),
      persistLifecycleState: async (lifecycleState) => {
        sessionRepo.updateLifecycleState(session.discordThreadId, lifecycleState);
      },
      syncReadOnlySurface: async () => {
        await sendTextToChannel(
          discord,
          session.discordThreadId,
          renderDegradationActionText({
            type: "session.degraded",
            params: {
              reason: session.degradationReason,
            },
          }),
        );
        await sendTextToChannel(
          discord,
          session.discordThreadId,
          renderDegradationBannerPayload({
            type: "session.degraded",
            params: {
              reason: session.degradationReason,
            },
          }),
        );
      },
      updateStatusCard: async (runtimeState) => {
        const refreshedSession = sessionRepo.getByCodexThreadId(session.codexThreadId);

        if (!refreshedSession) {
          throw new Error(`Managed session ${session.codexThreadId} disappeared during resume`);
        }

        await updateStatusCard({
          discord,
          session: refreshedSession,
          state: runtimeState,
        });
      },
      syncTranscriptSnapshot: async (snapshot) => {
        const refreshedSession = sessionRepo.getByCodexThreadId(session.codexThreadId);

        if (!refreshedSession) {
          throw new Error(`Managed session ${session.codexThreadId} disappeared during resume`);
        }

        await syncTranscriptSnapshotFromReadResult({
          discord,
          session: refreshedSession,
          snapshot,
          degradeOnUnexpectedItems: false,
        });
      },
    });
  };

  const syncManagedSessionIntoDiscordThread = async (
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>,
  ) => {
    const discord = requireDiscordClient(discordClient);

    return syncManagedSession({
      session,
      readThread: async () =>
        readThreadForSnapshotReconciliation({
          codexClient,
          threadId: session.codexThreadId,
        }),
      detectReadOnlyReason: async (snapshot) => {
        const runtime = ensureTranscriptRuntime(session.codexThreadId);

        return shouldDegradeForSnapshotMismatch({
            runtime,
            turns: snapshot.thread.turns,
          }) && shouldDegradeDiscordToReadOnly({ controlSurface: "codex-remote" })
          ? "snapshot_mismatch"
          : null;
      },
      persistSessionState: async (runtimeState, degradationReason) => {
        sessionRepo.syncState(
          session.discordThreadId,
          runtimeState,
          degradationReason,
        );
      },
      syncReadOnlySurface: async (outcome) => {
        const refreshedSession = sessionRepo.getByCodexThreadId(session.codexThreadId);
        const reason = refreshedSession?.degradationReason ?? session.degradationReason;

        if (outcome.kind === "error") {
          await sendTextToChannel(
            discord,
            session.discordThreadId,
            "Session synced, but Codex reports an error state. Discord remains read-only.",
          );
          return;
        }

        await sendTextToChannel(
          discord,
          session.discordThreadId,
          renderDegradationActionText({
            type: "session.degraded",
            params: {
              reason,
            },
          }),
        );
        await sendTextToChannel(
          discord,
          session.discordThreadId,
          renderDegradationBannerPayload({
            type: "session.degraded",
            params: {
              reason,
            },
          }),
        );
      },
      updateStatusCard: async (runtimeState) => {
        const refreshedSession = sessionRepo.getByCodexThreadId(session.codexThreadId);

        if (!refreshedSession) {
          throw new Error(`Managed session ${session.codexThreadId} disappeared during sync`);
        }

        await updateStatusCard({
          discord,
          session: refreshedSession,
          state: runtimeState,
        });
      },
      syncTranscriptSnapshot: async (snapshot) => {
        const refreshedSession = sessionRepo.getByCodexThreadId(session.codexThreadId);

        if (!refreshedSession) {
          throw new Error(`Managed session ${session.codexThreadId} disappeared during sync`);
        }

        await syncTranscriptSnapshotFromReadResult({
          discord,
          session: refreshedSession,
          snapshot,
          degradeOnUnexpectedItems: false,
        });
      },
    });
  };

  const services = createControlChannelServices({
    config,
    codexClient,
    sessionRepo,
    getDiscordClient: () => requireDiscordClient(discordClient),
    createVisibleSessionThread,
    ensureTranscriptRuntime,
    updateStatusCard,
    closeManagedSession: async (session) => {
      const discord = requireDiscordClient(discordClient);

      await closeManagedSession({
        archiveThread: async () =>
          setThreadArchivedState({
            client: discord,
            threadId: session.discordThreadId,
            archived: true,
            reason: "CodeHelm closed the managed session",
          }),
        unarchiveThread: async () =>
          setThreadArchivedState({
            client: discord,
            threadId: session.discordThreadId,
            archived: false,
            reason: "CodeHelm restored the managed session after close persistence failed",
          }),
        persistLifecycleState: async (lifecycleState) => {
          sessionRepo.updateLifecycleState(session.discordThreadId, lifecycleState);
        },
      });
    },
    syncManagedSessionIntoDiscordThread,
    resumeManagedSessionIntoDiscordThread,
    sendTextToChannel,
    isManagedDiscordThreadUsable,
    readThreadForSnapshotReconciliation: ({ threadId }) =>
      readThreadForSnapshotReconciliation({
        codexClient,
        threadId,
      }),
  });

  const bot = createDiscordBot({
    token: config.discord.botToken,
    services,
    logger,
  });
  discordClient = bot.client;

  const syncTurnProcessMessage = async ({
    discord,
    session,
    turnId,
    deleteIfEmpty,
  }: {
    discord: Client;
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    turnId: string;
    deleteIfEmpty?: boolean;
  }) => {
    if (session.state === "degraded" || !shouldProjectManagedSessionDiscordSurface(session)) {
      return;
    }

    const runtime = ensureTranscriptRuntime(session.codexThreadId);

    if (shouldSkipStaleLiveTurnProcessUpdate({
      activeTurnId: runtime.activeTurnId,
      closedTurnIds: runtime.closedTurnIds,
      turnId,
      deleteIfEmpty,
    })) {
      return;
    }

    const current = runtime.turnProcessMessages.get(turnId);

    if (!current) {
      return;
    }

    const rendered = renderLiveTurnProcessMessage({
      turnId,
      steps: current.steps,
      liveCommentaryText: current.liveCommentaryText,
      footer: current.footer,
    });
    const processEntryId = getProcessTranscriptEntryId(turnId);

    runtime.finalizingItemIds.add(processEntryId);

    try {
      if (isDiscordMessagePayloadEmpty(rendered)) {
        if (deleteIfEmpty) {
          await finalizeLiveTurnProcessMessage({
            currentMessage: current.message,
            currentMessagePromise: current.pendingCreate,
            rendered,
            sendRendered: async (payload) => {
              await sendChannelMessage(discord, session.discordThreadId, payload);
            },
          });
        }
        return;
      }

      const payload = rendered;

      if (!payload) {
        return;
      }

      const message = await upsertStreamingTranscriptMessage({
        state: current,
        payload,
        sendMessage: async (payload) =>
          sendChannelMessage(discord, session.discordThreadId, payload),
      });

      if (message) {
        current.message = message;
      }
      runtime.seenItemIds.add(processEntryId);
    } finally {
      runtime.finalizingItemIds.delete(processEntryId);
    }
  };

  const finalizeTurnProcessState = async ({
    discord,
    session,
    turnId,
  }: {
    discord: Client;
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    turnId: string;
  }) => {
    const runtime = ensureTranscriptRuntime(session.codexThreadId);
    const current = runtime.turnProcessMessages.get(turnId);

    if (!current) {
      return;
    }

    current.footer = undefined;
    current.liveCommentaryItemId = undefined;
    current.liveCommentaryText = undefined;
    await syncTurnProcessMessage({
      discord,
      session,
      turnId,
      deleteIfEmpty: true,
    });
    runtime.turnProcessMessages.delete(turnId);
  };

  const publishAgentDelta = async ({
    discord,
    session,
    turnId,
    itemId,
    delta,
  }: {
    discord: Client;
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    turnId?: string;
    itemId: string;
    delta: string;
  }) => {
    if (session.state === "degraded" || !shouldProjectManagedSessionDiscordSurface(session)) {
      return;
    }

    const runtime = ensureTranscriptRuntime(session.codexThreadId);
    const resolvedTurnId = turnId ?? runtime.itemTurnIds.get(itemId);

    if (!resolvedTurnId) {
      return;
    }

    if (shouldSkipStaleLiveTurnProcessUpdate({
      activeTurnId: runtime.activeTurnId,
      closedTurnIds: runtime.closedTurnIds,
      turnId: resolvedTurnId,
    })) {
      return;
    }

    const current = runtime.turnProcessMessages.get(resolvedTurnId);

    if (!current || current.liveCommentaryItemId !== itemId) {
      return;
    }

    current.liveCommentaryText = `${current.liveCommentaryText ?? ""}${delta}`;
    await updateStatusCard({
      discord,
      session,
      state: "running",
      activity: summarizeStatusActivity(current.liveCommentaryText),
    });
    await syncTurnProcessMessage({
      discord,
      session,
      turnId: resolvedTurnId,
    });
  };

  const finalizeAgentTranscriptMessage = async ({
    discord,
    session,
    turnId,
    item,
  }: {
    discord: Client;
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    turnId?: string;
    item: CodexAgentMessageItem;
  }) => {
    const runtime = ensureTranscriptRuntime(session.codexThreadId);
    const resolvedTurnId = turnId ?? runtime.itemTurnIds.get(item.id);

    if (!shouldProjectManagedSessionDiscordSurface(session)) {
      runtime.itemTurnIds.delete(item.id);
      return;
    }

    if (item.phase === "commentary") {
      runtime.seenItemIds.add(item.id);
      runtime.itemTurnIds.delete(item.id);

      if (!resolvedTurnId) {
        return;
      }

      if (shouldSkipStaleLiveTurnProcessUpdate({
        activeTurnId: runtime.activeTurnId,
        closedTurnIds: runtime.closedTurnIds,
        turnId: resolvedTurnId,
      })) {
        return;
      }

      const current = ensureTurnProcessMessageState(runtime, resolvedTurnId);

      if (current.liveCommentaryItemId === item.id) {
        current.liveCommentaryItemId = undefined;
        current.liveCommentaryText = undefined;
      }

      return;
    }

    const rendered = renderTranscriptEntry({
      itemId: resolvedTurnId
        ? getAssistantTranscriptEntryId(resolvedTurnId)
        : item.id,
      kind: "assistant",
      text: item.text,
    });

    const assistantEntryId = resolvedTurnId
      ? getAssistantTranscriptEntryId(resolvedTurnId)
      : item.id;

    runtime.finalizingItemIds.add(assistantEntryId);

    try {
      await sendChannelMessage(discord, session.discordThreadId, rendered);
      runtime.seenItemIds.add(assistantEntryId);
    } finally {
      runtime.finalizingItemIds.delete(assistantEntryId);
      runtime.itemTurnIds.delete(item.id);
    }
  };

  bot.client.on(Events.MessageCreate, (message) => {
    void (async () => {
      if (message.author.bot) {
        return;
      }

      const session = sessionRepo.getByDiscordThreadId(message.channelId);

      if (!session) {
        return;
      }

      if (session.lifecycleState === "archived") {
        const discord = requireDiscordClient(discordClient);
        const outcome = await handleArchivedManagedSessionThreadMessage({
          authorId: message.author.id,
          ownerId: session.ownerDiscordUserId,
          content: message.content,
          codexThreadId: session.codexThreadId,
          resumeSession: async () => resumeManagedSessionIntoDiscordThread(session),
          forwardMessage: async (input) =>
            startTurnFromDiscordInput({
              session,
              content: message.content,
              request: {
                threadId: session.codexThreadId,
                input,
              },
            }),
          rearchiveSession: async () => {
            await closeManagedSession({
              archiveThread: async () =>
                setThreadArchivedState({
                  client: discord,
                  threadId: session.discordThreadId,
                  archived: true,
                  reason: "CodeHelm kept the managed session archived",
                }),
              unarchiveThread: async () =>
                setThreadArchivedState({
                  client: discord,
                  threadId: session.discordThreadId,
                  archived: false,
                  reason: "CodeHelm restored the managed session after archive rollback",
                }),
              persistLifecycleState: async (lifecycleState) => {
                sessionRepo.updateLifecycleState(
                  session.discordThreadId,
                  lifecycleState,
                );
              },
            });
          },
        });

        if (outcome.kind === "ready") {
          await message.reply(
            "Session resumed. Review the latest Codex state before sending more input.",
          );
        } else if (outcome.kind === "busy") {
          await message.reply(
            outcome.session.runtimeState === "waiting-approval"
              ? "Session is waiting for approval."
              : "Session is already running.",
          );
        } else if (outcome.kind === "read-only") {
          await sendTextToChannel(
            bot.client,
            message.channelId,
            renderDegradationActionText({
              type: "session.degraded",
              params: {
                reason: session.degradationReason,
              },
            }),
          );
          await sendTextToChannel(
            bot.client,
            message.channelId,
            renderDegradationBannerPayload({
              type: "session.degraded",
              params: {
                reason: session.degradationReason,
              },
            }),
          );
        } else if (outcome.kind === "error") {
          await message.reply(
            "Session resumed as an error surface. Review the latest Codex state before sending more input.",
          );
        }

        return;
      }

      if (!canAcceptManagedSessionThreadInput(session)) {
        return;
      }

      const sessionState =
        session.state === "running"
          || session.state === "waiting-approval"
          || session.state === "degraded"
          ? (session.state as SessionRuntimeState)
          : "idle";
      const decision = decideThreadTurn({
        authorId: message.author.id,
        ownerId: session.ownerDiscordUserId,
        content: message.content,
        sessionState,
        codexThreadId: session.codexThreadId,
      });

      if (decision.kind === "noop") {
        if (decision.reason === "session-busy") {
          await message.reply("Session is already running.");
        }
        return;
      }

      if (decision.kind === "read-only") {
        await sendTextToChannel(
          bot.client,
          message.channelId,
          renderDegradationActionText({
            type: "session.degraded",
            params: {
              reason: session.degradationReason,
            },
          }),
        );
        await sendTextToChannel(
          bot.client,
          message.channelId,
          renderDegradationBannerPayload({
            type: "session.degraded",
            params: {
              reason: session.degradationReason,
            },
          }),
        );
        return;
      }

      await startTurnFromDiscordInput({
        session,
        content: message.content,
        request: decision.request,
      });
    })().catch(async (error) => {
      const session = sessionRepo.getByDiscordThreadId(message.channelId);

      if (session && isMissingCodexThreadError(error)) {
        logger.warn(
          `Managed Discord thread ${session.discordThreadId} points at missing Codex thread ${session.codexThreadId}; degrading to read-only.`,
          error,
        );
        await degradeSessionToReadOnly({
          discord: bot.client,
          session,
          reason: "thread_missing",
        });
        return;
      }

      logger.error("Failed to handle Discord thread message", error);
    });
  });

  bot.client.on(Events.ThreadDelete, (thread) => {
    void (async () => {
      handleManagedThreadDeletion({
        threadId: thread.id,
        sessionRepo,
      });
    })().catch((error) => {
      logger.error("Failed to detach deleted managed thread", error);
    });
  });

  bot.client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton()) {
      return;
    }

    void handleApprovalInteraction({
      interaction,
      client: codexClient,
      sessionRepo,
      approvalRepo,
      inFlightRequestIds: approvalResolutionsInFlight,
    }).catch((error) => {
      logger.error("Approval interaction failed", error);
    });
  });

  codexClient.on("turn/started", (params) => {
    void (async () => {
      const codexThreadId = readThreadIdFromEvent(params);
      const turnId = readTurnIdFromEvent(params);

      if (!codexThreadId) {
        return;
      }

      const session = sessionRepo.getByCodexThreadId(codexThreadId);

      if (!session) {
        return;
      }

      const runtime = ensureTranscriptRuntime(session.codexThreadId);
      runtime.activeTurnId = turnId ?? runtime.activeTurnId;

      if (turnId) {
        runtime.closedTurnIds.delete(turnId);
      }

      noteTrustedLiveExternalTurnStart({
        runtime,
        turnId,
      });

      updateSessionStateIfWritable(session, "running");
      await updateStatusCard({
        discord: bot.client,
        session,
        state: "running",
        activity: null,
        command: null,
      });
    })().catch((error) => {
      logger.error("Failed to process turn/started event", error);
    });
  });

  codexClient.on("thread/status/changed", (params) => {
    void (async () => {
      const codexThreadId = readThreadIdFromEvent(params);

      if (!codexThreadId) {
        return;
      }

      const session = sessionRepo.getByCodexThreadId(codexThreadId);

      if (!session) {
        return;
      }

      const status = coerceCodexThreadStatus(toRecord(params).status);

      if (status) {
        updateSessionStateIfWritable(
          session,
          inferSessionStateFromThreadStatus(status),
        );
      }

      const runtime = ensureTranscriptRuntime(session.codexThreadId);
      const activeTurnId = runtime.activeTurnId;

      if (status && activeTurnId) {
        const current = ensureTurnProcessMessageState(runtime, activeTurnId);
        current.footer = getFooterForSessionState(
          inferSessionStateFromThreadStatus(status),
        );
        const shouldSyncProcessMessage =
          current.footer === "Waiting for approval"
          || current.footer === undefined
          || current.steps.length > 0
          || !!current.liveCommentaryText
          || !!current.message
          || !!current.pendingCreate;

        if (shouldSyncProcessMessage) {
          await syncTurnProcessMessage({
            discord: bot.client,
            session,
            turnId: activeTurnId,
            deleteIfEmpty: current.footer === undefined,
          });
        }
      }

      await updateStatusCard({
        discord: bot.client,
        session,
        state: status
          ? inferSessionStateFromThreadStatus(status)
          : coerceSessionRuntimeState(session.state),
      });
    })().catch((error) => {
      logger.error("Failed to process thread/status/changed event", error);
    });
  });

  codexClient.on("item/started", (params) => {
    void (async () => {
      const codexThreadId = readThreadIdFromEvent(params);

      if (!codexThreadId) {
        return;
      }

      const session = sessionRepo.getByCodexThreadId(codexThreadId);

      if (!session) {
        return;
      }

      const item = readEventItem(params);
      const turnId = readTurnIdFromEvent(params);

      if (isAgentMessageItem(item)) {
        const runtime = ensureTranscriptRuntime(session.codexThreadId);

        if (turnId) {
          runtime.itemTurnIds.set(item.id, turnId);
        }

        if (!shouldProjectManagedSessionDiscordSurface(session)) {
          return;
        }

        if (item.phase === "commentary") {
          const resolvedTurnId = turnId ?? runtime.activeTurnId;

          if (!resolvedTurnId) {
            return;
          }

          if (shouldSkipStaleLiveTurnProcessUpdate({
            activeTurnId: runtime.activeTurnId,
            closedTurnIds: runtime.closedTurnIds,
            turnId: resolvedTurnId,
          })) {
            return;
          }

          const current = ensureTurnProcessMessageState(runtime, resolvedTurnId);
          if (current.steps.length > 0 || current.message || current.pendingCreate) {
            await syncTurnProcessMessage({
              discord: bot.client,
              session,
              turnId: resolvedTurnId,
            });
          }
        }
        return;
      }

      if (!isCommandExecutionItem(item)) {
        return;
      }

      if (!shouldProjectManagedSessionDiscordSurface(session)) {
        return;
      }

      if (turnId) {
        const runtime = ensureTranscriptRuntime(session.codexThreadId);

        if (shouldSkipStaleLiveTurnProcessUpdate({
          activeTurnId: runtime.activeTurnId,
          closedTurnIds: runtime.closedTurnIds,
          turnId,
        })) {
          return;
        }

        const current = ensureTurnProcessMessageState(runtime, turnId);
        current.footer ??= getFooterForSessionState(
          coerceSessionRuntimeState(session.state),
        );
        appendProcessStep(current.steps, buildCommandProcessStep(item.command));
        await syncTurnProcessMessage({
          discord: bot.client,
          session,
          turnId,
        });
      }

      await updateStatusCard({
        discord: bot.client,
        session,
        state: "running",
        activity: null,
        command: item.command,
      });
    })().catch((error) => {
      logger.error("Failed to process item/started event", error);
    });
  });

  codexClient.on("item/completed", (params) => {
    void (async () => {
      const codexThreadId = readThreadIdFromEvent(params);

      if (!codexThreadId) {
        return;
      }

      const session = sessionRepo.getByCodexThreadId(codexThreadId);

      if (!session) {
        return;
      }

      const item = readEventItem(params);
      const turnId = readTurnIdFromEvent(params);
      const runtime = ensureTranscriptRuntime(session.codexThreadId);

      if (!item) {
        return;
      }

      if (!shouldProjectManagedSessionDiscordSurface(session)) {
        if (isAgentMessageItem(item)) {
          runtime.itemTurnIds.delete(item.id);
        }
        return;
      }

      if (isAgentMessageItem(item)) {
        if (session.state === "degraded") {
          runtime.seenItemIds.add(item.id);
          runtime.itemTurnIds.delete(item.id);
          return;
        }

        await finalizeAgentTranscriptMessage({
          discord: bot.client,
          session,
          turnId,
          item,
        });
        return;
      }

      if (session.state === "degraded") {
        if (hasItemId(item)) {
          runtime.seenItemIds.add(item.id);
        }
        return;
      }

      if (isUserMessageItem(item)) {
        noteTrustedLiveExternalTurnStart({
          runtime,
          turnId,
        });
      }

      if (isCommandExecutionItem(item)) {
        await updateStatusCard({
          discord: bot.client,
          session,
          state: "running",
          activity: isFailedCommandExecutionItem(item) ? "command failed" : null,
          command: null,
        });
      }

      if (!shouldRelayLiveCompletedItemToTranscript(item)) {
        if (hasItemId(item)) {
          runtime.seenItemIds.add(item.id);
        }
        return;
      }

      const shouldTrackAsFinalizing =
        hasItemId(item) && shouldTrackLiveCompletedItemAsFinalizing(item);

      if (shouldTrackAsFinalizing) {
        runtime.finalizingItemIds.add(item.id);
      }

      try {
        await relayTranscriptEntries({
          client: bot.client,
          channelId: session.discordThreadId,
          runtime,
          turns: [
            {
              id: turnId ?? "live",
              items: [item],
            },
          ],
          source: "live",
        });
      } finally {
        if (shouldTrackAsFinalizing) {
          runtime.finalizingItemIds.delete(item.id);
        }
      }
    })().catch((error) => {
      logger.error("Failed to process item/completed event", error);
    });
  });

  codexClient.on("item/agentMessage/delta", (params) => {
    void (async () => {
      const codexThreadId = readThreadIdFromEvent(params);
      const turnId = readTurnIdFromEvent(params);
      const itemId = readString(params, "itemId");
      const delta = readString(params, "delta");

      if (!codexThreadId || !itemId || !delta) {
        return;
      }

      const session = sessionRepo.getByCodexThreadId(codexThreadId);

      if (!session) {
        return;
      }

      await publishAgentDelta({
        discord: bot.client,
        session,
        turnId,
        itemId,
        delta,
      });
    })().catch((error) => {
      logger.error("Failed to process item/agentMessage/delta event", error);
    });
  });

  codexClient.on("turn/completed", (params) => {
    void (async () => {
      const codexThreadId = readThreadIdFromEvent(params);
      const turnId = readTurnIdFromEvent(params);

      if (!codexThreadId) {
        return;
      }

      const session = sessionRepo.getByCodexThreadId(codexThreadId);

      if (!session) {
        return;
      }

      const runtime = ensureTranscriptRuntime(session.codexThreadId);

      if (turnId) {
        runtime.closedTurnIds.add(turnId);

        if (runtime.activeTurnId === turnId) {
          runtime.activeTurnId = undefined;
        }

        await finalizeTurnProcessState({
          discord: bot.client,
          session,
          turnId,
        });
      }

      await applyManagedTurnCompletion({
        session,
        markIdle: () => {
          updateSessionStateIfWritable(session, "idle");
        },
        updateStatusCard: async () => {
          await updateStatusCard({
            discord: bot.client,
            session,
            state: "idle",
          });
        },
        syncTranscriptSnapshot: async () => {
          await syncTranscriptSnapshot({
            discord: bot.client,
            session,
            degradeOnUnexpectedItems: false,
          });
        },
      });
    })().catch((error) => {
      logger.error("Failed to process turn/completed event", error);
    });
  });

  codexClient.on("item/commandExecution/requestApproval", (event) => {
    void (async () => {
      const session = sessionRepo.getByCodexThreadId(event.threadId);

      if (!session) {
        return;
      }

      if (session.state === "degraded") {
        if (shouldProjectManagedSessionDiscordSurface(session)) {
          await sendTextToChannel(
            bot.client,
            session.discordThreadId,
            `Approval pending for request \`${event.requestId}\`, but this session is already read-only in Discord.`,
          );
        }
        return;
      }

      updateSessionStateIfWritable(session, "waiting-approval");
      approvalRepo.insert({
        requestId: event.requestId,
        discordThreadId: session.discordThreadId,
        status: "pending",
      });
      if (!shouldProjectManagedSessionDiscordSurface(session)) {
        return;
      }

      const runtime = ensureTranscriptRuntime(session.codexThreadId);
      const approvalTurnId = event.turnId ?? runtime.activeTurnId;

      if (approvalTurnId) {
        runtime.activeTurnId = approvalTurnId;
        const current = ensureTurnProcessMessageState(runtime, approvalTurnId);
        current.footer = "Waiting for approval";
        await syncTurnProcessMessage({
          discord: bot.client,
          session,
          turnId: approvalTurnId,
        });
      }

      await updateStatusCard({
        discord: bot.client,
        session,
        state: "waiting-approval",
      });
      const requestId = String(event.requestId);
      const lifecycleState = approvalThreadMessages.get(requestId) ?? {};
      const pendingMessagePromise = upsertApprovalLifecycleMessage({
        currentMessage: lifecycleState.message,
        currentMessagePromise: lifecycleState.pendingMessage,
        recoverMessage: async () =>
          recoverApprovalLifecycleMessage(
            bot.client,
            session.discordThreadId,
            requestId,
          ),
        payload: renderApprovalLifecyclePayload({
          requestId,
          status: "pending",
        }),
        sendMessage: async (payload) =>
          sendTextToChannel(
            bot.client,
            session.discordThreadId,
            payload,
          ),
      });
      approvalThreadMessages.set(requestId, lifecycleState);
      const threadMessage = await finalizeApprovalLifecycleMessageState({
        state: lifecycleState,
        operation: pendingMessagePromise,
      });

      if (threadMessage) {
        lifecycleState.message = threadMessage;
      }

      try {
        const dmMessage = await maybeSendApprovalDm({
          client: bot.client,
          requestId: String(event.requestId),
          ownerId: session.ownerDiscordUserId,
          threadId: session.discordThreadId,
        });

        if (dmMessage) {
          approvalDmMessages.set(String(event.requestId), dmMessage);
        }
      } catch (error) {
        logger.warn(
          `Could not DM approval controls to ${session.ownerDiscordUserId}; local codex resume --remote remains the fallback path.`,
          error,
        );
      }
    })().catch((error) => {
      logger.error("Failed to process approval request event", error);
    });
  });

  codexClient.on("serverRequest/resolved", (event) => {
    void (async () => {
      const requestId = String(event.requestId);
      const approvalRecord = approvalRepo.getByRequestId(requestId);

      if (!approvalRecord) {
        return;
      }

      const outcome = applyApprovalResolutionSignal(
        {
          requestId: approvalRecord.requestId,
          status: approvalRecord.status,
        },
        {
          type: "serverRequest/resolved",
          requestId,
        },
      );

      approvalRepo.insert({
        requestId,
        discordThreadId: approvalRecord.discordThreadId,
        status: outcome.approval.status,
      });

      const session = sessionRepo.getByDiscordThreadId(approvalRecord.discordThreadId);

      if (session && shouldProjectManagedSessionDiscordSurface(session)) {
        const runtime = ensureTranscriptRuntime(session.codexThreadId);
        const activeTurnId = runtime.activeTurnId;

        if (activeTurnId) {
          const current = ensureTurnProcessMessageState(runtime, activeTurnId);
          current.footer = undefined;
          if (
            current.steps.length > 0
            || !!current.liveCommentaryText
            || !!current.message
            || !!current.pendingCreate
          ) {
            await syncTurnProcessMessage({
              discord: bot.client,
              session,
              turnId: activeTurnId,
              deleteIfEmpty: current.steps.length === 0,
            });
          }
        }
      }

      const dmMessage = outcome.closeActiveUi
        ? approvalDmMessages.get(requestId)
        : undefined;

      const lifecycleState = approvalThreadMessages.get(requestId) ?? {};
      const resolvedMessagePromise = reconcileApprovalResolutionSurface({
        requestId,
        status: outcome.approval.status,
        session,
        currentThreadMessage: lifecycleState.message,
        currentThreadMessagePromise: lifecycleState.pendingMessage,
        recoverThreadMessage: async () =>
          recoverApprovalLifecycleMessage(
            bot.client,
            approvalRecord.discordThreadId,
            requestId,
          ),
        sendThreadMessage: async (payload) =>
          sendTextToChannel(
            bot.client,
            approvalRecord.discordThreadId,
            payload,
          ),
        dmMessage,
      });
      approvalThreadMessages.set(requestId, lifecycleState);
      const threadMessage = await finalizeApprovalLifecycleMessageState({
        state: lifecycleState,
        operation: resolvedMessagePromise,
      });

      if (threadMessage) {
        lifecycleState.message = threadMessage;
      }

      if (dmMessage) {
        approvalDmMessages.delete(requestId);
      }
    })().catch((error) => {
      logger.error("Failed to process serverRequest/resolved event", error);
    });
  });

  await codexClient.initialize();
  await registerGuildCommands(
    config,
    buildControlChannelCommands(config.workdirs),
  );
  await bot.start();

  for (const session of sessionRepo.listAll()) {
    if (!shouldProjectManagedSessionDiscordSurface(session)) {
      continue;
    }

    try {
      await seedTranscriptRuntimeFromSnapshot(session);
    } catch (error) {
      const disposition = getSnapshotReconciliationFailureDisposition(error);

      if (disposition === "degrade-thread-missing") {
        await degradeSessionToReadOnly({
          discord: bot.client,
          session,
          reason: "thread_missing",
        });
        continue;
      }

      if (disposition === "warn") {
        logger.warn(
          `Failed to seed transcript runtime for mapped session ${session.codexThreadId}`,
          error,
        );
      }
    }
  }

  const snapshotPoll = setInterval(() => {
    void (async () => {
      for (const session of sessionRepo.listAll()) {
        if (!shouldProjectManagedSessionDiscordSurface(session)) {
          continue;
        }

        const sessionState = coerceSessionRuntimeState(session.state);

        try {
          if (shouldPollSnapshotForSessionState(sessionState)) {
            await syncTranscriptSnapshot({
              discord: bot.client,
              session,
              degradeOnUnexpectedItems: true,
            });
            continue;
          }

          if (!shouldPollRecoveryProbeForSessionState(sessionState)) {
            continue;
          }

          await pollSessionRecovery({
            session,
            sessionState,
            readThread: async (threadId) =>
              retryCodexThreadOperationAfterResume({
                threadId,
                operation: () =>
                  codexClient.readThread({
                    threadId,
                  }),
                resumeThread: ({ threadId: nextThreadId }) =>
                  codexClient.resumeThread({
                    threadId: nextThreadId,
                  }),
              }),
            updateSessionState: async (nextState) => {
              updateSessionStateIfWritable(session, nextState);
            },
            updateStatusCard: async (nextState) =>
              updateStatusCard({
                discord: bot.client,
                session,
                state: nextState,
              }),
            syncTranscriptSnapshot: async () =>
              syncTranscriptSnapshot({
                discord: bot.client,
                session,
                degradeOnUnexpectedItems: true,
              }),
          });
        } catch (error) {
          const disposition = getSnapshotReconciliationFailureDisposition(error);

          if (disposition === "degrade-thread-missing") {
            await degradeSessionToReadOnly({
              discord: bot.client,
              session,
              reason: "thread_missing",
            });
            continue;
          }

          if (disposition === "warn") {
            logger.warn(
              `Failed to reconcile transcript snapshot for ${session.codexThreadId}`,
              error,
            );
          }
        }
      }
    })().catch((error) => {
      logger.error("Snapshot reconciliation loop failed", error);
    });
  }, sessionSnapshotPollIntervalMs);

  const stop = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    clearInterval(snapshotPoll);
    await bot.stop();
    codexClient.close();
    db.close();
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stop().catch((error) => {
        logger.error(`Failed to stop cleanly on ${signal}`, error);
      });
    });
  }

  return {
    config,
    db,
    bot,
    codexClient,
    stop,
  };
};

if (import.meta.main) {
  void startCodeHelm(process.env as Record<string, string | undefined>)
    .then(({ config }) => {
      logger.info(`CodeHelm started for Discord app ${config.discord.appId}`);
    })
    .catch((error) => {
      logger.error("CodeHelm failed to start", error);
      process.exitCode = 1;
    });
}
