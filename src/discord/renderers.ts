import type { RoutedEventMap } from "../codex/protocol-types";

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

const readString = (value: unknown, keys: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const key of keys) {
    const candidate = record[key];

    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
};

export const renderSessionStartedText = ({
  params,
}: SessionStartedEvent) => {
  const { workdirLabel, codexThreadId } = params;

  return `Session started for \`${workdirLabel}\`.\nCodex thread: \`${codexThreadId}\`.`;
};

export const renderRunningStatusText = ({
  method,
  params,
}: RunningStatusEvent) => {
  if (method === "turn/started") {
    const turnId = readString(params, ["turnId"]);

    return turnId ? `Turn started: \`${turnId}\`.` : "Turn started.";
  }

  const status = readString(params, ["status"]);

  return status ? `Thread status changed: \`${status}\`.` : "Thread status changed.";
};

export const renderToolProgressSummaryText = ({
  method,
  params,
}: ToolProgressEvent) => {
  const phase = method === "item/completed" ? "completed" : "started";
  const title = readString(params, ["title", "command", "toolName", "itemId"]);

  return title ? `Tool ${phase}: \`${title}\`.` : `Tool ${phase}.`;
};

export const renderFinalAnswerText = ({ params }: FinalAnswerEvent) => {
  return readString(params, ["text", "message", "outputText", "finalText"])
    ?? "Turn completed.";
};

export const renderDegradationBannerText = ({
  params,
}: DegradationBannerEvent) => {
  const { reason } = params;

  if (!reason) {
    return "Session is now read-only because it was modified outside the supported Discord/Codex flow.";
  }

  return `Session is now read-only because it was modified outside the supported Discord/Codex flow (\`${reason}\`).`;
};
