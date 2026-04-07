import { expect, test } from "bun:test";
import {
  collectTranscriptEntries,
  renderTranscriptEntry,
} from "../../src/discord/transcript";
import type { CodexTurn } from "../../src/codex/protocol-types";

test("collectTranscriptEntries flattens renderable turn items in order", () => {
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
          type: "reasoning",
          id: "reason-1",
          summary: [],
          content: [],
        },
        {
          type: "agentMessage",
          id: "agent-1",
          text: "I'm reading the repository structure now.",
          phase: "commentary",
        },
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
  ];

  const entries = collectTranscriptEntries(turns);

  expect(entries.map((entry) => entry.itemId)).toEqual([
    "user-1",
    "agent-1",
    "cmd-1",
  ]);
  expect(entries.map((entry) => entry.kind)).toEqual([
    "user",
    "assistant",
    "command",
  ]);
});

test("renderTranscriptEntry formats user, assistant, and command transcript items", () => {
  expect(
    renderTranscriptEntry({
      itemId: "user-1",
      kind: "user",
      text: "Inspect the repo.",
    }),
  ).toBe("User: Inspect the repo.");

  expect(
    renderTranscriptEntry({
      itemId: "agent-1",
      kind: "assistant",
      text: "I'm reading the repository structure now.",
      phase: "commentary",
    }),
  ).toBe("Codex commentary: I'm reading the repository structure now.");

  expect(
    renderTranscriptEntry({
      itemId: "cmd-1",
      kind: "command",
      text: "README.md\nsrc\n",
      command: "ls",
      cwd: "/tmp/project",
      exitCode: 0,
    }),
  ).toBe(
    "Command completed: `ls` in `/tmp/project` (exit 0).\n```text\nREADME.md\nsrc\n```",
  );
});
