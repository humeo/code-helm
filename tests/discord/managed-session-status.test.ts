import { expect, test } from "bun:test";
import { renderManagedSessionStatus } from "../../src/discord/managed-session-status";

test("managed session status renderer returns compact monospace text with queued steer preview", () => {
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
    queuedSteers: [
      "Please continue.",
      "Then update the tests.",
    ],
    pendingApprovalCount: 1,
  });

  expect(text).toContain("CodeHelm /status");
  expect(text).toContain("Model:");
  expect(text).toContain("Reasoning effort:");
  expect(text).toContain("Queued steer:");
  expect(text).toContain("Pending approvals:");
  expect(text).toContain("Please continue.");
  expect(text).toContain("Then update the tests.");
});

test("managed session status renderer omits queued preview section when there are no queued steers", () => {
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
    queuedSteers: [],
    pendingApprovalCount: 0,
  });

  expect(text).toContain("Queued steer:       0");
  expect(text).not.toContain("Queued steer preview:");
  expect(text).toContain("not available");
});
