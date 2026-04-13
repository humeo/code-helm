import type { RoutedEventMap } from "../codex/protocol-types";

export type StatusCardState = {
  state: "idle" | "running" | "waiting-approval";
  activity?: string;
  command?: string;
};

export type SessionStartedEvent = {
  type: "session.started";
  params: {
    workdirLabel: string;
    codexThreadId: string;
  };
};

export type RunningStatusEvent =
  | {
      method: "turn/started";
      params: RoutedEventMap["turn/started"];
    }
  | {
      method: "thread/status/changed";
      params: RoutedEventMap["thread/status/changed"];
    };

export type ToolProgressEvent =
  | {
      method: "item/started";
      params: RoutedEventMap["item/started"];
    }
  | {
      method: "item/completed";
      params: RoutedEventMap["item/completed"];
    };

export type FinalAnswerEvent = {
  method: "turn/completed";
  params: RoutedEventMap["turn/completed"];
};

export type DegradationBannerEvent = {
  type: "session.degraded";
  params: {
    reason: string | null;
  };
};

const readStringField = (value: unknown, key: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidate = record[key];

  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }

  return undefined;
};

export const renderSessionStartedText = ({
  params,
}: SessionStartedEvent) => {
  const { workdirLabel, codexThreadId } = params;

  return `Session started for \`${workdirLabel}\`.\nCodex thread: \`${codexThreadId}\`.`;
};

export const renderStatusCardText = ({
  state,
  activity: _activity,
  command: _command,
}: StatusCardState) => {
  if (state === "waiting-approval") {
    return "CodeHelm status: Waiting for approval.";
  }

  if (state === "idle") {
    return "CodeHelm status: Idle.";
  }

  return "CodeHelm status: Running.";
};

export const renderRunningStatusText = ({
  method,
  params,
}: RunningStatusEvent) => {
  if (method === "turn/started") {
    const turnId = readStringField(params, "turnId");

    return turnId ? `Turn started: \`${turnId}\`.` : "Turn started.";
  }

  const status = readStringField(params, "status");

  return status ? `Thread status changed: \`${status}\`.` : "Thread status changed.";
};

export const renderToolProgressText = ({
  method,
  params,
}: ToolProgressEvent) => {
  const phase = method === "item/completed" ? "completed" : "started";
  const itemId = readStringField(params, "itemId");

  return itemId ? `Tool ${phase}: \`${itemId}\`.` : `Tool ${phase}.`;
};

export const renderFinalAnswerText = ({ params }: FinalAnswerEvent) => {
  return readStringField(params, "text")
    ?? "Turn completed.";
};

export const renderDegradationBannerText = ({
  params,
}: DegradationBannerEvent) => {
  const { reason } = params;

  if (reason === "thread_missing") {
    return "Session is now read-only because the bound Codex session no longer exists. Create or import a new session.";
  }

  if (reason === "snapshot_mismatch") {
    return "Session is now read-only because CodeHelm detected unsupported or offline activity it could not safely replay into Discord. Return to a supported control path and run `/session-sync` again.";
  }

  if (!reason) {
    return "Session is now read-only because it was modified outside the supported Discord/Codex flow.";
  }

  return `Session is now read-only because it was modified outside the supported Discord/Codex flow (\`${reason}\`).`;
};
