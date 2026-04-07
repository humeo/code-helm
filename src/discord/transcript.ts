import type {
  CodexAgentMessageItem,
  CodexCommandExecutionItem,
  CodexTurn,
  CodexTurnItem,
  CodexUserMessageItem,
} from "../codex/protocol-types";

export type TranscriptEntry =
  | {
      itemId: string;
      kind: "user";
      text: string;
    }
  | {
      itemId: string;
      kind: "assistant";
      text: string;
      phase?: string | null;
    }
  | {
      itemId: string;
      kind: "command";
      text: string;
      command: string;
      cwd?: string;
      exitCode?: number | null;
    };

const maxDiscordMessageLength = 1_900;
const maxCommandOutputLength = 1_200;

const truncate = (value: string, maxLength: number) => {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
};

const readUserMessageText = (item: CodexUserMessageItem) => {
  return item.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
};

const toTranscriptEntry = (item: CodexTurnItem): TranscriptEntry | undefined => {
  if (item.type === "userMessage") {
    const text = readUserMessageText(item as CodexUserMessageItem);

    return item.id && text.length > 0
      ? {
          itemId: item.id,
          kind: "user",
          text,
        }
      : undefined;
  }

  if (item.type === "agentMessage") {
    const message = item as CodexAgentMessageItem;
    const text = message.text.trim();

    return message.id && text.length > 0
      ? {
          itemId: message.id,
          kind: "assistant",
          text,
          phase: message.phase,
        }
      : undefined;
  }

  if (item.type === "commandExecution") {
    const command = item as CodexCommandExecutionItem;
    const aggregatedOutput = (command.aggregatedOutput ?? "").trim();

    return command.id
      ? {
          itemId: command.id,
          kind: "command",
          text: aggregatedOutput,
          command: command.command,
          cwd: command.cwd,
          exitCode: command.exitCode,
        }
      : undefined;
  }

  return undefined;
};

export const collectTranscriptEntries = (turns: CodexTurn[] | undefined) => {
  if (!turns) {
    return [] as TranscriptEntry[];
  }

  return turns.flatMap((turn) => {
    return (turn.items ?? [])
      .map((item) => toTranscriptEntry(item))
      .filter((entry): entry is TranscriptEntry => entry !== undefined);
  });
};

export const collectTranscriptItemIds = (turns: CodexTurn[] | undefined) => {
  if (!turns) {
    return [] as string[];
  }

  return turns.flatMap((turn) => {
    return (turn.items ?? [])
      .map((item) => item.id)
      .filter((itemId): itemId is string => typeof itemId === "string" && itemId.length > 0);
  });
};

export const renderTranscriptEntry = (entry: TranscriptEntry) => {
  if (entry.kind === "user") {
    return truncate(`User: ${entry.text}`, maxDiscordMessageLength);
  }

  if (entry.kind === "assistant") {
    const label = entry.phase === "commentary" ? "Codex commentary" : "Codex";

    return truncate(`${label}: ${entry.text}`, maxDiscordMessageLength);
  }

  const location = entry.cwd ? ` in \`${entry.cwd}\`` : "";
  const exitCode =
    typeof entry.exitCode === "number" ? ` (exit ${entry.exitCode})` : "";
  const header = `Command completed: \`${entry.command}\`${location}${exitCode}.`;

  if (entry.text.length === 0) {
    return truncate(header, maxDiscordMessageLength);
  }

  const output = truncate(entry.text.trim(), maxCommandOutputLength);

  return truncate(
    `${header}\n\`\`\`text\n${output}\n\`\`\``,
    maxDiscordMessageLength,
  );
};
