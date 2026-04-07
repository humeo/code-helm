import { expect, test } from "bun:test";
import {
  decideThreadTurn,
  normalizeOwnerThreadMessage,
} from "../../src/discord/thread-handler";
import {
  renderDegradationBannerText,
  renderFinalAnswerText,
  renderRunningStatusText,
  renderSessionStartedText,
  renderToolProgressText,
} from "../../src/discord/renderers";

test("owner thread message becomes Codex input", () => {
  const result = normalizeOwnerThreadMessage({
    authorId: "u1",
    ownerId: "u1",
    content: "fix the failing test",
  });

  expect(result).toEqual([{ type: "text", text: "fix the failing test" }]);
});

test("owner idle thread message starts a turn", () => {
  const result = decideThreadTurn({
    authorId: "u1",
    ownerId: "u1",
    content: "fix the failing test",
    sessionState: "idle",
    codexThreadId: "codex-thread-1",
  });

  expect(result).toEqual({
    kind: "start-turn",
    request: {
      threadId: "codex-thread-1",
      input: [{ type: "text", text: "fix the failing test" }],
    },
  });

  if (result.kind !== "start-turn") {
    throw new Error("expected a start-turn decision");
  }

  expect(
    Object.prototype.hasOwnProperty.call(result.request, "approvalPolicy"),
  ).toBe(false);
  expect(
    Object.prototype.hasOwnProperty.call(result.request, "sandboxPolicy"),
  ).toBe(false);
});

test("defined turn policies are forwarded", () => {
  const result = decideThreadTurn({
    authorId: "u1",
    ownerId: "u1",
    content: "fix the failing test",
    sessionState: "idle",
    codexThreadId: "codex-thread-1",
    approvalPolicy: "on-request",
    sandboxPolicy: "workspace-write",
  });

  expect(result).toEqual({
    kind: "start-turn",
    request: {
      threadId: "codex-thread-1",
      input: [{ type: "text", text: "fix the failing test" }],
      approvalPolicy: "on-request",
      sandboxPolicy: "workspace-write",
    },
  });
});

test("non-owner messages are ignored", () => {
  const result = decideThreadTurn({
    authorId: "u2",
    ownerId: "u1",
    content: "I have thoughts too",
    sessionState: "idle",
    codexThreadId: "codex-thread-1",
  });

  expect(result).toEqual({
    kind: "noop",
    reason: "non-owner",
  });
});

test("running sessions do not start a second turn", () => {
  const result = decideThreadTurn({
    authorId: "u1",
    ownerId: "u1",
    content: "run again",
    sessionState: "running",
    codexThreadId: "codex-thread-1",
  });

  expect(result).toEqual({
    kind: "noop",
    reason: "session-busy",
  });
});

test("waiting approval sessions also stay single-turn", () => {
  const result = decideThreadTurn({
    authorId: "u1",
    ownerId: "u1",
    content: "run again",
    sessionState: "waiting-approval",
    codexThreadId: "codex-thread-1",
  });

  expect(result).toEqual({
    kind: "noop",
    reason: "session-busy",
  });
});

test("degraded sessions stay read-only", () => {
  const result = decideThreadTurn({
    authorId: "u1",
    ownerId: "u1",
    content: "recover",
    sessionState: "degraded",
    codexThreadId: "codex-thread-1",
  });

  expect(result).toEqual({
    kind: "read-only",
    reason: "session-degraded",
  });
});

test("session started renderer returns stable Discord text", () => {
  expect(
    renderSessionStartedText({
      type: "session.started",
      params: {
        workdirLabel: "api",
        codexThreadId: "codex-thread-1",
      },
    }),
  ).toBe("Session started for `api`.\nCodex thread: `codex-thread-1`.");
});

test("running status renderer returns stable Discord text", () => {
  expect(
    renderRunningStatusText({
      method: "turn/started",
      params: {
        turnId: "turn-1",
      },
    }),
  ).toBe("Turn started: `turn-1`.");

  expect(
    renderRunningStatusText({
      method: "thread/status/changed",
      params: {
        status: "running",
      },
    }),
  ).toBe("Thread status changed: `running`.");
});

test("tool progress renderer summarizes known tool events", () => {
  expect(
    renderToolProgressText({
      method: "item/started",
      params: {
        itemId: "call-1",
      },
    }),
  ).toBe("Tool started: `call-1`.");
});

test("final answer renderer returns the final text", () => {
  expect(
    renderFinalAnswerText({
      method: "turn/completed",
      params: {
        text: "Implemented the bridge and verified tests pass.",
      },
    }),
  ).toBe("Implemented the bridge and verified tests pass.");
});

test("degradation renderer explains read-only mode", () => {
  expect(
    renderDegradationBannerText({
      type: "session.degraded",
      params: {
        reason: "native_cli_write",
      },
    }),
  ).toBe(
    "Session is now read-only because it was modified outside the supported Discord/Codex flow (`native_cli_write`).",
  );
});
