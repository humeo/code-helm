import { expect, test } from "bun:test";
import {
  getAssistantTranscriptEntryId,
  getProcessTranscriptEntryId,
  getUserTranscriptEntryId,
  collectTranscriptEntries,
  type ProcessFooterText,
  renderTranscriptMessages,
  renderTranscriptEntry,
} from "../../src/discord/transcript";
import type { CodexTurn } from "../../src/codex/protocol-types";

test("does not duplicate Discord-originated user messages or surface commentary-only process output", () => {
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

test("renders non-Discord input as a remote input card with explicit reply instructions", () => {
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
  expect(livePayload).not.toHaveProperty("content");
  expect(livePayload).toEqual(
    expect.objectContaining({
      embeds: [
        expect.objectContaining({
          title: "Remote Input",
          description: "```text\nresume --remote\n```",
        }),
      ],
    }),
  );
  expect(snapshotEntries).toEqual([
    {
      itemId: getUserTranscriptEntryId("turn-1"),
      kind: "user",
      source: "codex-cli",
      text: "resume --remote",
    },
  ]);
  const snapshotPayload = renderTranscriptEntry(snapshotEntries[0]);
  expect(snapshotPayload).not.toHaveProperty("content");
  expect(snapshotPayload).toEqual(
    expect.objectContaining({
      embeds: [
        expect.objectContaining({
          title: "Remote Input",
          description: "```text\nresume --remote\n```",
        }),
      ],
    }),
  );
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

test("renders synced remote input and final assistant output as one Discord message", () => {
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
      itemIds: [
        getUserTranscriptEntryId("turn-1"),
        getAssistantTranscriptEntryId("turn-1"),
      ],
      payload: {
        content: "Remote Input:\n```text\nreplay only \"ok9\"\n```\n\nok9",
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

test("builds one Codex process message and one final reply for a completed turn", () => {
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

test("commentary-only turns do not create a process transcript entry", () => {
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

test("active turn process footers stay on the last line", () => {
  const waitingFooter: ProcessFooterText = "Waiting for approval";
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
      activeTurnFooter: waitingFooter,
    },
  );

  expect(entries).toEqual([]);
});

test("failed command execution stays in the process card without a separate error bubble", () => {
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

test("preserves process-before-final order without a separate failed-command bubble", () => {
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

  expect(entries.map((entry) => entry.itemId)).toEqual([
    getAssistantTranscriptEntryId("turn-1"),
  ]);
  expect(entries[0]).toMatchObject({
    kind: "assistant",
    text: "Tests failed.",
  });
});

test("successful command execution contributes only to the process message", () => {
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
