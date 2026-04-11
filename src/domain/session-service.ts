import type { CodexThread } from "../codex/protocol-types";
import type {
  SessionAccessMode,
  SessionLifecycleState,
  SessionOwnership,
  SessionPersistedRuntimeState,
  SessionResumeState,
  SessionRuntimeState,
  SessionWorkdirChange,
} from "./types";

export const canImportSession = ({
  runtimeState,
}: {
  runtimeState: SessionRuntimeState;
}) => {
  return runtimeState === "idle";
};

export const coercePersistedSessionRuntimeState = (
  state: string,
): SessionPersistedRuntimeState => {
  return state === "running"
    || state === "waiting-approval"
    || state === "degraded"
    ? state
    : "idle";
};

export const resolveSessionAccessMode = ({
  lifecycleState,
  runtimeState,
}: {
  lifecycleState: SessionLifecycleState;
  runtimeState: SessionRuntimeState;
}): SessionAccessMode => {
  if (lifecycleState !== "active") {
    return "inactive";
  }

  return runtimeState === "degraded" || runtimeState === "error"
    ? "read-only"
    : "writable";
};

export const canChangeSessionWorkdir = ({
  currentWorkdirId,
  requestedWorkdirId,
}: SessionWorkdirChange) => {
  return currentWorkdirId === requestedWorkdirId;
};

export const canControlSession = ({ viewerId, ownerId }: SessionOwnership) => {
  return viewerId === ownerId;
};

const findLatestTurnStatus = (thread: Pick<CodexThread, "turns">) => {
  const latestTurnWithStatus = [...(thread.turns ?? [])]
    .reverse()
    .find((turn: NonNullable<CodexThread["turns"]>[number]) =>
      typeof turn.status === "string" && turn.status.length > 0);

  return latestTurnWithStatus?.status;
};

const isNextInputReadyThreadStatus = (
  thread: Pick<CodexThread, "status">,
) => {
  return thread.status.type === "idle"
    || thread.status.type === "notLoaded"
    || (thread.status.type === "active"
      && thread.status.activeFlags.includes("waitingOnUserInput"));
};

export const inferSyncedSessionRuntimeState = (
  thread: Pick<CodexThread, "status" | "turns">,
): SessionRuntimeState | null => {
  if (thread.status.type === "systemError") {
    return "error";
  }

  const latestTurnStatus = findLatestTurnStatus(thread);

  if (latestTurnStatus === "error") {
    return "error";
  }

  if (latestTurnStatus === "interrupted") {
    return isNextInputReadyThreadStatus(thread) ? "interrupted" : null;
  }

  if (thread.status.type === "active") {
    return thread.status.activeFlags.includes("waitingOnApproval")
      ? "waiting-approval"
      : "running";
  }

  return "idle";
};

export const resolveResumeSessionState = ({
  lifecycleState,
  persistedRuntimeState,
  degradationReason,
  syncedRuntimeState,
}: {
  lifecycleState: SessionLifecycleState;
  persistedRuntimeState: SessionPersistedRuntimeState;
  degradationReason: string | null;
  syncedRuntimeState: SessionRuntimeState | null;
}): SessionResumeState => {
  if (syncedRuntimeState === null) {
    return {
      kind: "untrusted",
      reason: "sync_state_untrusted",
    };
  }

  if (
    persistedRuntimeState === "degraded"
    || degradationReason !== null
  ) {
    return {
      kind: "read-only",
      session: {
        lifecycleState: "active",
        runtimeState: syncedRuntimeState,
        accessMode: "read-only",
      },
      persistedRuntimeState: "degraded",
      statusCardState: undefined,
    };
  }

  if (syncedRuntimeState === "error") {
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
  }

  if (syncedRuntimeState === "degraded") {
    return {
      kind: "read-only",
      session: {
        lifecycleState: "active",
        runtimeState: "degraded",
        accessMode: "read-only",
      },
      persistedRuntimeState: "degraded",
      statusCardState: undefined,
    };
  }

  if (
    syncedRuntimeState === "running"
    || syncedRuntimeState === "waiting-approval"
  ) {
    return {
      kind: "busy",
      session: {
        lifecycleState: "active",
        runtimeState: syncedRuntimeState,
        accessMode: "writable",
      },
      persistedRuntimeState: syncedRuntimeState,
      statusCardState: syncedRuntimeState,
    };
  }

  return {
    kind: "ready",
    session: {
      lifecycleState: "active",
      runtimeState: syncedRuntimeState,
      accessMode: "writable",
    },
    persistedRuntimeState: "idle",
    statusCardState: "idle",
  };
};

export const resolveSyncSessionState = ({
  syncedRuntimeState,
}: {
  syncedRuntimeState: SessionRuntimeState | null;
}): SessionResumeState => {
  if (syncedRuntimeState === null) {
    return {
      kind: "untrusted",
      reason: "sync_state_untrusted",
    };
  }

  if (syncedRuntimeState === "error") {
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
  }

  if (syncedRuntimeState === "degraded") {
    return {
      kind: "read-only",
      session: {
        lifecycleState: "active",
        runtimeState: "degraded",
        accessMode: "read-only",
      },
      persistedRuntimeState: "degraded",
      statusCardState: undefined,
    };
  }

  if (
    syncedRuntimeState === "running"
    || syncedRuntimeState === "waiting-approval"
  ) {
    return {
      kind: "busy",
      session: {
        lifecycleState: "active",
        runtimeState: syncedRuntimeState,
        accessMode: "writable",
      },
      persistedRuntimeState: syncedRuntimeState,
      statusCardState: syncedRuntimeState,
    };
  }

  return {
    kind: "ready",
    session: {
      lifecycleState: "active",
      runtimeState: syncedRuntimeState,
      accessMode: "writable",
    },
    persistedRuntimeState: "idle",
    statusCardState: "idle",
  };
};
