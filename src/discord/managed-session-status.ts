type ManagedSessionStatusInput = {
  session: {
    discordThreadId: string;
    codexThreadId: string;
    cwd: string;
    lifecycleState: string;
    modelOverride: string | null;
    reasoningEffortOverride: string | null;
  };
  effectiveState: string;
  queuedSteers: string[];
  pendingApprovalCount: number;
};

const truncatePreview = (value: string, maxLength = 72) => {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
};

export const renderManagedSessionStatus = ({
  session,
  effectiveState,
  queuedSteers,
  pendingApprovalCount,
}: ManagedSessionStatusInput) => {
  const lines = [
    "```ansi",
    "\u001b[1;36m>_ CodeHelm /status\u001b[0m",
    "",
    `Lifecycle:          ${session.lifecycleState}`,
    `Runtime:            ${effectiveState}`,
    `Directory:          ${session.cwd}`,
    `Codex thread:       ${session.codexThreadId}`,
    `Discord thread:     ${session.discordThreadId}`,
    `Model:              ${session.modelOverride ?? "not available"}`,
    `Reasoning effort:   ${session.reasoningEffortOverride ?? "not available"}`,
    `Queued steer:       ${queuedSteers.length}`,
    `Pending approvals:  ${pendingApprovalCount}`,
  ];

  if (queuedSteers.length > 0) {
    lines.push(
      "",
      "Queued steer preview:",
      ...queuedSteers.slice(0, 3).map((steer, index) =>
        `${index + 1}. ${truncatePreview(steer)}`
      ),
    );
  }

  lines.push("```");

  return lines.join("\n");
};
