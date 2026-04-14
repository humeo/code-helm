import { expect, test } from "bun:test";
import type {
  CodexThread,
  CodexThreadStatus,
  ThreadListParams,
} from "../src/codex/protocol-types";
import {
  applyManagedTurnCompletion,
  applyStatusCardUpdate,
  canAcceptManagedSessionThreadInput,
  closeManagedSession,
  reconcileResumedApprovalState,
  reconcileApprovalResolutionSurface,
  resolveCloseSessionCommand,
  resolveResumeSessionCommand,
  resolveSyncSessionCommand,
  describeSessionAccessMode,
  formatManagedSessionList,
  getSessionRecoveryProbeOutcome,
  handleArchivedManagedSessionThreadMessage,
  handleManagedThreadDeletion,
  markTranscriptItemsSeen,
  pollSessionRecovery,
  readThreadForSnapshotReconciliation,
  shouldLogSnapshotReconciliationWarning,
  shouldAcceptApprovalInteraction,
  shouldPollRecoveryProbeForSessionState,
  shouldSkipTranscriptRelayEntry,
  shouldSkipTranscriptSnapshotItem,
  finalizeApprovalLifecycleMessageState,
  hasHandledTranscriptItem,
  recoverApprovalLifecycleMessageFromHistory,
  isExpectedPreMaterializationIncludeTurnsError,
  isMissingCodexThreadError,
  getSnapshotReconciliationFailureDisposition,
  isNotLoadedCodexThreadError,
  shouldProjectManagedSessionDiscordSurface,
  renderApprovalLifecycleMessage,
  renderApprovalLifecyclePayload,
  resumeManagedSession,
  startTurnWithThreadResumeRetry,
  syncManagedSession,
  upsertApprovalLifecycleMessage,
  upsertStreamingTranscriptMessage,
  canImportThreadIntoWorkdir,
  buildResumeSessionAutocompleteChoices,
  describeCodexThreadStatus,
  type EditableStatusCardMessage,
  filterConfiguredWorkdirs,
  findReusableStatusCardMessage,
  inferSessionStateFromThreadStatus,
  isImportableThreadStatus,
  formatResumeSessionAutocompleteChoice,
  recoverStatusCardMessageFromHistory,
  resolveResumeAttachmentKind,
  shouldPollSnapshotForSessionState,
  shouldDegradeForSnapshotMismatch,
  shouldHoldSnapshotTranscriptForManualSync,
  shouldRelayLiveCompletedItemToTranscript,
  shouldRenderCommandExecutionStartMessage,
  shouldShowDiscordTypingIndicator,
  shouldSkipStaleLiveTurnProcessUpdate,
  summarizeStatusActivity,
  tryRecoverStatusCardMessage,
  upsertStatusCardMessage,
  handleApprovalInteraction,
  finalizeLiveTurnProcessMessage,
  renderLiveTurnProcessMessage,
  seedTranscriptRuntimeSeenItemsFromSnapshot,
  noteTrustedLiveExternalTurnStart,
  sortResumePickerThreads,
} from "../src/index";
import { renderStatusCardText } from "../src/discord/renderers";
import {
  getAssistantTranscriptEntryId,
  getProcessTranscriptEntryId,
  getUserTranscriptEntryId,
} from "../src/discord/transcript";
import type { CodexTurn } from "../src/codex/protocol-types";
import type { SessionRecord } from "../src/db/repos/sessions";

const createSessionRecord = (
  overrides: Partial<SessionRecord> = {},
): SessionRecord => ({
  discordThreadId: "discord-thread-1",
  codexThreadId: "codex-thread-1",
  ownerDiscordUserId: "owner-1",
  workdirId: "api",
  state: "idle",
  lifecycleState: "active",
  degradationReason: null,
  createdAt: "2026-04-09T00:00:00.000Z",
  updatedAt: "2026-04-09T00:00:00.000Z",
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
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
});

test("import eligibility only allows idle and notLoaded threads", () => {
  const cases: Array<[CodexThreadStatus, boolean]> = [
    [{ type: "idle" }, true],
    [{ type: "notLoaded" }, true],
    [{ type: "systemError" }, false],
    [{ type: "active", activeFlags: [] }, false],
    [{ type: "active", activeFlags: ["waitingOnApproval"] }, false],
  ];

  for (const [status, expected] of cases) {
    expect(isImportableThreadStatus(status)).toBe(expected);
  }
});

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

test("import also requires the selected workdir to match the thread cwd", () => {
  expect(
    canImportThreadIntoWorkdir(
      {
        cwd: "/tmp/workspace/api",
        status: { type: "idle" },
      },
      "/tmp/workspace/api",
    ),
  ).toBe(true);
  expect(
    canImportThreadIntoWorkdir(
      {
        cwd: "/tmp/workspace/web",
        status: { type: "idle" },
      },
      "/tmp/workspace/api",
    ),
  ).toBe(false);
});

test("configured workdir autocomplete choices are sourced from daemon config", () => {
  expect(
    filterConfiguredWorkdirs(
      [
        {
          id: "example",
          label: "Code Agent Helm Example",
          absolutePath: "/tmp/workspace/example",
        },
        {
          id: "web",
          label: "Web App",
          absolutePath: "/tmp/workspace/web",
        },
      ],
      "exa",
    ),
  ).toEqual([
    {
      name: "Code Agent Helm Example (example)",
      value: "example",
    },
  ]);
});

test("resume picker threads sort by updatedAt, createdAt, then id", () => {
  const oldest = createResumePickerThread({
    id: "thread-e",
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  const sameUpdatedOlderCreated = createResumePickerThread({
    id: "thread-c",
    createdAt: 2_000,
    updatedAt: 3_000,
  });
  const sameUpdatedNewerCreated = createResumePickerThread({
    id: "thread-d",
    createdAt: 3_000,
    updatedAt: 3_000,
  });
  const sameTimestampsEarlierId = createResumePickerThread({
    id: "thread-a",
    createdAt: 4_000,
    updatedAt: 4_000,
  });
  const sameTimestampsLaterId = createResumePickerThread({
    id: "thread-b",
    createdAt: 4_000,
    updatedAt: 4_000,
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

test("resume session autocomplete pipeline scopes threads, sorts them, formats labels, and truncates to 25", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const firstPageThreads = Array.from({ length: 13 }, (_, index) =>
    createResumePickerThread({
      id: `codex-thread-${String(index).padStart(2, "0")}`,
      preview: `Preview ${index}`,
      updatedAt: index,
      createdAt: index,
    })
  );
  const secondPageThreads = [
    createResumePickerThread({
      id: "codex-thread-12345678901",
      preview:
        "This preview is intentionally long so the autocomplete helper has to " +
        "truncate it before Discord rejects the choice label.",
      updatedAt: 5_000,
    }),
    ...Array.from({ length: 13 }, (_, index) =>
      createResumePickerThread({
        id: `codex-thread-late-${String(index).padStart(2, "0")}`,
        preview: `Late preview ${index}`,
        updatedAt: 100 + index,
        createdAt: 100 + index,
      })
    ),
  ];

  const choices = await buildResumeSessionAutocompleteChoices({
    codexClient: {
      async listThreads(params: ThreadListParams) {
        calls.push(params as Record<string, unknown>);
        return params.cursor === "cursor-2"
          ? {
              data: secondPageThreads,
              nextCursor: null,
            }
          : {
              data: firstPageThreads,
              nextCursor: "cursor-2",
            };
      },
    } as never,
    query: "  plan  ",
    workdirId: "api",
    workdirs: [
      {
        id: "api",
        label: "API",
        absolutePath: "/tmp/workspace/api",
      },
    ],
  });

  expect(calls).toEqual([
    {
      cwd: "/tmp/workspace/api",
      searchTerm: "plan",
      limit: 100,
    },
    {
      cwd: "/tmp/workspace/api",
      searchTerm: "plan",
      limit: 100,
      cursor: "cursor-2",
    },
  ]);
  expect(choices).toHaveLength(25);
  expect(choices[0]?.value).toBe("codex-thread-12345678901");
  expect(choices[0]?.name.length).toBeLessThanOrEqual(100);
  expect(choices[0]?.name.endsWith(" · …345678901")).toBe(true);
  expect(choices.at(-1)?.value).toBe("codex-thread-02");
});

test("resume session autocomplete labels include status, preview or name, and a short thread id", () => {
  expect(
    formatResumeSessionAutocompleteChoice(createResumePickerThread({
      id: "codex-thread-123456789",
      preview: "  Draft plan  ",
      name: "Ignored name",
      status: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
    })),
  ).toEqual({
    name: "active(waitingOnApproval) · Draft plan · …123456789",
    value: "codex-thread-123456789",
  });

  expect(
    formatResumeSessionAutocompleteChoice(createResumePickerThread({
      id: "codex-thread-000000002",
      preview: "   ",
      name: "Named fallback",
      status: {
        type: "idle",
      },
    })),
  ).toEqual({
    name: "idle · Named fallback · …000000002",
    value: "codex-thread-000000002",
  });

  const longChoice = formatResumeSessionAutocompleteChoice(createResumePickerThread({
    id: "codex-thread-12345678901",
    preview:
      "This preview is intentionally long so the autocomplete helper has to " +
      "truncate it before Discord rejects the choice label.",
    status: {
      type: "idle",
    },
  }));

  expect(longChoice.value).toBe("codex-thread-12345678901");
  expect(longChoice.name.length).toBeLessThanOrEqual(100);
  expect(longChoice.name.startsWith("idle · ")).toBe(true);
  expect(longChoice.name.endsWith(" · …345678901")).toBe(true);
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
        workdirId: "api",
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

test("resume command rejects unknown managed sessions", () => {
  expect(
    resolveResumeSessionCommand({
      actorId: "owner-1",
      codexThreadId: "codex-thread-1",
      session: null,
    }),
  ).toEqual({
    reply: {
      content: "Unknown managed session `codex-thread-1`.",
      ephemeral: true,
    },
  });
});

test("resume command rejects non-owners", () => {
  expect(
    resolveResumeSessionCommand({
      actorId: "viewer-1",
      codexThreadId: "codex-thread-1",
      session: {
        ...createSessionRecord({
          codexThreadId: "codex-thread-1",
          ownerDiscordUserId: "owner-1",
          lifecycleState: "archived",
        }),
      },
    }),
  ).toEqual({
    reply: {
      content: "Only the session owner can resume this session.",
      ephemeral: true,
    },
  });
});

test("resume command rejects deleted Discord thread containers", () => {
  expect(
    resolveResumeSessionCommand({
      actorId: "owner-1",
      codexThreadId: "codex-thread-1",
      session: createSessionRecord({
        codexThreadId: "codex-thread-1",
        ownerDiscordUserId: "owner-1",
        lifecycleState: "deleted",
      }),
    }),
  ).toEqual({
    reply: {
      content:
        "Session `codex-thread-1` no longer has a resumable Discord thread.",
      ephemeral: true,
    },
  });
});

test("resume command rejects non-archived sessions", () => {
  expect(
    resolveResumeSessionCommand({
      actorId: "owner-1",
      codexThreadId: "codex-thread-1",
      session: createSessionRecord({
        codexThreadId: "codex-thread-1",
        ownerDiscordUserId: "owner-1",
        lifecycleState: "active",
      }),
    }),
  ).toEqual({
    reply: {
      content: "Session `codex-thread-1` is currently `active`, not `archived`.",
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
          requestId: "req-7",
          status: "pending",
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
      expect(lifecycleState.message?.content).toBe(
        "Approval `req-7`: pending.",
      );
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
    async edit(payload: { content?: string; components?: unknown[] }) {
      recoveredMessage.content = payload.content ?? recoveredMessage.content;
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
    "approval:Approval `req-7`: pending.",
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

test("approval reconciliation only rehydrates pending approval state", async () => {
  const calls: string[] = [];

  await reconcileResumedApprovalState({
    runtimeState: "waiting-approval",
    pendingApprovals: [
      { requestId: "req-2", status: "pending" },
      { requestId: "req-1", status: "pending" },
    ],
    upsertApprovalMessage: async (requestId, status) => {
      calls.push(`message:${requestId}:${status}`);
    },
    ensureOwnerControls: async (requestId, status) => {
      calls.push(`dm:${requestId}:${status}`);
    },
  });

  expect(calls).toEqual([
    "message:req-2:pending",
    "dm:req-2:pending",
  ]);

  calls.length = 0;

  await reconcileResumedApprovalState({
    runtimeState: "running",
    pendingApprovals: [{ requestId: "req-2", status: "pending" }],
    upsertApprovalMessage: async (requestId, status) => {
      calls.push(`message:${requestId}:${status}`);
    },
    ensureOwnerControls: async (requestId, status) => {
      calls.push(`dm:${requestId}:${status}`);
    },
  });

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
    latestApproval: {
      requestId: "req-9",
      status: "approved",
    },
    upsertApprovalMessage: async (requestId, status) => {
      calls.push(`message:${requestId}:${status}`);
    },
    ensureOwnerControls: async (requestId, status) => {
      calls.push(`dm:${requestId}:${status}`);
    },
  });

  expect(calls).toEqual([]);
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

test("approval resolution updates DM and existing lifecycle message even while the thread is archived", async () => {
  const calls: string[] = [];
  const lifecycleMessage = {
    content: "Approval `req-1`: pending.",
    async edit(payload: { content?: string; components?: unknown[] }) {
      calls.push(`thread:${payload.content}:${payload.components?.length ?? 0}`);
      lifecycleMessage.content = payload.content ?? lifecycleMessage.content;
      return lifecycleMessage;
    },
  };
  const dmMessage = {
    async edit(payload: { content: string; components: [] }) {
      calls.push(`dm:${payload.content}:${payload.components.length}`);
      return dmMessage;
    },
  };

  await reconcileApprovalResolutionSurface({
    requestId: "req-1",
    status: "approved",
    session: createSessionRecord({
      lifecycleState: "archived",
    }),
    currentThreadMessage: lifecycleMessage,
    currentThreadMessagePromise: undefined,
    recoverThreadMessage: async () => undefined,
    sendThreadMessage: async (payload) => {
      calls.push(`send:${payload.content}:${payload.components?.length ?? 0}`);
      return lifecycleMessage;
    },
    dmMessage,
  });

  expect(calls).toEqual([
    "dm:Approval resolved: `approved`.:0",
    "thread:Approval `req-1`: approved.:0",
  ]);
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

  const handled = await handleApprovalInteraction({
    interaction: {
      customId: "approval|req-1|approve",
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
        }),
    } as never,
    approvalRepo: {
      getByRequestId: () => ({
        requestId: "req-1",
        discordThreadId: "discord-thread-1",
        status: "pending",
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

  await expect(
    handleApprovalInteraction({
      interaction: {
        customId: "approval|req-1|approve",
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
        getByRequestId: () => ({
          requestId: "req-1",
          discordThreadId: "discord-thread-1",
          status: "pending",
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

test("approval interaction rejects concurrent resolution attempts for the same request", async () => {
  const calls: string[] = [];
  let releaseRpc: (() => void) | undefined;
  const rpcGate = new Promise<void>((resolve) => {
    releaseRpc = resolve;
  });
  const inFlightRequestIds = new Set<string>();

  const firstInteraction = {
    customId: "approval|req-1|approve",
    user: { id: "owner-1" },
    deferUpdate: async () => {
      calls.push("defer:first");
    },
    reply: async () => {
      calls.push("reply:first");
    },
  } as never;
  const secondInteraction = {
    customId: "approval|req-1|decline",
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
      getByRequestId: () => ({
        requestId: "req-1",
        discordThreadId: "discord-thread-1",
        status: "pending",
      }),
      insert: () => {
        calls.push("insert:first");
      },
    } as never,
    inFlightRequestIds,
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
      getByRequestId: () => ({
        requestId: "req-1",
        discordThreadId: "discord-thread-1",
        status: "pending",
      }),
      insert: () => {
        calls.push("insert:second");
      },
    } as never,
    inFlightRequestIds,
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
  expect(inFlightRequestIds.size).toBe(0);
});

test("live turn process rendering does not produce a Codex panel", () => {
  const liveCommentaryPayload = renderLiveTurnProcessMessage({
    turnId: "turn-1",
    steps: ["reading SKILL.md"],
    liveCommentaryText: "running `bun test`",
  });

  expect(liveCommentaryPayload).toBeUndefined();

  const dedupedPayload = renderLiveTurnProcessMessage({
    turnId: "turn-1",
    steps: [],
    liveCommentaryText: "reading SKILL.md",
  });

  expect(dedupedPayload).toBeUndefined();
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
    pendingDiscordInputs: ["reply exactly OK"],
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
    pendingDiscordInputs: ["something else"],
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
    pendingDiscordInputs: [],
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
    pendingDiscordInputs: [] as string[],
    trustedExternalTurnIds: new Set<string>(),
  };

  noteTrustedLiveExternalTurnStart({
    runtime,
    turnId: "external-turn",
  });
  expect(runtime.trustedExternalTurnIds.has("external-turn")).toBe(true);

  runtime.pendingDiscordInputs.push("reply exactly OK");
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
    pendingDiscordInputs: [],
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
      getProcessTranscriptEntryId("turn-1"),
      getAssistantTranscriptEntryId("turn-1"),
    ]),
    finalizingItemIds: new Set<string>(),
    pendingDiscordInputs: [],
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
    pendingDiscordInputs: [],
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

test("approval lifecycle thread message is compact and request-scoped", () => {
  expect(
    renderApprovalLifecycleMessage({
      requestId: "req-7",
      status: "pending",
    }),
  ).toBe("Approval `req-7`: pending.");
  expect(
    renderApprovalLifecycleMessage({
      requestId: "req-7",
      status: "approved",
    }),
  ).toBe("Approval `req-7`: approved.");
});

test("approval lifecycle payload includes thread buttons only while pending", () => {
  const pending = renderApprovalLifecyclePayload({
    requestId: "req-7",
    status: "pending",
  });
  const approved = renderApprovalLifecyclePayload({
    requestId: "req-7",
    status: "approved",
  });

  expect(pending.content).toBe("Approval `req-7`: pending.");
  expect((pending.components ?? []).length).toBe(1);
  expect(approved.content).toBe("Approval `req-7`: approved.");
  expect(approved.components).toEqual([]);
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

test("approval lifecycle recovery finds the request-scoped thread message", async () => {
  const recovered = await recoverApprovalLifecycleMessageFromHistory({
    requestId: "req-7",
    botUserId: "bot-1",
    fetchPage: async () => [
      {
        id: "m1",
        content: "CodeHelm status: Idle.",
        editable: true,
        author: { bot: true, id: "bot-1" },
      },
      {
        id: "m2",
        content: "Approval `req-7`: pending.",
        editable: true,
        author: { bot: true, id: "bot-1" },
      },
    ],
  });

  expect(recovered?.id).toBe("m2");
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

test("running updates stay on the status card and out of the transcript", () => {
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
      steps: [],
      liveCommentaryText: "reasoning",
    }),
  ).toBeUndefined();
  expect(shouldRenderCommandExecutionStartMessage()).toBe(false);
});

test("Discord typing indicator is used only while the session is running", () => {
  expect(shouldShowDiscordTypingIndicator("running")).toBe(true);
  expect(shouldShowDiscordTypingIndicator("idle")).toBe(false);
  expect(shouldShowDiscordTypingIndicator("waiting-approval")).toBe(false);
  expect(shouldShowDiscordTypingIndicator("degraded")).toBe(false);
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
          content: "Session started for `api`.\nCodex thread: `codex-thread-1`.",
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
