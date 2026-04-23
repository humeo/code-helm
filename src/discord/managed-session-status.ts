import type {
  GetAccountRateLimitsResult,
  RateLimitSnapshot,
  ThreadTokenUsage,
  TokenUsageBreakdown,
} from "../codex/protocol-types";

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
  tokenUsageSummary: string;
  contextWindowSummary: string;
  limitsSummary: string;
};

const contextWindowBaselineTokens = 12_000;

const formatTokensCompact = (value: number) => {
  const normalized = Math.max(0, value);

  if (normalized === 0) {
    return "0";
  }

  if (normalized < 1_000) {
    return String(normalized);
  }

  const normalizedFloat = normalized;
  const [scaled, suffix] = normalized >= 1_000_000_000_000
    ? [normalizedFloat / 1_000_000_000_000, "T"]
    : normalized >= 1_000_000_000
      ? [normalizedFloat / 1_000_000_000, "B"]
      : normalized >= 1_000_000
        ? [normalizedFloat / 1_000_000, "M"]
        : [normalizedFloat / 1_000, "K"];
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  let formatted = scaled.toFixed(decimals);

  if (formatted.includes(".")) {
    formatted = formatted.replace(/\.?0+$/, "");
  }

  return `${formatted}${suffix}`;
};

const nonCachedInputTokens = (usage: TokenUsageBreakdown) => {
  return Math.max(usage.inputTokens - usage.cachedInputTokens, 0);
};

const blendedTotalTokens = (usage: TokenUsageBreakdown) => {
  return Math.max(nonCachedInputTokens(usage) + Math.max(usage.outputTokens, 0), 0);
};

const percentContextWindowRemaining = (
  usage: TokenUsageBreakdown,
  contextWindow: number,
) => {
  if (contextWindow <= contextWindowBaselineTokens) {
    return 0;
  }

  const effectiveWindow = contextWindow - contextWindowBaselineTokens;
  const used = Math.max(usage.totalTokens - contextWindowBaselineTokens, 0);
  const remaining = Math.max(effectiveWindow - used, 0);

  return Math.round((remaining / effectiveWindow) * 100);
};

const formatCreditBalance = (balance: string | null) => {
  if (!balance) {
    return null;
  }

  const normalized = balance.trim();

  if (normalized.length === 0) {
    return null;
  }

  const numericValue = Number(normalized);

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  return String(Math.round(numericValue));
};

const primaryRateLimitSnapshot = (
  result: GetAccountRateLimitsResult,
): RateLimitSnapshot | null => {
  return result.rateLimitsByLimitId?.codex ?? result.rateLimits ?? null;
};

export const formatManagedSessionTokenUsageSummary = (
  tokenUsage: ThreadTokenUsage | null | undefined,
) => {
  if (!tokenUsage) {
    return "data not available yet";
  }

  return `${formatTokensCompact(blendedTotalTokens(tokenUsage.total))} total  (${formatTokensCompact(nonCachedInputTokens(tokenUsage.total))} input + ${formatTokensCompact(Math.max(tokenUsage.total.outputTokens, 0))} output)`;
};

export const formatManagedSessionContextWindowSummary = (
  tokenUsage: ThreadTokenUsage | null | undefined,
) => {
  if (!tokenUsage || !tokenUsage.modelContextWindow) {
    return "data not available yet";
  }

  return `${percentContextWindowRemaining(tokenUsage.last, tokenUsage.modelContextWindow)}% left (${formatTokensCompact(Math.max(tokenUsage.last.totalTokens, 0))} used / ${formatTokensCompact(tokenUsage.modelContextWindow)})`;
};

export const summarizeManagedSessionRateLimits = (
  result: GetAccountRateLimitsResult | null | undefined,
) => {
  if (!result) {
    return "data not available yet";
  }

  const snapshot = primaryRateLimitSnapshot(result);

  if (!snapshot) {
    return "data not available yet";
  }

  if (snapshot.credits?.hasCredits) {
    if (snapshot.credits.unlimited) {
      return "Unlimited";
    }

    const formattedBalance = formatCreditBalance(snapshot.credits.balance);

    if (formattedBalance) {
      return `${formattedBalance} credits`;
    }
  }

  const primaryWindow = snapshot.primary ?? snapshot.secondary;

  if (primaryWindow) {
    return `${Math.max(0, Math.min(100, Math.round(100 - primaryWindow.usedPercent)))}% left`;
  }

  return "not available for this account";
};

export const renderManagedSessionStatus = ({
  session,
  effectiveState,
  tokenUsageSummary,
  contextWindowSummary,
  limitsSummary,
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
    "",
    `Token usage:      ${tokenUsageSummary}`,
    `Context window:   ${contextWindowSummary}`,
    `Limits:           ${limitsSummary}`,
  ];

  lines.push("```");

  return lines.join("\n");
};
