import { expect, test } from "bun:test";
import {
  getAssistantTranscriptEntryId,
  getProcessTranscriptEntryId,
  collectTranscriptEntries,
  type ProcessFooterText,
  renderTranscriptEntry,
} from "../../src/discord/transcript";
import type { CodexTurn } from "../../src/codex/protocol-types";

test("does not duplicate Discord-originated user messages in the transcript", () => {
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

  expect(entries.map((entry) => entry.itemId)).toEqual([
    getProcessTranscriptEntryId("turn-1"),
  ]);
});

test("renders non-Discord input as a weak remote-input card for live and recovered snapshots", () => {
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
      itemId: "user-1",
      kind: "user",
      source: "codex-cli",
      text: "resume --remote",
    },
  ]);
  expect(renderTranscriptEntry(liveEntries[0])).toEqual(
    expect.objectContaining({
      content: "",
      embeds: [
        expect.objectContaining({
          title: "Remote input",
          description: "> resume --remote",
        }),
      ],
    }),
  );
  expect(snapshotEntries).toEqual([
    {
      itemId: "user-1",
      kind: "user",
      source: "codex-cli",
      text: "resume --remote",
    },
  ]);
  expect(renderTranscriptEntry(snapshotEntries[0])).toEqual(
    expect.objectContaining({
      content: "",
      embeds: [
        expect.objectContaining({
          title: "Remote input",
          description: "> resume --remote",
        }),
      ],
    }),
  );
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
      itemId: "user-2",
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
      itemId: getProcessTranscriptEntryId("turn-1"),
      kind: "process",
      turnId: "turn-1",
      steps: [
        "reading SKILL.md",
        "RUN `bun test`",
      ],
    },
    {
      itemId: getAssistantTranscriptEntryId("turn-1"),
      kind: "assistant",
      text: "OK",
    },
  ]);
  expect(renderTranscriptEntry(entries[0])).toEqual(
    expect.objectContaining({
      content: "",
      embeds: [
        expect.objectContaining({
          title: "Codex",
          description: "reading SKILL.md\nRUN `bun test`",
        }),
      ],
    }),
  );
  expect(renderTranscriptEntry(entries[1])).toEqual({
    content: "OK",
  });
});

test("commentary-only turns preserve process history without fabricating a final reply", () => {
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

  expect(entries).toEqual([
    {
      itemId: getProcessTranscriptEntryId("turn-1"),
      kind: "process",
      turnId: "turn-1",
      steps: ["reading README.md"],
    },
  ]);
  expect(renderTranscriptEntry(entries[0])).toEqual(
    expect.objectContaining({
      content: "",
      embeds: [
        expect.objectContaining({
          title: "Codex",
          description: "reading README.md",
        }),
      ],
    }),
  );
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

  expect(entries).toEqual([
    {
      itemId: getProcessTranscriptEntryId("turn-1"),
      kind: "process",
      turnId: "turn-1",
      steps: [
        "reading README.md",
        "RUN `touch /tmp/README.md`",
      ],
      footer: "Waiting for approval",
    },
  ]);
  expect(renderTranscriptEntry(entries[0])).toEqual(
    expect.objectContaining({
      content: "",
      embeds: [
        expect.objectContaining({
          title: "Codex",
          description: "reading README.md\nRUN `touch /tmp/README.md`",
          footer: {
            text: "Waiting for approval",
          },
        }),
      ],
    }),
  );
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

  expect(entries).toEqual([
    {
      itemId: getProcessTranscriptEntryId("turn-1"),
      kind: "process",
      turnId: "turn-1",
      steps: ["RUN `npm test`"],
      footer: "Command failed",
    },
  ]);
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
    getProcessTranscriptEntryId("turn-1"),
    getAssistantTranscriptEntryId("turn-1"),
  ]);
  expect(entries[0]).toMatchObject({
    kind: "process",
    steps: [
      "reading package.json",
      "RUN `npm test`",
    ],
    footer: "Command failed",
  });
  expect(entries[1]).toMatchObject({
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

  expect(entries).toEqual([
    {
      itemId: getProcessTranscriptEntryId("turn-1"),
      kind: "process",
      turnId: "turn-1",
      steps: ["RUN `ls`"],
    },
  ]);
});
