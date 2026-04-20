import { expect, test } from "bun:test";
import {
  getAssistantTranscriptEntryId,
  getUserTranscriptEntryId,
  collectComparableTranscriptItemIds,
  collectTranscriptEntries,
  renderTranscriptMessages,
  renderTranscriptEntry,
} from "../../src/discord/transcript";
import type { CodexTurn } from "../../src/codex/protocol-types";

test("does not duplicate Discord-originated user messages and drops commentary from the minimal transcript surface", () => {
  const turns: CodexTurn[] = [
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "user-1",
          content: [{ type: "text", text: "Inspect the repo." }],
        },
        {
          type: "agentMessage",
          id: "agent-1",
          text: "Reading the repository structure now.",
          phase: "commentary",
        },
      ],
    },
  ];

  const entries = collectTranscriptEntries(turns, {
    source: "live",
    pendingDiscordInputs: ["Inspect the repo."],
  });

  expect(entries).toEqual([]);
});

test("renders non-Discord input as plain text instead of a remote input card", () => {
  const turn: CodexTurn = {
    id: "turn-1",
    status: "completed",
    items: [
      {
        type: "userMessage",
        id: "user-1",
        content: [{ type: "text", text: "resume --remote" }],
      },
    ],
  };

  const liveEntries = collectTranscriptEntries([turn], {
    source: "live",
  });
  const snapshotEntries = collectTranscriptEntries([turn], {
    source: "snapshot",
  });

  expect(liveEntries).toEqual([
    {
      itemId: getUserTranscriptEntryId("turn-1"),
      kind: "user",
      source: "codex-cli",
      text: "resume --remote",
    },
  ]);
  const livePayload = renderTranscriptEntry(liveEntries[0]);
  expect(livePayload).toEqual({
    content: "resume --remote",
  });
  expect(snapshotEntries).toEqual([
    {
      itemId: getUserTranscriptEntryId("turn-1"),
      kind: "user",
      source: "codex-cli",
      text: "resume --remote",
    },
  ]);
  const snapshotPayload = renderTranscriptEntry(snapshotEntries[0]);
  expect(snapshotPayload).toEqual({
    content: "resume --remote",
  });
});

test("remote input user entries use a stable turn-level id across live and snapshot views", () => {
  const liveEntries = collectTranscriptEntries([
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "live-user-id",
          content: [{ type: "text", text: "resume --remote" }],
        },
      ],
    },
  ], {
    source: "live",
  });

  const snapshotEntries = collectTranscriptEntries([
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "snapshot-user-id",
          content: [{ type: "text", text: "resume --remote" }],
        },
      ],
    },
  ], {
    source: "snapshot",
  });

  expect(liveEntries[0]?.itemId).toBe(getUserTranscriptEntryId("turn-1"));
  expect(snapshotEntries[0]?.itemId).toBe(getUserTranscriptEntryId("turn-1"));
});

test("renders synced remote input as plain text followed by a separate final assistant message", () => {
  const entries = collectTranscriptEntries(
    [
      {
        id: "turn-1",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user-1",
            content: [{ type: "text", text: "replay only \"ok9\"" }],
          },
          {
            type: "agentMessage",
            id: "agent-1",
            text: "ok9",
            phase: "final",
          },
        ],
      },
    ],
    {
      source: "snapshot",
    },
  );

  expect(renderTranscriptMessages(entries)).toEqual([
    {
      entryItemId: getUserTranscriptEntryId("turn-1"),
      entryKind: "user",
      isFirstChunk: true,
      itemIds: [getUserTranscriptEntryId("turn-1")],
      payload: {
        content: "replay only \"ok9\"",
      },
    },
    {
      entryItemId: getAssistantTranscriptEntryId("turn-1"),
      entryKind: "assistant",
      isFirstChunk: true,
      itemIds: [getAssistantTranscriptEntryId("turn-1")],
      payload: {
        content: "ok9",
      },
    },
  ]);
});

test("splits long final assistant replies across multiple Discord messages instead of truncating", () => {
  const longReply = `${"a".repeat(1_895)}不过我还看到一个更长的尾巴`;
  const entries = collectTranscriptEntries(
    [
      {
        id: "turn-1",
        status: "completed",
        items: [
          {
            type: "agentMessage",
            id: "agent-1",
            text: longReply,
            phase: "final",
          },
        ],
      },
    ],
    {
      source: "live",
    },
  );

  expect(renderTranscriptMessages(entries)).toEqual([
    {
      entryItemId: getAssistantTranscriptEntryId("turn-1"),
      entryKind: "assistant",
      isFirstChunk: true,
      itemIds: [],
      payload: {
        content: longReply.slice(0, 1_900),
      },
    },
    {
      entryItemId: getAssistantTranscriptEntryId("turn-1"),
      entryKind: "assistant",
      isFirstChunk: false,
      itemIds: [getAssistantTranscriptEntryId("turn-1")],
      payload: {
        content: longReply.slice(1_900),
      },
    },
  ]);
});

test("snapshot recovery clears stale pending Discord input before later live CLI input reuses the text", () => {
  const pendingDiscordInputs = ["resume --remote"];

  const snapshotEntries = collectTranscriptEntries(
    [
      {
        id: "turn-1",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user-1",
            content: [{ type: "text", text: "resume --remote" }],
          },
        ],
      },
    ],
    {
      source: "snapshot",
      pendingDiscordInputs,
    },
  );

  const liveEntries = collectTranscriptEntries(
    [
      {
        id: "turn-2",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user-2",
            content: [{ type: "text", text: "resume --remote" }],
          },
        ],
      },
    ],
    {
      source: "live",
      pendingDiscordInputs,
    },
  );

  expect(snapshotEntries).toEqual([]);
  expect(pendingDiscordInputs).toEqual([]);
  expect(liveEntries).toEqual([
    {
      itemId: getUserTranscriptEntryId("turn-2"),
      kind: "user",
      source: "codex-cli",
      text: "resume --remote",
    },
  ]);
});

test("builds only the final reply for a completed turn", () => {
  const turns: CodexTurn[] = [
    {
      id: "turn-1",
      status: "completed",
      items: [
        {
          type: "agentMessage",
          id: "agent-1",
          text: "reading SKILL.md",
          phase: "commentary",
        },
        {
          type: "commandExecution",
          id: "cmd-1",
          command: "bun test",
          cwd: "/tmp/project",
          status: "completed",
          exitCode: 0,
        },
        {
          type: "agentMessage",
          id: "agent-2",
          text: "OK",
          phase: "final",
        },
      ],
    },
  ];

  const entries = collectTranscriptEntries(turns, {
    source: "live",
  });

  expect(entries).toEqual([
    {
      itemId: getAssistantTranscriptEntryId("turn-1"),
      kind: "assistant",
      text: "OK",
    },
  ]);
  expect(renderTranscriptEntry(entries[0])).toEqual({
    content: "OK",
  });
});

test("commentary-only turns emit no transcript entries", () => {
  const entries = collectTranscriptEntries(
    [
      {
        id: "turn-1",
        status: "completed",
        items: [
          {
            type: "agentMessage",
            id: "agent-1",
            text: "reading README.md",
            phase: "commentary",
          },
        ],
      },
    ],
    {
      source: "live",
    },
  );

  expect(entries).toEqual([]);
});

test("active turn approval footers do not fabricate transcript entries", () => {
  const entries = collectTranscriptEntries(
    [
      {
        id: "turn-1",
        status: "in_progress",
        items: [
          {
            type: "agentMessage",
            id: "agent-1",
            text: "reading README.md",
            phase: "commentary",
          },
          {
            type: "commandExecution",
            id: "cmd-1",
            command: "touch /tmp/README.md",
            cwd: "/tmp/project",
            status: "running",
          },
        ],
      },
    ],
    {
      source: "snapshot",
      activeTurnId: "turn-1",
      activeTurnFooter: "Waiting for approval",
    },
  );

  expect(entries).toEqual([]);
});

test("failed command execution without a final reply emits no transcript entries", () => {
  const entries = collectTranscriptEntries(
    [
      {
        id: "turn-1",
        status: "completed",
        items: [
          {
            type: "commandExecution",
            id: "cmd-1",
            command: "npm test",
            cwd: "/tmp/project",
            status: "failed",
            aggregatedOutput: "stderr line 1\nstderr line 2\nstderr line 3\nstderr line 4\n",
            exitCode: 2,
          },
        ],
      },
    ],
    {
      source: "live",
    },
  );

  expect(entries).toEqual([]);
});

test("preserves only the final reply when earlier process work failed", () => {
  const entries = collectTranscriptEntries(
    [
      {
        id: "turn-1",
        status: "completed",
        items: [
          {
            type: "agentMessage",
            id: "agent-1",
            text: "reading package.json",
            phase: "commentary",
          },
          {
            type: "commandExecution",
            id: "cmd-1",
            command: "npm test",
            cwd: "/tmp/project",
            status: "failed",
            aggregatedOutput: "stderr line 1\nstderr line 2\n",
            exitCode: 1,
          },
          {
            type: "agentMessage",
            id: "agent-2",
            text: "Tests failed.",
            phase: "final",
          },
        ],
      },
    ],
    {
      source: "live",
    },
  );

  expect(entries).toEqual([
    {
      itemId: getAssistantTranscriptEntryId("turn-1"),
      kind: "assistant",
      text: "Tests failed.",
    },
  ]);
  expect(entries[0]).toMatchObject({
    kind: "assistant",
    text: "Tests failed.",
  });
});

test("successful command execution emits no transcript entries", () => {
  const entries = collectTranscriptEntries(
    [
      {
        id: "turn-1",
        status: "completed",
        items: [
          {
            type: "commandExecution",
            id: "cmd-1",
            command: "ls",
            cwd: "/tmp/project",
            status: "completed",
            aggregatedOutput: "README.md\nsrc\n",
            exitCode: 0,
          },
        ],
      },
    ],
    {
      source: "live",
    },
  );

  expect(entries).toEqual([]);
});

test("comparable transcript ids ignore commentary and command items", () => {
  const ids = collectComparableTranscriptItemIds(
    [
      {
        id: "turn-1",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user-1",
            content: [{ type: "text", text: "resume --remote" }],
          },
          {
            type: "agentMessage",
            id: "agent-1",
            text: "reading package.json",
            phase: "commentary",
          },
          {
            type: "commandExecution",
            id: "cmd-1",
            command: "bun test",
            cwd: "/tmp/project",
            status: "failed",
            exitCode: 1,
          },
          {
            type: "agentMessage",
            id: "agent-2",
            text: "Tests failed.",
            phase: "final",
          },
        ],
      },
    ],
    {},
  );

  expect(ids).toEqual([
    getUserTranscriptEntryId("turn-1"),
    getAssistantTranscriptEntryId("turn-1"),
  ]);
});
