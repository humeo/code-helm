import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  type Message,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type AnyThreadChannel,
  type Client,
  type MessageMentionOptions,
  type ReplyOptions,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { z } from "zod";
import {
  acquireInstanceLock,
  clearRuntimeState,
  writeRuntimeSummary,
} from "./cli/runtime-state";
import { resolveCodeHelmPaths } from "./cli/paths";
import { JsonRpcClient } from "./codex/jsonrpc-client";
import {
  startManagedCodexAppServer,
  type ManagedCodexAppServer,
} from "./codex/supervisor";
import {
  approvalRequestMethods,
  getApprovalRequestDecisionPayloads,
  type ApprovalRequestDecisionPayload,
  type ApprovalRequestMethod,
} from "./codex/protocol-types";
import type {
  CodexAgentMessageItem,
  CodexCommandExecutionItem,
  ApprovalRequestEvent,
  CodexThread,
  CodexThreadStatus,
  CodexTurn,
  CodexTurnItem,
  CodexUserMessageItem,
  JsonRpcId,
  RoutedEventMap,
  ServerRequestResolvedEvent,
  StartTurnParams,
  ThreadReadResult,
} from "./codex/protocol-types";
import {
  DEFAULT_CODEX_APP_SERVER_URL,
  DEFAULT_DISCORD_APP_ID,
  type AppConfig,
  parseConfig,
} from "./config";
import { createDatabaseClient } from "./db/client";
import { applyMigrations } from "./db/migrate";
import { createApprovalRepo, type ApprovalRecord } from "./db/repos/approvals";
import { createCurrentWorkdirRepo } from "./db/repos/current-workdirs";
import { createSessionRepo, type SessionRecord } from "./db/repos/sessions";
import { createWorkdirRepo } from "./db/repos/workdirs";
import { createWorkspaceRepo } from "./db/repos/workspaces";
import {
  createPersistedApprovalDecisions,
  type ApprovalStatus,
  type PersistedApprovalDecision,
} from "./domain/approval-service";
import { shouldDegradeDiscordToReadOnly } from "./domain/external-modification";
import {
  canControlSession,
  coercePersistedSessionRuntimeState,
  inferSyncedSessionRuntimeState,
  resolveResumeSessionState,
  resolveSyncSessionState,
  resolveSessionAccessMode,
} from "./domain/session-service";
import {
  buildPathBrowserChoices,
} from "./domain/session-path-browser";
import {
  formatSessionPathForDisplay,
  normalizeBootstrapThreadTitle,
  normalizeSessionPathInput,
  pathContainsHiddenDirectory,
} from "./domain/session-paths";
import {
  formatRelativeThreadTime,
  getNormalizedThreadActivityTime,
  normalizeThreadTimestamp,
} from "./domain/session-time";
import type {
  SessionLifecycleState,
  SessionPersistedRuntimeState,
  SessionResumeState,
  SessionRuntimeState,
} from "./domain/types";
import {
  applyApprovalResolutionSignal,
  renderApprovalRequestIdText,
  renderApprovalLifecyclePayload as renderStoredApprovalLifecyclePayload,
  renderApprovalStaleStatusText,
  truncateApprovalText,
} from "./discord/approval-ui";
import { createDiscordBot } from "./discord/bot";
import {
  buildControlChannelCommands,
  type DiscordAutocompleteChoice,
  type DiscordCommandResult,
  type DiscordCommandServices,
} from "./discord/commands";
import {
  buildManagedSessionCommands,
  handleManagedSessionCommand,
  type ManagedSessionCommandServices,
} from "./discord/managed-session-commands";
import {
  parseManagedModelCustomId,
} from "./discord/managed-session-model-ui";
import {
  formatManagedSessionContextWindowSummary,
  formatManagedSessionTokenUsageSummary,
  renderManagedSessionStatus,
  summarizeManagedSessionRateLimits,
} from "./discord/managed-session-status";
import { buildDiscordRestOptions } from "./discord/rest";
import {
  renderDegradationActionText,
  renderDegradationBannerPayload,
  renderSessionStartedPayload,
} from "./discord/renderers";
import {
  appendProcessStep,
  buildCommandProcessStep,
  collectComparableTranscriptItemIds,
  collectTranscriptEntries,
  collectTranscriptItemIds,
  getAssistantTranscriptEntryId,
  type DiscordMessageEmbed,
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
  type StartThreadTurnDecision,
} from "./discord/thread-handler";
import { logger } from "./logger";

const approvalButtonPrefix = "approval";
const approvalComponentRowLimit = 5;
const approvalButtonLabelCharacterLimit = 80;
const approvalDecisionCustomIdTokenByKey: Record<string, string> = {
  accept: "a",
  acceptForSession: "as",
  acceptWithExecpolicyAmendment: "ae",
  applyNetworkPolicyAmendment: "an",
  decline: "d",
  cancel: "c",
};
const approvalDecisionKeyByCustomIdToken = Object.fromEntries(
  Object.entries(approvalDecisionCustomIdTokenByKey).map(([decisionKey, token]) => [
    token,
    decisionKey,
  ]),
) as Record<string, string>;

type WorkdirConfig = {
  id: string;
  label: string;
  absolutePath: string;
};

type LegacyWorkspaceBootstrap = {
  workspaceRoot: string;
  workdirs: WorkdirConfig[];
};

const parseLegacyWorkspaceBootstrap = (
  env: Record<string, string | undefined>,
): LegacyWorkspaceBootstrap | null => {
  const workspaceRoot = env.WORKSPACE_ROOT;
  const serializedWorkdirs = env.WORKDIRS_JSON;

  if (workspaceRoot === undefined && serializedWorkdirs === undefined) {
    return null;
  }

  if (workspaceRoot === undefined || serializedWorkdirs === undefined) {
    throw new Error("WORKSPACE_ROOT and WORKDIRS_JSON must both be set");
  }

  if (!isAbsolute(workspaceRoot)) {
    throw new Error("WORKSPACE_ROOT must be an absolute path");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(serializedWorkdirs);
  } catch {
    throw new Error("WORKDIRS_JSON must be valid JSON");
  }

  const workdirs = z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      absolutePath: z.string().min(1),
    }),
  ).min(1).parse(parsed);
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const workdir of workdirs) {
    if (!isAbsolute(workdir.absolutePath)) {
      throw new Error("WORKDIRS_JSON paths must be absolute");
    }

    const workspaceRelativePath = relative(workspaceRoot, workdir.absolutePath);

    if (
      workspaceRelativePath !== ""
      && (workspaceRelativePath.startsWith("..") || isAbsolute(workspaceRelativePath))
    ) {
      throw new Error(
        `WORKDIRS_JSON contains a workdir outside WORKSPACE_ROOT: ${workdir.absolutePath}`,
      );
    }

    if (seenIds.has(workdir.id)) {
      throw new Error(`WORKDIRS_JSON contains duplicate workdir id: ${workdir.id}`);
    }

    if (seenPaths.has(workdir.absolutePath)) {
      throw new Error(
        `WORKDIRS_JSON contains duplicate workdir path: ${workdir.absolutePath}`,
      );
    }

    seenIds.add(workdir.id);
    seenPaths.add(workdir.absolutePath);
  }

  return {
    workspaceRoot,
    workdirs,
  };
};

export const resolveLegacyWorkspaceBootstrap = (
  env: Record<string, string | undefined>,
) => {
  return parseLegacyWorkspaceBootstrap(env);
};

type DiscordMessageComponents = ActionRowBuilder<ButtonBuilder>[];
type DiscordChannelMessagePayload = DiscordMessagePayload & {
  components?: DiscordMessageComponents;
  allowedMentions?: MessageMentionOptions;
};
type DiscordCreateChannelMessagePayload = DiscordChannelMessagePayload & {
  reply?: ReplyOptions;
};
type DiscordApprovalLifecyclePayload = DiscordChannelMessagePayload & {
  components?: DiscordMessageComponents;
  allowedMentions?: MessageMentionOptions;
};
type ApprovalLifecycleMessage = {
  id?: string;
  content: string;
  edit(payload: DiscordChannelMessagePayload): Promise<ApprovalLifecycleMessage>;
};
type RecoverableMessageComponent = {
  customId?: string;
};
type RecoverableMessageComponentRow = {
  components?: RecoverableMessageComponent[];
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
  components?: RecoverableMessageComponentRow[];
  author?: {
    bot?: boolean;
    id?: string;
  };
};
type SendableChannel = {
  send(payload: DiscordCreateChannelMessagePayload): Promise<Message<boolean>>;
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
type RenamableThreadChannel = {
  name: string | null;
  setName(name: string, reason?: string): Promise<unknown>;
};
export type PendingLocalInput = {
  kind: "start" | "steer";
  text: string;
  replyToMessageId?: string;
  turnId?: string;
};
type TranscriptRuntime = {
  seenItemIds: Set<string>;
  finalizingItemIds: Set<string>;
  pendingLocalInputs: PendingLocalInput[];
  pendingDiscordInputReplyMessageIds: Array<string | undefined>;
  turnReplyMessageIds: Map<string, string>;
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
  threadTokenUsage?: import("./codex/protocol-types").ThreadTokenUsage;
};

const sessionSnapshotPollIntervalMs = 15_000;
const startupSessionWarmupTimeoutMs = 10_000;
const managedCodexAppServerStopTimeoutMs = 1_000;
const discordTypingPulseIntervalMs = 8_000;
const approvalAllowedMentions = {
  parse: [],
} satisfies MessageMentionOptions;
const approvalPendingEmbedColor = 0xf59e0b;
const approvalApprovedEmbedColor = 0x16a34a;
const approvalDeclinedEmbedColor = 0xdc2626;
const approvalNeutralEmbedColor = 0x64748b;

export const shouldRenderLiveAssistantTranscriptBubble = (
  phase: string | null | undefined,
) => {
  return phase !== "commentary";
};

export const shouldRenderCompletedAssistantReplyImmediately = (
  phase: string | null | undefined,
) => {
  return phase === "final_answer";
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

const collectVisibleTurnProcessSteps = ({
  steps,
  liveCommentaryText,
}: {
  steps: string[];
  liveCommentaryText?: string;
}) => {
  const visibleSteps = [...steps];
  const normalizedLiveCommentary = liveCommentaryText
    ? normalizeProcessStepText(liveCommentaryText)
    : "";

  if (
    normalizedLiveCommentary.length > 0
    && visibleSteps.at(-1) !== normalizedLiveCommentary
  ) {
    visibleSteps.push(normalizedLiveCommentary);
  }

  return visibleSteps;
};

export const renderLiveTurnProcessMessage = ({
  turnId,
  steps,
  liveCommentaryText,
  footer,
}: {
  turnId: string;
  steps: string[];
  liveCommentaryText?: string;
  footer?: ProcessFooterText;
}) => {
  const visibleSteps = collectVisibleTurnProcessSteps({
    steps,
    liveCommentaryText,
  });

  if (visibleSteps.length === 0 && !footer) {
    return undefined;
  }

  return renderTranscriptEntry({
    itemId: getProcessTranscriptEntryId(turnId),
    kind: "process",
    turnId,
    text: visibleSteps.join("\n"),
    footer,
  });
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

const isPreMaterializationResumeError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.toLowerCase().includes("no rollout found for thread id");
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
  resumeBeforeStart = false,
}: {
  request: StartTurnParams;
  startTurn: (request: StartTurnParams) => Promise<TResult>;
  resumeThread: (params: { threadId: string }) => Promise<unknown>;
  resumeBeforeStart?: boolean;
}) => {
  if (resumeBeforeStart) {
    try {
      await resumeThread({
        threadId: request.threadId,
      });
    } catch (error) {
      // codex-rs keeps a fresh thread live before the first user turn
      // materializes rollout storage, so thread/resume can fail even though
      // turn/start is still valid for the in-memory session.
      if (!isPreMaterializationResumeError(error)) {
        throw error;
      }
    }
  }

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
    pendingLocalInputs: PendingLocalInput[];
    trustedExternalTurnIds?: Set<string>;
  };
  turns: CodexTurn[] | undefined;
}) => {
  const pendingDiscordInputsProbe = getPendingLocalInputTexts(runtime);
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

  if (runtime.pendingLocalInputs.length === 0) {
    return true;
  }

  return pendingDiscordInputsProbe.length === runtime.pendingLocalInputs.length;
};

export const shouldHoldSnapshotTranscriptForManualSync = ({
  runtime,
  turns,
  degradeOnUnexpectedItems,
}: {
  runtime: {
    seenItemIds: Set<string>;
    finalizingItemIds: Set<string>;
    pendingLocalInputs: PendingLocalInput[];
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
  approval,
}: {
  approval: Pick<
    ApprovalRecord,
    | "requestId"
    | "status"
    | "displayTitle"
    | "commandPreview"
    | "justification"
    | "cwd"
    | "requestKind"
    | "decisionCatalog"
    | "resolvedProviderDecision"
    | "resolvedBySurface"
    | "resolvedElsewhere"
  >;
}) => {
  return renderStoredApprovalLifecyclePayload({
    approval: {
      requestId: approval.requestId,
      status: approval.status,
      displayTitle: approval.displayTitle,
      commandPreview: approval.commandPreview,
      justification: approval.justification,
      cwd: approval.cwd,
      requestKind: approval.requestKind,
      decisions: parseStoredApprovalDecisions(approval.decisionCatalog),
      resolvedProviderDecision: approval.resolvedProviderDecision,
      resolvedBySurface: approval.resolvedBySurface,
      resolvedElsewhere: approval.resolvedElsewhere,
    },
  }).content;
};

const parseStoredApprovalDecisions = (
  decisionCatalog: string | null,
): PersistedApprovalDecision[] | null => {
  if (decisionCatalog === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(decisionCatalog);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      const candidate = entry as Record<string, unknown>;

      if (
        typeof candidate.key !== "string"
        || typeof candidate.providerDecision !== "string"
        || typeof candidate.label !== "string"
      ) {
        return [];
      }

      return [{
        key: candidate.key,
        providerDecision: candidate.providerDecision,
        label: candidate.label,
        consequence:
          typeof candidate.consequence === "string"
          || candidate.consequence === null
            ? candidate.consequence
            : null,
        replyPayload:
          candidate.replyPayload !== undefined ? candidate.replyPayload : undefined,
      } satisfies PersistedApprovalDecision];
    });
  } catch {
    return [];
  }
};

const toApprovalLifecycleEmbedColor = (
  approval: Pick<ApprovalRecord, "status">,
) => {
  if (approval.status === "pending") {
    return approvalPendingEmbedColor;
  }

  if (approval.status === "approved") {
    return approvalApprovedEmbedColor;
  }

  if (approval.status === "declined") {
    return approvalDeclinedEmbedColor;
  }

  return approvalNeutralEmbedColor;
};

const renderApprovalLifecycleEmbeds = ({
  approval,
  description,
}: {
  approval: Pick<ApprovalRecord, "status">;
  description: string;
}) => {
  const embed: DiscordMessageEmbed = {
    description,
    color: toApprovalLifecycleEmbedColor(approval),
  };

  return [embed];
};

const approvalButtonStyle = (providerDecision: string) => {
  if (providerDecision === "decline") {
    return ButtonStyle.Danger;
  }

  if (providerDecision === "cancel") {
    return ButtonStyle.Secondary;
  }

  return ButtonStyle.Success;
};

const isSupportedApprovalProviderDecision = (providerDecision: string) => {
  return providerDecision === "accept"
    || providerDecision === "acceptForSession"
    || providerDecision === "acceptWithExecpolicyAmendment"
    || providerDecision === "applyNetworkPolicyAmendment"
    || providerDecision === "decline"
    || providerDecision === "cancel";
};

const buildApprovalComponents = (
  approvalKey: string,
  decisions: PersistedApprovalDecision[] = [],
) => {
  const renderableDecisions = decisions.filter((decision) =>
    isSupportedApprovalProviderDecision(decision.providerDecision)
  );

  if (renderableDecisions.length === 0) {
    return [];
  }

  const buttons = renderableDecisions.map((decision) =>
    new ButtonBuilder()
      .setCustomId(buildApprovalCustomId(approvalKey, decision.key))
      .setLabel(
        truncateApprovalText(decision.label, approvalButtonLabelCharacterLimit),
      )
      .setStyle(approvalButtonStyle(decision.providerDecision))
  );
  const rows: DiscordMessageComponents = [];

  for (let index = 0; index < buttons.length; index += approvalComponentRowLimit) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...buttons.slice(index, index + approvalComponentRowLimit),
      ),
    );
  }

  return rows;
};

export const renderApprovalLifecyclePayload = ({
  approvalKey,
  approval,
}: {
  approvalKey?: string;
  approval: Pick<
    ApprovalRecord,
    | "approvalKey"
    | "requestId"
    | "status"
    | "displayTitle"
    | "commandPreview"
    | "justification"
    | "cwd"
    | "requestKind"
    | "decisionCatalog"
    | "resolvedProviderDecision"
    | "resolvedBySurface"
    | "resolvedElsewhere"
  >;
}): DiscordApprovalLifecyclePayload => {
  const lifecycle = renderStoredApprovalLifecyclePayload({
    approval: {
      requestId: approval.requestId,
      status: approval.status,
      displayTitle: approval.displayTitle,
      commandPreview: approval.commandPreview,
      justification: approval.justification,
      cwd: approval.cwd,
      requestKind: approval.requestKind,
      decisions: parseStoredApprovalDecisions(approval.decisionCatalog),
      resolvedProviderDecision: approval.resolvedProviderDecision,
      resolvedBySurface: approval.resolvedBySurface,
      resolvedElsewhere: approval.resolvedElsewhere,
    },
  });

  return {
    embeds: renderApprovalLifecycleEmbeds({
      approval,
      description: lifecycle.content,
    }),
    components: buildApprovalComponents(
      approvalKey ?? approval.approvalKey ?? approval.requestId,
      lifecycle.decisions,
    ),
    allowedMentions: approvalAllowedMentions,
  };
};

export const renderApprovalOwnerDmPayload = ({
  approvalKey,
  approval,
}: {
  approvalKey?: string;
  approval: Pick<
    ApprovalRecord,
    | "approvalKey"
    | "requestId"
    | "status"
    | "displayTitle"
    | "commandPreview"
    | "justification"
    | "cwd"
    | "requestKind"
    | "decisionCatalog"
    | "resolvedProviderDecision"
    | "resolvedBySurface"
    | "resolvedElsewhere"
  >;
}): DiscordApprovalLifecyclePayload => {
  return renderApprovalLifecyclePayload({
    approvalKey,
    approval,
  });
};

export type ThreadLanguage = "en" | "zh";

const containsHanText = (value: string) => {
  return /[\p{Script=Han}]/u.test(value);
};

export const detectThreadLanguageFromTexts = (
  texts: string[],
): ThreadLanguage => {
  let zhSignal = 0;
  let enSignal = 0;

  for (const text of texts) {
    if (containsHanText(text)) {
      zhSignal += 1;
    }

    if (/[A-Za-z]/.test(text)) {
      enSignal += 1;
    }
  }

  if (zhSignal > 0 && zhSignal >= enSignal) {
    return "zh";
  }

  return "en";
};

export const renderApprovalDeliveryFailureText = (
  language: ThreadLanguage,
) => {
  if (language === "zh") {
    return "审批卡片发送失败，当前操作仍在等待审批。";
  }

  return "Approval card delivery failed. The action is still waiting for approval.";
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
  approvalKey,
  requestId,
  content,
  components,
  editable,
  author,
  botUserId,
  allowRequestIdFallback,
}: StatusCardCandidate & {
  approvalKey?: string;
  requestId: string;
  botUserId?: string;
  allowRequestIdFallback?: boolean;
}) => {
  if (
    !editable
    || author?.bot !== true
    || (botUserId !== undefined && author.id !== botUserId)
  ) {
    return false;
  }

  const componentApprovalKey = components
    ?.flatMap((row) => row.components ?? [])
    .map((component) => component.customId)
    .find((customId): customId is string => {
      return typeof customId === "string" && parseApprovalCustomId(customId) !== null;
    });

  if (componentApprovalKey) {
    return approvalKey !== undefined
      && parseApprovalCustomId(componentApprovalKey)?.approvalKey === approvalKey;
  }

  if (approvalKey !== undefined && !allowRequestIdFallback) {
    return false;
  }

  return (
    content.startsWith(`Approval \`${requestId}\`:`)
    || content.includes(renderApprovalRequestIdText(requestId))
  );
};

export const recoverApprovalLifecycleMessageFromHistory = async <
  T extends StatusCardCandidate,
>({
  approvalKey,
  requestId,
  fetchPage,
  botUserId,
  allowRequestIdFallback,
  pageSize = 50,
  maxPages = 5,
}: {
  approvalKey?: string;
  requestId: string;
  fetchPage: (options: { limit: number; before?: string }) => Promise<T[]>;
  botUserId?: string;
  allowRequestIdFallback?: boolean;
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
        approvalKey,
        requestId,
        botUserId,
        allowRequestIdFallback,
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

export const readActiveTurnIdFromThreadReadResult = (
  snapshot: ThreadReadResult,
) => {
  const activeRuntimeState = inferSessionStateFromThreadStatus(snapshot.thread.status);

  return activeRuntimeState === "running" || activeRuntimeState === "waiting-approval"
    ? snapshot.thread.turns?.at(-1)?.id
    : undefined;
};

export const applySessionStartTurnOverrides = ({
  session,
  request,
}: {
  session: Pick<SessionRecord, "modelOverride" | "reasoningEffortOverride">;
  request: StartThreadTurnDecision["request"];
}) => {
  return {
    ...request,
    model: request.model ?? session.modelOverride ?? undefined,
    effort: request.effort ?? session.reasoningEffortOverride ?? undefined,
  };
};

const hydrateSessionModelMetadataFromResume = async ({
  session,
  sessionRepo,
  resumeThread,
}: {
  session: SessionRecord;
  sessionRepo: ReturnType<typeof createSessionRepo>;
  resumeThread: Pick<JsonRpcClient, "resumeThread">["resumeThread"];
}) => {
  if (session.modelOverride && session.reasoningEffortOverride) {
    return sessionRepo.getByDiscordThreadId(session.discordThreadId) ?? session;
  }

  const resumed = await resumeThread({
    threadId: session.codexThreadId,
  });
  const nextModel = resumed.model ?? session.modelOverride ?? null;
  const nextReasoningEffort =
    resumed.reasoningEffort ?? session.reasoningEffortOverride ?? null;

  if (
    nextModel === session.modelOverride
    && nextReasoningEffort === session.reasoningEffortOverride
  ) {
    return sessionRepo.getByDiscordThreadId(session.discordThreadId) ?? session;
  }

  sessionRepo.updateModelOverride(session.discordThreadId, {
    modelOverride: nextModel,
    reasoningEffortOverride: nextReasoningEffort,
  });

  return sessionRepo.getByDiscordThreadId(session.discordThreadId) ?? session;
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
    pendingLocalInputs: [],
    pendingDiscordInputReplyMessageIds: [],
    turnReplyMessageIds: new Map(),
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
    threadTokenUsage: undefined,
  };
};

const isUnavailableAccountRateLimitsError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  const normalizedMessage = error.message.toLowerCase();

  return normalizedMessage.includes("authentication required")
    || normalizedMessage.includes("chatgpt auth")
    || normalizedMessage.includes("rate limits");
};

export const getPendingLocalInputTexts = (
  runtime: Pick<TranscriptRuntime, "pendingLocalInputs">,
) => {
  return runtime.pendingLocalInputs.map((input) => input.text);
};

export const getQueuedSteerInputs = (
  runtime: Pick<TranscriptRuntime, "pendingLocalInputs">,
) => {
  return runtime.pendingLocalInputs.filter((input) => input.kind === "steer");
};

const removePendingLocalInput = ({
  runtime,
  pendingInput,
}: {
  runtime: Pick<TranscriptRuntime, "pendingLocalInputs">;
  pendingInput: PendingLocalInput;
}) => {
  const index = runtime.pendingLocalInputs.indexOf(pendingInput);

  if (index >= 0) {
    runtime.pendingLocalInputs.splice(index, 1);
  }
};

export const clearQueuedSteerInputs = ({
  runtime,
}: {
  runtime: Pick<TranscriptRuntime, "pendingLocalInputs">;
}) => {
  const discarded = getQueuedSteerInputs(runtime);

  if (discarded.length === 0) {
    return [] as PendingLocalInput[];
  }

  runtime.pendingLocalInputs = runtime.pendingLocalInputs.filter((input) => input.kind !== "steer");
  return discarded;
};

const readTurnIdFromTranscriptEntryId = (itemId: string) => {
  const separatorIndex = itemId.indexOf(":");

  if (separatorIndex < 0 || separatorIndex === itemId.length - 1) {
    return undefined;
  }

  const remainder = itemId.slice(separatorIndex + 1);
  const nextSeparatorIndex = remainder.indexOf(":");

  if (nextSeparatorIndex < 0) {
    return remainder;
  }

  return remainder.slice(0, nextSeparatorIndex);
};

export const noteTrustedLiveExternalTurnStart = ({
  runtime,
  turnId,
}: {
  runtime: Pick<TranscriptRuntime, "pendingLocalInputs" | "trustedExternalTurnIds">;
  turnId?: string;
}) => {
  if (!turnId || runtime.pendingLocalInputs.length > 0) {
    return;
  }

  runtime.trustedExternalTurnIds.add(turnId);
};

export const markTranscriptItemsSeen = ({
  runtime,
  turns,
  source,
}: {
  runtime: Pick<TranscriptRuntime, "seenItemIds" | "finalizingItemIds" | "activeTurnId">;
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

  if (source !== "live" || !runtime.activeTurnId) {
    return;
  }

  for (const turn of turns ?? []) {
    if (turn.id !== "live") {
      continue;
    }

    for (const itemId of collectComparableTranscriptItemIds([
      {
        ...turn,
        id: runtime.activeTurnId,
      },
    ])) {
      runtime.seenItemIds.add(itemId);
    }
  }
};

export const seedTranscriptRuntimeSeenItemsFromSnapshot = ({
  runtime,
  turns,
}: {
  runtime: Pick<TranscriptRuntime, "seenItemIds" | "finalizingItemIds" | "activeTurnId">;
  turns: CodexTurn[] | undefined;
}) => {
  markTranscriptItemsSeen({
    runtime,
    turns,
    source: "snapshot",
  });
};

export const remapSeenTranscriptEntriesToCompletedTurn = ({
  runtime,
  turn,
}: {
  runtime: Pick<TranscriptRuntime, "seenItemIds">;
  turn?: CodexTurn;
}) => {
  if (!turn) {
    return;
  }

  const syntheticLiveUserEntryId = getUserTranscriptEntryId("live");
  const syntheticLiveAssistantEntryId = getAssistantTranscriptEntryId("live");

  for (const item of turn.items ?? []) {
    if (isUserMessageItem(item)) {
      if (runtime.seenItemIds.has(syntheticLiveUserEntryId)) {
        runtime.seenItemIds.add(getUserTranscriptEntryId(turn.id));
      }
      continue;
    }

    if (!isAgentMessageItem(item) || item.phase === "commentary") {
      continue;
    }

    if (
      runtime.seenItemIds.has(item.id)
      || runtime.seenItemIds.has(syntheticLiveAssistantEntryId)
    ) {
      runtime.seenItemIds.add(getAssistantTranscriptEntryId(turn.id));
    }
  }
};

export const finalizeCompletedAssistantTranscriptReply = async ({
  runtime,
  turnId,
  item,
  sendMessage,
}: {
  runtime: Pick<
    TranscriptRuntime,
    | "itemTurnIds"
    | "activeTurnId"
    | "finalizingItemIds"
    | "seenItemIds"
    | "turnReplyMessageIds"
  >;
  turnId?: string;
  item: CodexAgentMessageItem;
  sendMessage: (
    payload: DiscordMessagePayload,
    options?: {
      replyToMessageId?: string;
    },
  ) => Promise<unknown>;
}) => {
  const resolvedTurnId =
    turnId
    ?? runtime.itemTurnIds.get(item.id)
    ?? runtime.activeTurnId;
  const assistantEntryId = resolvedTurnId
    ? getAssistantTranscriptEntryId(resolvedTurnId)
    : item.id;
  const renderedMessages = renderTranscriptMessages([{
    itemId: assistantEntryId,
    kind: "assistant",
    text: item.text,
  }]);
  const replyToMessageId = resolvedTurnId
    ? runtime.turnReplyMessageIds.get(resolvedTurnId)
    : undefined;

  runtime.finalizingItemIds.add(assistantEntryId);

  try {
    for (const renderedMessage of renderedMessages) {
      await sendMessage(renderedMessage.payload, {
        replyToMessageId: renderedMessage.isFirstChunk
          ? replyToMessageId
          : undefined,
      });

      for (const itemId of renderedMessage.itemIds) {
        runtime.seenItemIds.add(itemId);
      }
    }
  } finally {
    runtime.finalizingItemIds.delete(assistantEntryId);
    runtime.itemTurnIds.delete(item.id);

    if (resolvedTurnId) {
      runtime.turnReplyMessageIds.delete(resolvedTurnId);
    }
  }
};

const consumePendingDiscordReplyReferences = ({
  runtime,
  consumedCount,
}: {
  runtime: Pick<TranscriptRuntime, "pendingDiscordInputReplyMessageIds">;
  consumedCount: number;
}) => {
  for (let index = 0; index < consumedCount; index += 1) {
    runtime.pendingDiscordInputReplyMessageIds.shift();
  }
};

const consumePendingLocalInputs = ({
  runtime,
  consumedCount,
}: {
  runtime: Pick<TranscriptRuntime, "pendingLocalInputs">;
  consumedCount: number;
}) => {
  if (consumedCount <= 0) {
    return;
  }

  runtime.pendingLocalInputs.splice(0, consumedCount);
};

const rememberPendingDiscordReplyReferenceForTurn = ({
  runtime,
  turnId,
}: {
  runtime: Pick<TranscriptRuntime, "pendingDiscordInputReplyMessageIds" | "turnReplyMessageIds">;
  turnId?: string;
}) => {
  const replyToMessageId = runtime.pendingDiscordInputReplyMessageIds[0];

  if (!turnId || !replyToMessageId) {
    return;
  }

  runtime.turnReplyMessageIds.set(turnId, replyToMessageId);
};

const resolveTranscriptReplyToMessageId = ({
  runtime,
  renderedMessage,
}: {
  runtime: Pick<TranscriptRuntime, "turnReplyMessageIds">;
  renderedMessage: ReturnType<typeof renderTranscriptMessages>[number];
}) => {
  if (!renderedMessage.isFirstChunk || renderedMessage.entryKind !== "assistant") {
    return undefined;
  }

  const turnId = readTurnIdFromTranscriptEntryId(renderedMessage.entryItemId);

  return turnId ? runtime.turnReplyMessageIds.get(turnId) : undefined;
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
  const pendingDiscordInputs = getPendingLocalInputTexts(runtime);
  const pendingDiscordInputCount = pendingDiscordInputs.length;
  const entries = collectTranscriptEntries(turns, {
    source,
    pendingDiscordInputs,
    activeTurnId,
    activeTurnFooter,
  }).filter((entry) =>
    !shouldSkipTranscriptRelayEntry({
      runtime,
      itemId: entry.itemId,
      source,
    })
  );
  const consumedPendingDiscordInputs =
    pendingDiscordInputCount - pendingDiscordInputs.length;

  if (consumedPendingDiscordInputs > 0) {
    consumePendingLocalInputs({
      runtime,
      consumedCount: consumedPendingDiscordInputs,
    });
    consumePendingDiscordReplyReferences({
      runtime,
      consumedCount: consumedPendingDiscordInputs,
    });
  }

  for (const renderedMessage of renderTranscriptMessages(entries)) {
    const rendered = renderedMessage.payload;
    if (!isDiscordMessagePayloadEmpty(rendered)) {
      await sendChannelMessage(client, channelId, rendered, {
        replyToMessageId: resolveTranscriptReplyToMessageId({
          runtime,
          renderedMessage,
        }),
      });
    }

    for (const itemId of renderedMessage.itemIds) {
      runtime.seenItemIds.add(itemId);

      if (renderedMessage.entryKind === "assistant") {
        const turnId = readTurnIdFromTranscriptEntryId(itemId);

        if (turnId) {
          runtime.turnReplyMessageIds.delete(turnId);
        }
      }
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

const isRenamableThreadChannel = (
  value: unknown,
): value is RenamableThreadChannel => {
  return (
    !!value
    && typeof value === "object"
    && "name" in value
    && typeof (value as { name?: unknown }).name === "string"
    && "setName" in value
    && typeof (value as { setName?: unknown }).setName === "function"
  );
};

const buildApprovalKey = ({
  turnId,
  itemId,
  approvalId,
}: Pick<ApprovalRequestEvent, "turnId" | "itemId"> & {
  approvalId?: unknown;
}) => {
  const normalizedApprovalId =
    typeof approvalId === "string" && approvalId.length > 0
      ? approvalId
      : null;

  return normalizedApprovalId
    ? `${turnId}:${itemId}:${normalizedApprovalId}`
    : `${turnId}:${itemId}`;
};

const approvalRequestKindByMethod: Record<ApprovalRequestMethod, string> = {
  "item/commandExecution/requestApproval": "command_execution",
  "item/fileChange/requestApproval": "file_change",
  "item/permissions/requestApproval": "permissions",
};

const approvalDisplayTitleByRequestKind: Record<string, string> = {
  command_execution: "Command approval",
  file_change: "File change approval",
  permissions: "Permissions approval",
};

const readApprovalEventString = (
  event: ApprovalRequestEvent,
  key: string,
) => {
  const value = event[key];

  return typeof value === "string" && value.length > 0 ? value : null;
};

const readApprovalEventStringFromCandidates = (
  event: ApprovalRequestEvent,
  ...keys: string[]
) => {
  for (const key of keys) {
    const value = readApprovalEventString(event, key);

    if (value) {
      return value;
    }
  }

  return null;
};

const shellWrapperBinaryPattern = /(?:^|\/)(?:bash|zsh|sh)$/;

const unwrapQuotedShellCommand = (value: string) => {
  const trimmed = value.trim();

  if (trimmed.length < 2) {
    return null;
  }

  const quote = trimmed[0];

  if ((quote !== "'" && quote !== "\"") || trimmed.at(-1) !== quote) {
    return null;
  }

  const inner = trimmed.slice(1, -1);

  if (quote === "\"") {
    return inner.replace(/\\(["\\$`])/g, "$1");
  }

  return inner.replaceAll("'\"'\"'", "'");
};

const normalizeApprovalCommandPreview = (value: string | null) => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const shellMatch = trimmed.match(/^(?<shell>\S+)\s+(?<rest>[\s\S]+)$/);

  if (!shellMatch?.groups?.shell || !shellWrapperBinaryPattern.test(shellMatch.groups.shell)) {
    return value;
  }

  let remainder = shellMatch.groups.rest.trimStart();
  let sawCommandFlag = false;

  while (remainder.startsWith("-")) {
    const optionMatch = remainder.match(/^(?<option>-[A-Za-z]+)\s*/);

    if (!optionMatch?.groups?.option) {
      return value;
    }

    if (optionMatch.groups.option.includes("c")) {
      sawCommandFlag = true;
    }

    remainder = remainder.slice(optionMatch[0].length).trimStart();
  }

  if (!sawCommandFlag || remainder.length === 0) {
    return value;
  }

  return unwrapQuotedShellCommand(remainder) ?? value;
};

const readApprovalEventRecord = (
  event: ApprovalRequestEvent,
  key: string,
) => {
  const value = event[key];

  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
};

const formatApprovalInlineCodeList = (values: string[]) => {
  return values.map((value) => `\`${value}\``).join(", ");
};

const readStringArray = (value: unknown) => {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
};

const collectPermissionSummaryLines = (profile: unknown) => {
  const permissionProfile =
    profile && typeof profile === "object" && !Array.isArray(profile)
      ? profile as Record<string, unknown>
      : null;

  if (!permissionProfile) {
    return [];
  }

  const lines: string[] = [];
  const network = permissionProfile.network;

  if (network && typeof network === "object" && !Array.isArray(network)) {
    const enabled = (network as Record<string, unknown>).enabled;

    if (enabled === true) {
      lines.push("Network access");
    }
  }

  const fileSystem = permissionProfile.fileSystem;

  if (fileSystem && typeof fileSystem === "object" && !Array.isArray(fileSystem)) {
    const readPaths = readStringArray((fileSystem as Record<string, unknown>).read);
    const writePaths = readStringArray((fileSystem as Record<string, unknown>).write);

    if (readPaths.length > 0) {
      lines.push(`Read: ${formatApprovalInlineCodeList(readPaths)}`);
    }

    if (writePaths.length > 0) {
      lines.push(`Write: ${formatApprovalInlineCodeList(writePaths)}`);
    }
  }

  return lines;
};

const toGrantedPermissionProfile = (profile: unknown) => {
  const permissionProfile =
    profile && typeof profile === "object" && !Array.isArray(profile)
      ? profile as Record<string, unknown>
      : null;

  if (!permissionProfile) {
    return {};
  }

  const granted: Record<string, unknown> = {};
  const network = permissionProfile.network;

  if (network && typeof network === "object" && !Array.isArray(network)) {
    const enabled = (network as Record<string, unknown>).enabled;

    if (enabled === true) {
      granted.network = { enabled: true };
    }
  }

  const fileSystem = permissionProfile.fileSystem;

  if (fileSystem && typeof fileSystem === "object" && !Array.isArray(fileSystem)) {
    const readPaths = readStringArray((fileSystem as Record<string, unknown>).read);
    const writePaths = readStringArray((fileSystem as Record<string, unknown>).write);
    const nextFileSystem: Record<string, unknown> = {};

    if (readPaths.length > 0) {
      nextFileSystem.read = readPaths;
    }

    if (writePaths.length > 0) {
      nextFileSystem.write = writePaths;
    }

    if (Object.keys(nextFileSystem).length > 0) {
      granted.fileSystem = nextFileSystem;
    }
  }

  return granted;
};

const buildApprovalJustificationFromRequest = ({
  method,
  event,
}: {
  method: ApprovalRequestMethod;
  event: ApprovalRequestEvent;
}) => {
  const lines: string[] = [];
  const reason = readApprovalEventStringFromCandidates(event, "justification", "reason");

  if (reason) {
    lines.push(reason);
  }

  if (method === "item/commandExecution/requestApproval") {
    const networkApprovalContext = readApprovalEventRecord(event, "networkApprovalContext");
    const host =
      typeof networkApprovalContext?.host === "string" ? networkApprovalContext.host : null;
    const protocol =
      typeof networkApprovalContext?.protocol === "string"
        ? networkApprovalContext.protocol
        : null;

    if (host && protocol) {
      lines.push(`Network target: \`${host}\` (${protocol})`);
    }

    lines.push(...collectPermissionSummaryLines(readApprovalEventRecord(event, "additionalPermissions")));
  }

  if (method === "item/fileChange/requestApproval") {
    const grantRoot = readApprovalEventStringFromCandidates(event, "grantRoot", "grant_root");

    if (grantRoot) {
      lines.push(`Session write scope: \`${grantRoot}\``);
    }
  }

  if (method === "item/permissions/requestApproval") {
    lines.push(...collectPermissionSummaryLines(readApprovalEventRecord(event, "permissions")));
  }

  return lines.length > 0 ? lines.join("\n") : null;
};

const synthesizeApprovalDecisionPayloads = ({
  method,
  event,
}: {
  method: ApprovalRequestMethod;
  event: ApprovalRequestEvent;
}) => {
  if (method === "item/fileChange/requestApproval") {
    const decisions: ApprovalRequestDecisionPayload[] = [
      {
        decision: "accept",
        replyPayload: { decision: "accept" },
      },
      {
        decision: "acceptForSession",
        replyPayload: { decision: "acceptForSession" },
      },
    ];

    decisions.push(
      {
        decision: "decline",
        replyPayload: { decision: "decline" },
      },
      {
        decision: "cancel",
        replyPayload: { decision: "cancel" },
      },
    );
    return decisions;
  }

  if (method === "item/permissions/requestApproval") {
    const grantedPermissions = toGrantedPermissionProfile(
      readApprovalEventRecord(event, "permissions"),
    );

    return [
      {
        decision: "accept",
        replyPayload: {
          permissions: grantedPermissions,
          scope: "turn",
        },
      },
      {
        decision: "acceptForSession",
        replyPayload: {
          permissions: grantedPermissions,
          scope: "session",
        },
      },
      {
        decision: "decline",
        replyPayload: {
          permissions: {},
          scope: "turn",
        },
      },
    ] satisfies ApprovalRequestDecisionPayload[];
  }

  return null;
};

const getApprovalDecisionPayloadsForRequest = ({
  method,
  event,
}: {
  method: ApprovalRequestMethod;
  event: ApprovalRequestEvent;
}) => {
  const offeredDecisionPayloads = getApprovalRequestDecisionPayloads(event);

  if (offeredDecisionPayloads !== null) {
    return offeredDecisionPayloads;
  }

  return synthesizeApprovalDecisionPayloads({ method, event });
};

const extractApprovalSnapshotFromRequest = ({
  method,
  event,
}: {
  method: ApprovalRequestMethod;
  event: ApprovalRequestEvent;
}) => {
  const requestKind = approvalRequestKindByMethod[method];

  return {
    displayTitle: approvalDisplayTitleByRequestKind[requestKind] ?? "Approval request",
    commandPreview:
      method === "item/commandExecution/requestApproval"
        ? normalizeApprovalCommandPreview(
          readApprovalEventStringFromCandidates(event, "command", "cmd"),
        )
        : null,
    justification: buildApprovalJustificationFromRequest({ method, event }),
    cwd: readApprovalEventString(event, "cwd"),
    requestKind,
  };
};

const extractApprovalDecisionCatalogFromRequest = ({
  method,
  event,
}: {
  method: ApprovalRequestMethod;
  event: ApprovalRequestEvent;
}) => {
  const decisionPayloads = getApprovalDecisionPayloadsForRequest({
    method,
    event,
  });

  if (decisionPayloads === null) {
    return null;
  }

  return JSON.stringify(createPersistedApprovalDecisions({
    availableDecisions: decisionPayloads,
    requestMethod: method,
    grantRoot: readApprovalEventStringFromCandidates(event, "grantRoot", "grant_root"),
  }));
};

const getRuntimeApprovalRequestAssociations = (
  runtimeApprovalKeysByRequestId: Map<string, Set<string>>,
  requestId: string,
) => {
  const existing = runtimeApprovalKeysByRequestId.get(requestId);

  if (existing) {
    return existing;
  }

  const created = new Set<string>();
  runtimeApprovalKeysByRequestId.set(requestId, created);
  return created;
};

export const rememberRuntimeApprovalRequest = (
  runtimeApprovalKeysByRequestId: Map<string, Set<string>>,
  approval: Pick<ApprovalRecord, "approvalKey" | "requestId">,
  options?: {
    providerRequestId?: JsonRpcId;
    runtimeProviderRequestIdsByApprovalKey?: Map<string, JsonRpcId>;
  },
) => {
  getRuntimeApprovalRequestAssociations(
    runtimeApprovalKeysByRequestId,
    approval.requestId,
  ).add(approval.approvalKey);
  options?.runtimeProviderRequestIdsByApprovalKey?.set(
    approval.approvalKey,
    options.providerRequestId ?? approval.requestId,
  );
};

export const shouldHandlePersistedApprovalRequestAtRuntime = (
  approval: Pick<ApprovalRecord, "approvalKey" | "requestId" | "status">,
) => {
  if (approval.status === "pending") {
    return true;
  }

  logger.debug("Skipping stale replayed approval request at runtime", {
    approvalKey: approval.approvalKey,
    requestId: approval.requestId,
    status: approval.status,
  });
  return false;
};

const forgetRuntimeApprovalRequest = (
  runtimeApprovalKeysByRequestId: Map<string, Set<string>>,
  approval: Pick<ApprovalRecord, "approvalKey" | "requestId">,
  runtimeProviderRequestIdsByApprovalKey?: Map<string, JsonRpcId>,
) => {
  const approvalKeys = runtimeApprovalKeysByRequestId.get(approval.requestId);

  if (!approvalKeys) {
    runtimeProviderRequestIdsByApprovalKey?.delete(approval.approvalKey);
    return;
  }

  approvalKeys.delete(approval.approvalKey);
  runtimeProviderRequestIdsByApprovalKey?.delete(approval.approvalKey);

  if (approvalKeys.size === 0) {
    runtimeApprovalKeysByRequestId.delete(approval.requestId);
  }
};

const resolveProviderRequestIdForApproval = ({
  approval,
  approvalRepo,
  runtimeProviderRequestIdsByApprovalKey,
}: {
  approval: Pick<ApprovalRecord, "approvalKey" | "requestId">;
  approvalRepo: ReturnType<typeof createApprovalRepo>;
  runtimeProviderRequestIdsByApprovalKey?: Map<string, JsonRpcId>;
}) => {
  const persistedProviderRequestId =
    typeof approvalRepo.getProviderRequestId === "function"
      ? approvalRepo.getProviderRequestId(approval.approvalKey)
      : null;

  return runtimeProviderRequestIdsByApprovalKey?.get(approval.approvalKey)
    ?? persistedProviderRequestId
    ?? approval.requestId;
};

export const resolveStoredApprovalForResolvedEvent = ({
  approvalRepo,
  runtimeApprovalKeysByRequestId,
  event,
}: {
  approvalRepo: ReturnType<typeof createApprovalRepo>;
  runtimeApprovalKeysByRequestId: Map<string, Set<string>>;
  event: Pick<ServerRequestResolvedEvent, "requestId" | "threadId">;
}) => {
  const requestId = String(event.requestId);

  if (event.threadId) {
    return approvalRepo.getLatestByCodexThreadIdAndRequestId(event.threadId, requestId);
  }

  const runtimeApprovalKeys = runtimeApprovalKeysByRequestId.get(requestId);

  if (runtimeApprovalKeys && runtimeApprovalKeys.size > 0) {
    const runtimeApprovals = [...runtimeApprovalKeys]
      .map((approvalKey) => approvalRepo.getByApprovalKey(approvalKey))
      .filter((approval): approval is ApprovalRecord => approval !== null);

    if (runtimeApprovals.length === 1) {
      return runtimeApprovals[0];
    }

    if (runtimeApprovals.length > 1) {
      logger.debug(
        "Skipping ambiguous serverRequest/resolved event without threadId",
        {
          requestId,
          approvalKeys: runtimeApprovals.map((approval) => approval.approvalKey),
        },
      );
      return null;
    }
  }

  return approvalRepo.getUniqueByRequestId(requestId);
};

export const persistApprovalRequestSnapshot = ({
  approvalRepo,
  session,
  method,
  event,
}: {
  approvalRepo: ReturnType<typeof createApprovalRepo>;
  session: Pick<SessionRecord, "codexThreadId" | "discordThreadId">;
  method: ApprovalRequestMethod;
  event: ApprovalRequestEvent;
}) => {
  const approvalKey = buildApprovalKey({
    turnId: event.turnId,
    itemId: event.itemId,
    approvalId: event.approvalId,
  });
  const snapshot = extractApprovalSnapshotFromRequest({
    method,
    event,
  });
  const decisionCatalog = extractApprovalDecisionCatalogFromRequest({
    method,
    event,
  });

  approvalRepo.insert({
    approvalKey,
    requestId: event.requestId,
    codexThreadId: session.codexThreadId,
    discordThreadId: session.discordThreadId,
    status: "pending",
    decisionCatalog,
    ...snapshot,
  });

  const approval = approvalRepo.getByApprovalKey(approvalKey);

  if (!approval) {
    throw new Error(`Approval ${approvalKey} was not persisted`);
  }

  return approval;
};

const buildApprovalCustomId = (approvalKey: string, decisionKey: string) => {
  const decisionToken = approvalDecisionCustomIdTokenByKey[decisionKey]
    ?? encodeURIComponent(decisionKey);

  return `${approvalButtonPrefix}|${encodeURIComponent(approvalKey)}|${decisionToken}`;
};

const parseApprovalCustomId = (customId: string) => {
  const [prefix, encodedApprovalKey, encodedDecisionKey] = customId.split("|");

  if (
    prefix !== approvalButtonPrefix ||
    !encodedApprovalKey ||
    !encodedDecisionKey
  ) {
    return null;
  }

  const decodedDecisionKey = approvalDecisionKeyByCustomIdToken[encodedDecisionKey]
    ?? decodeURIComponent(encodedDecisionKey);

  return {
    approvalKey: decodeURIComponent(encodedApprovalKey),
    decisionKey: decodedDecisionKey === "approve" ? "accept" : decodedDecisionKey,
  } as const;
};

const approvalDecisionStatus = (
  providerDecision: string,
): ApprovalStatus => {
  if (providerDecision === "decline") {
    return "declined";
  }

  if (providerDecision === "cancel") {
    return "canceled";
  }

  return "approved";
};

const resolveApprovalInteractionDecision = ({
  approval,
  decisionKey,
}: {
  approval: Pick<ApprovalRecord, "decisionCatalog">;
  decisionKey: string;
}): {
  providerDecision: string;
  status: ApprovalStatus;
  replyPayload: unknown;
} | null => {
  const persistedDecisions = parseStoredApprovalDecisions(approval.decisionCatalog);
  const persistedDecision = persistedDecisions?.find(
    (decision) =>
      decision.key === decisionKey
      && isSupportedApprovalProviderDecision(decision.providerDecision),
  );
  const providerDecision =
    persistedDecision?.providerDecision
    ?? (isSupportedApprovalProviderDecision(decisionKey)
      ? decisionKey
      : null);

  if (!providerDecision) {
    return null;
  }

  return {
    providerDecision,
    status: approvalDecisionStatus(providerDecision),
    replyPayload: persistedDecision?.replyPayload ?? { decision: providerDecision },
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

export const shouldIgnoreManagedThreadMessage = (
  message: Pick<Message, "author" | "system">,
) => {
  return message.author.bot || message.system;
};

export const shouldProjectManagedSessionDiscordSurface = (
  session: Pick<SessionRecord, "lifecycleState">,
) => {
  return session.lifecycleState === "active";
};

const withStartupSessionTimeout = async <TResult>(
  operation: Promise<TResult>,
  timeoutMs: number | undefined,
  message: string,
) => {
  if (timeoutMs === undefined) {
    return operation;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

export const restoreManagedSessionSubscriptions = async ({
  sessions,
  perSessionTimeoutMs,
  resumeThread,
  onThreadMissing,
  onWarning,
}: {
  sessions: Array<Pick<SessionRecord, "codexThreadId" | "lifecycleState">>;
  perSessionTimeoutMs?: number;
  resumeThread: (params: { threadId: string }) => Promise<unknown>;
  onThreadMissing?: (
    session: Pick<SessionRecord, "codexThreadId" | "lifecycleState">,
  ) => Promise<void> | void;
  onWarning?: (
    session: Pick<SessionRecord, "codexThreadId" | "lifecycleState">,
    error: unknown,
  ) => Promise<void> | void;
}) => {
  for (const session of sessions) {
    if (!shouldProjectManagedSessionDiscordSurface(session)) {
      continue;
    }

    try {
      await withStartupSessionTimeout(
        (async () => {
          try {
            await resumeThread({
              threadId: session.codexThreadId,
            });
          } catch (error) {
            const disposition = getSnapshotReconciliationFailureDisposition(error);

            if (disposition === "degrade-thread-missing") {
              await onThreadMissing?.(session);
              return;
            }

            throw error;
          }
        })(),
        perSessionTimeoutMs,
        `Startup restore timed out for managed session ${session.codexThreadId}.`,
      );
    } catch (error) {
      const disposition = getSnapshotReconciliationFailureDisposition(error);

      if (disposition === "warn") {
        await onWarning?.(session, error);
      }
    }
  }
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
  bootstrapThreadTitle,
}: {
  session: Pick<SessionRecord, "lifecycleState">;
  markIdle: () => void;
  updateStatusCard: () => Promise<void>;
  syncTranscriptSnapshot: () => Promise<void>;
  bootstrapThreadTitle?: () => Promise<void>;
}) => {
  markIdle();

  if (!shouldProjectManagedSessionDiscordSurface(session)) {
    return;
  }

  await updateStatusCard();
  await syncTranscriptSnapshot();
  await bootstrapThreadTitle?.();
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
      | "cwd"
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
        `workdir \`${session.cwd}\``,
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
  rememberPendingApproval,
}: {
  runtimeState: SessionRuntimeState;
  pendingApprovals: Array<Pick<
    ApprovalRecord,
    | "approvalKey"
    | "requestId"
    | "status"
    | "displayTitle"
      | "commandPreview"
      | "justification"
      | "cwd"
      | "requestKind"
      | "decisionCatalog"
      | "resolvedProviderDecision"
      | "resolvedBySurface"
      | "resolvedElsewhere"
  >>;
  latestApproval?: Pick<
    ApprovalRecord,
    | "approvalKey"
    | "requestId"
    | "status"
    | "displayTitle"
    | "commandPreview"
    | "justification"
    | "cwd"
    | "requestKind"
    | "decisionCatalog"
    | "resolvedProviderDecision"
    | "resolvedBySurface"
    | "resolvedElsewhere"
  > | null;
  upsertApprovalMessage: (
    approval: Pick<
      ApprovalRecord,
      | "approvalKey"
      | "requestId"
      | "status"
      | "displayTitle"
      | "commandPreview"
      | "justification"
      | "cwd"
      | "requestKind"
      | "decisionCatalog"
      | "resolvedProviderDecision"
      | "resolvedBySurface"
      | "resolvedElsewhere"
    >,
  ) => Promise<void> | void;
  rememberPendingApproval?: (
    approval: Pick<
      ApprovalRecord,
      | "approvalKey"
      | "requestId"
      | "status"
      | "displayTitle"
      | "commandPreview"
      | "justification"
      | "cwd"
      | "requestKind"
      | "decisionCatalog"
      | "resolvedProviderDecision"
      | "resolvedBySurface"
      | "resolvedElsewhere"
    >,
  ) => Promise<void> | void;
}) => {
  if (runtimeState !== "waiting-approval") {
    return undefined;
  }

  const pendingApproval = pendingApprovals.find((approval) => approval.status === "pending");

  if (!pendingApproval) {
    if (latestApproval && latestApproval.status !== "pending") {
      if (latestApproval.status !== "resolved") {
        await rememberPendingApproval?.(latestApproval);
      }
      await upsertApprovalMessage(latestApproval);
      return latestApproval.approvalKey;
    }

    throw new Error(
      "waiting-approval session has no pending approval to reconcile",
    );
  }

  await rememberPendingApproval?.(pendingApproval);
  await upsertApprovalMessage(pendingApproval);
  return pendingApproval.approvalKey;
};

export const reconcileApprovalResolutionSurface = async ({
  approval,
  session,
  currentThreadMessage,
  currentThreadMessagePromise,
  recoverThreadMessage,
  sendThreadMessage,
}: {
  approval: Pick<
    ApprovalRecord,
    | "approvalKey"
    | "requestId"
    | "status"
    | "displayTitle"
    | "commandPreview"
    | "justification"
    | "cwd"
    | "requestKind"
    | "decisionCatalog"
    | "resolvedProviderDecision"
    | "resolvedBySurface"
    | "resolvedElsewhere"
  >;
  session?: Pick<SessionRecord, "lifecycleState"> | null;
  currentThreadMessage?: ApprovalLifecycleMessage;
  currentThreadMessagePromise?: Promise<ApprovalLifecycleMessage | undefined>;
  recoverThreadMessage: () => Promise<ApprovalLifecycleMessage | undefined>;
  sendThreadMessage: (payload: DiscordChannelMessagePayload) => Promise<ApprovalLifecycleMessage | undefined>;
}) => {
  return upsertApprovalLifecycleMessage({
    currentMessage: currentThreadMessage,
    currentMessagePromise: currentThreadMessagePromise,
    recoverMessage: recoverThreadMessage,
    payload: renderApprovalLifecyclePayload({
      approvalKey: approval.approvalKey,
      approval,
    }),
    sendMessage:
      session && shouldProjectManagedSessionDiscordSurface(session)
        ? sendThreadMessage
        : async () => undefined,
  });
};

export const resumeManagedSession = async ({
  session,
  materializeThread,
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
  materializeThread?: () => Promise<void> | void;
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
  await materializeThread?.();
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

export const seedLegacyWorkspaceBootstrap = (
  db: Database,
  config: AppConfig,
  bootstrap: LegacyWorkspaceBootstrap | null,
) => {
  const workspaceRepo = createWorkspaceRepo(db);
  const workdirRepo = createWorkdirRepo(db);

  if (!bootstrap) {
    return;
  }

  if (!workspaceRepo.getById(config.workspace.id)) {
    workspaceRepo.insert({
      id: config.workspace.id,
      name: config.workspace.name,
      rootPath: bootstrap.workspaceRoot,
    });
  }

  for (const workdir of bootstrap.workdirs) {
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

const formatPathValidationMessage = (message: string) => {
  return message.endsWith(".") ? message : `${message}.`;
};

const resolveSessionPathValidationError = (message: string): DiscordCommandResult => {
  return {
    reply: {
      content: formatPathValidationMessage(message),
      ephemeral: true,
    },
  };
};

const normalizeSessionPathForRuntime = (path: string, homeDir: string = homedir()) => {
  try {
    return {
      ok: true as const,
      cwd: normalizeSessionPathInput(path, homeDir),
    };
  } catch (error) {
    return {
      ok: false as const,
      message:
        error instanceof Error
          ? formatPathValidationMessage(error.message)
          : "Session path is invalid.",
    };
  }
};

const validateSessionPathPolicy = (cwd: string) => {
  if (pathContainsHiddenDirectory(cwd)) {
    return {
      ok: false as const,
      message: "Session path must not include hidden directories.",
    };
  }

  return {
    ok: true as const,
    cwd,
  };
};

const validateSessionPathDirectory = (cwd: string) => {
  if (!existsSync(cwd)) {
    return {
      ok: false as const,
      message: `Directory does not exist: \`${cwd}\`.`,
    };
  }

  const stats = statSync(cwd);

  if (!stats.isDirectory()) {
    return {
      ok: false as const,
      message: `Path is not a directory: \`${cwd}\`.`,
    };
  }

  return {
    ok: true as const,
    cwd,
  };
};

const resolveSessionPathForCommand = (path: string, homeDir: string = homedir()) => {
  const normalized = normalizeSessionPathForRuntime(path, homeDir);

  if (!normalized.ok) {
    return {
      ok: false as const,
      result: resolveSessionPathValidationError(normalized.message),
    };
  }

  const policy = validateSessionPathPolicy(normalized.cwd);

  if (!policy.ok) {
    return {
      ok: false as const,
      result: resolveSessionPathValidationError(policy.message),
    };
  }

  const directory = validateSessionPathDirectory(policy.cwd);

  if (!directory.ok) {
    return {
      ok: false as const,
      result: resolveSessionPathValidationError(directory.message),
    };
  }

  return {
    ok: true as const,
    cwd: directory.cwd,
  };
};

const resolveSessionPathForAutocomplete = (
  path?: string,
  homeDir: string = homedir(),
) => {
  if (!path) {
    return undefined;
  }

  const normalized = normalizeSessionPathForRuntime(path, homeDir);

  if (!normalized.ok) {
    return undefined;
  }

  const policy = validateSessionPathPolicy(normalized.cwd);

  if (!policy.ok) {
    return undefined;
  }

  const directory = validateSessionPathDirectory(policy.cwd);

  return directory.ok ? directory.cwd : undefined;
};

const resolveCurrentWorkdirCommandError = (message: string): DiscordCommandResult => {
  return {
    reply: {
      content: message,
      ephemeral: true,
    },
  };
};

const resolveResumeAttachFailure = (
  codexThreadId: string,
  error: unknown,
): DiscordCommandResult => {
  return {
    reply: {
      content:
        error instanceof Error
          ? `Attach failed for \`${codexThreadId}\`: ${error.message}.`
          : `Attach failed for \`${codexThreadId}\`.`,
      ephemeral: true,
    },
  };
};

const resolveStoredCurrentWorkdirForCommand = ({
  currentWorkdirRepo,
  actorId,
  guildId,
  channelId,
}: {
  currentWorkdirRepo: Pick<
    ReturnType<typeof createCurrentWorkdirRepo>,
    "get" | "upsert"
  >;
  actorId: string;
  guildId: string;
  channelId: string;
}): { ok: true; cwd: string } | { ok: false; result: DiscordCommandResult } => {
  const currentWorkdir = currentWorkdirRepo.get({
    guildId,
    channelId,
    discordUserId: actorId,
  });

  if (!currentWorkdir) {
    return {
      ok: false as const,
      result: resolveCurrentWorkdirCommandError(
        "No current workdir. Run /workdir first.",
      ),
    };
  }

  const directory = validateSessionPathDirectory(currentWorkdir.cwd);

  if (!directory.ok) {
    return {
      ok: false as const,
      result: resolveCurrentWorkdirCommandError(
        "Current workdir is no longer available. Run /workdir again.",
      ),
    };
  }

  return {
    ok: true as const,
    cwd: directory.cwd,
  };
};

export const sortResumePickerThreads = (threads: CodexThread[]) => {
  return [...threads].sort((left, right) => {
    const leftUpdatedAt =
      getNormalizedThreadActivityTime(left) ?? Number.NEGATIVE_INFINITY;
    const rightUpdatedAt =
      getNormalizedThreadActivityTime(right) ?? Number.NEGATIVE_INFINITY;

    if (leftUpdatedAt !== rightUpdatedAt) {
      return rightUpdatedAt - leftUpdatedAt;
    }

    const leftCreatedAt =
      normalizeThreadTimestamp(left.createdAt) ?? Number.NEGATIVE_INFINITY;
    const rightCreatedAt =
      normalizeThreadTimestamp(right.createdAt) ?? Number.NEGATIVE_INFINITY;

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

const resumeAutocompleteLocalSearchPageSize = 100;

const matchesResumeSessionQuery = (thread: CodexThread, query: string) => {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return true;
  }

  const preview = thread.preview.trim().toLowerCase();
  const name = typeof thread.name === "string"
    ? thread.name.trim().toLowerCase()
    : "";

  return (
    thread.id.toLowerCase().includes(normalizedQuery)
    || preview.includes(normalizedQuery)
    || name.includes(normalizedQuery)
  );
};

const listAllResumeThreadsForSearch = async ({
  codexClient,
  cwd,
  archived,
}: {
  codexClient: Pick<JsonRpcClient, "listThreads">;
  cwd: string;
  archived: boolean;
}) => {
  const threads: CodexThread[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  while (true) {
    const page = await codexClient.listThreads({
      cwd,
      archived,
      searchTerm: null,
      limit: resumeAutocompleteLocalSearchPageSize,
      sortKey: "updated_at",
      ...(cursor ? { cursor } : {}),
    });

    threads.push(...page.data);

    if (page.data.length === 0 || !page.nextCursor || seenCursors.has(page.nextCursor)) {
      return threads;
    }

    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
};

const searchResumeThreadsLocally = async ({
  codexClient,
  cwd,
  query,
}: {
  codexClient: Pick<JsonRpcClient, "listThreads">;
  cwd: string;
  query: string;
}) => {
  const [activeThreads, archivedThreads] = await Promise.all([
    listAllResumeThreadsForSearch({
      codexClient,
      cwd,
      archived: false,
    }),
    listAllResumeThreadsForSearch({
      codexClient,
      cwd,
      archived: true,
    }),
  ]);

  return [
    ...activeThreads,
    ...archivedThreads,
  ].filter((thread) => matchesResumeSessionQuery(thread, query));
};

const truncateWithEllipsis = (value: string, maxLength: number) => {
  if (maxLength <= 0) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength === 1) {
    return "…";
  }

  return `${value.slice(0, maxLength - 1)}…`;
};

const maxDiscordThreadNameLength = 100;
export const RESUME_WORKDIR_HINT_VALUE = "__codehelm_resume_workdir_hint__";

export const formatResumeWorkdirHintChoice = ({
  cwd,
  homeDir,
}: {
  cwd: string;
  homeDir: string;
}): DiscordAutocompleteChoice => {
  const displayPath = formatSessionPathForDisplay(cwd, homeDir);
  const prefix = "Current workdir: ";
  const suffix = " · Use /workdir to switch directories";
  const maxPathLength = maxDiscordThreadNameLength - prefix.length - suffix.length;

  return {
    name: `${prefix}${truncateWithEllipsis(displayPath, maxPathLength)}${suffix}`,
    value: RESUME_WORKDIR_HINT_VALUE,
  };
};

const isResumeWorkdirHintValue = (value: string) => {
  return value === RESUME_WORKDIR_HINT_VALUE;
};

const formatBootstrapThreadTitleCandidate = (value: string) => {
  const normalized = normalizeBootstrapThreadTitle(value);

  return normalized
    ? truncateWithEllipsis(normalized, maxDiscordThreadNameLength)
    : null;
};

const extractBootstrapThreadTitleFromTurn = (turn?: CodexTurn) => {
  if (!turn) {
    return null;
  }

  for (const item of turn.items) {
    if (item.type !== "userMessage") {
      continue;
    }

    const userMessage = item as CodexUserMessageItem;
    const content = Array.isArray(userMessage.content) ? userMessage.content : [];
    const text = content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    const title = formatBootstrapThreadTitleCandidate(text);

    if (title) {
      return title;
    }
  }

  return null;
};

const extractBootstrapThreadTitleFromTurns = (turns?: CodexTurn[]) => {
  if (!turns) {
    return null;
  }

  for (const turn of turns) {
    const title = extractBootstrapThreadTitleFromTurn(turn);

    if (title) {
      return title;
    }
  }

  return null;
};

const formatResumeThreadIdSuffix = (threadId: string) => {
  const shortIdLength = 9;

  if (threadId.length <= shortIdLength) {
    return threadId;
  }

  return `…${threadId.slice(-shortIdLength)}`;
};

const formatResumeThreadUpdatedAt = (thread: CodexThread, now: number) => {
  return formatRelativeThreadTime(getNormalizedThreadActivityTime(thread), now);
};

export const formatResumeSessionAutocompleteChoice = (
  thread: CodexThread,
  now: number = Date.now(),
) => {
  const updatedAtText = formatResumeThreadUpdatedAt(thread, now);
  const conversation = formatResumeThreadTitle(thread);
  const fullThreadId = thread.id;
  const maxNameLength = 100;
  const separator = " · ";
  const fullPrefix = `${updatedAtText}${separator}`;
  const fullSuffix = `${separator}${fullThreadId}`;
  const maxConversationLengthWithFullId =
    maxNameLength - fullPrefix.length - fullSuffix.length;

  if (maxConversationLengthWithFullId > 0) {
    return {
      name: `${fullPrefix}${truncateWithEllipsis(
        conversation,
        maxConversationLengthWithFullId,
      )}${fullSuffix}`,
      value: thread.id,
    };
  }

  const shortThreadId = formatResumeThreadIdSuffix(thread.id);
  const shortSuffix = `${separator}${shortThreadId}`;
  const maxConversationLengthWithShortId =
    maxNameLength - fullPrefix.length - shortSuffix.length;

  if (maxConversationLengthWithShortId > 0) {
    return {
      name: `${fullPrefix}${truncateWithEllipsis(
        conversation,
        maxConversationLengthWithShortId,
      )}${shortSuffix}`,
      value: thread.id,
    };
  }

  return {
    name: truncateWithEllipsis(
      `${updatedAtText}${separator}${shortThreadId}`,
      maxNameLength,
    ),
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
  cwd,
  homeDir = homedir(),
  now = Date.now(),
}: {
  codexClient: Pick<JsonRpcClient, "listThreads">;
  query: string;
  cwd?: string;
  homeDir?: string;
  now?: number;
}) => {
  if (!cwd) {
    return [];
  }

  const searchTerm = query.trim() || null;
  const listParams = {
    cwd,
    searchTerm,
    limit: 25,
    sortKey: "updated_at" as const,
  };
  const [activeThreads, archivedThreads] = await Promise.all([
    codexClient.listThreads({
      ...listParams,
      archived: false,
    }),
    codexClient.listThreads({
      ...listParams,
      archived: true,
    }),
  ]);
  const threads = [
    ...activeThreads.data,
    ...archivedThreads.data,
  ];
  const searchedThreads = searchTerm && threads.length === 0
    ? await searchResumeThreadsLocally({
        codexClient,
        cwd,
        query: searchTerm,
      })
    : threads;
  const hintChoice = formatResumeWorkdirHintChoice({
    cwd,
    homeDir,
  });

  return [
    hintChoice,
    ...sortResumePickerThreads(searchedThreads)
      .slice(0, 24)
      .map((thread) => formatResumeSessionAutocompleteChoice(thread, now)),
  ];
};

export const maybeBootstrapManagedThreadTitle = async ({
  client,
  session,
  readThreadSnapshot,
  completedTurn,
}: {
  client: Client;
  session: Pick<SessionRecord, "codexThreadId" | "discordThreadId">;
  readThreadSnapshot: () => Promise<ThreadReadResult>;
  completedTurn?: CodexTurn;
}) => {
  const channel = await client.channels.fetch(session.discordThreadId);

  if (!isRenamableThreadChannel(channel) || channel.name !== session.codexThreadId) {
    return;
  }

  const snapshot = await readThreadSnapshot();
  const nextTitle =
    extractBootstrapThreadTitleFromTurns(snapshot.thread.turns)
    ?? extractBootstrapThreadTitleFromTurn(completedTurn);

  if (!nextTitle || nextTitle === channel.name) {
    return;
  }

  await channel.setName(
    nextTitle,
    "CodeHelm bootstrapped the thread title from the first user message",
  );
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

const sessionThreadTitle = (codexThreadId: string) => {
  return codexThreadId;
};

type BoundSessionThread = {
  id: string;
  send(payload: DiscordChannelMessagePayload): Promise<unknown>;
  delete(reason?: string): Promise<unknown>;
};

type CreateControlChannelServicesDeps = {
  config: AppConfig;
  homeDir?: string;
  codexClient: Pick<JsonRpcClient, "listThreads" | "startThread">;
  currentWorkdirRepo: Pick<
    ReturnType<typeof createCurrentWorkdirRepo>,
    "get" | "upsert"
  >;
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
  sessionPath,
  codexThreadId,
  title,
  starterText,
  onBound,
  onRollback,
}: {
  client: Client;
  controlChannelId: string;
  createVisibleSessionThread: CreateControlChannelServicesDeps["createVisibleSessionThread"];
  sessionPath: string;
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
          path: sessionPath,
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

type CreateManagedSessionCommandServicesDeps = {
  sessionRepo: ReturnType<typeof createSessionRepo>;
  approvalRepo: ReturnType<typeof createApprovalRepo>;
  codexClient: Pick<JsonRpcClient, "getAccountRateLimits" | "listModels" | "resumeThread" | "turnInterrupt">;
  getDiscordClient: () => Client;
  ensureTranscriptRuntime: (codexThreadId: string) => TranscriptRuntime;
  readThreadForSnapshotReconciliation: (input: {
    threadId: string;
  }) => Promise<ThreadReadResult>;
  resolveActiveTurnId: (input: {
    session: Pick<SessionRecord, "codexThreadId">;
    runtime: Pick<TranscriptRuntime, "activeTurnId">;
  }) => Promise<string | undefined>;
  sendTextToChannel: (
    client: Client,
    channelId: string,
    payload: string,
  ) => Promise<unknown>;
};

const resolveManagedSessionThreadCommandSession = ({
  sessionRepo,
  channelId,
}: {
  sessionRepo: ReturnType<typeof createSessionRepo>;
  channelId: string;
}) => {
  const session = sessionRepo.getByDiscordThreadId(channelId);

  if (!session) {
    return {
      session: undefined,
      error: {
        reply: {
          content: "This command only works inside a managed session thread.",
          ephemeral: true,
        },
      } satisfies DiscordCommandResult,
    } as const;
  }

  if (session.lifecycleState !== "active") {
    return {
      session: undefined,
      error: {
        reply: {
          content: "This managed session thread is not currently active.",
          ephemeral: true,
        },
      } satisfies DiscordCommandResult,
    } as const;
  }

  return {
    session,
    error: undefined,
  };
};

const isManagedSessionCommandActorAllowed = ({
  actorId,
  session,
}: {
  actorId: string;
  session: Pick<SessionRecord, "ownerDiscordUserId">;
}) => {
  return canControlSession({
    viewerId: actorId,
    ownerId: session.ownerDiscordUserId,
  });
};

export const createManagedSessionCommandServices = ({
  sessionRepo,
  approvalRepo,
  codexClient,
  getDiscordClient,
  ensureTranscriptRuntime,
  readThreadForSnapshotReconciliation,
  resolveActiveTurnId,
  sendTextToChannel,
}: CreateManagedSessionCommandServicesDeps): ManagedSessionCommandServices => {
  return {
    async status({ channelId }) {
      const resolved = resolveManagedSessionThreadCommandSession({
        sessionRepo,
        channelId,
      });

      if (!resolved.session) {
        return resolved.error!;
      }

      let session = resolved.session;
      const runtime = ensureTranscriptRuntime(session.codexThreadId);
      let effectiveState = session.state;
      let limitsSummary = "data not available yet";

      try {
        session = await hydrateSessionModelMetadataFromResume({
          session,
          sessionRepo,
          resumeThread: (params) => codexClient.resumeThread(params),
        });
      } catch {
        session = sessionRepo.getByDiscordThreadId(session.discordThreadId) ?? session;
      }

      try {
        const snapshot = await readThreadForSnapshotReconciliation({
          threadId: session.codexThreadId,
        });

        effectiveState = inferSessionStateFromThreadStatus(snapshot.thread.status);
        runtime.activeTurnId = readActiveTurnIdFromThreadReadResult(snapshot);
      } catch {
        effectiveState = session.state;
      }

      try {
        limitsSummary = summarizeManagedSessionRateLimits(
          await codexClient.getAccountRateLimits(),
        );
      } catch (error) {
        limitsSummary = isUnavailableAccountRateLimitsError(error)
          ? "not available for this account"
          : "data not available yet";
      }

      return {
        reply: {
          content: renderManagedSessionStatus({
            session,
            effectiveState,
            tokenUsageSummary: formatManagedSessionTokenUsageSummary(
              runtime.threadTokenUsage,
            ),
            contextWindowSummary: formatManagedSessionContextWindowSummary(
              runtime.threadTokenUsage,
            ),
            limitsSummary,
          }),
        },
      };
    },
    async interrupt({ actorId, channelId }) {
      const resolved = resolveManagedSessionThreadCommandSession({
        sessionRepo,
        channelId,
      });

      if (!resolved.session) {
        return resolved.error!;
      }

      const session = resolved.session;

      if (!isManagedSessionCommandActorAllowed({ actorId, session })) {
        return {
          reply: {
            content: "Only the session owner can interrupt this managed session.",
            ephemeral: true,
          },
        };
      }

      const runtime = ensureTranscriptRuntime(session.codexThreadId);
      let effectiveState: SessionRuntimeState = coercePersistedSessionRuntimeState(session.state);
      let activeTurnId: string | undefined;
      let snapshotRecovered = false;

      try {
        const snapshot = await readThreadForSnapshotReconciliation({
          threadId: session.codexThreadId,
        });

        effectiveState = inferSessionStateFromThreadStatus(snapshot.thread.status);
        activeTurnId = readActiveTurnIdFromThreadReadResult(snapshot);
        runtime.activeTurnId = activeTurnId;
        snapshotRecovered = true;

        if (session.state !== "degraded") {
          sessionRepo.updateState(session.discordThreadId, effectiveState);
        }
      } catch {
        activeTurnId = runtime.activeTurnId;
      }

      if (effectiveState !== "running" && effectiveState !== "waiting-approval") {
        return {
          reply: {
            content: "Session is not currently running.",
          },
        };
      }

      if (!activeTurnId && !snapshotRecovered) {
        activeTurnId = await resolveActiveTurnId({
          session,
          runtime,
        });
      }

      if (!activeTurnId) {
        activeTurnId = undefined;
      }

      if (!activeTurnId) {
        return {
          reply: {
            content: "Couldn't interrupt the current turn because the active turn could not be resolved.",
          },
        };
      }

      try {
        await codexClient.turnInterrupt({
          threadId: session.codexThreadId,
          turnId: activeTurnId,
        });
      } catch {
        return {
          reply: {
            content: "Failed to interrupt the current turn.",
          },
        };
      }

      const discarded = clearQueuedSteerInputs({
        runtime,
      });

      return {
        reply: {
          content:
            discarded.length > 0
              ? `Interrupted current turn. Discarded ${discarded.length} queued steer messages.`
              : "Interrupted current turn.",
        },
      };
    },
  };
};

type HandleManagedSessionModelComponentDeps = {
  interaction: StringSelectMenuInteraction;
  sessionRepo: ReturnType<typeof createSessionRepo>;
  codexClient: Pick<JsonRpcClient, "listModels" | "resumeThread">;
  getDiscordClient: () => Client;
  sendTextToChannel: (
    client: Client,
    channelId: string,
    payload: string,
  ) => Promise<unknown>;
};

export const handleManagedSessionModelComponentInteraction = async ({
  interaction,
  sessionRepo: _sessionRepo,
  codexClient: _codexClient,
  getDiscordClient: _getDiscordClient,
  sendTextToChannel: _sendTextToChannel,
}: HandleManagedSessionModelComponentDeps) => {
  const parsed = parseManagedModelCustomId(interaction.customId);

  if (!parsed) {
    return false;
  }

  void parsed;
  await interaction.reply({
    content: "Model selection is no longer supported in CodeHelm. Use `/status` to inspect the current session.",
    flags: MessageFlags.Ephemeral,
  });
  return true;
};

export const createControlChannelServices = ({
  config,
  homeDir = homedir(),
  codexClient,
  currentWorkdirRepo,
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
    async setCurrentWorkdir({ actorId, guildId, channelId, path }) {
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return contextError;
      }

      const resolvedPath = resolveSessionPathForCommand(path ?? "", homeDir);

      if (!resolvedPath.ok) {
        return resolvedPath.result;
      }

      currentWorkdirRepo.upsert({
        guildId,
        channelId,
        discordUserId: actorId,
        cwd: resolvedPath.cwd,
      });

      return {
        reply: {
          content: `Current workdir: \`${formatSessionPathForDisplay(
            resolvedPath.cwd,
            homeDir,
          )}\``,
        },
      };
    },
    async createSession(input) {
      const { actorId, guildId, channelId } = input;
      const path = (input as { path?: string }).path;
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return contextError;
      }

      const resolvedPath = path
        ? resolveSessionPathForCommand(path, homeDir)
        : resolveStoredCurrentWorkdirForCommand({
            currentWorkdirRepo,
            actorId,
            guildId,
            channelId,
          });

      if (!resolvedPath.ok) {
        return resolvedPath.result;
      }

      const started = await codexClient.startThread({
        cwd: resolvedPath.cwd,
      });
      const authoritativeCwd = started.cwd;
      const displayPath = formatSessionPathForDisplay(authoritativeCwd, homeDir);
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
          sessionPath: displayPath,
          codexThreadId,
          title: sessionThreadTitle(codexThreadId),
          starterText: `Opening session for \`${authoritativeCwd}\`.`,
          onBound: async (boundThread) => {
            const sessionModelMetadata =
              started.model !== undefined || started.reasoningEffort !== undefined
                ? {
                    modelOverride: started.model ?? null,
                    reasoningEffortOverride: started.reasoningEffort ?? null,
                  }
                : {};
            sessionRepo.insert({
              discordThreadId: boundThread.id,
              codexThreadId,
              ownerDiscordUserId: actorId,
              cwd: authoritativeCwd,
              state: "idle",
              ...sessionModelMetadata,
            });
            ensureTranscriptRuntime(codexThreadId);
          },
          onRollback: rollbackBinding,
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
          content: `Created session <#${thread.id}> for \`${displayPath}\`.`,
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
    async autocompleteSessionPaths({ guildId, channelId, path, query }) {
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return [];
      }

      return buildPathBrowserChoices({
        inputPath: path ?? query,
        homeDir,
      });
    },
    async autocompleteResumeSessions(input) {
      const { actorId, guildId, channelId, query } = input;
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return [];
      }

      const currentWorkdirResult = resolveStoredCurrentWorkdirForCommand({
        currentWorkdirRepo,
        actorId,
        guildId,
        channelId,
      });

      if (!currentWorkdirResult.ok) {
        return [];
      }

      return buildResumeSessionAutocompleteChoices({
        codexClient,
        query,
        cwd: currentWorkdirResult.cwd,
        homeDir,
      });
    },
    async resumeSession(input) {
      const { actorId, guildId, channelId, codexThreadId } = input;
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return contextError;
      }

      const currentWorkdirResult = resolveStoredCurrentWorkdirForCommand({
        currentWorkdirRepo,
        actorId,
        guildId,
        channelId,
      });

      if (!currentWorkdirResult.ok) {
        return currentWorkdirResult.result;
      }

      const currentWorkdir = currentWorkdirResult.cwd;
      const displayPath = formatSessionPathForDisplay(currentWorkdir, homeDir);

      if (isResumeWorkdirHintValue(codexThreadId)) {
        let hasSessionsInCurrentWorkdir: boolean;

        try {
          const listParams = {
            cwd: currentWorkdir,
            searchTerm: null,
            limit: 1,
            sortKey: "updated_at" as const,
          };
          const [activeThreads, archivedThreads] = await Promise.all([
            codexClient.listThreads({
              ...listParams,
              archived: false,
            }),
            codexClient.listThreads({
              ...listParams,
              archived: true,
            }),
          ]);
          hasSessionsInCurrentWorkdir =
            activeThreads.data.length > 0 || archivedThreads.data.length > 0;
        } catch {
          return {
            reply: {
              content:
                `Current workdir: \`${displayPath}\`. This hint row could not verify ` +
                "available sessions right now. Try /session-resume again or run /workdir to confirm the directory.",
              ephemeral: true,
            },
          };
        }

        return {
          reply: {
            content: hasSessionsInCurrentWorkdir
              ? `Current workdir: \`${displayPath}\`. This row is only a hint and does not select a session. Run /workdir to switch directories, then choose a session below.`
              : `Current workdir: \`${displayPath}\`. This row is only a hint and does not select a session. No sessions are available in this directory. Run /workdir to switch directories or use /session-new to create one here.`,
            ephemeral: true,
          },
        };
      }

      let snapshot: ThreadReadResult;

      try {
        snapshot = await readThreadForSnapshotReconciliation({
          threadId: codexThreadId,
        });
      } catch (error) {
        if (!isMissingCodexThreadError(error)) {
          return resolveResumeAttachFailure(codexThreadId, error);
        }

        return {
          reply: {
            content:
              `Session \`${codexThreadId}\` was not found in current workdir \`${displayPath}\`.`,
              ephemeral: true,
          },
        };
      }

      if (snapshot.thread.cwd !== currentWorkdir) {
        return {
          reply: {
            content:
              `Session \`${codexThreadId}\` belongs to \`${snapshot.thread.cwd}\`, ` +
              `not \`${currentWorkdir}\`.`,
            ephemeral: true,
          },
        };
      }

      try {
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
            sessionPath: displayPath,
            codexThreadId,
            title: sessionThreadTitle(codexThreadId),
            starterText: `Attaching Codex session \`${codexThreadId}\` for \`${currentWorkdir}\`.`,
            onBound: async (boundThread) => {
              sessionRepo.insert({
                discordThreadId: boundThread.id,
                codexThreadId,
                ownerDiscordUserId: actorId,
                cwd: currentWorkdir,
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
            sessionPath: displayPath,
            codexThreadId,
            title: sessionThreadTitle(codexThreadId),
            starterText: `Attaching Codex session \`${codexThreadId}\` for \`${currentWorkdir}\`.`,
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

        const syncedRuntimeState = inferSyncedSessionRuntimeState(snapshot.thread);
        const shouldResumeIntoDiscordThread =
          attachmentKind === "reopen"
          || syncedRuntimeState === "idle"
          || syncedRuntimeState === "waiting-approval";
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
        return resolveResumeAttachFailure(codexThreadId, error);
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

export const applyDiscordReplyReference = ({
  payload,
  replyToMessageId,
}: {
  payload: DiscordChannelMessagePayload;
  replyToMessageId?: string;
}): DiscordCreateChannelMessagePayload => {
  if (!replyToMessageId) {
    return payload;
  }

  return {
    ...payload,
    reply: {
      messageReference: replyToMessageId,
      failIfNotExists: false,
    },
  };
};

const sendTextToChannel = async (
  client: Client,
  channelId: string,
  payload: string | DiscordChannelMessagePayload,
  options: {
    replyToMessageId?: string;
  } = {},
) => {
  return sendChannelMessage(
    client,
    channelId,
    typeof payload === "string" ? { content: payload } : payload,
    options,
  );
};

const sendChannelMessage = async (
  client: Client,
  channelId: string,
  payload: DiscordChannelMessagePayload,
  options: {
    replyToMessageId?: string;
  } = {},
) => {
  const channel = await client.channels.fetch(channelId);

  if (!isSendableChannel(channel)) {
    return undefined;
  }

  return channel.send(applyDiscordReplyReference({
    payload,
    replyToMessageId: options.replyToMessageId,
  }));
};

const collectMessageTextSignals = (message: unknown) => {
  if (!message || typeof message !== "object") {
    return [] as string[];
  }

  const record = message as {
    content?: unknown;
    embeds?: Array<{
      title?: unknown;
      description?: unknown;
      footer?: {
        text?: unknown;
      };
    }>;
  };
  const texts: string[] = [];

  if (typeof record.content === "string" && record.content.trim().length > 0) {
    texts.push(record.content);
  }

  for (const embed of record.embeds ?? []) {
    if (typeof embed.title === "string" && embed.title.trim().length > 0) {
      texts.push(embed.title);
    }

    if (
      typeof embed.description === "string" &&
      embed.description.trim().length > 0
    ) {
      texts.push(embed.description);
    }

    if (
      typeof embed.footer?.text === "string" &&
      embed.footer.text.trim().length > 0
    ) {
      texts.push(embed.footer.text);
    }
  }

  return texts;
};

const inferThreadLanguage = async ({
  client,
  channelId,
  fallbackTexts = [],
}: {
  client: Client;
  channelId: string;
  fallbackTexts?: string[];
}): Promise<ThreadLanguage> => {
  const texts = [...fallbackTexts];

  try {
    const channel = await client.channels.fetch(channelId);

    if (isStatusCardRecoverableChannel(channel)) {
      const messages = await channel.messages.fetch({ limit: 10 });
      const history = messages instanceof Map
        ? [...messages.values()]
        : [...messages];

      for (const message of history) {
        texts.push(...collectMessageTextSignals(message));
      }
    }
  } catch {
    return detectThreadLanguageFromTexts(texts);
  }

  return detectThreadLanguageFromTexts(texts);
};

const sendApprovalDeliveryFailureNotice = async ({
  client,
  channelId,
}: {
  client: Client;
  channelId: string;
}) => {
  const language = await inferThreadLanguage({
    client,
    channelId,
  });

  await sendTextToChannel(
    client,
    channelId,
    renderApprovalDeliveryFailureText(language),
  );
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
  approval: {
    approvalKey: string;
    requestId: string;
    threadMessageId?: string | null;
    allowRequestIdFallback?: boolean;
  },
) => {
  type RecoverableApprovalCandidate = ApprovalLifecycleMessage & StatusCardCandidate;
  const channel = await client.channels.fetch(channelId);

  if (!isStatusCardRecoverableChannel(channel)) {
    return undefined;
  }

  const toRecoverableApprovalCandidate = (
    message: Message<boolean>,
  ): RecoverableApprovalCandidate => {
    const components: RecoverableMessageComponentRow[] = [];

    for (const row of message.components) {
      if (!("components" in row) || !Array.isArray(row.components)) {
        continue;
      }

      components.push({
        components: row.components.map((component: { customId?: unknown }) => ({
          customId:
            typeof component.customId === "string"
              ? component.customId
              : undefined,
        })),
      });
    }

    return {
      id: message.id,
      content: message.content,
      editable: message.editable,
      components,
      author: {
        bot: message.author?.bot,
        id: message.author?.id,
      },
      edit: message.edit.bind(message),
    };
  };

  if (approval.threadMessageId) {
    try {
      const message = await (
        channel.messages as {
          fetch(messageId: string): Promise<Message<boolean>>;
        }
      ).fetch(approval.threadMessageId);
      const recoverable = toRecoverableApprovalCandidate(message);

      if (
        recoverable.editable
        && recoverable.author?.bot === true
        && (
          client.user?.id === undefined
          || recoverable.author.id === client.user.id
        )
      ) {
        return recoverable;
      }
    } catch {}
  }

  return recoverApprovalLifecycleMessageFromHistory<RecoverableApprovalCandidate>({
    approvalKey: approval.approvalKey,
    requestId: approval.requestId,
    botUserId: client.user?.id,
    allowRequestIdFallback: approval.allowRequestIdFallback,
    fetchPage: async (options) => {
      const fetched = await channel.messages.fetch(options);
      const messages = fetched instanceof Map ? [...fetched.values()] : [...fetched];
      const recoverableMessages: RecoverableApprovalCandidate[] = messages.map(
        toRecoverableApprovalCandidate,
      );

      return recoverableMessages;
    },
  });
};

const persistApprovalThreadMessageReference = ({
  approvalRepo,
  approvalKey,
  message,
}: {
  approvalRepo: ReturnType<typeof createApprovalRepo>;
  approvalKey: string;
  message?: ApprovalLifecycleMessage;
}) => {
  if (!message?.id) {
    return;
  }

  approvalRepo.updateThreadMessageId(approvalKey, message.id);
};

const shouldAllowLegacyApprovalRequestIdFallback = ({
  approvalRepo,
  approval,
}: {
  approvalRepo: ReturnType<typeof createApprovalRepo>;
  approval: Pick<
    ApprovalRecord,
    | "approvalKey"
    | "requestId"
    | "status"
    | "threadMessageId"
  >;
}) => {
  if (approval.status === "pending" || approval.threadMessageId) {
    return false;
  }

  return approvalRepo.getUniqueByRequestId(approval.requestId)?.approvalKey
    === approval.approvalKey;
};

const renderStaleApprovalInteractionText = ({
  approval,
}: {
  approval: Pick<
    ApprovalRecord,
    | "requestId"
    | "status"
    | "displayTitle"
    | "commandPreview"
    | "justification"
    | "cwd"
    | "requestKind"
    | "resolvedBySurface"
    | "resolvedElsewhere"
  >;
}) => {
  return truncateApprovalText(
    renderApprovalStaleStatusText({
      approval: {
        requestId: approval.requestId,
        status: approval.status,
        displayTitle: approval.displayTitle ?? "That approval",
        commandPreview: approval.commandPreview,
        justification: approval.justification,
        cwd: approval.cwd,
        requestKind: approval.requestKind,
        resolvedBySurface: approval.resolvedBySurface,
        resolvedElsewhere: approval.resolvedElsewhere,
      },
    }),
    2000,
  );
};

export const handleApprovalInteraction = async ({
  interaction,
  client,
  sessionRepo,
  approvalRepo,
  inFlightApprovalKeys,
  runtimeProviderRequestIdsByApprovalKey,
  afterPersistTerminalDecision,
}: {
  interaction: ButtonInteraction;
  client: JsonRpcClient;
  sessionRepo: ReturnType<typeof createSessionRepo>;
  approvalRepo: ReturnType<typeof createApprovalRepo>;
  inFlightApprovalKeys?: Set<string>;
  runtimeProviderRequestIdsByApprovalKey?: Map<string, JsonRpcId>;
  afterPersistTerminalDecision?: (
    approval: ApprovalRecord,
  ) => Promise<void> | void;
}) => {
  const parsed = parseApprovalCustomId(interaction.customId);

  if (!parsed) {
    return false;
  }

  const approvalRecord = approvalRepo.getByApprovalKey(parsed.approvalKey);

  if (!approvalRecord) {
    await interaction.reply({
      content: "That approval is no longer available.",
      ephemeral: true,
      allowedMentions: approvalAllowedMentions,
    });
    return true;
  }

  const session = sessionRepo.getByDiscordThreadId(approvalRecord.discordThreadId);

  if (!session || session.ownerDiscordUserId !== interaction.user.id) {
    await interaction.reply({
      content: "Only the session owner can resolve this approval.",
      ephemeral: true,
      allowedMentions: approvalAllowedMentions,
    });
    return true;
  }

  if (!shouldAcceptApprovalInteraction(approvalRecord.status)) {
    await interaction.reply({
      content: renderStaleApprovalInteractionText({
        approval: approvalRecord,
      }),
      ephemeral: true,
      allowedMentions: approvalAllowedMentions,
    });
    return true;
  }

  const nextDecision = resolveApprovalInteractionDecision({
    approval: approvalRecord,
    decisionKey: parsed.decisionKey,
  });

  if (!nextDecision) {
    await interaction.reply({
      content: "That approval no longer offers that decision.",
      ephemeral: true,
      allowedMentions: approvalAllowedMentions,
    });
    return true;
  }

  const approvalKey = parsed.approvalKey;

  if (inFlightApprovalKeys?.has(approvalKey)) {
    await interaction.reply({
      content: "That approval is already being resolved.",
      ephemeral: true,
      allowedMentions: approvalAllowedMentions,
    });
    return true;
  }

  inFlightApprovalKeys?.add(approvalKey);

  try {
    const providerRequestId = resolveProviderRequestIdForApproval({
      approval: approvalRecord,
      approvalRepo,
      runtimeProviderRequestIdsByApprovalKey,
    });

    await interaction.deferUpdate();
    logger.debug("Resolving approval interaction", {
      approvalKey: approvalRecord.approvalKey,
      storedRequestId: approvalRecord.requestId,
      providerRequestId,
      storedRequestIdType: typeof approvalRecord.requestId,
      providerRequestIdType: typeof providerRequestId,
      providerDecision: nextDecision.providerDecision,
      discordUserId: interaction.user.id,
    });
    await client.replyToServerRequest({
      requestId: providerRequestId,
      result: nextDecision.replyPayload,
    });
    approvalRepo.insert({
      approvalKey: approvalRecord.approvalKey,
      requestId: approvalRecord.requestId,
      providerRequestId,
      codexThreadId: approvalRecord.codexThreadId,
      discordThreadId: approvalRecord.discordThreadId,
      status: nextDecision.status,
      resolvedProviderDecision: nextDecision.providerDecision,
      resolvedBySurface: "discord_thread",
      resolvedElsewhere: false,
      resolvedByDiscordUserId: interaction.user.id,
      resolution: nextDecision.status,
    });
    const storedApproval = approvalRepo.getByApprovalKey(approvalRecord.approvalKey);

    if (storedApproval) {
      await afterPersistTerminalDecision?.(storedApproval);
    }
  } finally {
    inFlightApprovalKeys?.delete(approvalKey);
  }

  return true;
};

type StartCodeHelmMode = "foreground" | "background";

type StartedCodeHelmHandle = {
  config: AppConfig;
  stop: () => Promise<void>;
  [key: string]: unknown;
};

export type StartCodeHelmOptions = {
  acquireInstanceLock?: typeof acquireInstanceLock;
  clearRuntimeState?: typeof clearRuntimeState;
  installSignalHandlers?: boolean;
  legacyWorkspaceBootstrap?: ReturnType<typeof resolveLegacyWorkspaceBootstrap>;
  mode?: StartCodeHelmMode;
  startManagedCodexAppServer?: typeof startManagedCodexAppServer;
  startRuntime?: (
    config: AppConfig,
    options: {
      installSignalHandlers?: boolean;
      legacyWorkspaceBootstrap?: ReturnType<typeof resolveLegacyWorkspaceBootstrap>;
      onCoreReady?: () => Promise<void> | void;
    },
  ) => Promise<StartedCodeHelmHandle>;
  stateDir?: string;
  writeRuntimeSummary?: typeof writeRuntimeSummary;
};

const isPidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const startCodeHelmRuntime = async (
  config: AppConfig,
  options: {
    installSignalHandlers?: boolean;
    legacyWorkspaceBootstrap?: ReturnType<typeof resolveLegacyWorkspaceBootstrap>;
    onCoreReady?: () => Promise<void> | void;
  } = {},
) => {
  const installSignalHandlers = options.installSignalHandlers ?? true;
  const legacyWorkspaceBootstrap = options.legacyWorkspaceBootstrap ?? null;
  const db = createDatabaseClient(config.databasePath);

  applyMigrations(db);
  seedLegacyWorkspaceBootstrap(db, config, legacyWorkspaceBootstrap);

  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);
  const currentWorkdirRepo = createCurrentWorkdirRepo(db);
  const codexClient = new JsonRpcClient(config.codex.appServerUrl);
  const approvalThreadMessages = new Map<string, ApprovalLifecycleState>();
  const runtimeApprovalKeysByRequestId = new Map<string, Set<string>>();
  const runtimeProviderRequestIdsByApprovalKey = new Map<string, JsonRpcId>();
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
    const activeTurnId = readActiveTurnIdFromThreadReadResult(snapshot);
    runtime.activeTurnId = activeTurnId;

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
    replyToMessageId,
  }: {
    session: Pick<
      SessionRecord,
      | "codexThreadId"
      | "state"
      | "discordThreadId"
      | "modelOverride"
      | "reasoningEffortOverride"
    >;
    content: string;
    request: Omit<StartTurnParams, "input"> & {
      input: CodexTurnInput;
    };
    replyToMessageId?: string;
  }) => {
    const runtime = ensureTranscriptRuntime(session.codexThreadId);
    const pendingInput: PendingLocalInput = {
      kind: "start",
      text: content,
      replyToMessageId,
    };

    runtime.pendingLocalInputs.push(pendingInput);
    runtime.pendingDiscordInputReplyMessageIds.push(replyToMessageId);

    try {
      await startTurnWithThreadResumeRetry({
        request: applySessionStartTurnOverrides({
          session,
          request,
        }),
        startTurn: async (params) => codexClient.startTurn(params),
        resumeThread: async ({ threadId }) => codexClient.resumeThread({
          threadId,
        }),
        resumeBeforeStart: true,
      });
      const refreshedSession = sessionRepo.getByCodexThreadId(session.codexThreadId);

      if (refreshedSession) {
        updateSessionStateIfWritable(refreshedSession, "running");
      } else {
        sessionRepo.updateState(session.discordThreadId, "running");
      }
    } catch (error) {
      removePendingLocalInput({
        runtime,
        pendingInput,
      });
      if (replyToMessageId && runtime.pendingDiscordInputReplyMessageIds.at(-1) === replyToMessageId) {
        runtime.pendingDiscordInputReplyMessageIds.pop();
      }
      throw error;
    }
  };

  const resolveManagedSessionActiveTurnId = async ({
    session,
    runtime,
  }: {
    session: Pick<SessionRecord, "codexThreadId">;
    runtime: Pick<TranscriptRuntime, "activeTurnId">;
  }) => {
    if (runtime.activeTurnId) {
      return runtime.activeTurnId;
    }

    const snapshot = await readThreadForSnapshotReconciliation({
      codexClient,
      threadId: session.codexThreadId,
    });
    const recoveredTurnId = readActiveTurnIdFromThreadReadResult(snapshot);

    if (recoveredTurnId) {
      runtime.activeTurnId = recoveredTurnId;
    }

    return recoveredTurnId;
  };

  const steerTurnFromDiscordInput = async ({
    session,
    content,
  }: {
    session: Pick<SessionRecord, "codexThreadId">;
    content: string;
  }) => {
    const runtime = ensureTranscriptRuntime(session.codexThreadId);
    const activeTurnId = await resolveManagedSessionActiveTurnId({
      session,
      runtime,
    });

    if (!activeTurnId) {
      throw new Error("Active turn could not be resolved");
    }

    const pendingInput: PendingLocalInput = {
      kind: "steer",
      text: content,
      turnId: activeTurnId,
    };

    runtime.pendingLocalInputs.push(pendingInput);

    try {
      await codexClient.turnSteer({
        threadId: session.codexThreadId,
        expectedTurnId: activeTurnId,
        input: [{ type: "text", text: content }],
      });
    } catch (error) {
      removePendingLocalInput({
        runtime,
        pendingInput,
      });
      throw error;
    }
  };

  const resumeManagedSessionIntoDiscordThread = async (
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>,
  ) => {
    const discord = requireDiscordClient(discordClient);

    return resumeManagedSession({
      session,
      materializeThread: async () => {
        const resumed = await codexClient.resumeThread({
          threadId: session.codexThreadId,
        });

        if (resumed.model !== undefined || resumed.reasoningEffort !== undefined) {
          sessionRepo.updateModelOverride(session.discordThreadId, {
            modelOverride: resumed.model ?? null,
            reasoningEffortOverride: resumed.reasoningEffort ?? null,
          });
        }
      },
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
          rememberPendingApproval: async (approval) => {
            rememberRuntimeApprovalRequest(
              runtimeApprovalKeysByRequestId,
              approval,
              {
                providerRequestId:
                  approvalRepo.getProviderRequestId(approval.approvalKey)
                  ?? approval.requestId,
                runtimeProviderRequestIdsByApprovalKey,
              },
            );
          },
          upsertApprovalMessage: async (approval) => {
            const { approvalKey, requestId } = approval;
            const lifecycleState = approvalThreadMessages.get(approvalKey) ?? {};
            const threadMessageId =
              approvalRepo.getByApprovalKey(approvalKey)?.threadMessageId ?? null;
            const allowRequestIdFallback = shouldAllowLegacyApprovalRequestIdFallback({
              approvalRepo,
              approval: {
                approvalKey,
                requestId,
                status: approval.status,
                threadMessageId,
              },
            });
            try {
              const pendingMessagePromise = upsertApprovalLifecycleMessage({
                currentMessage: lifecycleState.message,
                currentMessagePromise: lifecycleState.pendingMessage,
                recoverMessage: async () =>
                  recoverApprovalLifecycleMessage(
                    discord,
                    session.discordThreadId,
                    {
                      approvalKey,
                      requestId,
                      threadMessageId,
                      allowRequestIdFallback,
                    },
                  ),
                payload: renderApprovalLifecyclePayload({
                  approvalKey,
                  approval,
                }),
                sendMessage: async (payload) =>
                  sendTextToChannel(
                    discord,
                    session.discordThreadId,
                    payload,
                  ),
              });
              approvalThreadMessages.set(approvalKey, lifecycleState);
              const threadMessage = await finalizeApprovalLifecycleMessageState({
                state: lifecycleState,
                operation: pendingMessagePromise,
              });

              if (threadMessage) {
                lifecycleState.message = threadMessage;
                persistApprovalThreadMessageReference({
                  approvalRepo,
                  approvalKey,
                  message: threadMessage,
                });
              }
            } catch (error) {
              try {
                await sendApprovalDeliveryFailureNotice({
                  client: discord,
                  channelId: session.discordThreadId,
                });
              } catch {}

              throw error;
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
    currentWorkdirRepo,
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
  const managedSessionServices = createManagedSessionCommandServices({
    sessionRepo,
    approvalRepo,
    codexClient,
    getDiscordClient: () => requireDiscordClient(discordClient),
    ensureTranscriptRuntime,
    readThreadForSnapshotReconciliation: ({ threadId }) =>
      readThreadForSnapshotReconciliation({
        codexClient,
        threadId,
      }),
    resolveActiveTurnId: ({ session, runtime }) =>
      resolveManagedSessionActiveTurnId({
        session,
        runtime,
      }),
    sendTextToChannel,
  });

  const bot = createDiscordBot({
    token: config.discord.botToken,
    services,
    logger,
    onUnhandledInteraction: async (interaction) => {
      await handleManagedSessionCommand(interaction, managedSessionServices);
    },
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

    await finalizeLiveTurnProcessMessage({
      currentMessage: current.message,
      currentMessagePromise: current.pendingCreate,
      rendered: undefined,
      sendRendered: async (payload) => {
        await sendChannelMessage(discord, session.discordThreadId, payload);
      },
    });
    runtime.seenItemIds.delete(getProcessTranscriptEntryId(turnId));
    runtime.turnProcessMessages.delete(turnId);
  };

  const publishAgentDelta = async ({
    session,
    itemId,
  }: {
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    itemId: string;
  }) => {
    if (session.state === "degraded" || !shouldProjectManagedSessionDiscordSurface(session)) {
      return;
    }
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
    const resolvedTurnId =
      turnId
      ?? runtime.itemTurnIds.get(item.id)
      ?? runtime.activeTurnId;

    if (!shouldProjectManagedSessionDiscordSurface(session)) {
      runtime.itemTurnIds.delete(item.id);
      return;
    }

    if (item.phase === "commentary") {
      runtime.itemTurnIds.delete(item.id);
      return;
    }

    await finalizeCompletedAssistantTranscriptReply({
      runtime,
      turnId: resolvedTurnId,
      item,
      sendMessage: async (payload, options) =>
        sendChannelMessage(discord, session.discordThreadId, payload, options),
    });
  };

  bot.client.on(Events.MessageCreate, (message) => {
    void (async () => {
      if (shouldIgnoreManagedThreadMessage(message)) {
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
              replyToMessageId: message.id,
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
        return;
      }

      if (decision.kind === "reject") {
        await message.reply(
          "Session is waiting for approval. New follow-up input is blocked until that approval is resolved.",
        );
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

      if (decision.kind === "steer-turn") {
        try {
          await steerTurnFromDiscordInput({
            session,
            content: message.content,
          });
        } catch (error) {
          logger.warn("Failed to steer managed session turn from Discord message", {
            discordThreadId: session.discordThreadId,
            codexThreadId: session.codexThreadId,
            error,
          });
          await message.reply(
            "Couldn't queue follow-up input for the current turn.",
          );
        }
        return;
      }

      await startTurnFromDiscordInput({
        session,
        content: message.content,
        replyToMessageId: message.id,
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
    if (interaction.isStringSelectMenu()) {
      void handleManagedSessionModelComponentInteraction({
        interaction,
        sessionRepo,
        codexClient,
        getDiscordClient: () => requireDiscordClient(discordClient),
        sendTextToChannel,
      }).catch((error) => {
        logger.error("Managed session model interaction failed", error);
      });
      return;
    }

    if (!interaction.isButton()) {
      return;
    }

    void handleApprovalInteraction({
      interaction,
      client: codexClient,
      sessionRepo,
      approvalRepo,
      inFlightApprovalKeys: approvalResolutionsInFlight,
      runtimeProviderRequestIdsByApprovalKey,
      afterPersistTerminalDecision: async (storedApproval) => {
        const session = sessionRepo.getByDiscordThreadId(storedApproval.discordThreadId);
        const lifecycleState = approvalThreadMessages.get(storedApproval.approvalKey) ?? {};
        const allowRequestIdFallback = shouldAllowLegacyApprovalRequestIdFallback({
          approvalRepo,
          approval: storedApproval,
        });
        const resolvedMessagePromise = reconcileApprovalResolutionSurface({
          approval: storedApproval,
          session,
          currentThreadMessage: lifecycleState.message,
          currentThreadMessagePromise: lifecycleState.pendingMessage,
          recoverThreadMessage: async () =>
            recoverApprovalLifecycleMessage(
              bot.client,
              storedApproval.discordThreadId,
              {
              approvalKey: storedApproval.approvalKey,
              requestId: storedApproval.requestId,
              threadMessageId: storedApproval.threadMessageId,
              allowRequestIdFallback,
            },
          ),
        sendThreadMessage: async (payload) =>
          sendTextToChannel(
            bot.client,
            storedApproval.discordThreadId,
            payload,
          ),
        });
        approvalThreadMessages.set(storedApproval.approvalKey, lifecycleState);
        const threadMessage = await finalizeApprovalLifecycleMessageState({
          state: lifecycleState,
          operation: resolvedMessagePromise,
        });

        if (threadMessage) {
          lifecycleState.message = threadMessage;
          persistApprovalThreadMessageReference({
            approvalRepo,
            approvalKey: storedApproval.approvalKey,
            message: threadMessage,
          });
        }
      },
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

      rememberPendingDiscordReplyReferenceForTurn({
        runtime,
        turnId,
      });

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
          return;
        }
        return;
      }

      if (!isCommandExecutionItem(item)) {
        return;
      }

      if (!shouldProjectManagedSessionDiscordSurface(session)) {
        return;
      }
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

        if (!shouldRenderCompletedAssistantReplyImmediately(item.phase)) {
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

      if (!shouldRelayLiveCompletedItemToTranscript(item)) {
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
        session,
        itemId,
      });
    })().catch((error) => {
      logger.error("Failed to process item/agentMessage/delta event", error);
    });
  });

  codexClient.on("thread/tokenUsage/updated", (params) => {
    const codexThreadId = readThreadIdFromEvent(params);

    if (!codexThreadId || !params.tokenUsage) {
      return;
    }

    const session = sessionRepo.getByCodexThreadId(codexThreadId);

    if (!session) {
      return;
    }

    const runtime = ensureTranscriptRuntime(session.codexThreadId);
    runtime.threadTokenUsage = params.tokenUsage;
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
        runtime.turnReplyMessageIds.delete(turnId);

        if (runtime.activeTurnId === turnId) {
          runtime.activeTurnId = undefined;
        }

        await finalizeTurnProcessState({
          discord: bot.client,
          session,
          turnId,
        });
      }

      remapSeenTranscriptEntriesToCompletedTurn({
        runtime,
        turn: params.turn,
      });

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
        bootstrapThreadTitle: async () => {
          await maybeBootstrapManagedThreadTitle({
            client: bot.client,
            session,
            completedTurn: params.turn,
            readThreadSnapshot: async () =>
              readThreadForSnapshotReconciliation({
                codexClient,
                threadId: session.codexThreadId,
              }),
          });
        },
      });
    })().catch((error) => {
      logger.error("Failed to process turn/completed event", error);
    });
  });

  const handleApprovalRequestEvent = (
    method: ApprovalRequestMethod,
    event: ApprovalRequestEvent,
  ) => {
    void (async () => {
      const approvalId = readApprovalEventString(event, "approvalId");
      const session = sessionRepo.getByCodexThreadId(event.threadId);

      if (!session) {
        logger.debug("Ignoring approval request for unknown session", {
          method,
          requestId: String(event.requestId),
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
          approvalId,
        });
        return;
      }

      const approval = persistApprovalRequestSnapshot({
        approvalRepo,
        session,
        method,
        event,
      });

      logger.debug("Received approval request event", {
        method,
        requestId: approval.requestId,
        approvalKey: approval.approvalKey,
        threadId: event.threadId,
        turnId: event.turnId,
        itemId: event.itemId,
        approvalId,
        sessionState: session.state,
        displayTitle: approval.displayTitle,
        commandPreview: approval.commandPreview,
        justification: approval.justification,
        cwd: approval.cwd,
        requestKind: approval.requestKind,
        decisionCatalog: approval.decisionCatalog,
      });

      if (!shouldHandlePersistedApprovalRequestAtRuntime(approval)) {
        return;
      }

      rememberRuntimeApprovalRequest(
        runtimeApprovalKeysByRequestId,
        approval,
        {
          providerRequestId: event.requestId,
          runtimeProviderRequestIdsByApprovalKey,
        },
      );
      const approvalKey = approval.approvalKey;

      const isReadOnlySession = session.state === "degraded";

      if (!isReadOnlySession) {
        updateSessionStateIfWritable(session, "waiting-approval");
      }
      if (!shouldProjectManagedSessionDiscordSurface(session)) {
        logger.debug("Skipping approval Discord projection for non-projectable session", {
          method,
          requestId: approval.requestId,
          approvalKey,
          discordThreadId: session.discordThreadId,
          sessionState: session.state,
          lifecycleState: session.lifecycleState,
        });
        return;
      }

      const runtime = ensureTranscriptRuntime(session.codexThreadId);
      const approvalTurnId = event.turnId ?? runtime.activeTurnId;

      if (approvalTurnId) {
        runtime.activeTurnId = approvalTurnId;
      }

      if (!isReadOnlySession) {
        await updateStatusCard({
          discord: bot.client,
          session,
          state: "waiting-approval",
        });
      }
      const lifecycleState = approvalThreadMessages.get(approvalKey) ?? {};
      try {
        const pendingMessagePromise = upsertApprovalLifecycleMessage({
          currentMessage: lifecycleState.message,
          currentMessagePromise: lifecycleState.pendingMessage,
          recoverMessage: async () =>
            recoverApprovalLifecycleMessage(
              bot.client,
              session.discordThreadId,
              {
                approvalKey,
                requestId: approval.requestId,
                threadMessageId: approval.threadMessageId,
              },
            ),
          payload: renderApprovalLifecyclePayload({
            approvalKey,
            approval,
          }),
          sendMessage: async (payload) =>
            sendTextToChannel(
              bot.client,
              session.discordThreadId,
              payload,
            ),
        });
        approvalThreadMessages.set(approvalKey, lifecycleState);
        const threadMessage = await finalizeApprovalLifecycleMessageState({
          state: lifecycleState,
          operation: pendingMessagePromise,
        });

        if (threadMessage) {
          lifecycleState.message = threadMessage;
          persistApprovalThreadMessageReference({
            approvalRepo,
            approvalKey,
            message: threadMessage,
          });
        }
      } catch (error) {
        stopDiscordTypingPulse(runtime);

        try {
          await sendApprovalDeliveryFailureNotice({
            client: bot.client,
            channelId: session.discordThreadId,
          });
        } catch {}

        throw error;
      }
    })().catch((error) => {
      logger.error("Failed to process approval request event", error);
    });
  };

  for (const method of approvalRequestMethods) {
    codexClient.on(method, (event) => {
      handleApprovalRequestEvent(method, event);
    });
  }

  codexClient.on("serverRequest/resolved", (event) => {
    void (async () => {
      const requestId = String(event.requestId);
      const approvalRecord = resolveStoredApprovalForResolvedEvent({
        approvalRepo,
        runtimeApprovalKeysByRequestId,
        event,
      });

      if (!approvalRecord) {
        return;
      }

      const outcome = applyApprovalResolutionSignal(
        {
          requestId: approvalRecord.requestId,
          status: approvalRecord.status,
          displayTitle: approvalRecord.displayTitle,
          commandPreview: approvalRecord.commandPreview,
          justification: approvalRecord.justification,
          cwd: approvalRecord.cwd,
          requestKind: approvalRecord.requestKind,
          resolvedProviderDecision: approvalRecord.resolvedProviderDecision,
          resolvedBySurface: approvalRecord.resolvedBySurface,
          resolvedElsewhere: approvalRecord.resolvedElsewhere,
        },
        {
          type: "serverRequest/resolved",
          requestId,
        },
      );

      approvalRepo.insert({
        approvalKey: approvalRecord.approvalKey,
        requestId,
        providerRequestId: event.requestId,
        codexThreadId: approvalRecord.codexThreadId,
        discordThreadId: approvalRecord.discordThreadId,
        status: outcome.approval.status,
        displayTitle: approvalRecord.displayTitle,
        commandPreview: approvalRecord.commandPreview,
        justification: approvalRecord.justification,
        cwd: approvalRecord.cwd,
        requestKind: approvalRecord.requestKind,
        decisionCatalog: approvalRecord.decisionCatalog,
        resolvedProviderDecision: approvalRecord.resolvedProviderDecision,
        resolvedBySurface:
          outcome.approval.status === "resolved"
            ? "codex_remote"
            : approvalRecord.resolvedBySurface,
        resolvedElsewhere:
          outcome.approval.status === "resolved"
            ? true
            : approvalRecord.resolvedElsewhere,
      });
      forgetRuntimeApprovalRequest(
        runtimeApprovalKeysByRequestId,
        approvalRecord,
        runtimeProviderRequestIdsByApprovalKey,
      );
      const storedApproval = approvalRepo.getByApprovalKey(approvalRecord.approvalKey);

      if (!storedApproval) {
        return;
      }

      const session = sessionRepo.getByDiscordThreadId(storedApproval.discordThreadId);

      const lifecycleState = approvalThreadMessages.get(storedApproval.approvalKey) ?? {};
      const allowRequestIdFallback = shouldAllowLegacyApprovalRequestIdFallback({
        approvalRepo,
        approval: storedApproval,
      });
      const resolvedMessagePromise = reconcileApprovalResolutionSurface({
        approval: storedApproval,
        session,
        currentThreadMessage: lifecycleState.message,
        currentThreadMessagePromise: lifecycleState.pendingMessage,
        recoverThreadMessage: async () =>
          recoverApprovalLifecycleMessage(
            bot.client,
            storedApproval.discordThreadId,
            {
              approvalKey: storedApproval.approvalKey,
              requestId: storedApproval.requestId,
              threadMessageId: storedApproval.threadMessageId,
              allowRequestIdFallback,
            },
          ),
        sendThreadMessage: async (payload) =>
          sendTextToChannel(
            bot.client,
            storedApproval.discordThreadId,
            payload,
          ),
      });
      approvalThreadMessages.set(storedApproval.approvalKey, lifecycleState);
      const threadMessage = await finalizeApprovalLifecycleMessageState({
        state: lifecycleState,
        operation: resolvedMessagePromise,
      });

      if (threadMessage) {
        lifecycleState.message = threadMessage;
        persistApprovalThreadMessageReference({
          approvalRepo,
          approvalKey: storedApproval.approvalKey,
          message: threadMessage,
        });
      }
    })().catch((error) => {
      logger.error("Failed to process serverRequest/resolved event", error);
    });
  });

  await codexClient.initialize();
  await registerGuildCommands(
    config,
    [
      ...buildControlChannelCommands(),
      ...buildManagedSessionCommands(),
    ],
  );
  await bot.start();

  await options.onCoreReady?.();

  const warmManagedSessionsAtStartup = async () => {
    await restoreManagedSessionSubscriptions({
      sessions: sessionRepo.listAll(),
      perSessionTimeoutMs: startupSessionWarmupTimeoutMs,
      resumeThread: async ({ threadId }) =>
        codexClient.resumeThread({
          threadId,
        }),
      onThreadMissing: async (session) => {
        const refreshedSession = sessionRepo.getByCodexThreadId(session.codexThreadId);

        if (!refreshedSession || shuttingDown) {
          return;
        }

        await degradeSessionToReadOnly({
          discord: bot.client,
          session: refreshedSession,
          reason: "thread_missing",
        });
      },
      onWarning: async (session, error) => {
        logger.warn(
          `Failed to restore thread event subscription for managed session ${session.codexThreadId}`,
          error,
        );
      },
    });

    for (const session of sessionRepo.listAll()) {
      if (shuttingDown) {
        return;
      }

      if (!shouldProjectManagedSessionDiscordSurface(session)) {
        continue;
      }

      try {
        await withStartupSessionTimeout(
          seedTranscriptRuntimeFromSnapshot(session),
          startupSessionWarmupTimeoutMs,
          `Startup transcript seed timed out for managed session ${session.codexThreadId}.`,
        );
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
  };

  void warmManagedSessionsAtStartup().catch((error) => {
    logger.error("Managed session startup warmup failed", error);
  });

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

  if (installSignalHandlers) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void stop().catch((error) => {
          logger.error(`Failed to stop cleanly on ${signal}`, error);
        });
      });
    }
  }

  return {
    config,
    db,
    bot,
    codexClient,
    stop,
  };
};

export const startCodeHelm = async (
  config: AppConfig,
  options: StartCodeHelmOptions = {},
) => {
  const acquireLock = options.acquireInstanceLock ?? acquireInstanceLock;
  const clearState = options.clearRuntimeState ?? clearRuntimeState;
  const mode = options.mode ?? "foreground";
  const installSignalHandlers = options.installSignalHandlers ?? true;
  const publishRuntimeSummary = options.writeRuntimeSummary ?? writeRuntimeSummary;
  const startManagedServer = options.startManagedCodexAppServer ?? startManagedCodexAppServer;
  const startRuntime = options.startRuntime ?? startCodeHelmRuntime;
  let runtimeConfig = config;
  let managedCodexAppServer: ManagedCodexAppServer | undefined;
  let runtimeHandle: StartedCodeHelmHandle | undefined;
  let didPublishRuntimeSummary = false;
  let shuttingDown = false;

  const publishReadyRuntimeSummary = () => {
    if (!options.stateDir || didPublishRuntimeSummary) {
      return;
    }

    publishRuntimeSummary({
      stateDir: options.stateDir,
      summary: {
        pid: process.pid,
        mode,
        discord: {
          guildId: runtimeConfig.discord.guildId,
          controlChannelId: runtimeConfig.discord.controlChannelId,
          connected: true,
        },
        codex: {
          appServerAddress: runtimeConfig.codex.appServerUrl,
          pid: managedCodexAppServer?.pid,
          running: true,
          startupState: "ready",
        },
        startedAt: new Date().toISOString(),
      },
    });
    didPublishRuntimeSummary = true;
  };

  if (options.stateDir) {
    acquireLock({
      stateDir: options.stateDir,
      pid: process.pid,
      isPidAlive,
    });
  }

  try {
    if (runtimeConfig.codex.appServerUrl === DEFAULT_CODEX_APP_SERVER_URL) {
      const managedAppServerCwd = mode === "background"
        ? resolveCodeHelmPaths().appServerWorkdir
        : process.cwd();
      managedCodexAppServer = await startManagedServer({
        cwd: managedAppServerCwd,
      });
      runtimeConfig = {
        ...runtimeConfig,
        codex: {
          ...runtimeConfig.codex,
          appServerUrl: managedCodexAppServer.address,
        },
      };
    }

    runtimeHandle = await startRuntime(runtimeConfig, {
      installSignalHandlers: false,
      legacyWorkspaceBootstrap: options.legacyWorkspaceBootstrap,
      onCoreReady: publishReadyRuntimeSummary,
    });

    publishReadyRuntimeSummary();
  } catch (error) {
    if (runtimeHandle) {
      await runtimeHandle.stop().catch((stopError) => {
        logger.error("Failed to stop CodeHelm runtime after startup failure", stopError);
      });
    }

    if (managedCodexAppServer) {
      await managedCodexAppServer.stop().catch((stopError) => {
        logger.error("Failed to stop managed Codex App Server after startup failure", stopError);
      });
    }

    if (options.stateDir) {
      clearState({ stateDir: options.stateDir });
    }

    throw error;
  }

  const stop = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    try {
      await runtimeHandle?.stop();
    } finally {
      if (managedCodexAppServer) {
        await managedCodexAppServer.stop({
          timeoutMs: managedCodexAppServerStopTimeoutMs,
        }).catch((error) => {
          logger.error("Failed to stop managed Codex App Server cleanly", error);
        });
      }

      if (options.stateDir) {
        clearState({ stateDir: options.stateDir });
      }
    }
  };

  if (installSignalHandlers) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void stop().catch((error) => {
          logger.error(`Failed to stop cleanly on ${signal}`, error);
        });
      });
    }
  }

  return {
    ...runtimeHandle,
    config: runtimeConfig,
    stop,
  };
};

export const loadAndStartCodeHelmFromProcess = async (
  env: Record<string, string | undefined> = Bun.env,
) => {
  const config = parseConfig(env);

  if (config.DISCORD_APP_ID === DEFAULT_DISCORD_APP_ID) {
    throw new Error("CodeHelm configuration is not ready for daemon startup: DISCORD_APP_ID is unresolved");
  }

  return startCodeHelm(config, {
    installSignalHandlers: true,
    legacyWorkspaceBootstrap: resolveLegacyWorkspaceBootstrap(env),
    mode: env.CODE_HELM_DAEMON_MODE === "background" ? "background" : "foreground",
    stateDir: resolveCodeHelmPaths({ env }).stateDir,
  });
};

if (import.meta.main) {
  void loadAndStartCodeHelmFromProcess(process.env as Record<string, string | undefined>)
    .then(({ config }) => {
      logger.info(`CodeHelm started for Discord app ${config.discord.appId}`);
    })
    .catch((error) => {
      logger.error("CodeHelm failed to start", error);
      process.exitCode = 1;
    });
}
