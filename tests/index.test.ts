import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  CodexThread,
  CodexThreadStatus,
  ThreadListParams,
} from "../src/codex/protocol-types";
import { CodexSupervisorError } from "../src/codex/supervisor";
import { resolveCodeHelmPaths } from "../src/cli/paths";
import { DEFAULT_CODEX_APP_SERVER_URL, type AppConfig } from "../src/config";
import type { SessionResumeState } from "../src/domain/types";
import { createDatabaseClient } from "../src/db/client";
import { applyMigrations } from "../src/db/migrate";
import { createCurrentWorkdirRepo } from "../src/db/repos/current-workdirs";
import {
  createApprovalRepo,
  type ApprovalRecord,
} from "../src/db/repos/approvals";
import { createSessionRepo } from "../src/db/repos/sessions";
import { createWorkdirRepo } from "../src/db/repos/workdirs";
import { createWorkspaceRepo } from "../src/db/repos/workspaces";
import {
  applyManagedTurnCompletion,
  applyStatusCardUpdate,
  canAcceptManagedSessionThreadInput,
  closeManagedSession,
  clearQueuedSteerInputs,
  createManagedSessionCommandServices,
  reconcileResumedApprovalState,
  reconcileApprovalResolutionSurface,
  createControlChannelServices,
  resolveCloseSessionCommand,
  resolveSyncSessionCommand,
  applyDiscordReplyReference,
  describeSessionAccessMode,
  formatManagedSessionList,
  getSessionRecoveryProbeOutcome,
  handleArchivedManagedSessionThreadMessage,
  handleManagedThreadDeletion,
  markTranscriptItemsSeen,
  maybeBootstrapManagedThreadTitle,
  pollSessionRecovery,
  readThreadForSnapshotReconciliation,
  shouldLogSnapshotReconciliationWarning,
  shouldAcceptApprovalInteraction,
  shouldPollRecoveryProbeForSessionState,
  shouldSkipTranscriptRelayEntry,
  shouldSkipTranscriptSnapshotItem,
  finalizeApprovalLifecycleMessageState,
  finalizeCompletedAssistantTranscriptReply,
  hasHandledTranscriptItem,
  recoverApprovalLifecycleMessageFromHistory,
  isExpectedPreMaterializationIncludeTurnsError,
  isMissingCodexThreadError,
  getSnapshotReconciliationFailureDisposition,
  isNotLoadedCodexThreadError,
  shouldProjectManagedSessionDiscordSurface,
  persistApprovalRequestSnapshot,
  handleManagedSessionModelComponentInteraction,
  renderApprovalLifecycleMessage,
  renderApprovalLifecyclePayload,
  detectThreadLanguageFromTexts,
  renderApprovalDeliveryFailureText,
  remapSeenTranscriptEntriesToCompletedTurn,
  resumeManagedSession,
  startTurnWithThreadResumeRetry,
  syncManagedSession,
  upsertApprovalLifecycleMessage,
  upsertStreamingTranscriptMessage,
  buildResumeSessionAutocompleteChoices,
  describeCodexThreadStatus,
  formatResumeWorkdirHintChoice,
  RESUME_WORKDIR_HINT_VALUE,
  resolveLegacyWorkspaceBootstrap,
  type EditableStatusCardMessage,
  findReusableStatusCardMessage,
  inferSessionStateFromThreadStatus,
  formatResumeSessionAutocompleteChoice,
  recoverStatusCardMessageFromHistory,
  resolveResumeAttachmentKind,
  readActiveTurnIdFromThreadReadResult,
  getPendingLocalInputTexts,
  getQueuedSteerInputs,
  shouldPollSnapshotForSessionState,
  shouldDegradeForSnapshotMismatch,
  shouldHoldSnapshotTranscriptForManualSync,
  shouldRelayLiveCompletedItemToTranscript,
  shouldRenderCompletedAssistantReplyImmediately,
  shouldIgnoreManagedThreadMessage,
  shouldRenderCommandExecutionStartMessage,
  shouldShowDiscordTypingIndicator,
  shouldSkipStaleLiveTurnProcessUpdate,
  summarizeStatusActivity,
  seedLegacyWorkspaceBootstrap,
  tryRecoverStatusCardMessage,
  upsertStatusCardMessage,
  handleApprovalInteraction,
  shouldHandlePersistedApprovalRequestAtRuntime,
  finalizeLiveTurnProcessMessage,
  renderLiveTurnProcessMessage,
  seedTranscriptRuntimeSeenItemsFromSnapshot,
  noteTrustedLiveExternalTurnStart,
  sortResumePickerThreads,
  applySessionStartTurnOverrides,
  startCodeHelm,
  rememberRuntimeApprovalRequest,
  resolveStoredApprovalForResolvedEvent,
} from "../src/index";
import { renderStatusCardText } from "../src/discord/renderers";
import {
  collectTranscriptEntries,
  getAssistantTranscriptEntryId,
  getProcessTranscriptEntryId,
  getUserTranscriptEntryId,
  renderTranscriptMessages,
} from "../src/discord/transcript";
import type { CodexTurn } from "../src/codex/protocol-types";
import type {
  InsertSessionInput,
  SessionRecord,
} from "../src/db/repos/sessions";

const createSessionRecord = (
  overrides: Partial<SessionRecord> = {},
): SessionRecord => ({
  discordThreadId: "discord-thread-1",
  codexThreadId: "codex-thread-1",
  ownerDiscordUserId: "owner-1",
  cwd: "/tmp/workspace/api",
  state: "idle",
  lifecycleState: "active",
  degradationReason: null,
  modelOverride: null,
  reasoningEffortOverride: null,
  createdAt: "2026-04-09T00:00:00.000Z",
  updatedAt: "2026-04-09T00:00:00.000Z",
  ...overrides,
});

const createApprovalRecord = (
  overrides: Partial<ApprovalRecord> = {},
): ApprovalRecord => ({
  approvalKey: "turn-1:call-1",
  requestId: "req-7",
  codexThreadId: "codex-1",
  discordThreadId: "discord-thread-1",
  status: "pending",
  displayTitle: "Command approval",
  commandPreview: "touch c.txt",
  justification: "要允许我在项目根目录创建 c.txt 吗？",
  cwd: "/tmp/ws1/app",
  requestKind: "command_execution",
  threadMessageId: null,
  decisionCatalog: null,
  resolvedProviderDecision: null,
  resolvedBySurface: null,
  resolvedElsewhere: false,
  resolvedByDiscordUserId: null,
  resolution: null,
  createdAt: "2026-04-17T00:00:00.000Z",
  updatedAt: "2026-04-17T00:00:00.000Z",
  ...overrides,
});

const createThreadReadResult = ({
  status,
  turns,
}: {
  status: CodexThreadStatus;
  turns?: CodexTurn[];
}) => ({
  thread: {
    id: "codex-thread-1",
    cwd: "/tmp/workspace/api",
    preview: "",
    status,
    turns,
  },
});

const createResumePickerThread = (
  overrides: Partial<CodexThread> = {},
): CodexThread => ({
  id: "codex-thread-1",
  cwd: "/tmp/workspace/api",
  preview: "",
  status: { type: "idle" },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

const defaultSessionPath = "/tmp/workspace/api";
const alternateSessionPath = "/tmp/workspace/web";
const createTestHomeRoot = () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "codehelm-home-"));
  mkdirSync(join(homeRoot, "code-github/code-helm"), { recursive: true });
  return homeRoot;
};

test("thread statuses map into Discord session runtime states", () => {
  expect(inferSessionStateFromThreadStatus({ type: "idle" })).toBe("idle");
  expect(inferSessionStateFromThreadStatus({ type: "notLoaded" })).toBe("idle");
  expect(
    inferSessionStateFromThreadStatus({
      type: "active",
      activeFlags: ["waitingOnApproval"],
    }),
  ).toBe("waiting-approval");
  expect(
    inferSessionStateFromThreadStatus({
      type: "active",
      activeFlags: ["waitingOnUserInput"],
    }),
  ).toBe("running");
  expect(inferSessionStateFromThreadStatus({ type: "systemError" })).toBe(
    "degraded",
  );
});

test("active turn ids are recovered only for running snapshots", () => {
  expect(
    readActiveTurnIdFromThreadReadResult({
      thread: {
        id: "codex-thread-1",
        cwd: "/tmp/workspace/api",
        preview: "",
        status: { type: "active", activeFlags: [] },
        turns: [{ id: "turn-1", items: [] }],
      },
    }),
  ).toBe("turn-1");
  expect(
    readActiveTurnIdFromThreadReadResult({
      thread: {
        id: "codex-thread-1",
        cwd: "/tmp/workspace/api",
        preview: "",
        status: { type: "idle" },
        turns: [{ id: "turn-1", items: [] }],
      },
    }),
  ).toBeUndefined();
});

test("session start-turn overrides fill in model and effort defaults without clobbering explicit request values", () => {
  expect(
    applySessionStartTurnOverrides({
      session: {
        modelOverride: "gpt-5.4",
        reasoningEffortOverride: "xhigh",
      },
      request: {
        threadId: "codex-thread-1",
        input: [{ type: "text", text: "Continue." }],
      },
    }),
  ).toEqual({
    threadId: "codex-thread-1",
    input: [{ type: "text", text: "Continue." }],
    model: "gpt-5.4",
    effort: "xhigh",
  });
  expect(
    applySessionStartTurnOverrides({
      session: {
        modelOverride: "gpt-5.4",
        reasoningEffortOverride: "xhigh",
      },
      request: {
        threadId: "codex-thread-1",
        input: [{ type: "text", text: "Continue." }],
        model: "gpt-5.3-codex",
        effort: "medium",
      },
    }),
  ).toEqual({
    threadId: "codex-thread-1",
    input: [{ type: "text", text: "Continue." }],
    model: "gpt-5.3-codex",
    effort: "medium",
  });
});

test("queued steer helpers keep start-turn inputs and remove only queued steers", () => {
  const runtime = {
    pendingLocalInputs: [
      { kind: "start" as const, text: "Start a new task", replyToMessageId: "m1" },
      { kind: "steer" as const, text: "Please continue." },
      { kind: "steer" as const, text: "Then update the tests." },
    ],
  };

  expect(getPendingLocalInputTexts(runtime)).toEqual([
    "Start a new task",
    "Please continue.",
    "Then update the tests.",
  ]);
  expect(getQueuedSteerInputs(runtime).map((input) => input.text)).toEqual([
    "Please continue.",
    "Then update the tests.",
  ]);
  expect(clearQueuedSteerInputs({ runtime }).map((input) => input.text)).toEqual([
    "Please continue.",
    "Then update the tests.",
  ]);
  expect(getPendingLocalInputTexts(runtime)).toEqual(["Start a new task"]);
});

test("managed session status command prefers fresh snapshot state and queued steer previews", async () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);
  const runtime = {
    pendingLocalInputs: [
      { kind: "steer" as const, text: "Please continue." },
    ],
    activeTurnId: undefined as string | undefined,
  };

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-thread-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/workspace/api",
    state: "idle",
  });
  approvalRepo.insert({
    approvalKey: "turn-1:call-1",
    requestId: "req-1",
    codexThreadId: "codex-thread-1",
    discordThreadId: "discord-thread-1",
    status: "pending",
    displayTitle: "Command approval",
    commandPreview: "touch c.txt",
    justification: null,
    cwd: "/tmp/workspace/api",
    requestKind: "command_execution",
    decisionCatalog: null,
    resolvedProviderDecision: null,
    resolvedBySurface: null,
    resolvedElsewhere: false,
    resolvedByDiscordUserId: null,
    resolution: null,
  });

  const services = createManagedSessionCommandServices({
    sessionRepo,
    approvalRepo,
    codexClient: {
      async listModels() {
        return { data: [], nextCursor: null };
      },
      async turnInterrupt() {
        return {};
      },
    } as never,
    getDiscordClient() {
      throw new Error("status should not need a Discord client");
    },
    ensureTranscriptRuntime() {
      return runtime as never;
    },
    async readThreadForSnapshotReconciliation() {
      return {
        thread: {
          id: "codex-thread-1",
          cwd: "/tmp/workspace/api",
          preview: "",
          status: { type: "active", activeFlags: [] },
          turns: [{ id: "turn-1", items: [] }],
        },
      };
    },
    async resolveActiveTurnId() {
      return "turn-1";
    },
    async sendTextToChannel() {
      return undefined;
    },
  });

  const result = await services.status({
    actorId: "viewer-1",
    guildId: "guild-1",
    channelId: "discord-thread-1",
  });

  expect(result.reply.content).toContain("Runtime:            running");
  expect(result.reply.content).toContain("Queued steer:       1");
  expect(result.reply.content).toContain("Pending approvals:  1");
  expect(result.reply.content).toContain("Please continue.");
  expect(runtime.activeTurnId).toBe("turn-1");

  db.close();
});

test("managed session interrupt clears queued steer only after interrupt succeeds", async () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);
  const runtime = {
    pendingLocalInputs: [
      { kind: "steer" as const, text: "Please continue." },
      { kind: "steer" as const, text: "Then update the tests." },
    ],
    activeTurnId: "turn-1",
  };
  const turnInterruptCalls: Array<Record<string, string>> = [];

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-thread-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/workspace/api",
    state: "running",
  });

  const services = createManagedSessionCommandServices({
    sessionRepo,
    approvalRepo,
    codexClient: {
      async listModels() {
        return { data: [], nextCursor: null };
      },
      async turnInterrupt(input: { threadId: string; turnId: string }) {
        turnInterruptCalls.push(input as Record<string, string>);
        return {};
      },
    } as never,
    getDiscordClient() {
      throw new Error("interrupt should not need a Discord client");
    },
    ensureTranscriptRuntime() {
      return runtime as never;
    },
    async readThreadForSnapshotReconciliation() {
      throw new Error("interrupt should not need a snapshot when turn id is present");
    },
    async resolveActiveTurnId() {
      return "turn-1";
    },
    async sendTextToChannel() {
      return undefined;
    },
  });

  const result = await services.interrupt({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "discord-thread-1",
  });

  expect(turnInterruptCalls).toEqual([
    {
      threadId: "codex-thread-1",
      turnId: "turn-1",
    },
  ]);
  expect(result.reply.content).toContain("Discarded 2 queued steer messages");
  expect(getQueuedSteerInputs(runtime)).toHaveLength(0);

  db.close();
});

test("managed session interrupt preserves queued steer when the upstream interrupt fails", async () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);
  const runtime = {
    pendingLocalInputs: [
      { kind: "steer" as const, text: "Please continue." },
    ],
    activeTurnId: "turn-1",
  };

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-thread-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/workspace/api",
    state: "running",
  });

  const services = createManagedSessionCommandServices({
    sessionRepo,
    approvalRepo,
    codexClient: {
      async listModels() {
        return { data: [], nextCursor: null };
      },
      async turnInterrupt() {
        throw new Error("boom");
      },
    } as never,
    getDiscordClient() {
      throw new Error("interrupt should not need a Discord client");
    },
    ensureTranscriptRuntime() {
      return runtime as never;
    },
    async readThreadForSnapshotReconciliation() {
      throw new Error("interrupt should not need a snapshot when turn id is present");
    },
    async resolveActiveTurnId() {
      return "turn-1";
    },
    async sendTextToChannel() {
      return undefined;
    },
  });

  const result = await services.interrupt({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "discord-thread-1",
  });

  expect(result.reply.content).toBe("Failed to interrupt the current turn.");
  expect(getQueuedSteerInputs(runtime).map((input) => input.text)).toEqual([
    "Please continue.",
  ]);

  db.close();
});

test("managed session model component persists the selected model and sends a thread confirmation", async () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const sentTexts: string[] = [];
  const updatedPayloads: unknown[] = [];

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-thread-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/workspace/api",
    state: "idle",
  });

  const handled = await handleManagedSessionModelComponentInteraction({
    interaction: {
      customId: "msm|model|discord-thread-1",
      values: ["gpt-5.4"],
      user: { id: "owner-1" },
      async reply() {
        throw new Error("reply should not be used on the happy path");
      },
      async update(payload: unknown) {
        updatedPayloads.push(payload);
      },
    } as never,
    sessionRepo,
    codexClient: {
      async listModels() {
        return {
          data: [
            {
              model: "gpt-5.4",
              displayName: "GPT-5.4",
              description: "Frontier model",
              supportedReasoningEfforts: ["high"],
              defaultReasoningEffort: "high",
              isDefault: true,
            },
          ],
          nextCursor: null,
        };
      },
    } as never,
    getDiscordClient() {
      return {} as never;
    },
    async sendTextToChannel(_client, _channelId, payload) {
      sentTexts.push(payload);
      return undefined;
    },
  });

  expect(handled).toBe(true);
  expect(sessionRepo.getByDiscordThreadId("discord-thread-1")).toMatchObject({
    modelOverride: "gpt-5.4",
    reasoningEffortOverride: "high",
  });
  expect(sentTexts).toEqual([
    "Model set to `gpt-5.4` with `high` reasoning effort for this session.",
  ]);
  expect(updatedPayloads).toEqual([
    {
      content: "Saved `gpt-5.4` for this session.",
      components: [],
    },
  ]);

  db.close();
});

const createAppConfig = (): AppConfig => ({
  DISCORD_APP_ID: "app-1",
  discord: {
    botToken: "token-1",
    appId: "app-1",
    guildId: "guild-1",
    controlChannelId: "control-1",
  },
  codex: {
    appServerUrl: "ws://localhost:7777/codex",
  },
  databasePath: ":memory:",
  workspace: {
    id: "workspace-1",
    name: "Workspace",
  },
});

test("legacy workspace bootstrap seeds workdirs on a fresh database", () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);

  const bootstrap = resolveLegacyWorkspaceBootstrap({
    WORKSPACE_ROOT: "/tmp/workspace",
    WORKDIRS_JSON:
      '[{"id":"api","label":"API","absolutePath":"/tmp/workspace/api"}]',
  });

  seedLegacyWorkspaceBootstrap(db, createAppConfig(), bootstrap);

  const workspaceRepo = createWorkspaceRepo(db);
  const workdirRepo = createWorkdirRepo(db);

  expect(workspaceRepo.getById("workspace-1")).toMatchObject({
    rootPath: "/tmp/workspace",
  });
  expect(workdirRepo.getById("api")).toMatchObject({
    workspaceId: "workspace-1",
    absolutePath: "/tmp/workspace/api",
  });

  db.close();
});

test("legacy workspace bootstrap rejects workdirs outside the workspace root", () => {
  expect(() =>
    resolveLegacyWorkspaceBootstrap({
      WORKSPACE_ROOT: "/tmp/workspace",
      WORKDIRS_JSON:
        '[{"id":"api","label":"API","absolutePath":"/tmp/other/api"}]',
    }),
  ).toThrow(/outside WORKSPACE_ROOT/);
});

test("startCodeHelm stops the started runtime when runtime-state publication fails", async () => {
  const stopCalls: string[] = [];
  const clearedStateDirs: string[] = [];

  await expect(
    startCodeHelm(createAppConfig(), {
      installSignalHandlers: false,
      stateDir: "/tmp/codehelm-state",
      acquireInstanceLock: () => ({
        pid: process.pid,
        cleanedStaleState: false,
      }),
      clearRuntimeState: ({ stateDir }) => {
        clearedStateDirs.push(stateDir);
      },
      writeRuntimeSummary: () => {
        throw new Error("runtime-state write failed");
      },
      startRuntime: async (config) => ({
        config,
        stop: async () => {
          stopCalls.push("stopped");
        },
      }),
    }),
  ).rejects.toThrow(/runtime-state write failed/i);

  expect(stopCalls).toEqual(["stopped"]);
  expect(clearedStateDirs).toEqual(["/tmp/codehelm-state"]);
});

test("startCodeHelm does not enter a running runtime when managed Codex startup stays delayed", async () => {
  const clearedStateDirs: string[] = [];
  let startedRuntime = false;

  await expect(
    startCodeHelm({
      ...createAppConfig(),
      codex: {
        appServerUrl: DEFAULT_CODEX_APP_SERVER_URL,
      },
    }, {
      installSignalHandlers: false,
      stateDir: "/tmp/codehelm-state",
      acquireInstanceLock: () => ({
        pid: process.pid,
        cleanedStaleState: false,
      }),
      clearRuntimeState: ({ stateDir }) => {
        clearedStateDirs.push(stateDir);
      },
      startManagedCodexAppServer: async () => {
        throw new CodexSupervisorError(
          "CODEX_APP_SERVER_FAILED_TO_START",
          "Managed Codex App Server did not become ready before the startup timeout expired.",
          {
            startupDisposition: "delayed",
            diagnostics: "stderr tail",
            startupTimeoutMs: 5_000,
          },
        );
      },
      startRuntime: async (config) => {
        startedRuntime = true;
        return {
          config,
          stop: async () => {},
        };
      },
    }),
  ).rejects.toMatchObject({
    code: "CODEX_APP_SERVER_FAILED_TO_START",
    startupDisposition: "delayed",
  } satisfies Partial<CodexSupervisorError>);

  expect(startedRuntime).toBe(false);
  expect(clearedStateDirs).toEqual(["/tmp/codehelm-state"]);
});

test("startCodeHelm starts managed Codex App Server in foreground using current cwd", async () => {
  let receivedCwd: string | undefined;

  const handle = await startCodeHelm({
    ...createAppConfig(),
    codex: {
      appServerUrl: DEFAULT_CODEX_APP_SERVER_URL,
    },
  }, {
    installSignalHandlers: false,
    startManagedCodexAppServer: async (options = {}) => {
      receivedCwd = options.cwd;
      return {
        pid: 999,
        address: "ws://127.0.0.1:4511",
        stop: async () => {},
      };
    },
    startRuntime: async (config) => ({
      config,
      stop: async () => {},
    }),
  });

  await handle.stop();

  expect(receivedCwd).toBe(process.cwd());
});

test("startCodeHelm starts managed Codex App Server in background using dedicated workdir", async () => {
  let receivedCwd: string | undefined;

  const handle = await startCodeHelm({
    ...createAppConfig(),
    codex: {
      appServerUrl: DEFAULT_CODEX_APP_SERVER_URL,
    },
  }, {
    installSignalHandlers: false,
    mode: "background",
    startManagedCodexAppServer: async (options = {}) => {
      receivedCwd = options.cwd;
      return {
        pid: 999,
        address: "ws://127.0.0.1:4511",
        stop: async () => {},
      };
    },
    startRuntime: async (config) => ({
      config,
      stop: async () => {},
    }),
  });

  await handle.stop();

  expect(receivedCwd).toBe(resolveCodeHelmPaths().appServerWorkdir);
});

test("applyDiscordReplyReference leaves non-reply payloads unchanged", () => {
  expect(applyDiscordReplyReference({
    payload: {
      content: "plain message",
    },
  })).toEqual({
    content: "plain message",
  });
});

test("applyDiscordReplyReference encodes Discord native reply references when asked", () => {
  expect(applyDiscordReplyReference({
    payload: {
      content: "reply message",
    },
    replyToMessageId: "discord-message-1",
  })).toEqual({
    content: "reply message",
    reply: {
      messageReference: "discord-message-1",
      failIfNotExists: false,
    },
  });
});

const createResumeOutcome = (
  kind: SessionResumeState["kind"],
): SessionResumeState => {
  switch (kind) {
    case "ready":
      return {
        kind: "ready",
        session: {
          lifecycleState: "active",
          runtimeState: "idle",
          accessMode: "writable",
        },
        persistedRuntimeState: "idle",
        statusCardState: "idle",
      };
    case "busy":
      return {
        kind: "busy",
        session: {
          lifecycleState: "active",
          runtimeState: "running",
          accessMode: "writable",
        },
        persistedRuntimeState: "running",
        statusCardState: "running",
      };
    case "read-only":
      return {
        kind: "read-only",
        session: {
          lifecycleState: "active",
          runtimeState: "idle",
          accessMode: "read-only",
        },
        persistedRuntimeState: "degraded",
        statusCardState: undefined,
      };
    case "error":
      return {
        kind: "error",
        session: {
          lifecycleState: "active",
          runtimeState: "error",
          accessMode: "read-only",
        },
        persistedRuntimeState: "degraded",
        statusCardState: undefined,
      };
    case "untrusted":
      return {
        kind: "untrusted",
        reason: "sync_state_untrusted",
      };
  }
};

const createControlChannelServicesFixture = ({
  existingSession,
  homeDir = homedir(),
  discordThreadUsable = true,
  readThreadStatus = { type: "idle" } satisfies CodexThreadStatus,
  readThreadCwd = "/tmp/workspace/api",
  startThreadCwd,
  readThreadError,
  discordClientError,
  createThreadSendError,
  updateStatusCardError,
  syncOutcome = createResumeOutcome("ready"),
  resumeOutcome = createResumeOutcome("ready"),
  listThreadsError,
  listThreadsData = {
    active: [] as CodexThread[],
    archived: [] as CodexThread[],
  },
}: {
  existingSession?: SessionRecord | null;
  homeDir?: string;
  discordThreadUsable?: boolean;
  readThreadStatus?: CodexThreadStatus;
  readThreadCwd?: string;
  startThreadCwd?: string;
  readThreadError?: Error;
  discordClientError?: Error;
  createThreadSendError?: Error;
  updateStatusCardError?: Error;
  syncOutcome?: SessionResumeState;
  resumeOutcome?: SessionResumeState;
  listThreadsError?: Error;
  listThreadsData?: {
    active: CodexThread[];
    archived: CodexThread[];
  };
} = {}) => {
  const config = createAppConfig();
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRecords = new Map<string, SessionRecord>();
  const codexThreadToDiscordThread = new Map<string, string>();
  const currentWorkdirRepo = createCurrentWorkdirRepo(db);
  const calls = {
    ensureTranscriptRuntime: [] as string[],
    createVisibleSessionThread: [] as Array<{
      title: string;
      starterText: string;
    }>,
    threadMessages: [] as Array<{
      threadId: string;
      payload: unknown;
    }>,
    insertedSessions: [] as Array<{
      discordThreadId: string;
      codexThreadId: string;
      ownerDiscordUserId: string;
      cwd: string;
      state: string;
    }>,
    deletedSessions: [] as string[],
    reboundThreads: [] as Array<{
      currentDiscordThreadId: string;
      nextDiscordThreadId: string;
    }>,
    lifecycleUpdates: [] as Array<{
      discordThreadId: string;
      lifecycleState: SessionRecord["lifecycleState"];
    }>,
    syncedThreads: [] as string[],
    resumedThreads: [] as string[],
    deletedThreads: [] as string[],
    sentTexts: [] as Array<{
      channelId: string;
      content: string;
    }>,
    readThreadIds: [] as string[],
    usabilityChecks: [] as string[],
    updateStatusCard: [] as Array<{
      state?: string;
    }>,
    startThread: [] as string[],
    listThreads: [] as ThreadListParams[],
  };

  if (existingSession) {
    sessionRecords.set(existingSession.discordThreadId, existingSession);
    codexThreadToDiscordThread.set(
      existingSession.codexThreadId,
      existingSession.discordThreadId,
    );
  }

  let nextThreadId = 1;

  mkdirSync(defaultSessionPath, { recursive: true });
  mkdirSync(alternateSessionPath, { recursive: true });

  const services = createControlChannelServices({
    config,
    homeDir,
    codexClient: {
      async startThread(params: { cwd: string }) {
        calls.startThread.push(params.cwd);
        const authoritativeCwd = startThreadCwd ?? params.cwd;
        return {
          thread: createResumePickerThread({
            cwd: authoritativeCwd,
          }),
          cwd: authoritativeCwd,
        };
      },
      async listThreads(params: ThreadListParams) {
        calls.listThreads.push(params);
        if (listThreadsError) {
          throw listThreadsError;
        }
        return {
          data: params.archived ? listThreadsData.archived : listThreadsData.active,
          nextCursor: null,
        };
      },
    } as never,
    currentWorkdirRepo,
    sessionRepo: {
      getByDiscordThreadId(discordThreadId: string) {
        return sessionRecords.get(discordThreadId) ?? null;
      },
      getByCodexThreadId(codexThreadId: string) {
        const discordThreadId = codexThreadToDiscordThread.get(codexThreadId);
        return discordThreadId
          ? sessionRecords.get(discordThreadId) ?? null
          : null;
      },
      insert(input: InsertSessionInput) {
        calls.insertedSessions.push(input);
        const inserted = createSessionRecord({
          discordThreadId: input.discordThreadId,
          codexThreadId: input.codexThreadId,
          ownerDiscordUserId: input.ownerDiscordUserId,
          cwd: input.cwd,
          state: input.state,
          lifecycleState: "active",
        });
        sessionRecords.set(inserted.discordThreadId, inserted);
        codexThreadToDiscordThread.set(inserted.codexThreadId, inserted.discordThreadId);
      },
      markDeleted(discordThreadId: string) {
        calls.deletedSessions.push(discordThreadId);
        const current = sessionRecords.get(discordThreadId);

        if (!current) {
          throw new Error(`Missing session for ${discordThreadId}`);
        }

        sessionRecords.set(discordThreadId, {
          ...current,
          lifecycleState: "deleted",
        });
      },
      updateLifecycleState(
        discordThreadId: string,
        lifecycleState: SessionRecord["lifecycleState"],
      ) {
        calls.lifecycleUpdates.push({ discordThreadId, lifecycleState });
        const current = sessionRecords.get(discordThreadId);

        if (!current) {
          throw new Error(`Missing session for ${discordThreadId}`);
        }

        sessionRecords.set(discordThreadId, {
          ...current,
          lifecycleState,
        });
      },
      rebindDiscordThread(input: {
        currentDiscordThreadId: string;
        nextDiscordThreadId: string;
      }) {
        calls.reboundThreads.push(input);
        const current = sessionRecords.get(input.currentDiscordThreadId);

        if (!current) {
          throw new Error(`Missing session for ${input.currentDiscordThreadId}`);
        }

        sessionRecords.delete(input.currentDiscordThreadId);
        sessionRecords.set(input.nextDiscordThreadId, {
          ...current,
          discordThreadId: input.nextDiscordThreadId,
        });
        codexThreadToDiscordThread.set(current.codexThreadId, input.nextDiscordThreadId);
      },
    } as never,
    getDiscordClient: () => {
      if (discordClientError) {
        throw discordClientError;
      }

      return { id: "discord-client" } as never;
    },
    createVisibleSessionThread: async ({ title, starterText }) => {
      calls.createVisibleSessionThread.push({ title, starterText });
      const threadId = `discord-thread-new-${nextThreadId++}`;

      return {
        id: threadId,
        async send(payload: unknown) {
          calls.threadMessages.push({ threadId, payload });
          if (createThreadSendError) {
            throw createThreadSendError;
          }
          return undefined as never;
        },
        async delete() {
          calls.deletedThreads.push(threadId);
          return undefined as never;
        },
      };
    },
    ensureTranscriptRuntime: (codexThreadId) => {
      calls.ensureTranscriptRuntime.push(codexThreadId);
    },
    updateStatusCard: async ({ state }) => {
      calls.updateStatusCard.push({ state });
      if (updateStatusCardError) {
        throw updateStatusCardError;
      }
    },
    closeManagedSession: async () => {},
    syncManagedSessionIntoDiscordThread: async (session) => {
      calls.syncedThreads.push(session.discordThreadId);
      return syncOutcome;
    },
    resumeManagedSessionIntoDiscordThread: async (session) => {
      calls.resumedThreads.push(session.discordThreadId);
      return resumeOutcome;
    },
    sendTextToChannel: async (_client, channelId, content) => {
      calls.sentTexts.push({
        channelId,
        content: typeof content === "string" ? content : content.content ?? "",
      });
      return undefined;
    },
    isManagedDiscordThreadUsable: async ({ threadId }) => {
      calls.usabilityChecks.push(threadId);
      return discordThreadUsable;
    },
    readThreadForSnapshotReconciliation: async ({ threadId }) => {
      if (readThreadError) {
        throw readThreadError;
      }

      calls.readThreadIds.push(threadId);
      return {
        thread: createResumePickerThread({
          id: threadId,
          cwd: readThreadCwd,
          status: readThreadStatus,
        }),
      };
    },
  }) as any;

  return {
    services,
    calls,
    getCurrentWorkdir(input: {
      guildId: string;
      channelId: string;
      discordUserId: string;
    }) {
      return currentWorkdirRepo.get(input);
    },
    getSessionByCodexThreadId(codexThreadId: string) {
      const discordThreadId = codexThreadToDiscordThread.get(codexThreadId);
      return discordThreadId
        ? sessionRecords.get(discordThreadId) ?? null
        : null;
    },
  };
};

test("resume picker threads sort by updatedAt, createdAt, then id", () => {
  const baseTimestamp = 1_700_000_000_000;
  const oldest = createResumePickerThread({
    id: "thread-e",
    createdAt: baseTimestamp + 1_000,
    updatedAt: baseTimestamp + 1_000,
  });
  const sameUpdatedOlderCreated = createResumePickerThread({
    id: "thread-c",
    createdAt: baseTimestamp + 2_000,
    updatedAt: baseTimestamp + 3_000,
  });
  const sameUpdatedNewerCreated = createResumePickerThread({
    id: "thread-d",
    createdAt: baseTimestamp + 3_000,
    updatedAt: baseTimestamp + 3_000,
  });
  const sameTimestampsEarlierId = createResumePickerThread({
    id: "thread-a",
    createdAt: baseTimestamp + 4_000,
    updatedAt: baseTimestamp + 4_000,
  });
  const sameTimestampsLaterId = createResumePickerThread({
    id: "thread-b",
    createdAt: baseTimestamp + 4_000,
    updatedAt: baseTimestamp + 4_000,
  });

  expect(
    sortResumePickerThreads([
      oldest,
      sameUpdatedOlderCreated,
      sameUpdatedNewerCreated,
      sameTimestampsLaterId,
      sameTimestampsEarlierId,
    ]).map((thread) => thread.id),
  ).toEqual([
    "thread-a",
    "thread-b",
    "thread-d",
    "thread-c",
    "thread-e",
  ]);
});

test("resume picker threads sort by normalized provider timestamps", () => {
  const newerThreadWithSecondBasedTimestamp = createResumePickerThread({
    id: "thread-newer-seconds",
    createdAt: 1_700_000_090,
    updatedAt: 1_700_000_100,
  });
  const olderThreadWithMillisecondTimestamp = createResumePickerThread({
    id: "thread-older-milliseconds",
    createdAt: 1_700_000_040_000,
    updatedAt: 1_700_000_050_000,
  });

  expect(
    sortResumePickerThreads([
      olderThreadWithMillisecondTimestamp,
      newerThreadWithSecondBasedTimestamp,
    ]).map((thread) => thread.id),
  ).toEqual([
    "thread-newer-seconds",
    "thread-older-milliseconds",
  ]);
});

test("resume workdir hint choice uses the sentinel value and fixed copy", () => {
  expect(formatResumeWorkdirHintChoice({
    cwd: "/Users/tester/code-github/code-helm",
    homeDir: "/Users/tester",
  })).toEqual({
    name: "Current workdir: ~/code-github/code-helm · Use /workdir to switch directories",
    value: RESUME_WORKDIR_HINT_VALUE,
  });
});

test("resume workdir hint choice truncates only the path segment to fit Discord limits", () => {
  const choice = formatResumeWorkdirHintChoice({
    cwd: "/Users/tester/code-github/projects/clients/acme/platforms/code-agent-helm-example",
    homeDir: "/Users/tester",
  });

  expect(choice.value).toBe(RESUME_WORKDIR_HINT_VALUE);
  expect(choice.name.length).toBeLessThanOrEqual(100);
  expect(choice.name.startsWith("Current workdir: ")).toBe(true);
  expect(choice.name.endsWith(" · Use /workdir to switch directories")).toBe(true);
});

test("resume session autocomplete pipeline prepends the workdir hint row and caps real sessions at 24", async () => {
  const baseTimestamp = 1_700_000_000_000;
  const calls: Array<Record<string, unknown>> = [];
  const activeThreads = Array.from({ length: 13 }, (_, index) =>
    createResumePickerThread({
      id: `codex-thread-${String(index).padStart(2, "0")}`,
      preview: `Preview ${index}`,
      updatedAt: baseTimestamp + index,
      createdAt: baseTimestamp + index,
    })
  );
  const archivedThreads = [
    createResumePickerThread({
      id: "codex-thread-12345678901",
      preview:
        "This preview is intentionally long so the autocomplete helper has to " +
        "truncate it before Discord rejects the choice label.",
      updatedAt: baseTimestamp + 5_000,
    }),
    ...Array.from({ length: 13 }, (_, index) =>
      createResumePickerThread({
        id: `codex-thread-late-${String(index).padStart(2, "0")}`,
        preview: `Late preview ${index}`,
        updatedAt: baseTimestamp + 100 + index,
        createdAt: baseTimestamp + 100 + index,
      })
    ),
  ];

  const choices = await buildResumeSessionAutocompleteChoices({
    codexClient: {
      async listThreads(params: ThreadListParams) {
        calls.push(params as Record<string, unknown>);
        return params.archived
          ? {
              data: archivedThreads,
              nextCursor: null,
            }
          : {
              data: activeThreads,
              nextCursor: null,
            };
      },
    } as never,
    query: "  plan  ",
    cwd: defaultSessionPath,
    homeDir: "/Users/tester",
    now: baseTimestamp + 7_200_000,
  });

  expect(calls).toEqual([
    {
      cwd: defaultSessionPath,
      searchTerm: "plan",
      limit: 25,
      sortKey: "updated_at",
      archived: false,
    },
    {
      cwd: defaultSessionPath,
      searchTerm: "plan",
      limit: 25,
      sortKey: "updated_at",
      archived: true,
    },
  ]);
  expect(choices).toHaveLength(25);
  expect(choices[0]).toEqual({
    name: "Current workdir: /tmp/workspace/api · Use /workdir to switch directories",
    value: RESUME_WORKDIR_HINT_VALUE,
  });
  expect(choices[1]?.value).toBe("codex-thread-12345678901");
  expect(choices[1]?.name.length).toBeLessThanOrEqual(100);
  expect(choices[1]?.name.endsWith(" · codex-thread-12345678901")).toBe(true);
  expect(choices.at(-1)?.value).toBe("codex-thread-03");
});

test("resume session autocomplete keeps the workdir hint row even when no sessions match", async () => {
  const choices = await buildResumeSessionAutocompleteChoices({
    codexClient: {
      async listThreads() {
        return {
          data: [],
          nextCursor: null,
        };
      },
    } as never,
    query: "focused search",
    cwd: defaultSessionPath,
    homeDir: "/Users/tester",
  });

  expect(choices).toEqual([
    {
      name: "Current workdir: /tmp/workspace/api · Use /workdir to switch directories",
      value: RESUME_WORKDIR_HINT_VALUE,
    },
  ]);
});

test("resume session autocomplete labels include updated time, preview or name, and the full thread id when it fits", () => {
  const baseTimestamp = 1_700_000_000_000;
  expect(
    formatResumeSessionAutocompleteChoice(createResumePickerThread({
      id: "019d8bbd-8bb5-73b1-b6d7-aec5b95c5c1e",
      preview: "  Draft plan  ",
      name: "Ignored name",
      updatedAt: baseTimestamp + 3_600_000,
    }), baseTimestamp + 7_200_000),
  ).toEqual({
    name: "1 hour ago · Draft plan · 019d8bbd-8bb5-73b1-b6d7-aec5b95c5c1e",
    value: "019d8bbd-8bb5-73b1-b6d7-aec5b95c5c1e",
  });

  expect(
    formatResumeSessionAutocompleteChoice(createResumePickerThread({
      id: "019d8e05-3a03-7da2-8af6-b7fb52dc4929",
      preview: "   ",
      name: "Named fallback",
      updatedAt: baseTimestamp,
    }), baseTimestamp + 7_200_000),
  ).toEqual({
    name: "2 hours ago · Named fallback · 019d8e05-3a03-7da2-8af6-b7fb52dc4929",
    value: "019d8e05-3a03-7da2-8af6-b7fb52dc4929",
  });

  const longChoice = formatResumeSessionAutocompleteChoice(createResumePickerThread({
    id: "codex-thread-12345678901",
    preview:
      "This preview is intentionally long so the autocomplete helper has to " +
      "truncate it before Discord rejects the choice label.",
    updatedAt: baseTimestamp + 3_600_000,
  }), baseTimestamp + 7_200_000);

  expect(longChoice.value).toBe("codex-thread-12345678901");
  expect(longChoice.name.length).toBeLessThanOrEqual(100);
  expect(longChoice.name.startsWith("1 hour ago · ")).toBe(true);
  expect(longChoice.name.endsWith(" · codex-thread-12345678901")).toBe(true);
});

test("resume session autocomplete labels normalize second-based provider timestamps", () => {
  expect(
    formatResumeSessionAutocompleteChoice(
      createResumePickerThread({ updatedAt: 1_700_000_000 }),
      1_700_003_600_000,
    ).name.startsWith("1 hour ago · "),
  ).toBe(true);
});

test("create session persists and displays the authoritative cwd returned by Codex", async () => {
  const authoritativeCwd = "/tmp/workspace/api-authoritative";
  const { services, calls, getSessionByCodexThreadId } = createControlChannelServicesFixture({
    startThreadCwd: authoritativeCwd,
  });

  const result = await services.createSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: `${defaultSessionPath}/../api`,
  });

  expect(calls.startThread).toEqual([defaultSessionPath]);
  expect(calls.insertedSessions).toEqual([
    {
      discordThreadId: "discord-thread-new-1",
      codexThreadId: "codex-thread-1",
      ownerDiscordUserId: "owner-1",
      cwd: authoritativeCwd,
      state: "idle",
    },
  ]);
  expect(calls.createVisibleSessionThread).toEqual([
    {
      title: "codex-thread-1",
      starterText: `Opening session for \`${authoritativeCwd}\`.`,
    },
  ]);
  expect(getSessionByCodexThreadId("codex-thread-1")).toMatchObject({
    cwd: authoritativeCwd,
  });
  expect(result).toEqual({
    reply: {
      content: `Created session <#discord-thread-new-1> for \`${authoritativeCwd}\`.`,
    },
  });
});

test("create session expands ~/ paths before starting Codex", async () => {
  const pathInsideHome = mkdtempSync(join(homedir(), "codehelm-session-path-"));

  try {
    const { services, calls, getSessionByCodexThreadId } = createControlChannelServicesFixture();
    const homePrefix = `${homedir()}/`;
    const tildePath = pathInsideHome.startsWith(homePrefix)
      ? `~/${pathInsideHome.slice(homePrefix.length)}`
      : "~";

    const result = await services.createSession({
      actorId: "owner-1",
      guildId: "guild-1",
      channelId: "control-1",
      path: tildePath,
    });

    expect(calls.startThread).toEqual([pathInsideHome]);
    expect(calls.insertedSessions.at(-1)).toEqual({
      discordThreadId: "discord-thread-new-1",
      codexThreadId: "codex-thread-1",
      ownerDiscordUserId: "owner-1",
      cwd: pathInsideHome,
      state: "idle",
    });
    expect(getSessionByCodexThreadId("codex-thread-1")).toMatchObject({
      cwd: pathInsideHome,
    });
    expect(result).toEqual({
      reply: {
        content: `Created session <#discord-thread-new-1> for \`${tildePath}\`.`,
      },
    });
  } finally {
    rmSync(pathInsideHome, { recursive: true, force: true });
  }
});

test("create session treats bare relative paths as home-relative shorthand", async () => {
  const pathInsideHome = mkdtempSync(join(homedir(), "codehelm-session-shorthand-"));

  try {
    const { services, calls, getSessionByCodexThreadId } = createControlChannelServicesFixture();
    const homePrefix = `${homedir()}/`;
    const shorthandPath = pathInsideHome.startsWith(homePrefix)
      ? pathInsideHome.slice(homePrefix.length)
      : ".";
    const displayPath = shorthandPath === "." ? "~" : `~/${shorthandPath}`;

    const result = await services.createSession({
      actorId: "owner-1",
      guildId: "guild-1",
      channelId: "control-1",
      path: shorthandPath,
    });

    expect(calls.startThread).toEqual([pathInsideHome]);
    expect(calls.insertedSessions.at(-1)).toEqual({
      discordThreadId: "discord-thread-new-1",
      codexThreadId: "codex-thread-1",
      ownerDiscordUserId: "owner-1",
      cwd: pathInsideHome,
      state: "idle",
    });
    expect(getSessionByCodexThreadId("codex-thread-1")).toMatchObject({
      cwd: pathInsideHome,
    });
    expect(result).toEqual({
      reply: {
        content: `Created session <#discord-thread-new-1> for \`${displayPath}\`.`,
      },
    });
  } finally {
    rmSync(pathInsideHome, { recursive: true, force: true });
  }
});

test("/workdir normalizes, stores, and replies with the current workdir", async () => {
  const homeRoot = createTestHomeRoot();
  const { services, getCurrentWorkdir } = createControlChannelServicesFixture({
    homeDir: homeRoot,
  });
  const expectedPath = join(homeRoot, "code-github/code-helm");

  const result = await services.setCurrentWorkdir({
    actorId: "u1",
    guildId: "guild-1",
    channelId: "control-1",
    path: "~/code-github/code-helm",
  });

  expect(
    getCurrentWorkdir({
      guildId: "guild-1",
      channelId: "control-1",
      discordUserId: "u1",
    }),
  ).toMatchObject({
    cwd: expectedPath,
  });
  expect(result).toEqual({
    reply: { content: "Current workdir: `~/code-github/code-helm`" },
  });
});

test("/workdir rejects hidden paths with the existing validation surface", async () => {
  const { services, getCurrentWorkdir } = createControlChannelServicesFixture();

  const result = await services.setCurrentWorkdir({
    actorId: "u1",
    guildId: "guild-1",
    channelId: "control-1",
    path: "~/.codex",
  });

  expect(
    getCurrentWorkdir({
      guildId: "guild-1",
      channelId: "control-1",
      discordUserId: "u1",
    }),
  ).toBeNull();
  expect(result).toEqual({
    reply: {
      content: "Session path must not include hidden directories.",
      ephemeral: true,
    },
  });
});

test("/workdir rejects missing paths with the existing validation surface", async () => {
  const { services, getCurrentWorkdir } = createControlChannelServicesFixture();
  const missingPath = join(tmpdir(), `codehelm-missing-${Date.now()}`);

  const result = await services.setCurrentWorkdir({
    actorId: "u1",
    guildId: "guild-1",
    channelId: "control-1",
    path: missingPath,
  });

  expect(
    getCurrentWorkdir({
      guildId: "guild-1",
      channelId: "control-1",
      discordUserId: "u1",
    }),
  ).toBeNull();
  expect(result).toEqual({
    reply: {
      content: `Directory does not exist: \`${missingPath}\`.`,
      ephemeral: true,
    },
  });
});

test("/session-new requires a current workdir", async () => {
  const { services, calls } = createControlChannelServicesFixture();

  const result = await services.createSession({
    actorId: "u1",
    guildId: "guild-1",
    channelId: "control-1",
  });

  expect(calls.startThread).toEqual([]);
  expect(calls.createVisibleSessionThread).toEqual([]);
  expect(result).toEqual({
    reply: {
      content: "No current workdir. Run /workdir first.",
      ephemeral: true,
    },
  });
});

test("/session-new uses the stored current workdir snapshot for thread creation", async () => {
  const homeRoot = createTestHomeRoot();
  const { services, calls } = createControlChannelServicesFixture({
    homeDir: homeRoot,
  });
  const expectedPath = join(homeRoot, "code-github/code-helm");

  await services.setCurrentWorkdir({
    actorId: "u1",
    guildId: "guild-1",
    channelId: "control-1",
    path: "~/code-github/code-helm",
  });

  const result = await services.createSession({
    actorId: "u1",
    guildId: "guild-1",
    channelId: "control-1",
  });

  expect(calls.startThread).toEqual([expectedPath]);
  expect(calls.createVisibleSessionThread).toEqual([
    {
      title: "codex-thread-1",
      starterText: `Opening session for \`${expectedPath}\`.`,
    },
  ]);
  expect(calls.threadMessages).toEqual([
    {
      threadId: "discord-thread-new-1",
      payload: {
        embeds: [
          {
            title: "Session started",
            description: "Workdir: `~/code-github/code-helm`\nCodex thread: `codex-thread-1`",
            color: expect.any(Number),
          },
        ],
      },
    },
  ]);
  expect(result).toEqual({
    reply: {
      content: "Created session <#discord-thread-new-1> for `~/code-github/code-helm`.",
    },
  });
});

test("/session-new fails when the stored current workdir is no longer readable", async () => {
  const { services, calls } = createControlChannelServicesFixture();
  const missingWorkdir = mkdtempSync(join(tmpdir(), "codehelm-current-workdir-"));

  try {
    await services.setCurrentWorkdir({
      actorId: "u1",
      guildId: "guild-1",
      channelId: "control-1",
      path: missingWorkdir,
    });
    rmSync(missingWorkdir, { recursive: true, force: true });

    const result = await services.createSession({
      actorId: "u1",
      guildId: "guild-1",
      channelId: "control-1",
    });

    expect(calls.startThread).toEqual([]);
    expect(calls.createVisibleSessionThread).toEqual([]);
    expect(result).toEqual({
      reply: {
        content: "Current workdir is no longer available. Run /workdir again.",
        ephemeral: true,
      },
    });
  } finally {
    rmSync(missingWorkdir, { recursive: true, force: true });
  }
});

test("create session rejects hidden paths with an ephemeral validation error", async () => {
  const { services, calls } = createControlChannelServicesFixture();

  const result = await services.createSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: "~/.codex",
  });

  expect(calls.startThread).toEqual([]);
  expect(calls.createVisibleSessionThread).toEqual([]);
  expect(result).toEqual({
    reply: {
      content: "Session path must not include hidden directories.",
      ephemeral: true,
    },
  });
});

test("create session rejects hidden absolute paths with an ephemeral validation error", async () => {
  const { services, calls } = createControlChannelServicesFixture();
  const hiddenAbsolutePath = join(tmpdir(), `.codehelm-hidden-${Date.now()}`, "nested");

  const result = await services.createSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: hiddenAbsolutePath,
  });

  expect(calls.startThread).toEqual([]);
  expect(calls.createVisibleSessionThread).toEqual([]);
  expect(result).toEqual({
    reply: {
      content: "Session path must not include hidden directories.",
      ephemeral: true,
    },
  });
});

test("path autocomplete starts from home directory choices", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "codehelm-path-home-"));

  try {
    mkdirSync(join(homeDir, "code-github", "code-helm"), { recursive: true });
    mkdirSync(join(homeDir, "code-github", "codex"), { recursive: true });
    mkdirSync(join(homeDir, "Downloads"));
    mkdirSync(join(homeDir, "Music"));

    const { services, calls } = createControlChannelServicesFixture({
      homeDir,
    });

    const choices = await services.autocompleteSessionPaths({
      actorId: "owner-1",
      guildId: "guild-1",
      channelId: "control-1",
      query: "",
    });

    expect(choices).toEqual([
      { name: ".", value: "~" },
      { name: "code-github/", value: "~/code-github/" },
      { name: "Downloads/", value: "~/Downloads/" },
      { name: "Music/", value: "~/Music/" },
    ]);
    expect(calls.listThreads).toEqual([]);

    expect(await services.autocompleteSessionPaths({
      actorId: "owner-1",
      guildId: "guild-1",
      channelId: "control-1",
      path: "~/code-github/",
      query: "~/code-github/",
    })).toEqual([
      { name: ".", value: "~/code-github" },
      { name: "..", value: "~" },
      {
        name: "code-github/code-helm/",
        value: "~/code-github/code-helm/",
      },
      {
        name: "code-github/codex/",
        value: "~/code-github/codex/",
      },
    ]);

    expect(await services.autocompleteSessionPaths({
      actorId: "owner-1",
      guildId: "guild-1",
      channelId: "control-1",
      query: "d",
    })).toEqual([
      { name: ".", value: "~" },
      { name: "code-github/", value: "~/code-github/" },
      { name: "Downloads/", value: "~/Downloads/" },
    ]);

    expect(await services.autocompleteSessionPaths({
      actorId: "owner-1",
      guildId: "guild-1",
      channelId: "control-1",
      query: "code-agent-helm-example/",
    })).toEqual([
      { name: ".", value: "~" },
    ]);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("/session-resume autocomplete returns [] when no current workdir exists", async () => {
  const { services, calls } = createControlChannelServicesFixture();

  expect(await services.autocompleteResumeSessions({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    query: "codex",
  })).toEqual([]);
  expect(calls.listThreads).toEqual([]);
});

test("/session-resume autocomplete returns [] when the stored current workdir is no longer available", async () => {
  const { services, calls } = createControlChannelServicesFixture();
  const missingWorkdir = mkdtempSync(join(tmpdir(), "codehelm-resume-current-workdir-"));

  try {
    await services.setCurrentWorkdir({
      actorId: "owner-1",
      guildId: "guild-1",
      channelId: "control-1",
      path: missingWorkdir,
    });
    rmSync(missingWorkdir, { recursive: true, force: true });

    expect(await services.autocompleteResumeSessions({
      actorId: "owner-1",
      guildId: "guild-1",
      channelId: "control-1",
      query: "codex",
    })).toEqual([]);
    expect(calls.listThreads).toEqual([]);
  } finally {
    rmSync(missingWorkdir, { recursive: true, force: true });
  }
});

test("/session-resume autocomplete scopes Codex threads by the stored current workdir, not by any slash-command path", async () => {
  const homeRoot = createTestHomeRoot();
  const { services, calls } = createControlChannelServicesFixture({
    homeDir: homeRoot,
  });
  const expectedPath = join(homeRoot, "code-github/code-helm");

  try {
    await services.setCurrentWorkdir({
      actorId: "owner-1",
      guildId: "guild-1",
      channelId: "control-1",
      path: "~/code-github/code-helm",
    });

    await services.autocompleteResumeSessions({
      actorId: "owner-1",
      guildId: "guild-1",
      channelId: "control-1",
      query: "codex",
    });

    expect(calls.listThreads).toEqual([
      {
        cwd: expectedPath,
        searchTerm: "codex",
        limit: 25,
        sortKey: "updated_at",
        archived: false,
      },
      {
        cwd: expectedPath,
        searchTerm: "codex",
        limit: 25,
        sortKey: "updated_at",
        archived: true,
      },
    ]);
  } finally {
    rmSync(homeRoot, { recursive: true, force: true });
  }
});

test("/session-resume autocomplete keeps home-relative workdir hint formatting through the service layer", async () => {
  const homeRoot = createTestHomeRoot();
  const cwd = join(homeRoot, "code-github/code-helm");
  const { services } = createControlChannelServicesFixture({
    homeDir: homeRoot,
    listThreadsData: {
      active: [
        createResumePickerThread({
          id: "codex-thread-service-1",
          cwd,
        }),
      ],
      archived: [],
    },
  });

  try {
    await services.setCurrentWorkdir({
      actorId: "owner-1",
      guildId: "guild-1",
      channelId: "control-1",
      path: "~/code-github/code-helm",
    });

    const choices = await services.autocompleteResumeSessions({
      actorId: "owner-1",
      guildId: "guild-1",
      channelId: "control-1",
      query: "codex",
    });

    expect(choices[0]).toEqual({
      name: "Current workdir: ~/code-github/code-helm · Use /workdir to switch directories",
      value: RESUME_WORKDIR_HINT_VALUE,
    });
    expect(choices[1]).toEqual({
      name: expect.stringContaining("codex-thread-service-1"),
      value: "codex-thread-service-1",
    });
    expect(choices).toHaveLength(2);
  } finally {
    rmSync(homeRoot, { recursive: true, force: true });
  }
});

test("resume attachment resolution distinguishes reuse, reopen, rebind, and create", () => {
  expect(
    resolveResumeAttachmentKind({
      existingSession: {
        lifecycleState: "active",
      },
      discordThreadUsable: true,
    }),
  ).toBe("reuse");

  expect(
    resolveResumeAttachmentKind({
      existingSession: {
        lifecycleState: "archived",
      },
      discordThreadUsable: true,
    }),
  ).toBe("reopen");

  expect(
    resolveResumeAttachmentKind({
      existingSession: {
        lifecycleState: "deleted",
      },
      discordThreadUsable: false,
    }),
  ).toBe("rebind");

  expect(
    resolveResumeAttachmentKind({
      existingSession: null,
      discordThreadUsable: true,
    }),
  ).toBe("create");
});

test("create session does not render an initial idle status card", async () => {
  const { services, calls, getSessionByCodexThreadId } = createControlChannelServicesFixture({
  });

  const result = await services.createSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  expect(calls.updateStatusCard).toEqual([]);
  expect(calls.deletedThreads).toEqual([]);
  expect(calls.deletedSessions).toEqual([]);
  expect(getSessionByCodexThreadId("codex-thread-1")).toMatchObject({
    discordThreadId: "discord-thread-new-1",
    lifecycleState: "active",
  });
  expect(result).toEqual({
    reply: {
      content: "Created session <#discord-thread-new-1> for `/tmp/workspace/api`.",
    },
  });
});

test("unmanaged idle session with matching workdir resumes the new Discord thread instead of plain sync", async () => {
  const { services, calls, getSessionByCodexThreadId } = createControlChannelServicesFixture();

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.readThreadIds).toEqual(["codex-thread-1"]);
  expect(calls.createVisibleSessionThread).toEqual([
    {
      title: "codex-thread-1",
      starterText: "Attaching Codex session `codex-thread-1` for `/tmp/workspace/api`.",
    },
  ]);
  expect(calls.insertedSessions).toEqual([
    {
      discordThreadId: "discord-thread-new-1",
      codexThreadId: "codex-thread-1",
      ownerDiscordUserId: "owner-1",
      cwd: "/tmp/workspace/api",
      state: "idle",
    },
  ]);
  expect(calls.resumedThreads).toEqual(["discord-thread-new-1"]);
  expect(calls.syncedThreads).toEqual([]);
  expect(getSessionByCodexThreadId("codex-thread-1")).toMatchObject({
    discordThreadId: "discord-thread-new-1",
    codexThreadId: "codex-thread-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/workspace/api",
  });
  expect(result).toEqual({
    reply: {
      content: "Attached session <#discord-thread-new-1>. Session is writable.",
    },
  });
});

test("archived managed session syncs and reopens the same Discord thread", async () => {
  const { services, calls } = createControlChannelServicesFixture({
    existingSession: createSessionRecord({
      discordThreadId: "discord-thread-archived",
      lifecycleState: "archived",
    }),
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.usabilityChecks).toEqual(["discord-thread-archived"]);
  expect(calls.createVisibleSessionThread).toHaveLength(0);
  expect(calls.resumedThreads).toEqual(["discord-thread-archived"]);
  expect(calls.syncedThreads).toEqual([]);
  expect(result).toEqual({
    reply: {
      content: "Attached session <#discord-thread-archived>. Session is writable.",
    },
  });
});

test("active idle managed session reuses and resumes the existing Discord thread instead of creating a duplicate", async () => {
  const { services, calls } = createControlChannelServicesFixture({
    existingSession: createSessionRecord({
      discordThreadId: "discord-thread-active",
      lifecycleState: "active",
    }),
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.usabilityChecks).toEqual(["discord-thread-active"]);
  expect(calls.createVisibleSessionThread).toHaveLength(0);
  expect(calls.resumedThreads).toEqual(["discord-thread-active"]);
  expect(calls.syncedThreads).toEqual([]);
  expect(result).toEqual({
    reply: {
      content: "Attached session <#discord-thread-active>. Session is writable.",
    },
  });
});

test("deleted or unusable idle managed thread resumes the replacement Discord thread through rebindDiscordThread", async () => {
  const { services, calls, getSessionByCodexThreadId } = createControlChannelServicesFixture({
    existingSession: createSessionRecord({
      discordThreadId: "discord-thread-deleted",
      lifecycleState: "deleted",
    }),
    discordThreadUsable: false,
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.usabilityChecks).toEqual(["discord-thread-deleted"]);
  expect(calls.createVisibleSessionThread).toEqual([
    {
      title: "codex-thread-1",
      starterText: "Attaching Codex session `codex-thread-1` for `/tmp/workspace/api`.",
    },
  ]);
  expect(calls.reboundThreads).toEqual([
    {
      currentDiscordThreadId: "discord-thread-deleted",
      nextDiscordThreadId: "discord-thread-new-1",
    },
  ]);
  expect(calls.lifecycleUpdates).toEqual([
    {
      discordThreadId: "discord-thread-new-1",
      lifecycleState: "active",
    },
  ]);
  expect(calls.resumedThreads).toEqual(["discord-thread-new-1"]);
  expect(calls.syncedThreads).toEqual([]);
  expect(getSessionByCodexThreadId("codex-thread-1")).toMatchObject({
    discordThreadId: "discord-thread-new-1",
    lifecycleState: "active",
  });
  expect(result).toEqual({
    reply: {
      content:
        "Attached session in replacement thread <#discord-thread-new-1>. Session is writable.",
    },
  });
});

test("/session-resume fails with No current workdir. Run /workdir first. when unset", async () => {
  const { services, calls } = createControlChannelServicesFixture();

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.readThreadIds).toEqual([]);
  expect(calls.createVisibleSessionThread).toEqual([]);
  expect(result).toEqual({
    reply: {
      content: "No current workdir. Run /workdir first.",
      ephemeral: true,
    },
  });
});

test("selecting the resume workdir hint explains how to switch directories when sessions exist", async () => {
  const { services, calls } = createControlChannelServicesFixture({
    listThreadsData: {
      active: [createResumePickerThread()],
      archived: [],
    },
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: RESUME_WORKDIR_HINT_VALUE,
  });

  expect(calls.readThreadIds).toEqual([]);
  expect(calls.createVisibleSessionThread).toEqual([]);
  expect(calls.syncedThreads).toEqual([]);
  expect(calls.resumedThreads).toEqual([]);
  expect(calls.listThreads).toEqual([
    {
      cwd: defaultSessionPath,
      searchTerm: null,
      limit: 1,
      sortKey: "updated_at",
      archived: false,
    },
    {
      cwd: defaultSessionPath,
      searchTerm: null,
      limit: 1,
      sortKey: "updated_at",
      archived: true,
    },
  ]);
  expect(result).toEqual({
    reply: {
      content:
        "Current workdir: `/tmp/workspace/api`. This row is only a hint and does not select a session. Run /workdir to switch directories, then choose a session below.",
      ephemeral: true,
    },
  });
});

test("selecting the resume workdir hint explains when no sessions exist in the current directory", async () => {
  const { services, calls } = createControlChannelServicesFixture();

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: RESUME_WORKDIR_HINT_VALUE,
  });

  expect(calls.readThreadIds).toEqual([]);
  expect(calls.createVisibleSessionThread).toEqual([]);
  expect(calls.syncedThreads).toEqual([]);
  expect(calls.resumedThreads).toEqual([]);
  expect(calls.listThreads).toEqual([
    {
      cwd: defaultSessionPath,
      searchTerm: null,
      limit: 1,
      sortKey: "updated_at",
      archived: false,
    },
    {
      cwd: defaultSessionPath,
      searchTerm: null,
      limit: 1,
      sortKey: "updated_at",
      archived: true,
    },
  ]);
  expect(result).toEqual({
    reply: {
      content:
        "Current workdir: `/tmp/workspace/api`. This row is only a hint and does not select a session. No sessions are available in this directory. Run /workdir to switch directories or use /session-new to create one here.",
      ephemeral: true,
    },
  });
});

test("selecting the resume workdir hint returns a controlled error when session probing fails", async () => {
  const { services, calls } = createControlChannelServicesFixture({
    listThreadsError: new Error("thread/list failed"),
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: RESUME_WORKDIR_HINT_VALUE,
  });

  expect(calls.readThreadIds).toEqual([]);
  expect(calls.createVisibleSessionThread).toEqual([]);
  expect(calls.syncedThreads).toEqual([]);
  expect(calls.resumedThreads).toEqual([]);
  expect(calls.listThreads).toEqual([
    {
      cwd: defaultSessionPath,
      searchTerm: null,
      limit: 1,
      sortKey: "updated_at",
      archived: false,
    },
    {
      cwd: defaultSessionPath,
      searchTerm: null,
      limit: 1,
      sortKey: "updated_at",
      archived: true,
    },
  ]);
  expect(result).toEqual({
    reply: {
      content:
        "Current workdir: `/tmp/workspace/api`. This hint row could not verify available sessions right now. Try /session-resume again or run /workdir to confirm the directory.",
      ephemeral: true,
    },
  });
});

test("hand-typed or stale session ids produce a deterministic user-facing error instead of leaking a raw provider exception", async () => {
  const { services } = createControlChannelServicesFixture({
    readThreadError: new Error("thread not found: codex-thread-1"),
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(result).toEqual({
    reply: {
      content:
        "Session `codex-thread-1` was not found in current workdir `/tmp/workspace/api`.",
      ephemeral: true,
    },
  });
});

test("a selected session whose authoritative cwd differs from current workdir is rejected", async () => {
  const { services, calls } = createControlChannelServicesFixture({
    readThreadCwd: alternateSessionPath,
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.createVisibleSessionThread).toHaveLength(0);
  expect(calls.syncedThreads).toEqual([]);
  expect(calls.resumedThreads).toEqual([]);
  expect(result).toEqual({
    reply: {
      content:
        "Session `codex-thread-1` belongs to `/tmp/workspace/web`, not `/tmp/workspace/api`.",
      ephemeral: true,
    },
  });
});

test("unexpected read-thread provider failures stay attach failures instead of being rewritten as not-found", async () => {
  const { services } = createControlChannelServicesFixture({
    readThreadError: new Error("unexpected rpc failure"),
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(result).toEqual({
    reply: {
      content: "Attach failed for `codex-thread-1`: unexpected rpc failure.",
      ephemeral: true,
    },
  });
});

test("create attach rolls back the new binding when starter relay fails", async () => {
  const failure = new Error("starter relay failed");
  const { services, calls, getSessionByCodexThreadId } = createControlChannelServicesFixture({
    createThreadSendError: failure,
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.deletedThreads).toEqual(["discord-thread-new-1"]);
  expect(calls.deletedSessions).toEqual(["discord-thread-new-1"]);
  expect(calls.syncedThreads).toEqual([]);
  expect(calls.resumedThreads).toEqual([]);
  expect(getSessionByCodexThreadId("codex-thread-1")).toMatchObject({
    discordThreadId: "discord-thread-new-1",
    lifecycleState: "deleted",
  });
  expect(result).toEqual({
    reply: {
      content: "Attach failed for `codex-thread-1`: starter relay failed.",
      ephemeral: true,
    },
  });
});

test("replacement attach restores the original binding when starter relay fails", async () => {
  const failure = new Error("starter relay failed");
  const { services, calls, getSessionByCodexThreadId } = createControlChannelServicesFixture({
    existingSession: createSessionRecord({
      discordThreadId: "discord-thread-deleted",
      lifecycleState: "deleted",
    }),
    discordThreadUsable: false,
    createThreadSendError: failure,
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.reboundThreads).toEqual([
    {
      currentDiscordThreadId: "discord-thread-deleted",
      nextDiscordThreadId: "discord-thread-new-1",
    },
    {
      currentDiscordThreadId: "discord-thread-new-1",
      nextDiscordThreadId: "discord-thread-deleted",
    },
  ]);
  expect(calls.lifecycleUpdates).toEqual([
    {
      discordThreadId: "discord-thread-new-1",
      lifecycleState: "active",
    },
    {
      discordThreadId: "discord-thread-deleted",
      lifecycleState: "deleted",
    },
  ]);
  expect(calls.deletedThreads).toEqual(["discord-thread-new-1"]);
  expect(calls.syncedThreads).toEqual([]);
  expect(calls.resumedThreads).toEqual([]);
  expect(getSessionByCodexThreadId("codex-thread-1")).toMatchObject({
    discordThreadId: "discord-thread-deleted",
    lifecycleState: "deleted",
  });
  expect(result).toEqual({
    reply: {
      content: "Attach failed for `codex-thread-1`: starter relay failed.",
      ephemeral: true,
    },
  });
});

test("waiting-approval create attach resumes the Discord thread instead of doing a plain sync", async () => {
  const waitingApprovalOutcome: SessionResumeState = {
    kind: "busy",
    session: {
      lifecycleState: "active",
      runtimeState: "waiting-approval",
      accessMode: "writable",
    },
    persistedRuntimeState: "waiting-approval",
    statusCardState: "waiting-approval",
  };
  const { services, calls } = createControlChannelServicesFixture({
    readThreadStatus: {
      type: "active",
      activeFlags: ["waitingOnApproval"],
    },
    resumeOutcome: waitingApprovalOutcome,
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.insertedSessions).toEqual([
    {
      discordThreadId: "discord-thread-new-1",
      codexThreadId: "codex-thread-1",
      ownerDiscordUserId: "owner-1",
      cwd: "/tmp/workspace/api",
      state: "waiting-approval",
    },
  ]);
  expect(calls.resumedThreads).toEqual(["discord-thread-new-1"]);
  expect(calls.syncedThreads).toEqual([]);
  expect(result).toEqual({
    reply: {
      content:
        "Attached session <#discord-thread-new-1>. Session remains `waiting-approval`.",
    },
  });
});

test("waiting-approval replacement attach resumes the replacement thread instead of doing a plain sync", async () => {
  const waitingApprovalOutcome: SessionResumeState = {
    kind: "busy",
    session: {
      lifecycleState: "active",
      runtimeState: "waiting-approval",
      accessMode: "writable",
    },
    persistedRuntimeState: "waiting-approval",
    statusCardState: "waiting-approval",
  };
  const { services, calls } = createControlChannelServicesFixture({
    existingSession: createSessionRecord({
      discordThreadId: "discord-thread-deleted",
      lifecycleState: "deleted",
      state: "waiting-approval",
    }),
    discordThreadUsable: false,
    readThreadStatus: {
      type: "active",
      activeFlags: ["waitingOnApproval"],
    },
    resumeOutcome: waitingApprovalOutcome,
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.resumedThreads).toEqual(["discord-thread-new-1"]);
  expect(calls.syncedThreads).toEqual([]);
  expect(result).toEqual({
    reply: {
      content:
        "Attached session in replacement thread <#discord-thread-new-1>. Session remains `waiting-approval`.",
    },
  });
});

test("untrusted create attach rolls back the new discord thread into a deleted binding", async () => {
  const { services, calls, getSessionByCodexThreadId } = createControlChannelServicesFixture({
    readThreadStatus: {
      type: "active",
      activeFlags: [],
    },
    syncOutcome: createResumeOutcome("untrusted"),
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.syncedThreads).toEqual(["discord-thread-new-1"]);
  expect(calls.deletedSessions).toEqual(["discord-thread-new-1"]);
  expect(calls.deletedThreads).toEqual(["discord-thread-new-1"]);
  expect(getSessionByCodexThreadId("codex-thread-1")).toMatchObject({
    discordThreadId: "discord-thread-new-1",
    lifecycleState: "deleted",
  });
  expect(result).toEqual({
    reply: {
      content:
        "Attach aborted for `codex-thread-1` because CodeHelm could not establish a trustworthy synced session view.",
      ephemeral: true,
    },
  });
});

test("untrusted replacement attach rebinds back to the original deleted thread", async () => {
  const { services, calls, getSessionByCodexThreadId } = createControlChannelServicesFixture({
    existingSession: createSessionRecord({
      discordThreadId: "discord-thread-deleted",
      lifecycleState: "deleted",
    }),
    discordThreadUsable: false,
    readThreadStatus: {
      type: "active",
      activeFlags: [],
    },
    syncOutcome: createResumeOutcome("untrusted"),
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.reboundThreads).toEqual([
    {
      currentDiscordThreadId: "discord-thread-deleted",
      nextDiscordThreadId: "discord-thread-new-1",
    },
    {
      currentDiscordThreadId: "discord-thread-new-1",
      nextDiscordThreadId: "discord-thread-deleted",
    },
  ]);
  expect(calls.deletedThreads).toEqual(["discord-thread-new-1"]);
  expect(getSessionByCodexThreadId("codex-thread-1")).toMatchObject({
    discordThreadId: "discord-thread-deleted",
    lifecycleState: "deleted",
  });
  expect(result).toEqual({
    reply: {
      content:
        "Attach aborted for `codex-thread-1` because CodeHelm could not establish a trustworthy synced session view.",
      ephemeral: true,
    },
  });
});

test("attached busy sessions stay non-writable", async () => {
  const { services, calls } = createControlChannelServicesFixture({
    readThreadStatus: {
      type: "active",
      activeFlags: [],
    },
    syncOutcome: createResumeOutcome("busy"),
  });

  await services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const result = await services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(calls.syncedThreads).toEqual(["discord-thread-new-1"]);
  expect(result).toEqual({
    reply: {
      content: "Attached session <#discord-thread-new-1>. Session remains `running`.",
    },
  });
});

test("attached degraded or error sessions stay read-only", async () => {
  const readOnlyFixture = createControlChannelServicesFixture({
    readThreadStatus: {
      type: "active",
      activeFlags: [],
    },
    syncOutcome: createResumeOutcome("read-only"),
  });

  await readOnlyFixture.services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const readOnlyResult = await readOnlyFixture.services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(readOnlyResult).toEqual({
    reply: {
      content: "Attached session <#discord-thread-new-1>. Session remains read-only.",
    },
  });
  expect(readOnlyFixture.calls.sentTexts).toEqual([]);

  const errorFixture = createControlChannelServicesFixture({
    readThreadStatus: { type: "systemError" },
    syncOutcome: createResumeOutcome("error"),
  });

  await errorFixture.services.setCurrentWorkdir({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    path: defaultSessionPath,
  });

  const errorResult = await errorFixture.services.resumeSession({
    actorId: "owner-1",
    guildId: "guild-1",
    channelId: "control-1",
    codexThreadId: "codex-thread-1",
  });

  expect(errorResult).toEqual({
    reply: {
      content:
        "Attached session <#discord-thread-new-1>. Session remains read-only because Codex reports an error state.",
    },
  });
  expect(errorFixture.calls.sentTexts).toEqual([
    {
      channelId: "discord-thread-new-1",
      content:
        "CodeHelm attached this thread as an error surface. Review the latest Codex state before sending more input.",
    },
  ]);
});

test("status descriptions stay readable in Discord output", () => {
  expect(describeCodexThreadStatus({ type: "idle" })).toBe("idle");
  expect(
    describeCodexThreadStatus({
      type: "active",
      activeFlags: ["waitingOnApproval", "waitingOnUserInput"],
    }),
  ).toBe("active(waitingOnApproval, waitingOnUserInput)");
});

test("archived managed sessions are surfaced as inactive instead of writable", () => {
  expect(
    describeSessionAccessMode({
      state: "idle",
      lifecycleState: "archived",
    }),
  ).toBe("inactive");
  expect(
    formatManagedSessionList([
      {
        discordThreadId: "discord-thread-1",
        codexThreadId: "codex-thread-1",
        cwd: "/tmp/workspace/api",
        lifecycleState: "archived",
        state: "idle",
      },
    ]),
  ).toContain("access `inactive`");
});

test("close command rejects non-managed threads", () => {
  expect(
    resolveCloseSessionCommand({
      actorId: "owner-1",
      session: null,
    }),
  ).toEqual({
    reply: {
      content: "Use this command in a managed session thread.",
      ephemeral: true,
    },
  });
});

test("close command rejects non-owners", () => {
  expect(
    resolveCloseSessionCommand({
      actorId: "viewer-1",
      session: {
        discordThreadId: "discord-thread-1",
        ownerDiscordUserId: "owner-1",
      },
    }),
  ).toEqual({
    reply: {
      content: "Only the session owner can close this session.",
      ephemeral: true,
    },
  });
});

test("sync command rejects non-managed threads", () => {
  expect(
    resolveSyncSessionCommand({
      actorId: "owner-1",
      session: null,
    }),
  ).toEqual({
    reply: {
      content: "Use this command in a managed session thread.",
      ephemeral: true,
    },
  });
});

test("sync command rejects non-owners and non-degraded sessions", () => {
  expect(
    resolveSyncSessionCommand({
      actorId: "viewer-1",
      session: createSessionRecord({
        state: "degraded",
        degradationReason: "snapshot_mismatch",
      }),
    }),
  ).toEqual({
    reply: {
      content: "Only the session owner can sync this session.",
      ephemeral: true,
    },
  });

  expect(
    resolveSyncSessionCommand({
      actorId: "owner-1",
      session: createSessionRecord({
        state: "idle",
      }),
    }),
  ).toEqual({
    reply: {
      content: "Session `codex-thread-1` is currently `idle`, not `degraded`.",
      ephemeral: true,
    },
  });
});

test("close session archives the same Discord thread before persisting lifecycle state", async () => {
  const calls: string[] = [];

  const result = await closeManagedSession({
    archiveThread: async () => {
      calls.push("archive");
    },
    unarchiveThread: async () => {
      calls.push("rollback");
    },
    persistLifecycleState: async (lifecycleState) => {
      calls.push(`lifecycle:${lifecycleState}`);
    },
  });

  expect(result).toEqual({
    lifecycleState: "archived",
  });
  expect(calls).toEqual([
    "archive",
    "lifecycle:archived",
  ]);
});

test("close session restores the thread when lifecycle persistence fails", async () => {
  const calls: string[] = [];
  const failure = new Error("close persistence failed");

  await expect(
    closeManagedSession({
      archiveThread: async () => {
        calls.push("archive");
      },
      unarchiveThread: async () => {
        calls.push("rollback");
      },
      persistLifecycleState: async () => {
        calls.push("lifecycle:archived");
        throw failure;
      },
    }),
  ).rejects.toBe(failure);

  expect(calls).toEqual([
    "archive",
    "lifecycle:archived",
    "rollback",
  ]);
});

test("resume session restores idle sessions as writable after sync", async () => {
  const calls: string[] = [];
  const initialSnapshot = createThreadReadResult({
    status: { type: "idle" },
    turns: [],
  });

  const result = await resumeManagedSession({
    session: createSessionRecord({
      lifecycleState: "archived",
      state: "idle",
    }),
    readThread: async () => initialSnapshot,
    archiveThread: async () => {
      calls.push("archive");
    },
    unarchiveThread: async () => {
      calls.push("unarchive");
    },
    persistLifecycleState: async (lifecycleState) => {
      calls.push(`lifecycle:${lifecycleState}`);
    },
    persistRuntimeState: async (runtimeState) => {
      calls.push(`state:${runtimeState}`);
    },
    updateStatusCard: async (runtimeState) => {
      calls.push(`status:${runtimeState}`);
    },
    syncTranscriptSnapshot: async (snapshot) => {
      expect(snapshot).toBe(initialSnapshot);
      calls.push("snapshot");
    },
  });

  expect(result).toEqual({
    kind: "ready",
    session: {
      lifecycleState: "active",
      runtimeState: "idle",
      accessMode: "writable",
    },
    persistedRuntimeState: "idle",
    statusCardState: "idle",
  });
  expect(calls).toEqual([
    "state:idle",
    "status:idle",
    "snapshot",
    "unarchive",
    "lifecycle:active",
  ]);
});

test("resume session materializes the Codex thread before reading the snapshot", async () => {
  const calls: string[] = [];
  const initialSnapshot = createThreadReadResult({
    status: { type: "idle" },
    turns: [],
  });

  const result = await resumeManagedSession({
    session: createSessionRecord({
      lifecycleState: "archived",
      state: "idle",
    }),
    materializeThread: async () => {
      calls.push("resume-thread");
    },
    readThread: async () => {
      calls.push("read");
      return initialSnapshot;
    },
    archiveThread: async () => {
      calls.push("archive");
    },
    unarchiveThread: async () => {
      calls.push("unarchive");
    },
    persistLifecycleState: async (lifecycleState) => {
      calls.push(`lifecycle:${lifecycleState}`);
    },
    persistRuntimeState: async (runtimeState) => {
      calls.push(`state:${runtimeState}`);
    },
    updateStatusCard: async (runtimeState) => {
      calls.push(`status:${runtimeState}`);
    },
    syncTranscriptSnapshot: async (snapshot) => {
      expect(snapshot).toBe(initialSnapshot);
      calls.push("snapshot");
    },
  });

  expect(result).toEqual({
    kind: "ready",
    session: {
      lifecycleState: "active",
      runtimeState: "idle",
      accessMode: "writable",
    },
    persistedRuntimeState: "idle",
    statusCardState: "idle",
  });
  expect(calls).toEqual([
    "resume-thread",
    "read",
    "state:idle",
    "status:idle",
    "snapshot",
    "unarchive",
    "lifecycle:active",
  ]);
});

test("resume session re-archives the thread when lifecycle persistence fails after reopen", async () => {
  const calls: string[] = [];
  const failure = new Error("resume persistence failed");

  await expect(
    resumeManagedSession({
      session: createSessionRecord({
        lifecycleState: "archived",
        state: "idle",
      }),
      readThread: async () => createThreadReadResult({
        status: { type: "idle" },
        turns: [],
      }),
      archiveThread: async () => {
        calls.push("archive");
      },
      unarchiveThread: async () => {
        calls.push("unarchive");
      },
      persistLifecycleState: async () => {
        calls.push("lifecycle:active");
        throw failure;
      },
      persistRuntimeState: async (runtimeState) => {
        calls.push(`state:${runtimeState}`);
      },
      updateStatusCard: async (runtimeState) => {
        calls.push(`status:${runtimeState}`);
      },
      syncTranscriptSnapshot: async () => {
        calls.push("snapshot");
      },
    }),
  ).rejects.toBe(failure);

  expect(calls).toEqual([
    "state:idle",
    "status:idle",
    "snapshot",
    "unarchive",
    "lifecycle:active",
    "archive",
  ]);
});

test("resume session leaves running and waiting-approval sessions busy after sync", async () => {
  const runningCalls: string[] = [];
  const waitingCalls: string[] = [];

  const running = await resumeManagedSession({
    session: createSessionRecord({
      lifecycleState: "archived",
      state: "running",
    }),
    readThread: async () => createThreadReadResult({
      status: { type: "active", activeFlags: [] },
      turns: [],
    }),
    archiveThread: async () => {
      runningCalls.push("archive");
    },
    unarchiveThread: async () => {
      runningCalls.push("unarchive");
    },
    persistLifecycleState: async (lifecycleState) => {
      runningCalls.push(`lifecycle:${lifecycleState}`);
    },
    persistRuntimeState: async (runtimeState) => {
      runningCalls.push(`state:${runtimeState}`);
    },
    updateStatusCard: async (runtimeState) => {
      runningCalls.push(`status:${runtimeState}`);
    },
    syncTranscriptSnapshot: async () => {
      runningCalls.push("snapshot");
    },
  });

  const waiting = await resumeManagedSession({
    session: createSessionRecord({
      lifecycleState: "archived",
      state: "waiting-approval",
    }),
    readThread: async () => createThreadReadResult({
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
      turns: [],
    }),
    archiveThread: async () => {
      waitingCalls.push("archive");
    },
    unarchiveThread: async () => {
      waitingCalls.push("unarchive");
    },
    persistLifecycleState: async (lifecycleState) => {
      waitingCalls.push(`lifecycle:${lifecycleState}`);
    },
    persistRuntimeState: async (runtimeState) => {
      waitingCalls.push(`state:${runtimeState}`);
    },
    updateStatusCard: async (runtimeState) => {
      waitingCalls.push(`status:${runtimeState}`);
    },
    syncTranscriptSnapshot: async () => {
      waitingCalls.push("snapshot");
    },
  });

  expect(running.kind).toBe("busy");
  expect(waiting.kind).toBe("busy");
  expect(runningCalls).toEqual([
    "state:running",
    "status:running",
    "snapshot",
    "unarchive",
    "lifecycle:active",
  ]);
  expect(waitingCalls).toEqual([
    "state:waiting-approval",
    "status:waiting-approval",
    "snapshot",
    "unarchive",
    "lifecycle:active",
  ]);
});

test("resume session treats interrupted threads as writable once Codex is next-input-ready", async () => {
  const calls: string[] = [];

  const result = await resumeManagedSession({
    session: createSessionRecord({
      lifecycleState: "archived",
      state: "running",
    }),
    readThread: async () => createThreadReadResult({
      status: { type: "idle" },
      turns: [{ id: "turn-1", items: [], status: "interrupted" }],
    }),
    archiveThread: async () => {
      calls.push("archive");
    },
    unarchiveThread: async () => {
      calls.push("unarchive");
    },
    persistLifecycleState: async (lifecycleState) => {
      calls.push(`lifecycle:${lifecycleState}`);
    },
    persistRuntimeState: async (runtimeState) => {
      calls.push(`state:${runtimeState}`);
    },
    updateStatusCard: async (runtimeState) => {
      calls.push(`status:${runtimeState}`);
    },
    syncTranscriptSnapshot: async () => {
      calls.push("snapshot");
    },
  });

  expect(result).toEqual({
    kind: "ready",
    session: {
      lifecycleState: "active",
      runtimeState: "interrupted",
      accessMode: "writable",
    },
    persistedRuntimeState: "idle",
    statusCardState: "idle",
  });
  expect(calls).toEqual([
    "state:idle",
    "status:idle",
    "snapshot",
    "unarchive",
    "lifecycle:active",
  ]);
});

test("resume session restores degraded sessions in read-only mode", async () => {
  const calls: string[] = [];

  const result = await resumeManagedSession({
    session: createSessionRecord({
      lifecycleState: "archived",
      state: "degraded",
      degradationReason: "snapshot_mismatch",
    }),
    readThread: async () => createThreadReadResult({
      status: { type: "idle" },
      turns: [],
    }),
    archiveThread: async () => {
      calls.push("archive");
    },
    unarchiveThread: async () => {
      calls.push("unarchive");
    },
    persistLifecycleState: async (lifecycleState) => {
      calls.push(`lifecycle:${lifecycleState}`);
    },
    persistRuntimeState: async (runtimeState) => {
      calls.push(`state:${runtimeState}`);
    },
    syncReadOnlySurface: async () => {
      calls.push("read-only-surface");
    },
    updateStatusCard: async (runtimeState) => {
      calls.push(`status:${runtimeState}`);
    },
    syncTranscriptSnapshot: async () => {
      calls.push("snapshot");
    },
  });

  expect(result).toEqual({
    kind: "read-only",
    session: {
      lifecycleState: "active",
      runtimeState: "idle",
      accessMode: "read-only",
    },
    persistedRuntimeState: "degraded",
    statusCardState: undefined,
  });
  expect(calls).toEqual([
    "state:degraded",
    "read-only-surface",
    "snapshot",
    "unarchive",
    "lifecycle:active",
  ]);
});

test("resume session exposes Codex error state without restoring writable control", async () => {
  const calls: string[] = [];

  const result = await resumeManagedSession({
    session: createSessionRecord({
      lifecycleState: "archived",
      state: "idle",
    }),
    readThread: async () => createThreadReadResult({
      status: { type: "systemError" },
      turns: [],
    }),
    archiveThread: async () => {
      calls.push("archive");
    },
    unarchiveThread: async () => {
      calls.push("unarchive");
    },
    persistLifecycleState: async (lifecycleState) => {
      calls.push(`lifecycle:${lifecycleState}`);
    },
    persistRuntimeState: async (runtimeState) => {
      calls.push(`state:${runtimeState}`);
    },
    updateStatusCard: async (runtimeState) => {
      calls.push(`status:${runtimeState}`);
    },
    syncTranscriptSnapshot: async () => {
      calls.push("snapshot");
    },
  });

  expect(result).toEqual({
    kind: "error",
    session: {
      lifecycleState: "active",
      runtimeState: "error",
      accessMode: "read-only",
    },
    persistedRuntimeState: "degraded",
    statusCardState: undefined,
  });
  expect(calls).toEqual([
    "state:degraded",
    "snapshot",
    "unarchive",
    "lifecycle:active",
  ]);
});

test("resume session applies the waiting-approval lifecycle message before reopening the thread", async () => {
  type ApprovalLifecycleTestMessage = {
    content: string;
    edit(payload: {
      content?: string;
      components?: unknown[];
    }): Promise<ApprovalLifecycleTestMessage>;
  };

  const calls: string[] = [];
  let approvalReconciled = false;
  let resolveRecoveredMessage:
    | ((message: ApprovalLifecycleTestMessage | undefined) => void)
    | undefined;
  const lifecycleState: {
    message?: ApprovalLifecycleTestMessage;
    pendingMessage?: Promise<ApprovalLifecycleTestMessage | undefined>;
  } = {};

  const recoveredMessagePromise = new Promise<
    ApprovalLifecycleTestMessage | undefined
  >((resolve) => {
    resolveRecoveredMessage = resolve;
  });
  const pendingApproval = createApprovalRecord({
    approvalKey: "turn-1:item-1",
  });
  const pendingApprovalContent = renderApprovalLifecycleMessage({
    approval: pendingApproval,
  });

  const resumePromise = resumeManagedSession({
    session: createSessionRecord({
      lifecycleState: "archived",
      state: "waiting-approval",
    }),
    readThread: async () => createThreadReadResult({
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
      turns: [],
    }),
    archiveThread: async () => {
      calls.push("archive");
    },
    persistRuntimeState: async (runtimeState) => {
      calls.push(`state:${runtimeState}`);
    },
    reconcileApprovalState: async () => {
      const pendingMessagePromise = upsertApprovalLifecycleMessage({
        currentMessage: lifecycleState.message,
        currentMessagePromise: recoveredMessagePromise,
        recoverMessage: async () => undefined,
        payload: renderApprovalLifecyclePayload({
          approvalKey: pendingApproval.approvalKey,
          approval: pendingApproval,
        }),
        sendMessage: async () => {
          throw new Error("should not send a replacement approval message");
        },
      });
      lifecycleState.pendingMessage = pendingMessagePromise;
      const threadMessage = await finalizeApprovalLifecycleMessageState({
        state: lifecycleState,
        operation: pendingMessagePromise,
      });

      approvalReconciled = true;

      if (threadMessage) {
        lifecycleState.message = threadMessage;
      }

      calls.push(`approval:${lifecycleState.message?.content ?? "missing"}`);
    },
    unarchiveThread: async () => {
      calls.push("unarchive");
      expect(approvalReconciled).toBe(true);
      expect(lifecycleState.message?.content).toBe(pendingApprovalContent);
      expect(lifecycleState.pendingMessage).toBeUndefined();
    },
    persistLifecycleState: async (lifecycleStateValue) => {
      calls.push(`lifecycle:${lifecycleStateValue}`);
    },
    updateStatusCard: async (runtimeState) => {
      calls.push(`status:${runtimeState}`);
    },
    syncTranscriptSnapshot: async () => {
      calls.push("snapshot");
    },
  });

  const recoveredMessage: ApprovalLifecycleTestMessage = {
    content: "Approval `req-7`: pending.",
    async edit(payload: {
      content?: string;
      components?: unknown[];
      embeds?: Array<{ description?: string }>;
    }) {
      recoveredMessage.content =
        payload.content
        ?? payload.embeds?.[0]?.description
        ?? recoveredMessage.content;
      return recoveredMessage;
    },
  };

  resolveRecoveredMessage?.(recoveredMessage);

  await Promise.resolve();
  expect(calls).toEqual([]);

  const result = await resumePromise;

  expect(result).toEqual({
    kind: "busy",
    session: {
      lifecycleState: "active",
      runtimeState: "waiting-approval",
      accessMode: "writable",
    },
    persistedRuntimeState: "waiting-approval",
    statusCardState: "waiting-approval",
  });
  expect(calls).toEqual([
    `approval:${pendingApprovalContent}`,
    "state:waiting-approval",
    "status:waiting-approval",
    "snapshot",
    "unarchive",
    "lifecycle:active",
  ]);
});

test("resume session leaves the thread archived when approval reconciliation fails", async () => {
  const calls: string[] = [];
  const failure = new Error("approval recovery failed");

  await expect(
    resumeManagedSession({
      session: createSessionRecord({
        lifecycleState: "archived",
        state: "waiting-approval",
      }),
      readThread: async () => createThreadReadResult({
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
        turns: [],
      }),
      archiveThread: async () => {
        calls.push("archive");
      },
      persistRuntimeState: async (runtimeState) => {
        calls.push(`state:${runtimeState}`);
      },
      persistLifecycleState: async (lifecycleState) => {
        calls.push(`lifecycle:${lifecycleState}`);
      },
      reconcileApprovalState: async () => {
        calls.push("approval");
        throw failure;
      },
      unarchiveThread: async () => {
        calls.push("unarchive");
      },
      updateStatusCard: async (runtimeState) => {
        calls.push(`status:${runtimeState}`);
      },
      syncTranscriptSnapshot: async () => {
        calls.push("snapshot");
      },
    }),
  ).rejects.toBe(failure);

  expect(calls).toEqual([
    "approval",
  ]);
});

test("resume session leaves the thread archived when transcript sync fails", async () => {
  const calls: string[] = [];
  const failure = new Error("snapshot recovery failed");

  await expect(
    resumeManagedSession({
      session: createSessionRecord({
        lifecycleState: "archived",
        state: "idle",
      }),
      readThread: async () => createThreadReadResult({
        status: { type: "idle" },
        turns: [],
      }),
      archiveThread: async () => {
        calls.push("archive");
      },
      persistRuntimeState: async (runtimeState) => {
        calls.push(`state:${runtimeState}`);
      },
      unarchiveThread: async () => {
        calls.push("unarchive");
      },
      persistLifecycleState: async (lifecycleState) => {
        calls.push(`lifecycle:${lifecycleState}`);
      },
      updateStatusCard: async (runtimeState) => {
        calls.push(`status:${runtimeState}`);
      },
      syncTranscriptSnapshot: async () => {
        calls.push("snapshot");
        throw failure;
      },
    }),
  ).rejects.toBe(failure);

  expect(calls).toEqual([
    "state:idle",
    "status:idle",
    "snapshot",
  ]);
});

test("resume session fails closed when sync cannot establish a trustworthy view", async () => {
  const calls: string[] = [];

  const result = await resumeManagedSession({
    session: createSessionRecord({
      lifecycleState: "archived",
      state: "running",
    }),
    readThread: async () => createThreadReadResult({
      status: { type: "active", activeFlags: [] },
      turns: [{ id: "turn-1", items: [], status: "interrupted" }],
    }),
    archiveThread: async () => {
      calls.push("archive");
    },
    unarchiveThread: async () => {
      calls.push("unarchive");
    },
    persistLifecycleState: async (lifecycleState) => {
      calls.push(`lifecycle:${lifecycleState}`);
    },
    persistRuntimeState: async (runtimeState) => {
      calls.push(`state:${runtimeState}`);
    },
    reconcileApprovalState: async () => {
      calls.push("approval");
    },
    updateStatusCard: async (runtimeState) => {
      calls.push(`status:${runtimeState}`);
    },
    syncTranscriptSnapshot: async () => {
      calls.push("snapshot");
    },
  });

  expect(result).toEqual({
    kind: "untrusted",
    reason: "sync_state_untrusted",
  });
  expect(calls).toEqual([]);
});

test("approval reconciliation rebuilds waiting-approval surfaces from stored approval rows", async () => {
  const calls: string[] = [];
  const pendingApproval = createApprovalRecord();
  const pendingContent = renderApprovalLifecycleMessage({
    approval: pendingApproval,
  });

  await reconcileResumedApprovalState({
    runtimeState: "waiting-approval",
    pendingApprovals: [
      createApprovalRecord({
        approvalKey: "turn-2:item-1",
        requestId: "req-2",
        commandPreview: "touch z.txt",
      }),
      pendingApproval,
    ],
    upsertApprovalMessage: async (approval: ApprovalRecord) => {
      calls.push(`message:${approval.approvalKey}:${renderApprovalLifecycleMessage({
        approval,
      })}`);
    },
    rememberPendingApproval: async (approval: ApprovalRecord) => {
      calls.push(`remember:${approval.approvalKey}:${approval.requestId}`);
    },
    ensureOwnerControls: async (approval: ApprovalRecord) => {
      calls.push(`unexpected-owner-controls:${approval.approvalKey}`);
    },
  } as never);

  expect(calls).toEqual([
    "remember:turn-2:item-1:req-2",
    `message:turn-2:item-1:${renderApprovalLifecycleMessage({
      approval: createApprovalRecord({
        approvalKey: "turn-2:item-1",
        requestId: "req-2",
        commandPreview: "touch z.txt",
      }),
    })}`,
  ]);
  expect(calls.join("\n")).not.toContain("Approval `req-2`: pending.");
  expect(pendingContent).toContain("```sh\ntouch c.txt\n```");

  calls.length = 0;

  await reconcileResumedApprovalState({
    runtimeState: "running",
    pendingApprovals: [
      createApprovalRecord({
        approvalKey: "turn-2:item-1",
        requestId: "req-2",
      }),
    ],
    upsertApprovalMessage: async (approval: ApprovalRecord) => {
      calls.push(`message:${approval.approvalKey}:${approval.requestId}`);
    },
    rememberPendingApproval: async (approval: ApprovalRecord) => {
      calls.push(`remember:${approval.approvalKey}:${approval.requestId}`);
    },
    ensureOwnerControls: async (approval: ApprovalRecord) => {
      calls.push(`dm:${approval.approvalKey}:${approval.requestId}`);
    },
  } as never);

  expect(calls).toEqual([]);
});

test("approval reconciliation rejects waiting-approval sessions without a pending approval", async () => {
  await expect(
    reconcileResumedApprovalState({
      runtimeState: "waiting-approval",
      pendingApprovals: [],
      upsertApprovalMessage: async () => {},
    }),
  ).rejects.toThrow(
    "waiting-approval session has no pending approval to reconcile",
  );
});

test("approval reconciliation tolerates a locally answered approval that is still awaiting provider resolution", async () => {
  const calls: string[] = [];

  await reconcileResumedApprovalState({
    runtimeState: "waiting-approval",
    pendingApprovals: [],
    latestApproval: createApprovalRecord({
      approvalKey: "turn-9:item-1",
      requestId: "req-9",
      status: "approved",
    }),
    upsertApprovalMessage: async (approval) => {
      calls.push(`message:${approval.approvalKey}:${approval.requestId}:${approval.status}`);
    },
    rememberPendingApproval: async (approval) => {
      calls.push(`remember:${approval.approvalKey}:${approval.requestId}:${approval.status}`);
    },
  });

  expect(calls).toEqual([
    "remember:turn-9:item-1:req-9:approved",
    "message:turn-9:item-1:req-9:approved",
  ]);
});

test("resume re-seeds a locally answered approval so resolved events without threadId still bind after restart", async () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);
  const runtimeApprovalKeysByRequestId = new Map<string, Set<string>>();

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/ws1/app",
    state: "waiting-approval",
  });

  approvalRepo.insert({
    approvalKey: "turn-1:call-1",
    requestId: "req-dup",
    codexThreadId: "codex-1",
    discordThreadId: "discord-thread-1",
    status: "approved",
    resolvedByDiscordUserId: "owner-1",
    resolution: "approved",
  });
  approvalRepo.insert({
    approvalKey: "turn-2:call-1",
    requestId: "req-dup",
    codexThreadId: "codex-1",
    discordThreadId: "discord-thread-1",
    status: "approved",
    resolvedByDiscordUserId: "owner-1",
    resolution: "approved",
  });

  await reconcileResumedApprovalState({
    runtimeState: "waiting-approval",
    pendingApprovals: [],
    latestApproval: createApprovalRecord({
      approvalKey: "turn-2:call-1",
      requestId: "req-dup",
      status: "approved",
    }),
    upsertApprovalMessage: async () => {},
    rememberPendingApproval: async (approval) => {
      rememberRuntimeApprovalRequest(runtimeApprovalKeysByRequestId, approval);
    },
  });

  expect(
    resolveStoredApprovalForResolvedEvent({
      approvalRepo,
      runtimeApprovalKeysByRequestId,
      event: {
        requestId: "req-dup",
      },
    }),
  ).toMatchObject({
    approvalKey: "turn-2:call-1",
    requestId: "req-dup",
    status: "approved",
  });

  db.close();
});

test("managed session thread input is blocked for archived and deleted lifecycles", () => {
  expect(
    canAcceptManagedSessionThreadInput(
      createSessionRecord({
        lifecycleState: "active",
      }),
    ),
  ).toBe(true);
  expect(
    canAcceptManagedSessionThreadInput(
      createSessionRecord({
        lifecycleState: "archived",
      }),
    ),
  ).toBe(false);
  expect(
    canAcceptManagedSessionThreadInput(
      createSessionRecord({
        lifecycleState: "deleted",
      }),
    ),
  ).toBe(false);
  expect(
    shouldProjectManagedSessionDiscordSurface(
      createSessionRecord({
        lifecycleState: "active",
      }),
    ),
  ).toBe(true);
  expect(
    shouldProjectManagedSessionDiscordSurface(
      createSessionRecord({
        lifecycleState: "archived",
      }),
    ),
  ).toBe(false);
  expect(
    shouldProjectManagedSessionDiscordSurface(
      createSessionRecord({
        lifecycleState: "deleted",
      }),
    ),
  ).toBe(false);
});

test("archived owner message resumes first and only forwards when the synced session is ready", async () => {
  const calls: string[] = [];

  const result = await handleArchivedManagedSessionThreadMessage({
    authorId: "owner-1",
    ownerId: "owner-1",
    content: "resume and continue",
    resumeSession: async () => {
      calls.push("resume");
      return {
        kind: "ready",
        session: {
          lifecycleState: "active",
          runtimeState: "idle",
          accessMode: "writable",
        },
        persistedRuntimeState: "idle",
        statusCardState: "idle",
      };
    },
    forwardMessage: async (input: Array<{ type: "text"; text: string }>) => {
      calls.push(`forward:${input[0]?.text ?? ""}`);
    },
    rearchiveSession: async () => {
      calls.push("rearchive");
    },
  });

  expect(result).toEqual({
    kind: "forwarded",
    session: {
      lifecycleState: "active",
      runtimeState: "idle",
      accessMode: "writable",
    },
  });
  expect(calls).toEqual([
    "resume",
    "forward:resume and continue",
  ]);
});

test("archived owner message does not forward when resume sync finds the session busy", async () => {
  const calls: string[] = [];

  const result = await handleArchivedManagedSessionThreadMessage({
    authorId: "owner-1",
    ownerId: "owner-1",
    content: "resume and continue",
    resumeSession: async () => {
      calls.push("resume");
      return {
        kind: "busy",
        session: {
          lifecycleState: "active",
          runtimeState: "running",
          accessMode: "writable",
        },
        persistedRuntimeState: "running",
        statusCardState: "running",
      };
    },
    forwardMessage: async () => {
      calls.push("forward");
    },
    rearchiveSession: async () => {
      calls.push("rearchive");
    },
  });

  expect(result).toEqual({
    kind: "busy",
    session: {
      lifecycleState: "active",
      runtimeState: "running",
      accessMode: "writable",
    },
  });
  expect(calls).toEqual([
    "resume",
  ]);
});

test("archived owner message does not forward interrupted synced sessions", async () => {
  const calls: string[] = [];

  const result = await handleArchivedManagedSessionThreadMessage({
    authorId: "owner-1",
    ownerId: "owner-1",
    content: "resume and continue",
    resumeSession: async () => {
      calls.push("resume");
      return {
        kind: "ready",
        session: {
          lifecycleState: "active",
          runtimeState: "interrupted",
          accessMode: "writable",
        },
        persistedRuntimeState: "idle",
        statusCardState: "idle",
      };
    },
    forwardMessage: async () => {
      calls.push("forward");
    },
    rearchiveSession: async () => {
      calls.push("rearchive");
    },
  });

  expect(result).toEqual({
    kind: "ready",
    session: {
      lifecycleState: "active",
      runtimeState: "interrupted",
      accessMode: "writable",
    },
  });
  expect(calls).toEqual([
    "resume",
  ]);
});

test("archived owner message keeps degraded sessions read-only after resume sync", async () => {
  const calls: string[] = [];

  const result = await handleArchivedManagedSessionThreadMessage({
    authorId: "owner-1",
    ownerId: "owner-1",
    content: "resume and continue",
    resumeSession: async () => {
      calls.push("resume");
      return {
        kind: "read-only",
        session: {
          lifecycleState: "active",
          runtimeState: "idle",
          accessMode: "read-only",
        },
        persistedRuntimeState: "degraded",
        statusCardState: undefined,
      };
    },
    forwardMessage: async () => {
      calls.push("forward");
    },
    rearchiveSession: async () => {
      calls.push("rearchive");
    },
  });

  expect(result).toEqual({
    kind: "read-only",
    session: {
      lifecycleState: "active",
      runtimeState: "idle",
      accessMode: "read-only",
    },
  });
  expect(calls).toEqual([
    "resume",
  ]);
});

test("archived non-owner message is ignored and best-effort re-archives the thread", async () => {
  const calls: string[] = [];

  const result = await handleArchivedManagedSessionThreadMessage({
    authorId: "viewer-1",
    ownerId: "owner-1",
    content: "resume and continue",
    resumeSession: async () => {
      calls.push("resume");
      return {
        kind: "ready",
        session: {
          lifecycleState: "active",
          runtimeState: "idle",
          accessMode: "writable",
        },
        persistedRuntimeState: "idle",
        statusCardState: "idle",
      };
    },
    forwardMessage: async () => {
      calls.push("forward");
    },
    rearchiveSession: async () => {
      calls.push("rearchive");
    },
  });

  expect(result).toEqual({
    kind: "ignored",
    reason: "non-owner",
  });
  expect(calls).toEqual([
    "rearchive",
  ]);
});

test("archived owner message fails closed and re-archives when resume sync is untrusted", async () => {
  const calls: string[] = [];

  const result = await handleArchivedManagedSessionThreadMessage({
    authorId: "owner-1",
    ownerId: "owner-1",
    content: "resume and continue",
    resumeSession: async () => {
      calls.push("resume");
      return {
        kind: "untrusted",
        reason: "sync_state_untrusted",
      };
    },
    forwardMessage: async () => {
      calls.push("forward");
    },
    rearchiveSession: async () => {
      calls.push("rearchive");
    },
  });

  expect(result).toEqual({
    kind: "failed-closed",
    reason: "resume-untrusted",
  });
  expect(calls).toEqual([
    "resume",
    "rearchive",
  ]);
});

test("archived owner message best-effort re-archives before surfacing resume failures", async () => {
  const calls: string[] = [];
  const failure = new Error("snapshot recovery failed");

  await expect(
    handleArchivedManagedSessionThreadMessage({
      authorId: "owner-1",
      ownerId: "owner-1",
      content: "resume and continue",
      resumeSession: async () => {
        calls.push("resume");
        throw failure;
      },
      forwardMessage: async () => {
        calls.push("forward");
      },
      rearchiveSession: async () => {
        calls.push("rearchive");
      },
    }),
  ).rejects.toBe(failure);

  expect(calls).toEqual([
    "resume",
    "rearchive",
  ]);
});

test("archived owner message re-archives the managed session when forwarding fails after resume", async () => {
  const calls: string[] = [];
  const failure = new Error("turn start failed");

  await expect(
    handleArchivedManagedSessionThreadMessage({
      authorId: "owner-1",
      ownerId: "owner-1",
      content: "resume and continue",
      resumeSession: async () => {
        calls.push("resume");
        return {
          kind: "ready",
          session: {
            lifecycleState: "active",
            runtimeState: "idle",
            accessMode: "writable",
          },
          persistedRuntimeState: "idle",
          statusCardState: "idle",
        };
      },
      forwardMessage: async () => {
        calls.push("forward");
        throw failure;
      },
      rearchiveSession: async () => {
        calls.push("rearchive");
      },
    }),
  ).rejects.toBe(failure);

  expect(calls).toEqual([
    "resume",
    "forward",
    "rearchive",
  ]);
});

test("turn completion only projects transcript and status into active Discord threads", async () => {
  const activeCalls: string[] = [];
  const archivedCalls: string[] = [];

  await applyManagedTurnCompletion({
    session: createSessionRecord({
      lifecycleState: "active",
      state: "running",
    }),
    markIdle: () => {
      activeCalls.push("idle");
    },
    updateStatusCard: async () => {
      activeCalls.push("status");
    },
    syncTranscriptSnapshot: async () => {
      activeCalls.push("snapshot");
    },
  });

  await applyManagedTurnCompletion({
    session: createSessionRecord({
      lifecycleState: "archived",
      state: "running",
    }),
    markIdle: () => {
      archivedCalls.push("idle");
    },
    updateStatusCard: async () => {
      archivedCalls.push("status");
    },
    syncTranscriptSnapshot: async () => {
      archivedCalls.push("snapshot");
    },
  });

  expect(activeCalls).toEqual([
    "idle",
    "status",
    "snapshot",
  ]);
  expect(archivedCalls).toEqual([
    "idle",
  ]);
});

test("bootstrap thread title renames once and accepts short first messages", async () => {
  for (const firstMessage of ["hi", "1", "继续"]) {
    const renames: string[] = [];
    const thread = {
      name: "codex-thread-1",
      async setName(nextName: string) {
        renames.push(nextName);
        this.name = nextName;
      },
    };

    await maybeBootstrapManagedThreadTitle({
      client: {
        channels: {
          fetch: async () => thread,
        },
      } as never,
      session: createSessionRecord({
        discordThreadId: "discord-thread-1",
        codexThreadId: "codex-thread-1",
      }),
      readThreadSnapshot: async () => ({
        thread: createResumePickerThread({
          turns: [
            {
              id: "turn-1",
              items: [
                {
                  type: "userMessage",
                  id: "item-user-1",
                  content: [{ type: "text", text: firstMessage }],
                },
              ],
            },
          ],
        }),
      }),
    });

    await maybeBootstrapManagedThreadTitle({
      client: {
        channels: {
          fetch: async () => thread,
        },
      } as never,
      session: createSessionRecord({
        discordThreadId: "discord-thread-1",
        codexThreadId: "codex-thread-1",
      }),
      readThreadSnapshot: async () => {
        throw new Error("should not read snapshot after the bootstrap rename is complete");
      },
    });

    expect(renames).toEqual([firstMessage]);
  }
});

test("bootstrap thread title uses the first thread message from snapshot, not a later completed turn", async () => {
  const renames: string[] = [];
  const thread = {
    name: "codex-thread-1",
    async setName(nextName: string) {
      renames.push(nextName);
      this.name = nextName;
    },
  };

  await maybeBootstrapManagedThreadTitle({
    client: {
      channels: {
        fetch: async () => thread,
      },
    } as never,
    session: createSessionRecord({
      discordThreadId: "discord-thread-1",
      codexThreadId: "codex-thread-1",
    }),
    completedTurn: {
      id: "turn-2",
      items: [
        {
          type: "userMessage",
          id: "item-user-2",
          content: [{ type: "text", text: "later turn title" }],
        },
      ],
    },
    readThreadSnapshot: async () => ({
      thread: createResumePickerThread({
        turns: [
          {
            id: "turn-1",
            items: [
              {
                type: "userMessage",
                id: "item-user-1",
                content: [{ type: "text", text: "first thread title" }],
              },
            ],
          },
          {
            id: "turn-2",
            items: [
              {
                type: "userMessage",
                id: "item-user-2",
                content: [{ type: "text", text: "later turn title" }],
              },
            ],
          },
        ],
      }),
    }),
  });

  expect(renames).toEqual(["first thread title"]);
});

test("approval resolution updates the existing lifecycle message in place even while the thread is archived", async () => {
  const calls: string[] = [];
  const pendingApproval = createApprovalRecord();
  const resolvedApproval = createApprovalRecord({
    status: "resolved",
  });
  const resolvedContent = renderApprovalLifecycleMessage({
    approval: resolvedApproval,
  });
  const lifecycleMessage = {
    content: renderApprovalLifecycleMessage({
      approval: pendingApproval,
    }),
    async edit(payload: {
      content?: string;
      components?: unknown[];
      embeds?: Array<{ description?: string }>;
    }) {
      const description = payload.embeds?.[0]?.description;
      calls.push(`thread:${description}:${payload.components?.length ?? 0}`);
      lifecycleMessage.content = payload.content ?? description ?? lifecycleMessage.content;
      return lifecycleMessage;
    },
  };

  await reconcileApprovalResolutionSurface({
    approval: resolvedApproval,
    session: createSessionRecord({
      lifecycleState: "archived",
    }),
    currentThreadMessage: lifecycleMessage,
    currentThreadMessagePromise: undefined,
    recoverThreadMessage: async () => undefined,
    sendThreadMessage: async (payload) => {
      calls.push(
        `send:${payload.embeds?.[0]?.description}:${payload.components?.length ?? 0}`,
      );
      return lifecycleMessage;
    },
  });

  expect(calls).toEqual([
    `thread:${resolvedContent}:0`,
  ]);
  expect(resolvedContent.startsWith("Resolved: touch c.txt")).toBe(true);
  expect(resolvedContent).not.toContain("Request ID:");
});

test("managed thread deletion detaches the Discord container without touching unknown threads", () => {
  const calls: string[] = [];

  expect(
    handleManagedThreadDeletion({
      threadId: "discord-thread-1",
      sessionRepo: {
        getByDiscordThreadId: (threadId: string) =>
          threadId === "discord-thread-1" ? createSessionRecord() : null,
        markDeleted: (threadId: string) => {
          calls.push(`deleted:${threadId}`);
        },
      } as never,
    }),
  ).toBe(true);

  expect(
    handleManagedThreadDeletion({
      threadId: "discord-thread-missing",
      sessionRepo: {
        getByDiscordThreadId: () => null,
        markDeleted: (threadId: string) => {
          calls.push(`deleted:${threadId}`);
        },
      } as never,
    }),
  ).toBe(false);

  expect(calls).toEqual([
    "deleted:discord-thread-1",
  ]);
});

test("approval interaction replies to Codex before persisting a terminal local decision", async () => {
  const calls: string[] = [];
  const approvalKey = "turn-1:item-1";
  let status: ApprovalRecord["status"] = "pending";
  let insertedApproval: Record<string, unknown> | undefined;

  const handled = await handleApprovalInteraction({
    interaction: {
      customId: "approval|turn-1%3Aitem-1|acceptForSession",
      user: { id: "owner-1" },
      deferUpdate: async () => {
        calls.push("defer");
      },
      reply: async () => {
        calls.push("reply");
      },
    } as never,
    client: {
      replyToServerRequest: async (payload: { result: { decision: string } }) => {
        calls.push(`rpc:${payload.result.decision}`);
      },
    } as never,
    sessionRepo: {
      getByDiscordThreadId: () =>
        createSessionRecord({
          discordThreadId: "discord-thread-1",
          ownerDiscordUserId: "owner-1",
        }),
    } as never,
    approvalRepo: {
      getByApprovalKey: () => ({
        approvalKey,
        requestId: "req-1",
        codexThreadId: "codex-thread-1",
        discordThreadId: "discord-thread-1",
        status,
        decisionCatalog: JSON.stringify([
          {
            key: "acceptForSession",
            providerDecision: "acceptForSession",
            label: "Yes, and don't ask again for this command in this session",
          },
        ]),
      }),
      insert: (approval: Record<string, unknown>) => {
        insertedApproval = approval;
        status = "approved";
        calls.push("insert");
      },
    } as never,
    afterPersistTerminalDecision: async (approval: ApprovalRecord) => {
      calls.push(`surface:${approval.approvalKey}:${approval.status}`);
    },
  } as never);

  expect(handled).toBe(true);
  expect(calls).toEqual([
    "defer",
    "rpc:acceptForSession",
    "insert",
    "surface:turn-1:item-1:approved",
  ]);
  expect(insertedApproval).toMatchObject({
    status: "approved",
    resolvedProviderDecision: "acceptForSession",
    resolvedBySurface: "discord_thread",
    resolvedElsewhere: false,
    resolution: "approved",
  });
});

test("approval interaction preserves numeric-looking string request ids", async () => {
  const rpcPayloads: Array<{ requestId: string | number; result: { decision: string } }> = [];

  const handled = await handleApprovalInteraction({
    interaction: {
      customId: "approval|turn-1%3Aitem-1|accept",
      user: { id: "owner-1" },
      deferUpdate: async () => {},
      reply: async () => {},
    } as never,
    client: {
      replyToServerRequest: async (payload: {
        requestId: string | number;
        result: { decision: string };
      }) => {
        rpcPayloads.push(payload);
      },
    } as never,
    sessionRepo: {
      getByDiscordThreadId: () =>
        createSessionRecord({
          discordThreadId: "discord-thread-1",
          ownerDiscordUserId: "owner-1",
        }),
    } as never,
    approvalRepo: {
      getByApprovalKey: () => ({
        approvalKey: "turn-1:item-1",
        requestId: "01",
        codexThreadId: "codex-thread-1",
        discordThreadId: "discord-thread-1",
        status: "pending",
        decisionCatalog: JSON.stringify([
          {
            key: "accept",
            providerDecision: "accept",
            label: "Yes, proceed",
          },
        ]),
      }),
      insert: () => {},
    } as never,
  } as never);

  expect(handled).toBe(true);
  expect(rpcPayloads).toEqual([
    {
      requestId: "01",
      result: { decision: "accept" },
    },
  ]);
});

test("approval interaction prefers the live provider request id type over the stored string id", async () => {
  const rpcPayloads: Array<{ requestId: string | number; result: { decision: string } }> = [];

  const handled = await handleApprovalInteraction({
    interaction: {
      customId: "approval|turn-1%3Aitem-1|accept",
      user: { id: "owner-1" },
      deferUpdate: async () => {},
      reply: async () => {},
    } as never,
    client: {
      replyToServerRequest: async (payload: {
        requestId: string | number;
        result: { decision: string };
      }) => {
        rpcPayloads.push(payload);
      },
    } as never,
    sessionRepo: {
      getByDiscordThreadId: () =>
        createSessionRecord({
          discordThreadId: "discord-thread-1",
          ownerDiscordUserId: "owner-1",
        }),
    } as never,
    approvalRepo: {
      getByApprovalKey: () => ({
        approvalKey: "turn-1:item-1",
        requestId: "1",
        codexThreadId: "codex-thread-1",
        discordThreadId: "discord-thread-1",
        status: "pending",
        decisionCatalog: JSON.stringify([
          {
            key: "accept",
            providerDecision: "accept",
            label: "Yes, proceed",
          },
        ]),
      }),
      insert: () => {},
    } as never,
    runtimeProviderRequestIdsByApprovalKey: new Map([
      ["turn-1:item-1", 1],
    ]),
  } as never);

  expect(handled).toBe(true);
  expect(rpcPayloads).toEqual([
    {
      requestId: 1,
      result: { decision: "accept" },
    },
  ]);
});

test("approval interaction falls back to the persisted provider request id after restart", async () => {
  const rpcPayloads: Array<{ requestId: string | number; result: { decision: string } }> = [];

  const handled = await handleApprovalInteraction({
    interaction: {
      customId: "approval|turn-1%3Aitem-1|accept",
      user: { id: "owner-1" },
      deferUpdate: async () => {},
      reply: async () => {},
    } as never,
    client: {
      replyToServerRequest: async (payload: {
        requestId: string | number;
        result: { decision: string };
      }) => {
        rpcPayloads.push(payload);
      },
    } as never,
    sessionRepo: {
      getByDiscordThreadId: () =>
        createSessionRecord({
          discordThreadId: "discord-thread-1",
          ownerDiscordUserId: "owner-1",
        }),
    } as never,
    approvalRepo: {
      getByApprovalKey: () => ({
        approvalKey: "turn-1:item-1",
        requestId: "1",
        codexThreadId: "codex-thread-1",
        discordThreadId: "discord-thread-1",
        status: "pending",
        decisionCatalog: JSON.stringify([
          {
            key: "accept",
            providerDecision: "accept",
            label: "Yes, proceed",
          },
        ]),
      }),
      getProviderRequestId: () => 1,
      insert: () => {},
    } as never,
  } as never);

  expect(handled).toBe(true);
  expect(rpcPayloads).toEqual([
    {
      requestId: 1,
      result: { decision: "accept" },
    },
  ]);
});

test("approval interaction rejects unknown persisted provider decisions", async () => {
  const calls: string[] = [];
  const replies: Array<{
    allowedMentions?: { parse: string[] };
    content: string;
    ephemeral: boolean;
  }> = [];

  const handled = await handleApprovalInteraction({
    interaction: {
      customId: "approval|turn-1%3Aitem-1|futureDecision",
      user: { id: "owner-1" },
      deferUpdate: async () => {
        calls.push("defer");
      },
      reply: async (payload: {
        allowedMentions?: { parse: string[] };
        content: string;
        ephemeral: boolean;
      }) => {
        calls.push("reply");
        replies.push(payload);
      },
    } as never,
    client: {
      replyToServerRequest: async () => {
        calls.push("rpc");
      },
    } as never,
    sessionRepo: {
      getByDiscordThreadId: () =>
        createSessionRecord({
          discordThreadId: "discord-thread-1",
          ownerDiscordUserId: "owner-1",
        }),
    } as never,
    approvalRepo: {
      getByApprovalKey: () => ({
        approvalKey: "turn-1:item-1",
        requestId: "req-1",
        codexThreadId: "codex-thread-1",
        discordThreadId: "discord-thread-1",
        status: "pending",
        decisionCatalog: JSON.stringify([
          {
            key: "futureDecision",
            providerDecision: "futureDecision",
            label: "Let the future happen",
          },
        ]),
      }),
      insert: () => {
        calls.push("insert");
      },
    } as never,
  } as never);

  expect(handled).toBe(true);
  expect(calls).toEqual(["reply"]);
  expect(replies).toEqual([
    {
      allowedMentions: { parse: [] },
      content: "That approval no longer offers that decision.",
      ephemeral: true,
    },
  ]);
});

test("approval interaction replays structured command approval results from the persisted decision catalog", async () => {
  const rpcPayloads: Array<{ requestId: string | number; result: unknown }> = [];

  const handled = await handleApprovalInteraction({
    interaction: {
      customId: "approval|turn-1%3Aitem-1|ae",
      user: { id: "owner-1" },
      deferUpdate: async () => {},
      reply: async () => {},
    } as never,
    client: {
      replyToServerRequest: async (payload: { requestId: string | number; result: unknown }) => {
        rpcPayloads.push(payload);
      },
    } as never,
    sessionRepo: {
      getByDiscordThreadId: () =>
        createSessionRecord({
          discordThreadId: "discord-thread-1",
          ownerDiscordUserId: "owner-1",
        }),
    } as never,
    approvalRepo: {
      getByApprovalKey: () => ({
        approvalKey: "turn-1:item-1",
        requestId: "req-structured-command",
        codexThreadId: "codex-thread-1",
        discordThreadId: "discord-thread-1",
        status: "pending",
        decisionCatalog: JSON.stringify([
          {
            key: "acceptWithExecpolicyAmendment",
            providerDecision: "acceptWithExecpolicyAmendment",
            label: "Yes, proceed and save this decision for this command policy",
            replyPayload: {
              decision: {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: {
                    commandPattern: "^bun test$",
                    timeoutMs: 120000,
                  },
                },
              },
            },
          },
        ]),
      }),
      insert: () => {},
    } as never,
  } as never);

  expect(handled).toBe(true);
  expect(rpcPayloads).toEqual([
    {
      requestId: "req-structured-command",
      result: {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: {
              commandPattern: "^bun test$",
              timeoutMs: 120000,
            },
          },
        },
      },
    },
  ]);
});

test("approval interaction replies to permissions approvals with the stored structured grant payload", async () => {
  const rpcPayloads: Array<{ requestId: string | number; result: unknown }> = [];

  const handled = await handleApprovalInteraction({
    interaction: {
      customId: "approval|turn-1%3Aperm-1|acceptForSession",
      user: { id: "owner-1" },
      deferUpdate: async () => {},
      reply: async () => {},
    } as never,
    client: {
      replyToServerRequest: async (payload: { requestId: string | number; result: unknown }) => {
        rpcPayloads.push(payload);
      },
    } as never,
    sessionRepo: {
      getByDiscordThreadId: () =>
        createSessionRecord({
          discordThreadId: "discord-thread-1",
          ownerDiscordUserId: "owner-1",
        }),
    } as never,
    approvalRepo: {
      getByApprovalKey: () => ({
        approvalKey: "turn-1:perm-1",
        requestId: "req-permissions-1",
        codexThreadId: "codex-thread-1",
        discordThreadId: "discord-thread-1",
        status: "pending",
        decisionCatalog: JSON.stringify([
          {
            key: "acceptForSession",
            providerDecision: "acceptForSession",
            label: "Yes, and keep these permissions for this session",
            replyPayload: {
              permissions: {
                network: { enabled: true },
                fileSystem: {
                  read: ["/tmp/ws1"],
                  write: ["/tmp/ws1/app"],
                },
              },
              scope: "session",
            },
          },
        ]),
      }),
      insert: () => {},
    } as never,
  } as never);

  expect(handled).toBe(true);
  expect(rpcPayloads).toEqual([
    {
      requestId: "req-permissions-1",
      result: {
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/tmp/ws1"],
            write: ["/tmp/ws1/app"],
          },
        },
        scope: "session",
      },
    },
  ]);
});

test("approval interaction still resolves pending approvals for degraded sessions", async () => {
  const calls: string[] = [];
  const approvalKey = "turn-1:item-1";

  const handled = await handleApprovalInteraction({
    interaction: {
      customId: "approval|turn-1%3Aitem-1|accept",
      user: { id: "owner-1" },
      deferUpdate: async () => {
        calls.push("defer");
      },
      reply: async () => {
        calls.push("reply");
      },
    } as never,
    client: {
      replyToServerRequest: async () => {
        calls.push("rpc");
      },
    } as never,
    sessionRepo: {
      getByDiscordThreadId: () =>
        createSessionRecord({
          discordThreadId: "discord-thread-1",
          ownerDiscordUserId: "owner-1",
          state: "degraded",
        }),
    } as never,
    approvalRepo: {
      getByApprovalKey: () => ({
        approvalKey,
        requestId: "req-1",
        codexThreadId: "codex-thread-1",
        discordThreadId: "discord-thread-1",
        status: "pending",
        decisionCatalog: JSON.stringify([
          {
            key: "accept",
            providerDecision: "accept",
            label: "Yes, proceed",
          },
        ]),
      }),
      insert: () => {
        calls.push("insert");
      },
    } as never,
  });

  expect(handled).toBe(true);
  expect(calls).toEqual([
    "defer",
    "rpc",
    "insert",
  ]);
});

test("approval interaction does not persist a terminal local decision when the Codex reply fails", async () => {
  const calls: string[] = [];
  const failure = new Error("rpc failed");
  const approvalKey = "turn-1:item-1";

  await expect(
    handleApprovalInteraction({
      interaction: {
        customId: "approval|turn-1%3Aitem-1|accept",
        user: { id: "owner-1" },
        deferUpdate: async () => {
          calls.push("defer");
        },
        reply: async () => {
          calls.push("reply");
        },
      } as never,
      client: {
        replyToServerRequest: async () => {
          calls.push("rpc");
          throw failure;
        },
      } as never,
      sessionRepo: {
        getByDiscordThreadId: () =>
          createSessionRecord({
            discordThreadId: "discord-thread-1",
            ownerDiscordUserId: "owner-1",
          }),
      } as never,
      approvalRepo: {
        getByApprovalKey: () => ({
          approvalKey,
          requestId: "req-1",
          codexThreadId: "codex-thread-1",
          discordThreadId: "discord-thread-1",
          status: "pending",
          decisionCatalog: JSON.stringify([
            {
              key: "accept",
              providerDecision: "accept",
              label: "Yes, proceed",
            },
          ]),
        }),
        insert: () => {
          calls.push("insert");
        },
      } as never,
    }),
  ).rejects.toBe(failure);

  expect(calls).toEqual([
    "defer",
    "rpc",
  ]);
});

const expectStaleApprovalInteractionReply = async ({
  approval,
  expectedContent,
}: {
  approval: Partial<ApprovalRecord>;
  expectedContent: string;
}) => {
  const calls: string[] = [];
  const replies: Array<{
    content: string;
    ephemeral: boolean;
    allowedMentions?: { parse: string[] };
  }> = [];

  const handled = await handleApprovalInteraction({
    interaction: {
      customId: `approval|${encodeURIComponent(approval.approvalKey ?? "turn-1:item-1")}|accept`,
      user: { id: "owner-1" },
      deferUpdate: async () => {
        calls.push("defer");
      },
      reply: async (payload: {
        content: string;
        ephemeral: boolean;
        allowedMentions?: { parse: string[] };
      }) => {
        calls.push("reply");
        replies.push(payload);
      },
    } as never,
    client: {
      replyToServerRequest: async () => {
        calls.push("rpc");
      },
    } as never,
    sessionRepo: {
      getByDiscordThreadId: () =>
        createSessionRecord({
          discordThreadId: "discord-thread-1",
          ownerDiscordUserId: "owner-1",
        }),
    } as never,
    approvalRepo: {
      getByApprovalKey: () => createApprovalRecord(approval),
      insert: () => {
        calls.push("insert");
      },
    } as never,
  });

  expect(handled).toBe(true);
  expect(calls).toEqual(["reply"]);
  expect(replies).toEqual([
    {
      content: expectedContent,
      ephemeral: true,
      allowedMentions: { parse: [] },
    },
  ]);
};

test("approval interaction reports approved stale approvals with the saved command preview", async () => {
  await expectStaleApprovalInteractionReply({
    approval: {
      approvalKey: "turn-1:item-approved",
      status: "approved",
      commandPreview: "touch c.txt",
    },
    expectedContent: "This approval was already approved: touch c.txt",
  });
});

test("approval interaction reports approvals already handled in codex-remote", async () => {
  await expectStaleApprovalInteractionReply({
    approval: {
      approvalKey: "turn-1:item-approved-remote",
      status: "approved",
      commandPreview: "touch c.txt",
      resolvedElsewhere: true,
      resolvedBySurface: "codex_remote",
    },
    expectedContent: "This approval was already approved in codex-remote: touch c.txt",
  });
});

test("approval interaction reports declined stale approvals with the saved command preview", async () => {
  await expectStaleApprovalInteractionReply({
    approval: {
      approvalKey: "turn-1:item-declined",
      status: "declined",
      commandPreview: "touch c.txt",
    },
    expectedContent:
      "This approval was already declined and Codex continued without it: touch c.txt",
  });
});

test("approval interaction falls back softly when a canceled approval has no preview", async () => {
  await expectStaleApprovalInteractionReply({
    approval: {
      approvalKey: "turn-1:item-canceled",
      status: "canceled",
      commandPreview: null,
      displayTitle: null,
    },
    expectedContent:
      "This approval was already canceled. The turn was interrupted: That approval",
  });
});

test("approval interaction explains when an approval was already resolved elsewhere", async () => {
  await expectStaleApprovalInteractionReply({
    approval: {
      approvalKey: "turn-1:item-resolved",
      status: "resolved",
      commandPreview: "touch c.txt",
      resolvedElsewhere: true,
      resolvedBySurface: "codex_remote",
    },
    expectedContent: "This approval was already resolved in codex-remote: touch c.txt",
  });
});

test("approval interaction bounds stale replies to Discord-safe lengths", async () => {
  const replies: Array<{ content: string; ephemeral: boolean }> = [];
  const longCommandPreview = `bun run deploy ${"--flag ".repeat(400)}`.trim();

  const handled = await handleApprovalInteraction({
    interaction: {
      customId: "approval|turn-1%3Aitem-approved|accept",
      user: { id: "owner-1" },
      deferUpdate: async () => {
        throw new Error("stale approval should reply immediately");
      },
      reply: async (payload: { content: string; ephemeral: boolean }) => {
        replies.push(payload);
      },
    } as never,
    client: {
      replyToServerRequest: async () => {
        throw new Error("stale approval should not hit RPC");
      },
    } as never,
    sessionRepo: {
      getByDiscordThreadId: () =>
        createSessionRecord({
          discordThreadId: "discord-thread-1",
          ownerDiscordUserId: "owner-1",
        }),
    } as never,
    approvalRepo: {
      getByApprovalKey: () =>
        createApprovalRecord({
          approvalKey: "turn-1:item-approved",
          status: "approved",
          commandPreview: longCommandPreview,
        }),
    } as never,
  });

  expect(handled).toBe(true);
  expect(replies).toHaveLength(1);
  expect(replies[0]?.ephemeral).toBe(true);
  expect(replies[0]?.content.length).toBeLessThanOrEqual(2000);
  expect(replies[0]?.content).toStartWith(
    "This approval was already approved: bun run deploy",
  );
  expect(replies[0]?.content).toContain("…");
});

test("approval interaction rejects concurrent resolution attempts for the same request", async () => {
  const calls: string[] = [];
  let releaseRpc: (() => void) | undefined;
  const rpcGate = new Promise<void>((resolve) => {
    releaseRpc = resolve;
  });
  const inFlightApprovalKeys = new Set<string>();
  const approvalKey = "turn-1:item-1";

  const firstInteraction = {
    customId: "approval|turn-1%3Aitem-1|accept",
    user: { id: "owner-1" },
    deferUpdate: async () => {
      calls.push("defer:first");
    },
    reply: async () => {
      calls.push("reply:first");
    },
  } as never;
  const secondInteraction = {
    customId: "approval|turn-1%3Aitem-1|decline",
    user: { id: "owner-1" },
    deferUpdate: async () => {
      calls.push("defer:second");
    },
    reply: async () => {
      calls.push("reply:second");
    },
  } as never;

  const first = handleApprovalInteraction({
    interaction: firstInteraction,
    client: {
      replyToServerRequest: async () => {
        calls.push("rpc:first");
        await rpcGate;
      },
    } as never,
    sessionRepo: {
      getByDiscordThreadId: () =>
        createSessionRecord({
          discordThreadId: "discord-thread-1",
          ownerDiscordUserId: "owner-1",
        }),
    } as never,
    approvalRepo: {
      getByApprovalKey: () => ({
        approvalKey,
        requestId: "req-1",
        codexThreadId: "codex-thread-1",
        discordThreadId: "discord-thread-1",
        status: "pending",
        decisionCatalog: JSON.stringify([
          {
            key: "accept",
            providerDecision: "accept",
            label: "Yes, proceed",
          },
          {
            key: "decline",
            providerDecision: "decline",
            label: "No, continue without running it",
          },
        ]),
      }),
      insert: () => {
        calls.push("insert:first");
      },
    } as never,
    inFlightApprovalKeys,
  });

  await Promise.resolve();

  const second = await handleApprovalInteraction({
    interaction: secondInteraction,
    client: {
      replyToServerRequest: async () => {
        calls.push("rpc:second");
      },
    } as never,
    sessionRepo: {
      getByDiscordThreadId: () =>
        createSessionRecord({
          discordThreadId: "discord-thread-1",
          ownerDiscordUserId: "owner-1",
        }),
    } as never,
    approvalRepo: {
      getByApprovalKey: () => ({
        approvalKey,
        requestId: "req-1",
        codexThreadId: "codex-thread-1",
        discordThreadId: "discord-thread-1",
        status: "pending",
        decisionCatalog: JSON.stringify([
          {
            key: "accept",
            providerDecision: "accept",
            label: "Yes, proceed",
          },
          {
            key: "decline",
            providerDecision: "decline",
            label: "No, continue without running it",
          },
        ]),
      }),
      insert: () => {
        calls.push("insert:second");
      },
    } as never,
    inFlightApprovalKeys,
  });

  expect(second).toBe(true);
  expect(calls).toEqual([
    "defer:first",
    "rpc:first",
    "reply:second",
  ]);

  releaseRpc?.();
  await first;

  expect(calls).toEqual([
    "defer:first",
    "rpc:first",
    "reply:second",
    "insert:first",
  ]);
  expect(inFlightApprovalKeys.size).toBe(0);
});

test("live turn process rendering keeps commentary deduped and the footer on the last line", () => {
  const liveCommentaryPayload = renderLiveTurnProcessMessage({
    turnId: "turn-1",
    steps: ["reading SKILL.md"],
    liveCommentaryText: "running `bun test`",
    footer: "Waiting for approval",
  });

  expect(liveCommentaryPayload).toEqual({
    embeds: [
      {
        title: "Codex",
        description: "reading SKILL.md\nrunning `bun test`",
        color: 0x64748b,
        footer: {
          text: "Waiting for approval",
        },
      },
    ],
  });

  const dedupedPayload = renderLiveTurnProcessMessage({
    turnId: "turn-1",
    steps: ["reading SKILL.md"],
    liveCommentaryText: "reading SKILL.md",
    footer: "Waiting for approval",
  });

  expect(dedupedPayload).toEqual({
    embeds: [
      {
        title: "Codex",
        description: "reading SKILL.md",
        color: 0x64748b,
        footer: {
          text: "Waiting for approval",
        },
      },
    ],
  });
  expect(shouldRenderCommandExecutionStartMessage()).toBe(false);
});

test("in-flight transcript items are treated as already handled", () => {
  expect(
    hasHandledTranscriptItem({
      seenItemIds: new Set<string>(),
      finalizingItemIds: new Set<string>(["agent-1"]),
    }, "agent-1"),
  ).toBe(true);
  expect(
    hasHandledTranscriptItem({
      seenItemIds: new Set<string>(["agent-2"]),
      finalizingItemIds: new Set<string>(),
    }, "agent-2"),
  ).toBe(true);
  expect(
    hasHandledTranscriptItem({
      seenItemIds: new Set<string>(),
      finalizingItemIds: new Set<string>(),
    }, "agent-3"),
  ).toBe(false);
});

test("snapshot reconciliation only skips live-finalizing items without marking them seen", () => {
  expect(
    shouldSkipTranscriptSnapshotItem({
      seenItemIds: new Set<string>(),
      finalizingItemIds: new Set<string>(["agent-1"]),
    }, "agent-1"),
  ).toBe(true);
  expect(
    shouldSkipTranscriptSnapshotItem({
      seenItemIds: new Set<string>(["agent-2"]),
      finalizingItemIds: new Set<string>(),
    }, "agent-2"),
  ).toBe(true);
  expect(
    shouldSkipTranscriptSnapshotItem({
      seenItemIds: new Set<string>(),
      finalizingItemIds: new Set<string>(),
    }, "agent-3"),
  ).toBe(false);
});

test("snapshot bookkeeping does not mark skipped finalizing items as seen", () => {
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(["agent-1"]),
  };
  const turns: CodexTurn[] = [
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "agentMessage",
          id: "agent-1",
          text: "final reply",
          phase: "final",
        },
        {
          type: "commandExecution",
          id: "cmd-1",
          command: "bun test",
          exitCode: 1,
        },
      ],
    },
  ];

  markTranscriptItemsSeen({
    runtime,
    turns,
    source: "snapshot",
  });

  expect(runtime.seenItemIds.has("agent-1")).toBe(false);
  expect(runtime.seenItemIds.has("cmd-1")).toBe(true);
});

test("snapshot mismatch does not degrade when snapshot can consume a pending Discord input", () => {
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(),
    pendingLocalInputs: [{ kind: "start" as const, text: "reply exactly OK" }],
  };
  const turns: CodexTurn[] = [
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "user-1",
          content: [{ type: "text", text: "reply exactly OK" }],
        },
        {
          type: "agentMessage",
          id: "agent-1",
          text: "Checking instructions.",
          phase: "commentary",
        },
        {
          type: "agentMessage",
          id: "agent-2",
          text: "OK",
          phase: "final_answer",
        },
      ],
    },
  ];

  expect(
    shouldDegradeForSnapshotMismatch({
      runtime,
      turns,
    }),
  ).toBe(false);
});

test("snapshot mismatch still degrades when unseen items do not match pending Discord inputs", () => {
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(),
    pendingLocalInputs: [{ kind: "start" as const, text: "something else" }],
  };
  const turns: CodexTurn[] = [
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "user-1",
          content: [{ type: "text", text: "reply exactly OK" }],
        },
      ],
    },
  ];

  expect(
    shouldDegradeForSnapshotMismatch({
      runtime,
      turns,
    }),
  ).toBe(true);
});

test("snapshot mismatch does not degrade for a live-observed external turn", () => {
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(),
    pendingLocalInputs: [],
    trustedExternalTurnIds: new Set<string>(["turn-1"]),
  };
  const turns: CodexTurn[] = [
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "user-1",
          content: [{ type: "text", text: "replay only ok10" }],
        },
      ],
    },
  ];

  expect(
    shouldDegradeForSnapshotMismatch({
      runtime,
      turns,
    }),
  ).toBe(false);
});

test("live turn start trusts only external turns that did not originate from Discord", () => {
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(),
    pendingLocalInputs: [] as Array<{ kind: "start"; text: string }>,
    trustedExternalTurnIds: new Set<string>(),
  };

  noteTrustedLiveExternalTurnStart({
    runtime,
    turnId: "external-turn",
  });
  expect(runtime.trustedExternalTurnIds.has("external-turn")).toBe(true);

  runtime.pendingLocalInputs.push({
    kind: "start",
    text: "reply exactly OK",
  });
  noteTrustedLiveExternalTurnStart({
    runtime,
    turnId: "discord-turn",
  });
  expect(runtime.trustedExternalTurnIds.has("discord-turn")).toBe(false);
});

test("automatic snapshot mismatch holds transcript relay until manual sync", () => {
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(),
    pendingLocalInputs: [],
  };
  const turns: CodexTurn[] = [
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "user-1",
          content: [{ type: "text", text: "replay only ok9" }],
        },
      ],
    },
  ];

  expect(
    shouldHoldSnapshotTranscriptForManualSync({
      runtime,
      turns,
      degradeOnUnexpectedItems: true,
    }),
  ).toBe(true);
  expect(
    shouldHoldSnapshotTranscriptForManualSync({
      runtime,
      turns,
      degradeOnUnexpectedItems: false,
    }),
  ).toBe(false);
});

test("snapshot mismatch ignores live-vs-snapshot id remapping when the same turn was already observed live", () => {
  const runtime = {
    seenItemIds: new Set<string>([
      "live-user-id",
      "live-commentary-id",
      "live-final-id",
      getUserTranscriptEntryId("turn-1"),
      getProcessTranscriptEntryId("turn-1", 0),
      getAssistantTranscriptEntryId("turn-1"),
    ]),
    finalizingItemIds: new Set<string>(),
    pendingLocalInputs: [],
  };
  const turns: CodexTurn[] = [
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "item-1",
          content: [{ type: "text", text: "你现在在哪个目录" }],
        },
        {
          type: "agentMessage",
          id: "item-2",
          text: "我先确认当前工作目录。",
          phase: "commentary",
        },
        {
          type: "agentMessage",
          id: "item-3",
          text: "当前目录是 `/tmp/project`。",
          phase: "final_answer",
        },
      ],
    },
  ];

  expect(
    shouldDegradeForSnapshotMismatch({
      runtime,
      turns,
    }),
  ).toBe(false);
});

test("snapshot replay does not duplicate a resumed turn after live relay used a synthetic fallback id", () => {
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(),
    pendingLocalInputs: [] as Array<{ kind: "start"; text: string }>,
    activeTurnId: "turn-1",
  };
  const liveTurns: CodexTurn[] = [
    {
      id: "live",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "item-1",
          content: [{ type: "text", text: "where am I?" }],
        },
        {
          type: "agentMessage",
          id: "item-2",
          text: "You are in `/tmp/project`.",
          phase: "final_answer",
        },
      ],
    },
  ];
  const snapshotTurns: CodexTurn[] = [
    {
      id: "turn-1",
      status: "completed",
      items: liveTurns[0]?.items ?? [],
    },
  ];

  const relayEntryIds = ({
    turns,
    source,
  }: {
    turns: CodexTurn[];
    source: "live" | "snapshot";
  }) => {
    const entries = collectTranscriptEntries(turns, {
      source,
      pendingDiscordInputs: getPendingLocalInputTexts(runtime),
    }).filter((entry) =>
      !shouldSkipTranscriptRelayEntry({
        runtime,
        itemId: entry.itemId,
        source,
      })
    );

    const rendered = renderTranscriptMessages(entries).map((message) => message.entryItemId);

    for (const message of renderTranscriptMessages(entries)) {
      for (const itemId of message.itemIds) {
        runtime.seenItemIds.add(itemId);
      }
    }

    markTranscriptItemsSeen({
      runtime,
      turns,
      source,
    });

    return rendered;
  };

  expect(relayEntryIds({ turns: liveTurns, source: "live" })).toEqual([
    getUserTranscriptEntryId("live"),
    getAssistantTranscriptEntryId("live"),
  ]);
  expect(relayEntryIds({ turns: snapshotTurns, source: "snapshot" })).toEqual([]);
  expect(runtime.seenItemIds.has(getUserTranscriptEntryId("turn-1"))).toBe(true);
  expect(runtime.seenItemIds.has(getAssistantTranscriptEntryId("turn-1"))).toBe(true);
});

test("snapshot replay does not duplicate a resumed final assistant reply after live completion used the active turn fallback", async () => {
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(),
    itemTurnIds: new Map<string, string>(),
    activeTurnId: "turn-1",
    turnReplyMessageIds: new Map<string, string>(),
  };
  const sent: Array<{
    payload: { content?: string; embeds?: unknown[] };
    replyToMessageId?: string;
  }> = [];
  const snapshotTurns: CodexTurn[] = [
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "agentMessage",
          id: "item-2",
          text: "You are in `/tmp/project`.",
          phase: "final_answer",
        },
      ],
    },
  ];

  await finalizeCompletedAssistantTranscriptReply({
    runtime,
    item: {
      type: "agentMessage",
      id: "item-2",
      text: "You are in `/tmp/project`.",
      phase: "final_answer",
    },
    sendMessage: async (payload, options = {}) => {
      sent.push({
        payload,
        replyToMessageId: options.replyToMessageId,
      });
    },
  });

  expect(sent).toHaveLength(1);
  expect(runtime.seenItemIds.has(getAssistantTranscriptEntryId("turn-1"))).toBe(true);

  const snapshotEntries = collectTranscriptEntries(snapshotTurns, {
    source: "snapshot",
  }).filter((entry) =>
    !shouldSkipTranscriptRelayEntry({
      runtime,
      itemId: entry.itemId,
      source: "snapshot",
    })
  );

  expect(renderTranscriptMessages(snapshotEntries).map((message) => message.entryItemId)).toEqual([]);
});

test("completed assistant live replies split long final answers across multiple sends", async () => {
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(),
    itemTurnIds: new Map<string, string>(),
    activeTurnId: "turn-1",
    turnReplyMessageIds: new Map<string, string>([["turn-1", "discord-msg-1"]]),
  };
  const longReply = `${"a".repeat(1_895)}不过我还看到一个更长的尾巴`;
  const sent: Array<{
    payload: { content?: string; embeds?: unknown[] };
    replyToMessageId?: string;
  }> = [];

  await finalizeCompletedAssistantTranscriptReply({
    runtime,
    item: {
      type: "agentMessage",
      id: "item-2",
      text: longReply,
      phase: "final_answer",
    },
    sendMessage: async (payload, options = {}) => {
      sent.push({
        payload,
        replyToMessageId: options.replyToMessageId,
      });
    },
  });

  expect(sent).toEqual([
    {
      payload: {
        content: longReply.slice(0, 1_900),
      },
      replyToMessageId: "discord-msg-1",
    },
    {
      payload: {
        content: longReply.slice(1_900),
      },
      replyToMessageId: undefined,
    },
  ]);
  expect(runtime.seenItemIds.has(getAssistantTranscriptEntryId("turn-1"))).toBe(true);
});

test("completed turn remaps synthetic live transcript ids so snapshot replay stays deduped", async () => {
  const userItem = {
    type: "userMessage" as const,
    id: "user-1",
    content: [{ type: "text" as const, text: "hi" }],
  };
  const assistantItem = {
    type: "agentMessage" as const,
    id: "agent-1",
    text: "Hi! What would you like to work on in this repo?",
    phase: "final_answer" as const,
  };
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(),
    pendingLocalInputs: [{ kind: "start" as const, text: "hi" }],
    itemTurnIds: new Map<string, string>(),
    activeTurnId: undefined as string | undefined,
    turnReplyMessageIds: new Map<string, string>(),
  };

  const liveUserEntries = collectTranscriptEntries([{
    id: "live",
    status: "completed",
    items: [userItem],
  }], {
    source: "live",
    pendingDiscordInputs: getPendingLocalInputTexts(runtime),
  }).filter((entry) =>
    !shouldSkipTranscriptRelayEntry({
      runtime,
      itemId: entry.itemId,
      source: "live",
    })
  );

  expect(liveUserEntries).toEqual([]);

  markTranscriptItemsSeen({
    runtime,
    turns: [{
      id: "live",
      status: "completed",
      items: [userItem],
    }],
    source: "live",
  });

  await finalizeCompletedAssistantTranscriptReply({
    runtime,
    item: assistantItem,
    sendMessage: async () => undefined,
  });

  remapSeenTranscriptEntriesToCompletedTurn({
    runtime,
    turn: {
      id: "turn-1",
      status: "completed",
      items: [userItem, assistantItem],
    },
  });

  const snapshotEntries = collectTranscriptEntries([{
    id: "turn-1",
    status: "completed",
    items: [userItem, assistantItem],
  }], {
    source: "snapshot",
    pendingDiscordInputs: getPendingLocalInputTexts(runtime),
  }).filter((entry) =>
    !shouldSkipTranscriptRelayEntry({
      runtime,
      itemId: entry.itemId,
      source: "snapshot",
    })
  );

  expect(renderTranscriptMessages(snapshotEntries).map((message) => message.entryItemId)).toEqual([]);
});

test("runtime seeded from snapshot after restart does not re-degrade the same completed Discord turn", () => {
  const turns: CodexTurn[] = [
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "item-1",
          content: [{ type: "text", text: "你现在在哪个目录" }],
        },
        {
          type: "agentMessage",
          id: "item-2",
          text: "我先直接确认当前工作目录，避免依赖上下文假设。",
          phase: "commentary",
        },
        {
          type: "agentMessage",
          id: "item-3",
          text: "当前目录是 `/Users/koltenluca/code-github/code-agent-helm-example`。",
          phase: "final_answer",
        },
      ],
    },
  ];
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(),
    pendingLocalInputs: [],
  };

  seedTranscriptRuntimeSeenItemsFromSnapshot({
    runtime,
    turns,
  });

  expect(
    shouldDegradeForSnapshotMismatch({
      runtime,
      turns,
    }),
  ).toBe(false);
});

test("live relay does not skip a finalizing failed command, but snapshot relay does", () => {
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(["cmd-1"]),
  };

  expect(
    shouldSkipTranscriptRelayEntry({
      runtime,
      itemId: "cmd-1",
      source: "live",
    }),
  ).toBe(false);
  expect(
    shouldSkipTranscriptRelayEntry({
      runtime,
      itemId: "cmd-1",
      source: "snapshot",
    }),
  ).toBe(true);
});

test("after live relay marks a failed command seen, snapshot relay also skips it", () => {
  const runtime = {
    seenItemIds: new Set<string>(),
    finalizingItemIds: new Set<string>(["cmd-1"]),
  };
  const turns: CodexTurn[] = [
    {
      id: "turn-1",
      items: [
        {
          type: "commandExecution",
          id: "cmd-1",
          command: "bun test",
          exitCode: 1,
        },
      ],
    },
  ];

  markTranscriptItemsSeen({
    runtime,
    turns,
    source: "live",
  });

  expect(runtime.seenItemIds.has("cmd-1")).toBe(true);
  expect(
    shouldSkipTranscriptRelayEntry({
      runtime,
      itemId: "cmd-1",
      source: "snapshot",
    }),
  ).toBe(true);
});

test("approval interactions only accept still-pending approvals", () => {
  expect(shouldAcceptApprovalInteraction("pending")).toBe(true);
  expect(shouldAcceptApprovalInteraction("resolved")).toBe(false);
  expect(shouldAcceptApprovalInteraction("approved")).toBe(false);
  expect(shouldAcceptApprovalInteraction("declined")).toBe(false);
  expect(shouldAcceptApprovalInteraction("canceled")).toBe(false);
});

test("footer-only live process messages are deleted on completion", async () => {
  let deleted = 0;
  let edited = 0;
  let sent = 0;

  await finalizeLiveTurnProcessMessage({
    currentMessage: {
      async delete() {
        deleted += 1;
      },
      async edit() {
        edited += 1;
      },
    },
    rendered: undefined,
    sendRendered: async () => {
      sent += 1;
    },
  });

  expect(deleted).toBe(1);
  expect(edited).toBe(0);
  expect(sent).toBe(0);
});

test("completed live turn process waits for the in-flight message before editing", async () => {
  let sent = 0;
  let edited = 0;
  let resolveMessage: ((value: {
    delete(): Promise<void>;
    edit(payload: { content?: string; embeds?: unknown[] }): Promise<void>;
  }) => void) | undefined;

  const currentMessagePromise = new Promise<{
    delete(): Promise<void>;
    edit(payload: { content?: string; embeds?: unknown[] }): Promise<void>;
  }>((resolve) => {
    resolveMessage = resolve;
  });

  const finalizePromise = finalizeLiveTurnProcessMessage({
    currentMessage: undefined,
    currentMessagePromise,
    rendered: {
      embeds: [
        {
          title: "Codex",
          description: "reading README.md",
        },
      ],
    },
    sendRendered: async () => {
      sent += 1;
    },
  });

  resolveMessage?.({
    async delete() {},
    async edit() {
      edited += 1;
    },
  });

  await finalizePromise;

  expect(sent).toBe(0);
  expect(edited).toBe(1);
});

test("completed live turn process edits the existing message in place", async () => {
  let deleted = 0;
  let edited = 0;
  let sent = 0;

  await finalizeLiveTurnProcessMessage({
    currentMessage: {
      async delete() {
        deleted += 1;
      },
      async edit() {
        edited += 1;
      },
    },
    rendered: {
      embeds: [
        {
          title: "Codex",
          description: "reading README.md",
        },
      ],
    },
    sendRendered: async () => {
      sent += 1;
    },
  });

  expect(deleted).toBe(0);
  expect(edited).toBe(1);
  expect(sent).toBe(0);
});

test("streaming transcript message creation is serialized per item", async () => {
  let sends = 0;
  let edits = 0;
  let resolveMessage: ((value: {
    edit(payload: { content?: string; embeds?: unknown[] }): Promise<void>;
  }) => void) | undefined;

  const state: {
    message?: {
      edit(payload: { content?: string; embeds?: unknown[] }): Promise<void>;
    };
    pendingCreate?: Promise<{
      edit(payload: { content?: string; embeds?: unknown[] }): Promise<void>;
    } | undefined>;
  } = {};

  const sendMessage = (_payload: { content?: string; embeds?: unknown[] }) => {
    sends += 1;
    return new Promise<{
      edit(payload: { content?: string; embeds?: unknown[] }): Promise<void>;
    }>((resolve) => {
      resolveMessage = resolve;
    });
  };

  const first = upsertStreamingTranscriptMessage({
    state,
    payload: {
      embeds: [
        {
          title: "Codex",
          description: "first",
        },
      ],
    },
    sendMessage,
  });
  const second = upsertStreamingTranscriptMessage({
    state,
    payload: {
      embeds: [
        {
          title: "Codex",
          description: "second",
        },
      ],
    },
    sendMessage,
  });

  resolveMessage?.({
    async edit() {
      edits += 1;
    },
  });

  await Promise.all([first, second]);

  expect(sends).toBe(1);
  expect(edits).toBe(1);
});

test("streaming transcript message edits coalesce to the latest payload", async () => {
  let resolveFirstEdit: (() => void) | undefined;
  const editDescriptions: string[] = [];
  let editCalls = 0;

  const state: {
    message?: {
      edit(payload: { content?: string; embeds?: Array<{ description?: string }> }): Promise<void>;
    };
    pendingCreate?: Promise<{
      edit(payload: { content?: string; embeds?: Array<{ description?: string }> }): Promise<void>;
    } | undefined>;
  } = {
    message: {
      edit(payload) {
        editDescriptions.push(payload.embeds?.[0]?.description ?? "");
        editCalls += 1;

        if (editCalls === 1) {
          return new Promise<void>((resolve) => {
            resolveFirstEdit = resolve;
          });
        }

        return Promise.resolve();
      },
    },
  };

  const first = upsertStreamingTranscriptMessage({
    state,
    payload: {
      embeds: [{ title: "Codex", description: "first" }],
    },
    sendMessage: async () => {
      throw new Error("sendMessage should not be called");
    },
  });
  const second = upsertStreamingTranscriptMessage({
    state,
    payload: {
      embeds: [{ title: "Codex", description: "second" }],
    },
    sendMessage: async () => {
      throw new Error("sendMessage should not be called");
    },
  });
  const third = upsertStreamingTranscriptMessage({
    state,
    payload: {
      embeds: [{ title: "Codex", description: "third" }],
    },
    sendMessage: async () => {
      throw new Error("sendMessage should not be called");
    },
  });

  expect(editDescriptions).toEqual(["first"]);

  resolveFirstEdit?.();
  await Promise.all([first, second, third]);

  expect(editDescriptions).toEqual(["first", "third"]);
});

test("live command approvals persist snapshot data before lifecycle rendering", () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/ws1/app",
    state: "waiting-approval",
  });

  const approval = persistApprovalRequestSnapshot({
    approvalRepo,
    session: createSessionRecord({
      codexThreadId: "codex-1",
      discordThreadId: "discord-thread-1",
    }),
    method: "item/commandExecution/requestApproval",
    event: {
      requestId: "req-7",
      threadId: "codex-1",
      turnId: "turn-1",
      itemId: "call-1",
      cmd: "touch c.txt",
      justification: "要允许我在项目根目录创建 c.txt 吗？",
      cwd: "/tmp/ws1/app",
      availableDecisions: ["accept", "acceptForSession", "cancel"],
    },
  });

  expect(approvalRepo.getByApprovalKey("turn-1:call-1")).toMatchObject({
    approvalKey: "turn-1:call-1",
    requestId: "req-7",
    status: "pending",
    displayTitle: "Command approval",
    commandPreview: "touch c.txt",
    justification: "要允许我在项目根目录创建 c.txt 吗？",
    cwd: "/tmp/ws1/app",
    requestKind: "command_execution",
    decisionCatalog: expect.stringContaining("\"acceptForSession\""),
  });
  expect(renderApprovalLifecycleMessage({
    approval,
  })).toBe(
    "**Would you like to run the following command?**\n"
      + "```sh\n"
      + "touch c.txt\n"
      + "```\n"
      + "要允许我在项目根目录创建 c.txt 吗？\n"
      + "CWD: `/tmp/ws1/app`",
  );

  db.close();
});

test("live command approvals strip common shell wrappers from the displayed command preview", () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/ws1/app",
    state: "waiting-approval",
  });

  const approval = persistApprovalRequestSnapshot({
    approvalRepo,
    session: createSessionRecord({
      codexThreadId: "codex-1",
      discordThreadId: "discord-thread-1",
    }),
    method: "item/commandExecution/requestApproval",
    event: {
      requestId: "req-7a",
      threadId: "codex-1",
      turnId: "turn-1",
      itemId: "call-1",
      cmd: "/bin/zsh -lc 'touch c.txt'",
      justification: "要允许我在项目根目录创建 c.txt 吗？",
      cwd: "/tmp/ws1/app",
      availableDecisions: ["accept", "cancel"],
    },
  });

  expect(approvalRepo.getByApprovalKey("turn-1:call-1")).toMatchObject({
    approvalKey: "turn-1:call-1",
    requestId: "req-7a",
    status: "pending",
    commandPreview: "touch c.txt",
  });
  expect(renderApprovalLifecycleMessage({
    approval,
  })).toContain("touch c.txt");
  expect(renderApprovalLifecycleMessage({
    approval,
  })).not.toContain("/bin/zsh -lc");

  db.close();
});

test("live file-change approvals synthesize real decisions and grant-root copy from protocol-shaped events", () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/ws1/app",
    state: "waiting-approval",
  });

  const approval = persistApprovalRequestSnapshot({
    approvalRepo,
    session: createSessionRecord({
      codexThreadId: "codex-1",
      discordThreadId: "discord-thread-1",
    }),
    method: "item/fileChange/requestApproval",
    event: {
      requestId: "req-8",
      threadId: "codex-1",
      turnId: "turn-1",
      itemId: "call-2",
      reason: "Allow updating tracked files?",
      grantRoot: "/tmp/ws1/app",
    },
  });

  expect(approvalRepo.getByApprovalKey("turn-1:call-2")).toMatchObject({
    approvalKey: "turn-1:call-2",
    requestId: "req-8",
    status: "pending",
    displayTitle: "File change approval",
    commandPreview: null,
    justification: expect.stringContaining("Allow updating tracked files?"),
    requestKind: "file_change",
  });
  expect(approvalRepo.getByApprovalKey("turn-1:call-2")?.decisionCatalog).toEqual(
    expect.stringContaining("\"acceptForSession\""),
  );
  expect(renderApprovalLifecycleMessage({
    approval,
  })).toBe(
    "**Would you like to apply these file changes?**\n"
      + "Allow updating tracked files?\n"
      + "Session write scope: `/tmp/ws1/app`",
  );

  db.close();
});

test("live file-change approvals synthesize protocol-backed decision buttons when the provider omits them", () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/ws1/app",
    state: "waiting-approval",
  });

  const approval = persistApprovalRequestSnapshot({
    approvalRepo,
    session: createSessionRecord({
      codexThreadId: "codex-1",
      discordThreadId: "discord-thread-1",
    }),
    method: "item/fileChange/requestApproval",
    event: {
      requestId: "req-8b",
      threadId: "codex-1",
      turnId: "turn-1",
      itemId: "call-2b",
      reason: "command failed; retry without sandbox?",
      grantRoot: "/tmp/ws1/app",
      cwd: "/tmp/ws1/app",
    },
  });

  expect(approvalRepo.getByApprovalKey("turn-1:call-2b")).toMatchObject({
    approvalKey: "turn-1:call-2b",
    requestId: "req-8b",
    status: "pending",
    justification: expect.stringContaining("command failed; retry without sandbox?"),
    cwd: "/tmp/ws1/app",
    requestKind: "file_change",
    decisionCatalog: expect.stringContaining("\"acceptForSession\""),
  });
  const payload = renderApprovalLifecyclePayload({
    approvalKey: approval.approvalKey,
    approval,
  });
  const labels = (payload.components ?? []).flatMap((row) =>
    row.components.map((component) =>
      (component as { data?: { label?: string } }).data?.label ?? ""
    ),
  );

  expect(labels).toEqual([
    "Yes, proceed",
    "Yes, allow this path for the rest of the session",
    "No, continue without applying these changes",
    "No, and tell Codex what to do differently",
  ]);

  db.close();
});

test("live file-change approvals still offer a session-scope decision when grantRoot is missing", () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/ws1/app",
    state: "waiting-approval",
  });

  const approval = persistApprovalRequestSnapshot({
    approvalRepo,
    session: createSessionRecord({
      codexThreadId: "codex-1",
      discordThreadId: "discord-thread-1",
    }),
    method: "item/fileChange/requestApproval",
    event: {
      requestId: "req-8c",
      threadId: "codex-1",
      turnId: "turn-1",
      itemId: "call-2c",
      reason: "command failed; retry without sandbox?",
    },
  });

  expect(approvalRepo.getByApprovalKey("turn-1:call-2c")).toMatchObject({
    approvalKey: "turn-1:call-2c",
    requestId: "req-8c",
    status: "pending",
    justification: "command failed; retry without sandbox?",
    cwd: null,
    requestKind: "file_change",
    decisionCatalog: expect.stringContaining("\"acceptForSession\""),
  });
  const payload = renderApprovalLifecyclePayload({
    approvalKey: approval.approvalKey,
    approval,
  });
  const labels = (payload.components ?? []).flatMap((row) =>
    row.components.map((component) =>
      (component as { data?: { label?: string } }).data?.label ?? ""
    ),
  );

  expect(labels).toEqual([
    "Yes, proceed",
    "Yes, allow file changes for the rest of the session",
    "No, continue without applying these changes",
    "No, and tell Codex what to do differently",
  ]);

  db.close();
});

test("live permissions approvals synthesize structured grant decisions from protocol-shaped events", () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/ws1/app",
    state: "waiting-approval",
  });

  const approval = persistApprovalRequestSnapshot({
    approvalRepo,
    session: createSessionRecord({
      codexThreadId: "codex-1",
      discordThreadId: "discord-thread-1",
    }),
    method: "item/permissions/requestApproval",
    event: {
      requestId: "req-9",
      threadId: "codex-1",
      turnId: "turn-1",
      itemId: "call-3",
      reason: "Allow elevated permissions for this step?",
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/tmp/ws1"],
          write: ["/tmp/ws1/app"],
        },
      },
    },
  });

  expect(approvalRepo.getByApprovalKey("turn-1:call-3")).toMatchObject({
    approvalKey: "turn-1:call-3",
    requestId: "req-9",
    status: "pending",
    displayTitle: "Permissions approval",
    commandPreview: null,
    justification: expect.stringContaining("Allow elevated permissions for this step?"),
    requestKind: "permissions",
    decisionCatalog: expect.stringContaining("\"acceptForSession\""),
  });
  expect(renderApprovalLifecycleMessage({
    approval,
  })).toContain("**Would you like to grant these permissions?**");
  expect(renderApprovalLifecycleMessage({
    approval,
  })).toContain("Allow elevated permissions for this step?");
  expect(renderApprovalLifecycleMessage({
    approval,
  })).toContain("Network access");
  expect(renderApprovalLifecycleMessage({
    approval,
  })).toContain("Read: `/tmp/ws1`");
  expect(renderApprovalLifecycleMessage({
    approval,
  })).toContain("Write: `/tmp/ws1/app`");

  db.close();
});

test("resolved events without threadId fail safe when duplicate live approvals share a request id", () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);
  const runtimeApprovalKeysByRequestId = new Map<string, Set<string>>();

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/ws1/app",
    state: "waiting-approval",
  });
  sessionRepo.insert({
    discordThreadId: "discord-thread-2",
    codexThreadId: "codex-2",
    ownerDiscordUserId: "owner-2",
    cwd: "/tmp/ws2/app",
    state: "waiting-approval",
  });

  const firstApproval = persistApprovalRequestSnapshot({
    approvalRepo,
    session: createSessionRecord({
      codexThreadId: "codex-1",
      discordThreadId: "discord-thread-1",
    }),
    method: "item/commandExecution/requestApproval",
    event: {
      requestId: "req-dup",
      threadId: "codex-1",
      turnId: "turn-1",
      itemId: "call-1",
      cmd: "touch first.txt",
      justification: "Allow the first command?",
      cwd: "/tmp/ws1/app",
    },
  });
  const secondApproval = persistApprovalRequestSnapshot({
    approvalRepo,
    session: createSessionRecord({
      codexThreadId: "codex-2",
      discordThreadId: "discord-thread-2",
    }),
    method: "item/commandExecution/requestApproval",
    event: {
      requestId: "req-dup",
      threadId: "codex-2",
      turnId: "turn-2",
      itemId: "call-1",
      cmd: "touch second.txt",
      justification: "Allow the second command?",
      cwd: "/tmp/ws2/app",
    },
  });

  rememberRuntimeApprovalRequest(runtimeApprovalKeysByRequestId, firstApproval);
  rememberRuntimeApprovalRequest(runtimeApprovalKeysByRequestId, secondApproval);

  expect(
    resolveStoredApprovalForResolvedEvent({
      approvalRepo,
      runtimeApprovalKeysByRequestId,
      event: {
        requestId: "req-dup",
      },
    }),
  ).toBeNull();
  expect(approvalRepo.getByApprovalKey(firstApproval.approvalKey)?.status).toBe("pending");
  expect(approvalRepo.getByApprovalKey(secondApproval.approvalKey)?.status).toBe("pending");

  db.close();
});

test("resolved events without threadId fall back to the unique persisted request when runtime associations are empty", () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/ws1/app",
    state: "waiting-approval",
  });

  const approval = persistApprovalRequestSnapshot({
    approvalRepo,
    session: createSessionRecord({
      codexThreadId: "codex-1",
      discordThreadId: "discord-thread-1",
    }),
    method: "item/commandExecution/requestApproval",
    event: {
      requestId: "req-unique",
      threadId: "codex-1",
      turnId: "turn-1",
      itemId: "call-1",
      cmd: "touch unique.txt",
      justification: "Allow the unique command?",
      cwd: "/tmp/ws1/app",
    },
  });

  expect(
    resolveStoredApprovalForResolvedEvent({
      approvalRepo,
      runtimeApprovalKeysByRequestId: new Map(),
      event: {
        requestId: "req-unique",
      },
    }),
  ).toMatchObject({
    approvalKey: approval.approvalKey,
    requestId: approval.requestId,
    status: "pending",
  });

  db.close();
});

test("stale replayed pending approvals do not reopen runtime handling after resolution", () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);
  const runtimeApprovalKeysByRequestId = new Map<string, Set<string>>();

  sessionRepo.insert({
    discordThreadId: "discord-thread-1",
    codexThreadId: "codex-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/ws1/app",
    state: "waiting-approval",
  });

  persistApprovalRequestSnapshot({
    approvalRepo,
    session: createSessionRecord({
      codexThreadId: "codex-1",
      discordThreadId: "discord-thread-1",
    }),
    method: "item/commandExecution/requestApproval",
    event: {
      requestId: "req-stale",
      threadId: "codex-1",
      turnId: "turn-1",
      itemId: "call-1",
      cmd: "touch stale.txt",
      justification: "Allow the stale command?",
      cwd: "/tmp/ws1/app",
    },
  });

  approvalRepo.insert({
    approvalKey: "turn-1:call-1",
    requestId: "req-stale",
    codexThreadId: "codex-1",
    discordThreadId: "discord-thread-1",
    status: "resolved",
  });

  const replayedApproval = persistApprovalRequestSnapshot({
    approvalRepo,
    session: createSessionRecord({
      codexThreadId: "codex-1",
      discordThreadId: "discord-thread-1",
    }),
    method: "item/commandExecution/requestApproval",
    event: {
      requestId: "req-stale",
      threadId: "codex-1",
      turnId: "turn-1",
      itemId: "call-1",
      cmd: "touch stale.txt",
      justification: "Allow the stale command?",
      cwd: "/tmp/ws1/app",
    },
  });

  const shouldHandleReplay = shouldHandlePersistedApprovalRequestAtRuntime(
    replayedApproval,
  );

  if (shouldHandleReplay) {
    rememberRuntimeApprovalRequest(runtimeApprovalKeysByRequestId, replayedApproval);
  }

  expect(replayedApproval.status).toBe("resolved");
  expect(shouldHandleReplay).toBe(false);
  expect(runtimeApprovalKeysByRequestId.size).toBe(0);

  db.close();
});

test("approval lifecycle payload renders provider-driven thread components safely", () => {
  const longLabel = `Allow this very carefully named approval path ${"x".repeat(80)}`;
  const approval = createApprovalRecord({
    decisionCatalog: JSON.stringify([
      {
        key: "accept",
        providerDecision: "accept",
        label: "Yes, proceed",
      },
      {
        key: "cancel",
        providerDecision: "cancel",
        label: "No, and tell Codex what to do differently",
      },
      {
        key: "acceptForSession",
        providerDecision: "acceptForSession",
        label: longLabel,
      },
      {
        key: "decline",
        providerDecision: "decline",
        label: "No, continue without running it",
      },
      {
        key: "acceptWithExecpolicyAmendment",
        providerDecision: "acceptWithExecpolicyAmendment",
        label: "Yes, and save this matching command rule",
      },
      {
        key: "applyNetworkPolicyAmendment",
        providerDecision: "applyNetworkPolicyAmendment",
        label: "Yes, and allow this host in the future",
      },
    ]),
  });
  const threadPayload = renderApprovalLifecyclePayload({
    approvalKey: approval.approvalKey,
    approval,
  });
  const rows = threadPayload.components ?? [];
  const embeds = threadPayload.embeds ?? [];
  const components = rows.flatMap((row) => row.components);
  const labels = components.map((component) =>
    (component as { data?: { label?: string } }).data?.label ?? "",
  );
  const customIds = components.map((component) =>
    (component as { data?: { custom_id?: string } }).data?.custom_id,
  );

  expect(threadPayload.allowedMentions).toEqual({ parse: [] });
  expect(threadPayload.content).toBeUndefined();
  expect(embeds).toHaveLength(1);
  expect(embeds[0]?.title).toBeUndefined();
  expect(rows).toHaveLength(2);
  expect(rows[0]?.components).toHaveLength(5);
  expect(rows[1]?.components).toHaveLength(1);
  expect(labels).toEqual([
    "Yes, proceed",
    "No, and tell Codex what to do differently",
    `${longLabel.slice(0, 79)}…`,
    "No, continue without running it",
    "Yes, and save this matching command rule",
    "Yes, and allow this host in the future",
  ]);
  expect(customIds).toEqual([
    "approval|turn-1%3Acall-1|a",
    "approval|turn-1%3Acall-1|c",
    "approval|turn-1%3Acall-1|as",
    "approval|turn-1%3Acall-1|d",
    "approval|turn-1%3Acall-1|ae",
    "approval|turn-1%3Acall-1|an",
  ]);
});

test("approval lifecycle payload keeps the stored approval body and only drops controls after resolution", () => {
  const pendingApproval = createApprovalRecord();
  const pending = renderApprovalLifecyclePayload({
    approvalKey: pendingApproval.approvalKey,
    approval: pendingApproval,
  });
  const approved = renderApprovalLifecyclePayload({
    approvalKey: pendingApproval.approvalKey,
    approval: createApprovalRecord({
      status: "approved",
    }),
  });

  expect(pending.content).toBeUndefined();
  expect(pending.embeds?.[0]?.description).toBe(
    renderApprovalLifecycleMessage({
      approval: pendingApproval,
    }),
  );
  expect((pending.components ?? []).length).toBe(1);
  expect(approved.content).toBeUndefined();
  expect(approved.embeds?.[0]?.description?.startsWith("Approved: touch c.txt")).toBe(
    true,
  );
  expect(approved.components).toEqual([]);
});

test("approval delivery failure text follows the thread language", () => {
  expect(
    detectThreadLanguageFromTexts([
      "请先看一下日志",
      "好的，我继续查。",
    ]),
  ).toBe("zh");
  expect(
    detectThreadLanguageFromTexts([
      "Please inspect the latest logs.",
    ]),
  ).toBe("en");

  expect(renderApprovalDeliveryFailureText("zh")).toBe(
    "审批卡片发送失败，当前操作仍在等待审批。",
  );
  expect(renderApprovalDeliveryFailureText("en")).toBe(
    "Approval card delivery failed. The action is still waiting for approval.",
  );
});

test("approval lifecycle updates edit the same Discord message instead of sending a new one", async () => {
  let sent = 0;
  let edited = 0;

  const existingMessage = {
    content: "Approval `req-7`: pending.",
    async edit(payload: { content?: string; components?: unknown[] }) {
      edited += 1;
      existingMessage.content = payload.content ?? existingMessage.content;
      return existingMessage;
    },
  };

  const result = await upsertApprovalLifecycleMessage({
    currentMessage: existingMessage,
    recoverMessage: async () => undefined,
    payload: {
      content: "Approval `req-7`: approved.",
      components: [],
    },
    sendMessage: async () => {
      sent += 1;
      throw new Error("should not send a second approval message");
    },
  });

  expect(result).toBeDefined();
  expect(result?.content).toBe("Approval `req-7`: approved.");
  expect(edited).toBe(1);
  expect(sent).toBe(0);
});

test("approval lifecycle waits for the in-flight pending send before resolving", async () => {
  let sent = 0;
  let edited = 0;
  type ApprovalLifecycleTestMessage = {
    content: string;
    edit(payload: {
      content?: string;
      components?: unknown[];
    }): Promise<ApprovalLifecycleTestMessage>;
  };
  let resolveMessage: ((value: ApprovalLifecycleTestMessage) => void) | undefined;

  const currentMessagePromise = new Promise<ApprovalLifecycleTestMessage>((resolve) => {
    resolveMessage = resolve;
  });

  const upsertPromise = upsertApprovalLifecycleMessage({
    currentMessage: undefined,
    currentMessagePromise,
    recoverMessage: async () => undefined,
    payload: {
      content: "Approval `req-7`: approved.",
      components: [],
    },
    sendMessage: async () => {
      sent += 1;
      return undefined;
    },
  });

  const pendingMessage: ApprovalLifecycleTestMessage = {
    content: "Approval `req-7`: pending.",
    async edit(payload: {
      content?: string;
      components?: unknown[];
    }) {
      edited += 1;
      pendingMessage.content = payload.content ?? pendingMessage.content;
      return pendingMessage;
    },
  };

  resolveMessage?.(pendingMessage);

  const result = await upsertPromise;

  expect(result?.content).toBe("Approval `req-7`: approved.");
  expect(edited).toBe(1);
  expect(sent).toBe(0);
});

test("approval lifecycle state clears pending promise after rejection", async () => {
  type ApprovalLifecycleTestMessage = {
    content: string;
    edit(payload: {
      content?: string;
      components?: unknown[];
    }): Promise<ApprovalLifecycleTestMessage>;
  };
  const state: {
    pendingMessage?: Promise<ApprovalLifecycleTestMessage | undefined>;
    message?: ApprovalLifecycleTestMessage;
  } = {};
  const failure = new Error("send failed");

  await expect(
    finalizeApprovalLifecycleMessageState({
      state,
      operation: Promise.reject(failure),
    }),
  ).rejects.toThrow("send failed");

  expect(state.pendingMessage).toBeUndefined();
  expect(state.message).toBeUndefined();
});

test("approval lifecycle recovery prefers the approval-key-scoped thread message", async () => {
  const recovered = await recoverApprovalLifecycleMessageFromHistory({
    approvalKey: "turn-1:item-2",
    requestId: "req-7",
    botUserId: "bot-1",
    fetchPage: async () => [
      {
        id: "m1",
        content: "Approval `req-7`: pending.",
        editable: true,
        author: { bot: true, id: "bot-1" },
        components: [
          {
            components: [
              { customId: "approval|turn-1%3Aitem-1|accept" },
            ],
          },
        ],
      },
      {
        id: "m2",
        content: "Approval `req-7`: pending.",
        editable: true,
        author: { bot: true, id: "bot-1" },
        components: [
          {
            components: [
              { customId: "approval|turn-1%3Aitem-2|accept" },
            ],
          },
        ],
      },
    ],
  });

  expect(recovered?.id).toBe("m2");
});

test("current embed-only resolved approvals do not rely on visible request ids for history recovery", async () => {
  const requestId = `req-${"1234567890".repeat(12)}`;
  const lifecycle = renderApprovalLifecyclePayload({
    approval: createApprovalRecord({
      requestId,
      status: "resolved",
    }),
  });

  const recovered = await recoverApprovalLifecycleMessageFromHistory({
    requestId,
    botUserId: "bot-1",
    fetchPage: async () => [
      {
        id: "m1",
        content: lifecycle.content ?? "",
        editable: true,
        author: { bot: true, id: "bot-1" },
        components: [],
      },
    ],
  });

  expect(lifecycle.content).toBeUndefined();
  expect(recovered).toBeUndefined();
});

test("approval lifecycle recovery still avoids collisions when legacy request-id fallback is used", async () => {
  const sharedPrefix = `req-${"1234567890".repeat(8)}`;
  const requestId = `${sharedPrefix}-alpha-tail`;
  const otherRequestId = `${sharedPrefix}-omega-tail`;
  const otherLifecycle = `Resolved: touch c.txt\nRequest ID: \`${otherRequestId}\``;

  const recovered = await recoverApprovalLifecycleMessageFromHistory({
    requestId,
    botUserId: "bot-1",
    allowRequestIdFallback: true,
    fetchPage: async () => [
      {
        id: "m1",
        content: otherLifecycle,
        editable: true,
        author: { bot: true, id: "bot-1" },
        components: [],
      },
    ],
  });

  expect(recovered).toBeUndefined();
});

test("approval lifecycle recovery does not reuse a no-button message for a different approval key", async () => {
  const lifecycle = renderApprovalLifecyclePayload({
    approvalKey: "turn-1:item-1",
    approval: createApprovalRecord({
      approvalKey: "turn-1:item-1",
      requestId: "req-shared",
      status: "resolved",
    }),
  });

  const recovered = await recoverApprovalLifecycleMessageFromHistory({
    approvalKey: "turn-2:item-1",
    requestId: "req-shared",
    botUserId: "bot-1",
    fetchPage: async () => [
      {
        id: "m1",
        content: lifecycle.content ?? "",
        editable: true,
        author: { bot: true, id: "bot-1" },
        components: [],
      },
    ],
  });

  expect(recovered).toBeUndefined();
});

test("approval lifecycle recovery can reuse a legacy no-button message when the request id is uniquely owned", async () => {
  const lifecycle = "Approved: touch c.txt\nRequest ID: `req-legacy`";

  const recovered = await recoverApprovalLifecycleMessageFromHistory({
    approvalKey: "legacy:item-1",
    requestId: "req-legacy",
    allowRequestIdFallback: true,
    botUserId: "bot-1",
    fetchPage: async () => [
      {
        id: "m1",
        content: lifecycle,
        editable: true,
        author: { bot: true, id: "bot-1" },
        components: [],
      },
    ],
  } as never);

  expect(recovered?.id).toBe("m1");
});

test("status card renderer stays operational and compact", () => {
  expect(
    renderStatusCardText({
      state: "idle",
    }),
  ).toBe("CodeHelm status: Idle.");

  expect(
    renderStatusCardText({
      state: "running",
    }),
  ).toBe("CodeHelm status: Running.");

  expect(
    renderStatusCardText({
      state: "running",
      activity: "reasoning",
    }),
  ).toBe("CodeHelm status: Running.");

  expect(
    renderStatusCardText({
      state: "running",
      command: "bun test tests/index.test.ts",
      activity: "reasoning",
    }),
  ).toBe("CodeHelm status: Running.");

  expect(
    renderStatusCardText({
      state: "waiting-approval",
      command: "bun test tests/index.test.ts",
    }),
  ).toBe("CodeHelm status: Waiting for approval.");
});

test("running updates stay on the status card and the live Codex process panel", () => {
  expect(
    renderStatusCardText({
      state: "running",
      activity: "reasoning",
    }),
  ).toBe("CodeHelm status: Running.");
  expect(
    renderStatusCardText({
      state: "running",
      command: "bun test tests/index.test.ts",
    }),
  ).toBe("CodeHelm status: Running.");
  expect(
    renderLiveTurnProcessMessage({
      turnId: "turn-1",
      steps: ["reasoning"],
      liveCommentaryText: "reasoning",
    }),
  ).toEqual({
    embeds: [
      {
        title: "Codex",
        description: "reasoning",
        color: 0x64748b,
      },
    ],
  });
  expect(shouldRenderCommandExecutionStartMessage()).toBe(false);
});

test("Discord typing indicator is used only while the session is running", () => {
  expect(shouldShowDiscordTypingIndicator("running")).toBe(true);
  expect(shouldShowDiscordTypingIndicator("idle")).toBe(false);
  expect(shouldShowDiscordTypingIndicator("waiting-approval")).toBe(false);
  expect(shouldShowDiscordTypingIndicator("degraded")).toBe(false);
});

test("managed thread input ignores bot and Discord system messages", () => {
  expect(
    shouldIgnoreManagedThreadMessage({
      author: { bot: true },
      system: false,
    } as never),
  ).toBe(true);
  expect(
    shouldIgnoreManagedThreadMessage({
      author: { bot: false },
      system: true,
    } as never),
  ).toBe(true);
  expect(
    shouldIgnoreManagedThreadMessage({
      author: { bot: false },
      system: false,
    } as never),
  ).toBe(false);
});

test("stale live turn process updates are ignored once the active turn changes", () => {
  expect(
    shouldSkipStaleLiveTurnProcessUpdate({
      activeTurnId: "turn-2",
      turnId: "turn-1",
    }),
  ).toBe(true);
  expect(
    shouldSkipStaleLiveTurnProcessUpdate({
      activeTurnId: undefined,
      closedTurnIds: new Set<string>(["turn-1"]),
      turnId: "turn-1",
    }),
  ).toBe(true);
  expect(
    shouldSkipStaleLiveTurnProcessUpdate({
      activeTurnId: "turn-1",
      turnId: "turn-1",
    }),
  ).toBe(false);
  expect(
    shouldSkipStaleLiveTurnProcessUpdate({
      activeTurnId: undefined,
      turnId: "turn-1",
      deleteIfEmpty: true,
    }),
  ).toBe(false);
});

test("commentary activity summaries are normalized for status hints", () => {
  expect(summarizeStatusActivity("  reasoning through the failure  ")).toBe(
    "reasoning through the failure",
  );
  expect(summarizeStatusActivity("first line\nsecond line")).toBe("first line");
  expect(
    summarizeStatusActivity(
      "this commentary hint is intentionally long so the status card needs to truncate it before it turns into another transcript bubble",
    ),
  ).toBe("this commentary hint is intentionally long so the status ca...");
});

test("live completed items only relay transcript entries when needed", () => {
  expect(
    shouldRelayLiveCompletedItemToTranscript({
      type: "commandExecution",
      id: "cmd-1",
      command: "bun test",
      exitCode: 0,
    }),
  ).toBe(false);

  expect(
    shouldRelayLiveCompletedItemToTranscript({
      type: "commandExecution",
      id: "cmd-2",
      command: "bun test",
      exitCode: 1,
    }),
  ).toBe(false);

  expect(
    shouldRelayLiveCompletedItemToTranscript({
      type: "userMessage",
      id: "user-1",
      content: [{ type: "text", text: "run it" }],
    }),
  ).toBe(true);
});

test("completed assistant replies are projected immediately only for final_answer", () => {
  expect(
    shouldRenderCompletedAssistantReplyImmediately("final_answer"),
  ).toBe(true);
  expect(
    shouldRenderCompletedAssistantReplyImmediately("commentary"),
  ).toBe(false);
  expect(
    shouldRenderCompletedAssistantReplyImmediately(null),
  ).toBe(false);
  expect(
    shouldRenderCompletedAssistantReplyImmediately(undefined),
  ).toBe(false);
});

test("periodic snapshot polling skips active sessions", () => {
  expect(shouldPollSnapshotForSessionState("idle")).toBe(true);
  expect(shouldPollSnapshotForSessionState("running")).toBe(false);
  expect(shouldPollSnapshotForSessionState("waiting-approval")).toBe(false);
  expect(shouldPollSnapshotForSessionState("degraded")).toBe(false);
});

test("periodic recovery probe covers active sessions without re-enabling snapshot polling", () => {
  expect(shouldPollRecoveryProbeForSessionState("idle")).toBe(false);
  expect(shouldPollRecoveryProbeForSessionState("running")).toBe(true);
  expect(shouldPollRecoveryProbeForSessionState("waiting-approval")).toBe(true);
  expect(shouldPollRecoveryProbeForSessionState("degraded")).toBe(false);
});

test("active-session recovery probe triggers snapshot recovery only after an idle transition", () => {
  expect(
    getSessionRecoveryProbeOutcome({
      sessionState: "running",
      threadStatus: { type: "idle" },
    }),
  ).toEqual({
    nextState: "idle",
    shouldUpdateSessionState: true,
    shouldUpdateStatusCard: true,
    shouldSyncTranscriptSnapshot: true,
  });

  expect(
    getSessionRecoveryProbeOutcome({
      sessionState: "waiting-approval",
      threadStatus: {
        type: "active",
        activeFlags: [],
      },
    }),
  ).toEqual({
    nextState: "running",
    shouldUpdateSessionState: true,
    shouldUpdateStatusCard: true,
    shouldSyncTranscriptSnapshot: false,
  });
});

test("pre-materialization includeTurns read failures are treated as expected", () => {
  expect(
    isExpectedPreMaterializationIncludeTurnsError(
      new Error("includeTurns unavailable before first user message"),
    ),
  ).toBe(true);
  expect(
    isExpectedPreMaterializationIncludeTurnsError(
      new Error("Thread exists but is not yet materialized for includeTurns=true"),
    ),
  ).toBe(true);
  expect(
    isExpectedPreMaterializationIncludeTurnsError(
      new Error("connection reset by peer"),
    ),
  ).toBe(false);
});

test("snapshot reconciliation reader falls back to plain thread/read before first user message", async () => {
  const calls: Array<{ threadId: string; includeTurns?: boolean }> = [];

  const result = await readThreadForSnapshotReconciliation({
    codexClient: {
      async readThread(params) {
        calls.push(params);

        if (params.includeTurns) {
          throw new Error("includeTurns unavailable before first user message");
        }

        return {
          thread: {
            id: "thread-1",
            cwd: "/tmp/workspace/api",
            preview: "",
            status: { type: "notLoaded" },
          },
        };
      },
      async resumeThread() {
        throw new Error("resumeThread should not be called for pre-materialization fallback");
      },
    },
    threadId: "thread-1",
  });

  expect(calls).toEqual([
    { threadId: "thread-1", includeTurns: true },
    { threadId: "thread-1" },
  ]);
  expect(result.thread.turns).toEqual([]);
});

test("snapshot reconciliation reader resumes not-loaded threads before retrying", async () => {
  const calls: string[] = [];
  let attempts = 0;

  const result = await readThreadForSnapshotReconciliation({
    codexClient: {
      async readThread(params) {
        calls.push(`read:${params.threadId}:${params.includeTurns ? "includeTurns" : "plain"}`);
        attempts += 1;

        if (attempts === 1) {
          throw new Error("thread not loaded: thread-1");
        }

        return {
          thread: {
            id: "thread-1",
            cwd: "/tmp/workspace/api",
            preview: "",
            status: { type: "notLoaded" },
            turns: [],
          },
        };
      },
      async resumeThread({ threadId }) {
        calls.push(`resume:${threadId}`);
        return {
          thread: {
            id: threadId,
            cwd: "/tmp/workspace/api",
            preview: "",
            status: { type: "notLoaded" },
          },
          cwd: "/tmp/workspace/api",
        };
      },
    },
    threadId: "thread-1",
  });

  expect(calls).toEqual([
    "read:thread-1:includeTurns",
    "resume:thread-1",
    "read:thread-1:includeTurns",
  ]);
  expect(result.thread.turns).toEqual([]);
  expect(result.thread.status).toEqual({ type: "notLoaded" });
});

test("snapshot reconciliation reader resumes thread-not-found threads before retrying", async () => {
  const calls: string[] = [];
  let attempts = 0;

  const result = await readThreadForSnapshotReconciliation({
    codexClient: {
      async readThread(params) {
        calls.push(`read:${params.threadId}:${params.includeTurns ? "includeTurns" : "plain"}`);
        attempts += 1;

        if (attempts === 1) {
          throw new Error("thread not found: thread-1");
        }

        return {
          thread: {
            id: "thread-1",
            cwd: "/tmp/workspace/api",
            preview: "",
            status: { type: "idle" },
            turns: [],
          },
        };
      },
      async resumeThread({ threadId }) {
        calls.push(`resume:${threadId}`);
        return {
          thread: {
            id: threadId,
            cwd: "/tmp/workspace/api",
            preview: "",
            status: { type: "idle" },
          },
          cwd: "/tmp/workspace/api",
        };
      },
    },
    threadId: "thread-1",
  });

  expect(calls).toEqual([
    "read:thread-1:includeTurns",
    "resume:thread-1",
    "read:thread-1:includeTurns",
  ]);
  expect(result.thread.turns).toEqual([]);
  expect(result.thread.status).toEqual({ type: "idle" });
});

test("snapshot reconciliation warning policy suppresses expected pre-materialization failures", () => {
  expect(
    shouldLogSnapshotReconciliationWarning(
      new Error("includeTurns unavailable before first user message"),
    ),
  ).toBe(false);
  expect(
    shouldLogSnapshotReconciliationWarning(
      new Error("Thread exists but is not yet materialized for includeTurns=true"),
    ),
  ).toBe(false);
  expect(
    shouldLogSnapshotReconciliationWarning(
      new Error("unexpected rpc failure"),
    ),
  ).toBe(true);
});

test("snapshot reconciliation failure disposition degrades missing threads and ignores expected pre-materialization reads", () => {
  expect(
    getSnapshotReconciliationFailureDisposition(
      new Error("no rollout found for thread id abc"),
    ),
  ).toBe("degrade-thread-missing");
  expect(
    getSnapshotReconciliationFailureDisposition(
      new Error("includeTurns unavailable before first user message"),
    ),
  ).toBe("ignore");
  expect(
    getSnapshotReconciliationFailureDisposition(
      new Error("unexpected rpc failure"),
    ),
  ).toBe("warn");
});

test("missing Codex thread errors are classified for read-only recovery", () => {
  expect(isMissingCodexThreadError(new Error("thread not found: abc"))).toBe(true);
  expect(isMissingCodexThreadError(new Error("no rollout found for thread id abc"))).toBe(true);
  expect(isMissingCodexThreadError(new Error("thread not loaded: abc"))).toBe(false);
  expect(isMissingCodexThreadError(new Error("unexpected rpc failure"))).toBe(false);
  expect(isMissingCodexThreadError("thread not found")).toBe(false);
});

test("not-loaded Codex thread errors are classified for resume-and-retry recovery", () => {
  expect(isNotLoadedCodexThreadError(new Error("thread not loaded: abc"))).toBe(true);
  expect(isNotLoadedCodexThreadError(new Error("thread not found: abc"))).toBe(false);
  expect(isNotLoadedCodexThreadError(new Error("unexpected rpc failure"))).toBe(false);
  expect(isNotLoadedCodexThreadError("thread not loaded")).toBe(false);
});

test("start-turn recovery resumes not-loaded threads and retries once", async () => {
  const calls: string[] = [];
  let attempts = 0;

  const result = await startTurnWithThreadResumeRetry({
    request: {
      threadId: "codex-thread-1",
      input: { kind: "discord-message", content: "有哪些文件" },
    },
    startTurn: async (request) => {
      calls.push(`start:${request.threadId}`);
      attempts += 1;

      if (attempts === 1) {
        throw new Error("thread not loaded: codex-thread-1");
      }

      return { ok: true, threadId: request.threadId };
    },
    resumeThread: async ({ threadId }) => {
      calls.push(`resume:${threadId}`);
      return {
        thread: {
          id: threadId,
        },
      };
    },
  });

  expect(result).toEqual({
    ok: true,
    threadId: "codex-thread-1",
  });
  expect(calls).toEqual([
    "start:codex-thread-1",
    "resume:codex-thread-1",
    "start:codex-thread-1",
  ]);
});

test("start-turn can materialize the thread before the first attempt", async () => {
  const calls: string[] = [];

  const result = await startTurnWithThreadResumeRetry({
    request: {
      threadId: "codex-thread-1",
      input: { kind: "discord-message", content: "有哪些文件" },
    },
    resumeBeforeStart: true,
    startTurn: async (request) => {
      calls.push(`start:${request.threadId}`);
      return { ok: true, threadId: request.threadId };
    },
    resumeThread: async ({ threadId }) => {
      calls.push(`resume:${threadId}`);
      return {
        thread: {
          id: threadId,
        },
      };
    },
  });

  expect(result).toEqual({
    ok: true,
    threadId: "codex-thread-1",
  });
  expect(calls).toEqual([
    "resume:codex-thread-1",
    "start:codex-thread-1",
  ]);
});

test("start-turn ignores pre-start resume failures for unmaterialized fresh threads", async () => {
  const calls: string[] = [];

  const result = await startTurnWithThreadResumeRetry({
    request: {
      threadId: "codex-thread-1",
      input: { kind: "discord-message", content: "有哪些文件" },
    },
    resumeBeforeStart: true,
    startTurn: async (request) => {
      calls.push(`start:${request.threadId}`);
      return { ok: true, threadId: request.threadId };
    },
    resumeThread: async ({ threadId }) => {
      calls.push(`resume:${threadId}`);
      throw new Error(`no rollout found for thread id ${threadId}`);
    },
  });

  expect(result).toEqual({
    ok: true,
    threadId: "codex-thread-1",
  });
  expect(calls).toEqual([
    "resume:codex-thread-1",
    "start:codex-thread-1",
  ]);
});

test("start-turn recovery resumes thread-not-found failures and retries once", async () => {
  const calls: string[] = [];
  let attempts = 0;

  const result = await startTurnWithThreadResumeRetry({
    request: {
      threadId: "codex-thread-1",
      input: { kind: "discord-message", content: "有哪些文件" },
    },
    startTurn: async (request) => {
      calls.push(`start:${request.threadId}`);
      attempts += 1;

      if (attempts === 1) {
        throw new Error("thread not found: codex-thread-1");
      }

      return { ok: true, threadId: request.threadId };
    },
    resumeThread: async ({ threadId }) => {
      calls.push(`resume:${threadId}`);
      return {
        thread: {
          id: threadId,
        },
      };
    },
  });

  expect(result).toEqual({
    ok: true,
    threadId: "codex-thread-1",
  });
  expect(calls).toEqual([
    "start:codex-thread-1",
    "resume:codex-thread-1",
    "start:codex-thread-1",
  ]);
});

test("start-turn recovery still fails when thread-not-found persists after resume", async () => {
  const calls: string[] = [];

  await expect(
    startTurnWithThreadResumeRetry({
      request: {
        threadId: "codex-thread-1",
        input: { kind: "discord-message", content: "有哪些文件" },
      },
      startTurn: async (request) => {
        calls.push(`start:${request.threadId}`);
        throw new Error("thread not found: codex-thread-1");
      },
      resumeThread: async ({ threadId }) => {
        calls.push(`resume:${threadId}`);
        return {
          thread: {
            id: threadId,
          },
        };
      },
    }),
  ).rejects.toThrow("thread not found: codex-thread-1");

  expect(calls).toEqual([
    "start:codex-thread-1",
    "resume:codex-thread-1",
    "start:codex-thread-1",
  ]);
});

test("status card reuse only matches clear operational status messages", () => {
  expect(
    findReusableStatusCardMessage({
      messages: [
        {
          id: "m1",
          content: "CodeHelm status: Idle.",
          editable: true,
          author: { bot: true, id: "bot-1" },
        },
      ],
      botUserId: "bot-1",
    })?.id,
  ).toBe("m1");

  expect(
    findReusableStatusCardMessage({
      messages: [
        {
          id: "m2",
          content: "CodeHelm status: Running.",
          editable: false,
          author: { bot: true, id: "bot-1" },
        },
      ],
      botUserId: "bot-1",
    }),
  ).toBeUndefined();

  expect(
    findReusableStatusCardMessage({
      messages: [
        {
          id: "m3",
          content: "CodeHelm status: Idle.",
          editable: true,
          author: { bot: true, id: "other-bot" },
        },
      ],
      botUserId: "bot-1",
    }),
  ).toBeUndefined();

  expect(
    findReusableStatusCardMessage({
      messages: [
        {
          id: "m4",
          content: "Session started.\nPath: `~/code-github/code-helm`.\nCodex thread: `codex-thread-1`.",
          editable: true,
          author: { bot: true, id: "bot-1" },
        },
        {
          id: "m5",
          content: "Codex: implemented the fix",
          editable: true,
          author: { bot: true, id: "bot-1" },
        },
      ],
      botUserId: "bot-1",
    }),
  ).toBeUndefined();
});

test("status card recovery scans bounded pages until it finds a reusable message", async () => {
  const calls: Array<{ limit: number; before?: string }> = [];

  const recovered = await recoverStatusCardMessageFromHistory({
    botUserId: "bot-1",
    fetchPage: async (options) => {
      calls.push(options);

      if (calls.length === 1) {
        return Array.from({ length: options.limit }, (_, index) => ({
          id: index === options.limit - 1 ? "page-1-last" : `page-1-${index}`,
          content: "Codex: transcript message",
          editable: true,
          author: { bot: true, id: "bot-1" },
        }));
      }

      return [
        {
          id: "status-1",
          content: "CodeHelm status: Idle.",
          editable: true,
          author: { bot: true, id: "bot-1" },
        },
      ];
    },
  });

  expect(recovered?.id).toBe("status-1");
  expect(calls).toEqual([
    { limit: 50 },
    { limit: 50, before: "page-1-last" },
  ]);
});

test("status card recovery stays bounded when no reusable message exists", async () => {
  let calls = 0;

  const recovered = await recoverStatusCardMessageFromHistory({
    botUserId: "bot-1",
    fetchPage: async (options) => {
      calls += 1;

      return Array.from({ length: options.limit }, (_, index) => ({
        id: `page-${calls}-message-${index}`,
        content: "Codex: transcript message",
        editable: true,
        author: { bot: true, id: "bot-1" },
      }));
    },
  });

  expect(recovered).toBeUndefined();
  expect(calls).toBe(5);
});

test("status card upsert edits a recovered message instead of sending a new one", async () => {
  let sent = 0;
  let edited = 0;
  const recoveredMessage = {
    content: "CodeHelm status: Idle.",
    async edit(payload: { content: string }) {
      edited += 1;
      recoveredMessage.content = payload.content;
      return recoveredMessage;
    },
  };

  const result = await upsertStatusCardMessage({
    currentMessage: undefined,
    recoverMessage: async () => recoveredMessage,
    content: "CodeHelm status: Running.",
    sendMessage: async () => {
      sent += 1;
      throw new Error("should not send a new message");
    },
  });

  expect(result?.content).toBe("CodeHelm status: Running.");
  expect(edited).toBe(1);
  expect(sent).toBe(0);
});

test("status card upsert avoids redundant edits when content is unchanged", async () => {
  let edited = 0;
  const currentMessage = {
    content: "CodeHelm status: Idle.",
    async edit(payload: { content: string }) {
      edited += 1;
      currentMessage.content = payload.content;
      return currentMessage;
    },
  };

  const result = await upsertStatusCardMessage({
    currentMessage,
    recoverMessage: async () => undefined,
    content: "CodeHelm status: Idle.",
    sendMessage: async () => {
      throw new Error("should not send a replacement");
    },
  });

  expect(result).toBe(currentMessage);
  expect(edited).toBe(0);
});

test("concurrent first status-card updates converge on one created message", async () => {
  let sent = 0;
  let edited = 0;
  let releaseRecovery: (() => void) | undefined;

  const runtime: {
    attemptedStatusRecovery: boolean;
    statusMessage?: EditableStatusCardMessage;
    pendingStatusUpdate?: Promise<EditableStatusCardMessage | undefined>;
  } = {
    attemptedStatusRecovery: false,
    statusMessage: undefined,
    pendingStatusUpdate: undefined,
  };

  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });

  const createdMessage: EditableStatusCardMessage = {
    content: "CodeHelm status: Running.",
    async edit(payload: { content: string }) {
      edited += 1;
      createdMessage.content = payload.content;
      return createdMessage;
    },
  };

  const first = applyStatusCardUpdate({
    runtime,
    content: "CodeHelm status: Running.",
    recoverMessage: async () => {
      await recoveryGate;
      return undefined;
    },
    sendMessage: async () => {
      sent += 1;
      return createdMessage;
    },
  });

  const second = applyStatusCardUpdate({
    runtime,
    content: "CodeHelm status: Waiting for approval.",
    recoverMessage: async () => undefined,
    sendMessage: async () => {
      sent += 1;
      throw new Error("should not create a second status card");
    },
  });

  releaseRecovery?.();

  const [, finalMessage] = await Promise.all([first, second]);

  expect(sent).toBe(1);
  expect(edited).toBe(1);
  expect(finalMessage?.content).toBe("CodeHelm status: Waiting for approval.");
  expect(runtime.statusMessage).toBe(createdMessage);
});

test("status-card updates recover and resend when the cached message handle is stale", async () => {
  let recoveries = 0;
  let sends = 0;
  const staleMessage: EditableStatusCardMessage = {
    content: "CodeHelm status: Idle.",
    async edit() {
      throw new Error("Unknown Message");
    },
  };
  const runtime: {
    attemptedStatusRecovery: boolean;
    statusMessage?: EditableStatusCardMessage;
    pendingStatusUpdate?: Promise<EditableStatusCardMessage | undefined>;
  } = {
    attemptedStatusRecovery: true,
    statusMessage: staleMessage,
    pendingStatusUpdate: undefined,
  };

  const result = await applyStatusCardUpdate({
    runtime,
    content: "CodeHelm status: Running.",
    recoverMessage: async () => {
      recoveries += 1;
      return undefined;
    },
    sendMessage: async (content) => {
      sends += 1;
      const message: EditableStatusCardMessage = {
        content,
        async edit(payload: { content: string }) {
          message.content = payload.content;
          return message;
        },
      };
      return message;
    },
  });

  expect(result?.content).toBe("CodeHelm status: Running.");
  expect(recoveries).toBe(1);
  expect(sends).toBe(1);
  expect(runtime.statusMessage).toBe(result);
  expect(runtime.attemptedStatusRecovery).toBe(true);
});

test("status-card updates preserve non-stale edit failures without creating a replacement", async () => {
  let recoveries = 0;
  let sends = 0;
  const failure = new Error("rate limited");
  const currentMessage: EditableStatusCardMessage = {
    content: "CodeHelm status: Idle.",
    async edit() {
      throw failure;
    },
  };
  const runtime: {
    attemptedStatusRecovery: boolean;
    statusMessage?: EditableStatusCardMessage;
    pendingStatusUpdate?: Promise<EditableStatusCardMessage | undefined>;
  } = {
    attemptedStatusRecovery: true,
    statusMessage: currentMessage,
    pendingStatusUpdate: undefined,
  };

  await expect(
    applyStatusCardUpdate({
      runtime,
      content: "CodeHelm status: Running.",
      recoverMessage: async () => {
        recoveries += 1;
        return undefined;
      },
      sendMessage: async () => {
        sends += 1;
        throw new Error("should not create a replacement message");
      },
    }),
  ).rejects.toBe(failure);

  expect(recoveries).toBe(0);
  expect(sends).toBe(0);
  expect(runtime.statusMessage).toBe(currentMessage);
  expect(runtime.attemptedStatusRecovery).toBe(true);
});

test("per-session recovery polling updates busy sessions that have gone idle", async () => {
  const calls: string[] = [];
  const session = {
    codexThreadId: "thread-1",
    discordThreadId: "discord-1",
    state: "running",
  };

  await pollSessionRecovery({
    session,
    sessionState: "running",
    readThread: async () => ({
      thread: {
        id: "thread-1",
        cwd: "/tmp/workspace/api",
        preview: "",
        status: { type: "idle" },
      },
    }),
    updateSessionState: async (nextState) => {
      calls.push(`state:${nextState}`);
    },
    updateStatusCard: async (nextState) => {
      calls.push(`status:${nextState}`);
    },
    syncTranscriptSnapshot: async () => {
      calls.push("snapshot");
    },
  });

  expect(calls).toEqual([
    "state:idle",
    "status:idle",
    "snapshot",
  ]);
});

test("manual sync clears snapshot-mismatch read-only once the session view is trustworthy", async () => {
  const calls: string[] = [];

  const result = await syncManagedSession({
    session: createSessionRecord({
      state: "degraded",
      degradationReason: "snapshot_mismatch",
    }),
    readThread: async () => createThreadReadResult({
      status: { type: "idle" },
    }),
    persistSessionState: async (runtimeState, degradationReason) => {
      calls.push(`persist:${runtimeState}:${degradationReason ?? "null"}`);
    },
    syncReadOnlySurface: async () => {
      calls.push("read-only");
    },
    updateStatusCard: async (runtimeState) => {
      calls.push(`status:${runtimeState}`);
    },
    syncTranscriptSnapshot: async () => {
      calls.push("snapshot");
    },
  });

  expect(result).toEqual({
    kind: "ready",
    session: {
      lifecycleState: "active",
      runtimeState: "idle",
      accessMode: "writable",
    },
    persistedRuntimeState: "idle",
    statusCardState: "idle",
  });
  expect(calls).toEqual([
    "snapshot",
    "persist:idle:null",
    "status:idle",
  ]);
});

test("manual sync absorbs snapshot mismatch and restores writable control in one pass", async () => {
  const calls: string[] = [];
  let transcriptTrusted = false;

  const result = await syncManagedSession({
    session: createSessionRecord({
      state: "degraded",
      degradationReason: "snapshot_mismatch",
    }),
    readThread: async () => createThreadReadResult({
      status: { type: "idle" },
    }),
    detectReadOnlyReason: async () => transcriptTrusted ? null : "snapshot_mismatch",
    persistSessionState: async (runtimeState, degradationReason) => {
      calls.push(`persist:${runtimeState}:${degradationReason ?? "null"}`);
    },
    syncReadOnlySurface: async () => {
      calls.push("read-only");
    },
    updateStatusCard: async () => {
      calls.push("status");
    },
    syncTranscriptSnapshot: async () => {
      calls.push("snapshot");
      transcriptTrusted = true;
    },
  });

  expect(result).toEqual({
    kind: "ready",
    session: {
      lifecycleState: "active",
      runtimeState: "idle",
      accessMode: "writable",
    },
    persistedRuntimeState: "idle",
    statusCardState: "idle",
  });
  expect(calls).toEqual([
    "snapshot",
    "persist:idle:null",
    "status",
  ]);
});

test("manual sync preserves read-only mode when Codex reports an error state", async () => {
  const calls: string[] = [];

  const result = await syncManagedSession({
    session: createSessionRecord({
      state: "degraded",
      degradationReason: "snapshot_mismatch",
    }),
    readThread: async () => createThreadReadResult({
      status: { type: "systemError" },
    }),
    persistSessionState: async (runtimeState, degradationReason) => {
      calls.push(`persist:${runtimeState}:${degradationReason ?? "null"}`);
    },
    syncReadOnlySurface: async () => {
      calls.push("read-only");
    },
    updateStatusCard: async () => {
      calls.push("status");
    },
    syncTranscriptSnapshot: async () => {
      calls.push("snapshot");
    },
  });

  expect(result).toEqual({
    kind: "error",
    session: {
      lifecycleState: "active",
      runtimeState: "error",
      accessMode: "read-only",
    },
    persistedRuntimeState: "degraded",
    statusCardState: undefined,
  });
  expect(calls).toEqual([
    "persist:degraded:null",
    "read-only",
    "snapshot",
  ]);
});

test("failed status-card recovery can retry on the next update", async () => {
  let attempts = 0;
  const runtime: {
    attemptedStatusRecovery: boolean;
    statusMessage?: EditableStatusCardMessage;
  } = {
    attemptedStatusRecovery: false,
    statusMessage: undefined,
  };

  await expect(
    tryRecoverStatusCardMessage({
      runtime,
      recoverMessage: async () => {
        attempts += 1;
        throw new Error("transient fetch failure");
      },
    }),
  ).rejects.toThrow("transient fetch failure");

  expect(runtime.attemptedStatusRecovery).toBe(false);
  expect(runtime.statusMessage).toBeUndefined();

  const recovered: EditableStatusCardMessage = {
    content: "CodeHelm status: Idle.",
    async edit(payload: { content: string }) {
      recovered.content = payload.content;
      return recovered;
    },
  };

  const result = await tryRecoverStatusCardMessage({
    runtime,
    recoverMessage: async () => {
      attempts += 1;
      return recovered;
    },
  });

  expect(result).toBe(recovered);
  expect(runtime.attemptedStatusRecovery).toBe(true);
  expect(runtime.statusMessage).toBeDefined();
  if (!runtime.statusMessage) {
    throw new Error("expected runtime status message to be set");
  }
  expect(runtime.statusMessage.content).toBe(recovered.content);
  expect(attempts).toBe(2);
});
