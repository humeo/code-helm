export type SessionRuntimeState =
  | "idle"
  | "running"
  | "waiting-approval"
  | "degraded";

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
