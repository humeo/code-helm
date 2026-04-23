import { expect, test } from "bun:test";
import { renderManagedSessionStatus } from "../../src/discord/managed-session-status";

test("managed session status renderer includes Codex-style footer summaries", () => {
  const text = renderManagedSessionStatus({
    session: {
      discordThreadId: "discord-1",
      codexThreadId: "codex-1",
      cwd: "/tmp/project",
      lifecycleState: "active",
      modelOverride: "gpt-5.4",
      reasoningEffortOverride: "xhigh",
    },
    effectiveState: "running",
    tokenUsageSummary: "2.9M total  (2.64M input + 262K output)",
    contextWindowSummary: "52% left (130K used / 258K)",
    limitsSummary: "not available for this account",
  });

  expect(text).toContain("CodeHelm /status");
  expect(text).toContain("Model:");
  expect(text).toContain("Reasoning effort:");
  expect(text).toContain("Token usage:      2.9M total  (2.64M input + 262K output)");
  expect(text).toContain("Context window:   52% left (130K used / 258K)");
  expect(text).toContain("Limits:           not available for this account");
});

test("managed session status renderer no longer includes queued-steer internals", () => {
  const text = renderManagedSessionStatus({
    session: {
      discordThreadId: "discord-1",
      codexThreadId: "codex-1",
      cwd: "/tmp/project",
      lifecycleState: "active",
      modelOverride: null,
      reasoningEffortOverride: null,
    },
    effectiveState: "idle",
    tokenUsageSummary: "data not available yet",
    contextWindowSummary: "data not available yet",
    limitsSummary: "data not available yet",
  });

  expect(text).not.toContain("Queued steer:");
  expect(text).not.toContain("Pending approvals:");
  expect(text).toContain("Token usage:      data not available yet");
  expect(text).toContain("Context window:   data not available yet");
  expect(text).toContain("Limits:           data not available yet");
});
