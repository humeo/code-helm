import { expect, test } from "bun:test";
import {
  decideArchivedThreadResume,
  decideThreadTurn,
  normalizeOwnerThreadMessage,
} from "../../src/discord/thread-handler";
import {
  renderDegradationActionText,
  renderDegradationBannerPayload,
  renderDegradationBannerText,
  renderFinalAnswerText,
  renderRunningStatusText,
  renderSessionStartedPayload,
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

test("owner archived-thread message is treated as an implicit resume attempt", () => {
  expect(
    decideArchivedThreadResume({
      authorId: "u1",
      ownerId: "u1",
      content: "resume from here",
      codexThreadId: "codex-thread-1",
      sessionState: "idle",
    }),
  ).toEqual({
    kind: "implicit-resume",
    request: {
      threadId: "codex-thread-1",
      input: [{ type: "text", text: "resume from here" }],
    },
  });
});

test("non-owner archived-thread message is ignored", () => {
  expect(
    decideArchivedThreadResume({
      authorId: "u2",
      ownerId: "u1",
      content: "resume from here",
      codexThreadId: "codex-thread-1",
      sessionState: "idle",
    }),
  ).toEqual({
    kind: "noop",
    reason: "non-owner",
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

test("session started renderer returns a structured system card payload", () => {
  const payload = renderSessionStartedPayload({
    type: "session.started",
    params: {
      workdirLabel: "api",
      codexThreadId: "codex-thread-1",
    },
  });

  expect(payload).not.toHaveProperty("content");
  expect(payload).toEqual({
    embeds: [
      {
        title: "Session started",
        description: "Session: `api`\n\nCodex thread: `codex-thread-1`",
        color: 0x2563eb,
      },
    ],
  });
});

test("running status helper renders turn and thread status text", () => {
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

test("tool progress helper renders item progress text", () => {
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
        reason: "snapshot_mismatch",
      },
    }),
  ).toBe(
    "Session is read-only.\n\nCodeHelm detected Codex activity that was not mirrored into this Discord thread.\n\nRun `/session-sync` to resync this thread and restore write access.",
  );
});

test("degradation renderer explains when the bound Codex thread is gone", () => {
  expect(
    renderDegradationBannerText({
      type: "session.degraded",
      params: {
        reason: "thread_missing",
      },
    }),
  ).toBe(
    "Session is read-only.\n\nThe bound Codex session no longer exists.\n\nCreate or import a new session to continue in Discord.",
  );
});

test("degradation renderer returns a compact warning card payload", () => {
  const payload = renderDegradationBannerPayload({
    type: "session.degraded",
    params: {
      reason: "snapshot_mismatch",
    },
  });

  expect(payload).not.toHaveProperty("content");
  expect(payload).toEqual({
    embeds: [
      {
        title: "Session is read-only",
        description:
          "CodeHelm detected Codex activity that was not mirrored into this Discord thread.",
        color: 0xf59e0b,
      },
    ],
  });
});

test("degradation renderer returns a missing-thread warning card payload", () => {
  const payload = renderDegradationBannerPayload({
    type: "session.degraded",
    params: {
      reason: "thread_missing",
    },
  });

  expect(payload).not.toHaveProperty("content");
  expect(payload).toEqual({
    embeds: [
      {
        title: "Session is read-only",
        description: "The bound Codex session no longer exists.",
        color: 0xf59e0b,
      },
    ],
  });
});

test("degradation renderer returns the standalone action text", () => {
  expect(
    renderDegradationActionText({
      type: "session.degraded",
      params: {
        reason: "snapshot_mismatch",
      },
    }),
  ).toBe("Run `/session-sync` to resync this thread and restore write access.");

  expect(
    renderDegradationActionText({
      type: "session.degraded",
      params: {
        reason: "thread_missing",
      },
    }),
  ).toBe("Create or import a new session to continue in Discord.");
});
