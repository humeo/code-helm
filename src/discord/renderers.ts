import type { RoutedEventMap } from "../codex/protocol-types";
import type { DiscordMessagePayload } from "./transcript";

export type StatusCardState = {
  state: "idle" | "running" | "waiting-approval";
  activity?: string;
  command?: string;
};

export type SessionStartedEvent = {
  type: "session.started";
  params: {
    path: string;
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

const maxDiscordEmbedTitleLength = 256;
const maxDiscordEmbedDescriptionLength = 4_000;
const maxDiscordEmbedFooterTextLength = 256;
const startedNoticeColor = 0x2563eb;
const warningNoticeColor = 0xf59e0b;

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

const truncate = (value: string, maxLength: number) => {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
};

const buildEmbedPayload = ({
  title,
  description,
  footer,
  color,
}: {
  title: string;
  description: string;
  footer?: string;
  color: number;
}): DiscordMessagePayload => {
  const embed: NonNullable<DiscordMessagePayload["embeds"]>[number] = {
    title: truncate(title, maxDiscordEmbedTitleLength),
    description: truncate(description, maxDiscordEmbedDescriptionLength),
    color,
  };

  if (footer) {
    embed.footer = {
      text: truncate(footer, maxDiscordEmbedFooterTextLength),
    };
  }

  return {
    embeds: [embed],
  };
};

const renderReadOnlyDescription = (reason: string | null) => {
  if (reason === "thread_missing") {
    return "The bound Codex session no longer exists.";
  }

  if (reason === "snapshot_mismatch") {
    return "CodeHelm detected Codex activity that was not mirrored into this Discord thread.";
  }

  if (!reason) {
    return "CodeHelm detected Codex activity outside the supported Discord control flow.";
  }

  return `CodeHelm detected unsupported Codex activity (\`${reason}\`).`;
};

export const renderDegradationActionText = ({
  params,
}: DegradationBannerEvent) => {
  return params.reason === "thread_missing"
    ? "Create or import a new session to continue in Discord."
    : "Run `/session-sync` to resync this thread and restore write access.";
};

export const renderSessionStartedText = ({
  params,
}: SessionStartedEvent) => {
  const { path, codexThreadId } = params;

  return `Session started.\nPath: \`${path}\`.\nCodex thread: \`${codexThreadId}\`.`;
};

export const renderSessionStartedPayload = ({
  params,
}: SessionStartedEvent): DiscordMessagePayload => {
  const { path, codexThreadId } = params;

  return buildEmbedPayload({
    title: "Session started",
    description: `Path: \`${path}\`\nCodex thread: \`${codexThreadId}\``,
    color: startedNoticeColor,
  });
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
  if (params.reason === "thread_missing") {
    return "Session is read-only.\n\nThe bound Codex session no longer exists.\n\nCreate or import a new session to continue in Discord.";
  }

  if (params.reason === "snapshot_mismatch") {
    return "Session is read-only.\n\nCodeHelm detected Codex activity that was not mirrored into this Discord thread.\n\nRun `/session-sync` to resync this thread and restore write access.";
  }

  if (!params.reason) {
    return "Session is read-only.\n\nCodeHelm detected Codex activity outside the supported Discord control flow.\n\nRun `/session-sync` to resync this thread and restore write access.";
  }

  return `Session is read-only.\n\nCodeHelm detected unsupported Codex activity (\`${params.reason}\`).\n\nRun \`/session-sync\` to resync this thread and restore write access.`;
};

export const renderDegradationBannerPayload = ({
  params,
}: DegradationBannerEvent): DiscordMessagePayload => {
  const description = renderReadOnlyDescription(params.reason);

  return buildEmbedPayload({
    title: "Session is read-only",
    description,
    color: warningNoticeColor,
  });
};
