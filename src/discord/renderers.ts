export type SessionStartedRenderInput = {
  workdirLabel: string;
  codexThreadId: string;
};

export type RunningStatusRenderInput = {
  state: "running" | "waiting-approval";
  detail?: string;
};

export type ToolProgressRenderInput = {
  phase: "started" | "completed";
  title: string;
};

export type FinalAnswerRenderInput = {
  text: string;
};

export type DegradationBannerRenderInput = {
  reason: string | null;
};

export const renderSessionStartedText = ({
  workdirLabel,
  codexThreadId,
}: SessionStartedRenderInput) => {
  return `Session started for \`${workdirLabel}\`.\nCodex thread: \`${codexThreadId}\`.`;
};

export const renderRunningStatusText = ({
  state,
  detail,
}: RunningStatusRenderInput) => {
  const prefix =
    state === "waiting-approval" ? "Session waiting-approval" : "Session running";

  return detail ? `${prefix}: ${detail}` : prefix;
};

export const renderToolProgressSummaryText = ({
  phase,
  title,
}: ToolProgressRenderInput) => {
  return `Tool ${phase}: ${title}`;
};

export const renderFinalAnswerText = ({ text }: FinalAnswerRenderInput) => {
  return text;
};

export const renderDegradationBannerText = ({
  reason,
}: DegradationBannerRenderInput) => {
  if (!reason) {
    return "Session is now read-only because it was modified outside the supported Discord/Codex flow.";
  }

  return `Session is now read-only because it was modified outside the supported Discord/Codex flow (\`${reason}\`).`;
};
