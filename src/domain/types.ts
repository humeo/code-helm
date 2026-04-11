export type SessionPersistedRuntimeState =
  | "idle"
  | "running"
  | "waiting-approval"
  | "degraded";

export type SessionRuntimeState =
  | SessionPersistedRuntimeState
  | "interrupted"
  | "error";

export type SessionLifecycleState = "active" | "archived" | "deleted";

export type SessionAccessMode = "writable" | "read-only" | "inactive";

export type SessionStateView = {
  lifecycleState: SessionLifecycleState;
  runtimeState: SessionRuntimeState;
  accessMode: SessionAccessMode;
};

export type SessionResumeState =
  | {
      kind: "ready";
      session: SessionStateView & {
        lifecycleState: "active";
        runtimeState: "idle" | "interrupted";
        accessMode: "writable";
      };
      persistedRuntimeState: "idle";
      statusCardState: "idle";
    }
  | {
      kind: "busy";
      session: SessionStateView & {
        lifecycleState: "active";
        runtimeState: "running" | "waiting-approval";
        accessMode: "writable";
      };
      persistedRuntimeState: "running" | "waiting-approval";
      statusCardState: "running" | "waiting-approval";
    }
  | {
      kind: "read-only";
      session: SessionStateView & {
        lifecycleState: "active";
        accessMode: "read-only";
      };
      persistedRuntimeState: "degraded";
      statusCardState: undefined;
    }
  | {
      kind: "error";
      session: SessionStateView & {
        lifecycleState: "active";
        runtimeState: "error";
        accessMode: "read-only";
      };
      persistedRuntimeState: "degraded";
      statusCardState: undefined;
    }
  | {
      kind: "untrusted";
      reason: "sync_state_untrusted";
    };

export type SessionOwnership = {
  viewerId: string;
  ownerId: string;
};

export type SessionWorkdirChange = {
  currentWorkdirId: string;
  requestedWorkdirId: string;
};

export type ExternalModificationSource =
  | "discord"
  | "codex-remote"
  | "plain-codex"
  | "unknown";

export type ExternalModificationObservation = {
  controlSurface: ExternalModificationSource;
};
