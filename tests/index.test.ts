import { expect, test } from "bun:test";
import type { CodexThreadStatus } from "../src/codex/protocol-types";
import {
  describeCodexThreadStatus,
  inferSessionStateFromThreadStatus,
  isImportableThreadStatus,
} from "../src/index";

test("import eligibility only allows idle and notLoaded threads", () => {
  const cases: Array<[CodexThreadStatus, boolean]> = [
    [{ type: "idle" }, true],
    [{ type: "notLoaded" }, true],
    [{ type: "systemError" }, false],
    [{ type: "active", activeFlags: [] }, false],
    [{ type: "active", activeFlags: ["waitingOnApproval"] }, false],
  ];

  for (const [status, expected] of cases) {
    expect(isImportableThreadStatus(status)).toBe(expected);
  }
});

test("thread statuses map into Discord session runtime states", () => {
  expect(inferSessionStateFromThreadStatus({ type: "idle" })).toBe("idle");
  expect(inferSessionStateFromThreadStatus({ type: "notLoaded" })).toBe("idle");
  expect(
    inferSessionStateFromThreadStatus({
      type: "active",
      activeFlags: ["waitingOnApproval"],
    }),
  ).toBe("waiting-approval");
  expect(
    inferSessionStateFromThreadStatus({
      type: "active",
      activeFlags: ["waitingOnUserInput"],
    }),
  ).toBe("running");
  expect(inferSessionStateFromThreadStatus({ type: "systemError" })).toBe(
    "degraded",
  );
});

test("status descriptions stay readable in Discord output", () => {
  expect(describeCodexThreadStatus({ type: "idle" })).toBe("idle");
  expect(
    describeCodexThreadStatus({
      type: "active",
      activeFlags: ["waitingOnApproval", "waitingOnUserInput"],
    }),
  ).toBe("active(waitingOnApproval, waitingOnUserInput)");
});
