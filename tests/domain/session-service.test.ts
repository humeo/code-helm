import { expect, test } from "bun:test";
import {
  canChangeSessionWorkdir,
  canControlSession,
  canImportSession,
  coercePersistedSessionRuntimeState,
  inferSyncedSessionRuntimeState,
  resolveResumeSessionState,
  resolveSyncSessionState,
  resolveSessionAccessMode,
} from "../../src/domain/session-service";
import type {
  SessionPersistedRuntimeState,
  SessionRuntimeState,
} from "../../src/domain/types";
import {
  isUnsupportedExternalModification,
  shouldDegradeDiscordToReadOnly,
} from "../../src/domain/external-modification";

test("only idle sessions are importable", () => {
  const states: Array<[SessionRuntimeState, boolean]> = [
    ["idle", true],
    ["running", false],
    ["waiting-approval", false],
    ["degraded", false],
  ];

  for (const [runtimeState, expected] of states) {
    expect(canImportSession({ runtimeState })).toBe(expected);
  }

  const runtimeState = "idle" as string;

  // @ts-expect-error runtimeState must be a SessionRuntimeState
  canImportSession({ runtimeState });
});

test("persisted runtime coercion keeps legacy storage states bounded", () => {
  const cases: Array<[string, SessionPersistedRuntimeState]> = [
    ["idle", "idle"],
    ["running", "running"],
    ["waiting-approval", "waiting-approval"],
    ["degraded", "degraded"],
    ["unexpected", "idle"],
  ];

  for (const [value, expected] of cases) {
    expect(coercePersistedSessionRuntimeState(value)).toBe(expected);
  }
});

test("sessions keep the same workdir", () => {
  expect(
    canChangeSessionWorkdir({
      currentWorkdirId: "wd1",
      requestedWorkdirId: "wd1",
    }),
  ).toBe(true);
  expect(
    canChangeSessionWorkdir({
      currentWorkdirId: "wd1",
      requestedWorkdirId: "wd2",
    }),
  ).toBe(false);
});

test("only the owner can control the session", () => {
  expect(canControlSession({ viewerId: "u1", ownerId: "u1" })).toBe(true);
  expect(canControlSession({ viewerId: "u2", ownerId: "u1" })).toBe(false);
});

test("access mode stays distinct from lifecycle and runtime state", () => {
  expect(
    resolveSessionAccessMode({
      lifecycleState: "archived",
      runtimeState: "idle",
    }),
  ).toBe("inactive");
  expect(
    resolveSessionAccessMode({
      lifecycleState: "active",
      runtimeState: "degraded",
    }),
  ).toBe("read-only");
  expect(
    resolveSessionAccessMode({
      lifecycleState: "active",
      runtimeState: "error",
    }),
  ).toBe("read-only");
  expect(
    resolveSessionAccessMode({
      lifecycleState: "active",
      runtimeState: "interrupted",
    }),
  ).toBe("writable");
});

test("sync runtime inference recognizes interrupted and error branches", () => {
  expect(
    inferSyncedSessionRuntimeState({
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
      turns: [],
    }),
  ).toBe("waiting-approval");
  expect(
    inferSyncedSessionRuntimeState({
      status: { type: "systemError" },
      turns: [],
    }),
  ).toBe("error");
  expect(
    inferSyncedSessionRuntimeState({
      status: { type: "idle" },
      turns: [{ id: "turn-1", items: [], status: "interrupted" }],
    }),
  ).toBe("interrupted");
  expect(
    inferSyncedSessionRuntimeState({
      status: { type: "idle" },
      turns: [{ id: "turn-1", items: [], status: "error" }],
    }),
  ).toBe("error");
  expect(
    inferSyncedSessionRuntimeState({
      status: { type: "active", activeFlags: [] },
      turns: [{ id: "turn-1", items: [], status: "interrupted" }],
    }),
  ).toBeNull();
});

test("resume sync resolves idle and interrupted sessions back to writable control", () => {
  const idle = resolveResumeSessionState({
    lifecycleState: "archived",
    persistedRuntimeState: "idle",
    degradationReason: null,
    syncedRuntimeState: "idle",
  });
  const interrupted = resolveResumeSessionState({
    lifecycleState: "archived",
    persistedRuntimeState: "running",
    degradationReason: null,
    syncedRuntimeState: "interrupted",
  });

  expect(idle).toEqual({
    kind: "ready",
    session: {
      lifecycleState: "active",
      runtimeState: "idle",
      accessMode: "writable",
    },
    persistedRuntimeState: "idle",
    statusCardState: "idle",
  });
  expect(interrupted).toEqual({
    kind: "ready",
    session: {
      lifecycleState: "active",
      runtimeState: "interrupted",
      accessMode: "writable",
    },
    persistedRuntimeState: "idle",
    statusCardState: "idle",
  });
});

test("resume sync preserves busy sessions until Codex is ready", () => {
  const states: Array<
    [
      Extract<SessionRuntimeState, "running" | "waiting-approval">,
      Extract<SessionPersistedRuntimeState, "running" | "waiting-approval">,
    ]
  > = [
    ["running", "running"],
    ["waiting-approval", "waiting-approval"],
  ];

  for (const [syncedRuntimeState, expectedPersistedState] of states) {
    expect(
      resolveResumeSessionState({
        lifecycleState: "archived",
        persistedRuntimeState: "idle",
        degradationReason: null,
        syncedRuntimeState,
      }),
    ).toEqual({
      kind: "busy",
      session: {
        lifecycleState: "active",
        runtimeState: syncedRuntimeState,
        accessMode: "writable",
      },
      persistedRuntimeState: expectedPersistedState,
      statusCardState: expectedPersistedState,
    });
  }
});

test("resume sync keeps degraded sessions read-only and exposes error sessions separately", () => {
  expect(
    resolveResumeSessionState({
      lifecycleState: "archived",
      persistedRuntimeState: "degraded",
      degradationReason: "snapshot_mismatch",
      syncedRuntimeState: "idle",
    }),
  ).toEqual({
    kind: "read-only",
    session: {
      lifecycleState: "active",
      runtimeState: "idle",
      accessMode: "read-only",
    },
    persistedRuntimeState: "degraded",
    statusCardState: undefined,
  });

  expect(
    resolveResumeSessionState({
      lifecycleState: "archived",
      persistedRuntimeState: "idle",
      degradationReason: null,
      syncedRuntimeState: "error",
    }),
  ).toEqual({
    kind: "error",
    session: {
      lifecycleState: "active",
      runtimeState: "error",
      accessMode: "read-only",
    },
    persistedRuntimeState: "degraded",
    statusCardState: undefined,
  });
});

test("resume sync fails closed when it cannot form a trustworthy view", () => {
  expect(
    resolveResumeSessionState({
      lifecycleState: "archived",
      persistedRuntimeState: "running",
      degradationReason: null,
      syncedRuntimeState: null,
    }),
  ).toEqual({
    kind: "untrusted",
    reason: "sync_state_untrusted",
  });
});

test("manual sync can clear snapshot-mismatch read-only once the snapshot is trustworthy", () => {
  expect(
    resolveSyncSessionState({
      syncedRuntimeState: "idle",
    }),
  ).toEqual({
    kind: "ready",
    session: {
      lifecycleState: "active",
      runtimeState: "idle",
      accessMode: "writable",
    },
    persistedRuntimeState: "idle",
    statusCardState: "idle",
  });

  expect(
    resolveSyncSessionState({
      syncedRuntimeState: "waiting-approval",
    }),
  ).toEqual({
    kind: "busy",
    session: {
      lifecycleState: "active",
      runtimeState: "waiting-approval",
      accessMode: "writable",
    },
    persistedRuntimeState: "waiting-approval",
    statusCardState: "waiting-approval",
  });
});

test("manual sync still fails closed for untrusted views and keeps Codex error state read-only", () => {
  expect(
    resolveSyncSessionState({
      syncedRuntimeState: null,
    }),
  ).toEqual({
    kind: "untrusted",
    reason: "sync_state_untrusted",
  });

  expect(
    resolveSyncSessionState({
      syncedRuntimeState: "error",
    }),
  ).toEqual({
    kind: "error",
    session: {
      lifecycleState: "active",
      runtimeState: "error",
      accessMode: "read-only",
    },
    persistedRuntimeState: "degraded",
    statusCardState: undefined,
  });
});

test("unsupported external modifications degrade Discord to read-only", () => {
  expect(isUnsupportedExternalModification({ controlSurface: "discord" })).toBe(
    false,
  );
  expect(
    isUnsupportedExternalModification({ controlSurface: "codex-remote" }),
  ).toBe(false);
  expect(
    isUnsupportedExternalModification({ controlSurface: "plain-codex" }),
  ).toBe(true);
  expect(isUnsupportedExternalModification({ controlSurface: "unknown" })).toBe(
    true,
  );

  expect(shouldDegradeDiscordToReadOnly({ controlSurface: "discord" })).toBe(
    false,
  );
  expect(
    shouldDegradeDiscordToReadOnly({ controlSurface: "codex-remote" }),
  ).toBe(false);
  expect(
    shouldDegradeDiscordToReadOnly({ controlSurface: "plain-codex" }),
  ).toBe(true);
  expect(shouldDegradeDiscordToReadOnly({ controlSurface: "unknown" })).toBe(
    true,
  );
});
