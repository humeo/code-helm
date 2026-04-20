import type {
  CodexAgentMessageItem,
  CodexCommandExecutionItem,
  CodexTurn,
  CodexUserMessageItem,
} from "../codex/protocol-types";

type TranscriptSource = "live" | "snapshot";

export type DiscordMessageEmbed = {
  title?: string;
  description?: string;
  color?: number;
  footer?: {
    text: string;
  };
};

export type DiscordMessagePayload = {
  content?: string;
  embeds?: DiscordMessageEmbed[];
};

export type RenderedTranscriptMessage = {
  entryItemId: string;
  entryKind: TranscriptEntry["kind"];
  isFirstChunk: boolean;
  itemIds: string[];
  payload: DiscordMessagePayload;
};

export type ProcessFooterText =
  | "Waiting for approval"
  | "Command failed";

export const getProcessTranscriptEntryId = (
  turnId: string,
  processIndex?: number,
) => {
  return processIndex === undefined
    ? `process:${turnId}`
    : `process:${turnId}:${processIndex}`;
};

export const getAssistantTranscriptEntryId = (turnId: string) => {
  return `assistant:${turnId}`;
};

export const getUserTranscriptEntryId = (turnId: string) => {
  return `user:${turnId}`;
};

export type TranscriptEntry =
  | {
      itemId: string;
      kind: "user";
      source: "discord" | "codex-cli";
      text: string;
    }
  | {
      itemId: string;
      kind: "process";
      turnId: string;
      text: string;
      footer?: ProcessFooterText;
    }
  | {
      itemId: string;
      kind: "assistant";
      text: string;
    };

export type CollectTranscriptEntriesOptions = {
  source?: TranscriptSource;
  pendingDiscordInputs?: string[];
  activeTurnId?: string;
  activeTurnFooter?: ProcessFooterText;
};

const maxDiscordMessageLength = 1_900;
const maxDiscordEmbedTitleLength = 256;
const maxDiscordEmbedDescriptionLength = 4_000;
const maxDiscordEmbedFooterTextLength = 256;
const codexProcessEmbedColor = 0x64748b;

const truncate = (value: string, maxLength: number) => {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
};

const splitTextContent = (content: string, maxLength: number) => {
  if (content.length <= maxLength) {
    return [content];
  }

  const chunks: string[] = [];

  for (let start = 0; start < content.length; start += maxLength) {
    chunks.push(content.slice(start, start + maxLength));
  }

  return chunks;
};

const buildTextPayloads = (content: string): DiscordMessagePayload[] => {
  return splitTextContent(content, maxDiscordMessageLength).map((chunk) => ({
    content: chunk,
  }));
};

const buildEmbedPayload = ({
  title,
  description,
  footer,
  color,
}: {
  title?: string;
  description?: string;
  footer?: string;
  color?: number;
}): DiscordMessagePayload => {
  const embed: DiscordMessageEmbed = {
    color,
  };

  if (title) {
    embed.title = truncate(title, maxDiscordEmbedTitleLength);
  }

  if (description) {
    embed.description = truncate(description, maxDiscordEmbedDescriptionLength);
  }

  if (footer) {
    embed.footer = {
      text: truncate(footer, maxDiscordEmbedFooterTextLength),
    };
  }

  return {
    embeds: [embed],
  };
};

export const isDiscordMessagePayloadEmpty = (
  payload: DiscordMessagePayload | undefined,
) => {
  if (!payload) {
    return true;
  }

  if ((payload.content ?? "").trim().length > 0) {
    return false;
  }

  return (payload.embeds ?? []).length === 0;
};

const readUserMessageText = (item: CodexUserMessageItem) => {
  return item.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
};

const readAssistantMessageText = (item: CodexAgentMessageItem) => {
  return item.text.trim();
};

const isCommentaryPhase = (phase: string | null | undefined) => {
  return phase === "commentary";
};

export const normalizeProcessStepText = (value: string) => {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
};

export const appendProcessStep = (steps: string[], step: string) => {
  const normalizedStep = normalizeProcessStepText(step);

  if (normalizedStep.length === 0 || steps.at(-1) === normalizedStep) {
    return steps;
  }

  steps.push(normalizedStep);
  return steps;
};

export const buildCommandProcessStep = (command: string) => {
  return `RUN \`${command}\``;
};

export const collectTurnProcessSteps = (turn: CodexTurn) => {
  const steps: string[] = [];

  for (const item of turn.items ?? []) {
    if (item.type === "agentMessage") {
      const assistant = item as CodexAgentMessageItem;

      if (!isCommentaryPhase(assistant.phase)) {
        continue;
      }

      appendProcessStep(steps, readAssistantMessageText(assistant));
      continue;
    }

    if (item.type === "commandExecution") {
      const command = item as CodexCommandExecutionItem;
      appendProcessStep(steps, buildCommandProcessStep(command.command));
    }
  }

  return steps;
};

const collectTurnEntries = (
  turn: CodexTurn,
  options: CollectTranscriptEntriesOptions,
) => {
  const entries: Array<{
    order: number;
    entry: TranscriptEntry;
  }> = [];
  const pendingDiscordInputs = options.pendingDiscordInputs;
  let finalAssistant:
    | {
        order: number;
        itemId: string;
        text: string;
      }
    | undefined;

  for (const [order, item] of (turn.items ?? []).entries()) {
    if (item.type === "userMessage") {
      const user = item as CodexUserMessageItem;
      const text = readUserMessageText(user);

      if (!user.id || text.length === 0) {
        continue;
      }

      const nextPendingInput = pendingDiscordInputs?.[0];

      if (typeof nextPendingInput === "string" && nextPendingInput === text) {
        pendingDiscordInputs?.shift();
        continue;
      }

      entries.push({
        order,
        entry: {
          itemId: getUserTranscriptEntryId(turn.id),
          kind: "user",
          source: "codex-cli",
          text,
        },
      });
      continue;
    }

    if (item.type === "agentMessage") {
      const assistant = item as CodexAgentMessageItem;
      const text = readAssistantMessageText(assistant);

      if (!assistant.id || text.length === 0) {
        continue;
      }

      if (isCommentaryPhase(assistant.phase)) {
        continue;
      }

      finalAssistant = {
        order,
        itemId: assistant.id,
        text,
      };
      continue;
    }

    if (item.type === "commandExecution") {
      continue;
    }
  }

  if (finalAssistant) {
    entries.push({
      order: finalAssistant.order,
      entry: {
        itemId: getAssistantTranscriptEntryId(turn.id),
        kind: "assistant",
        text: finalAssistant.text,
      },
    });
  }

  return entries.sort((left, right) => left.order - right.order).map((item) => item.entry);
};

export const collectTranscriptEntries = (
  turns: CodexTurn[] | undefined,
  options: CollectTranscriptEntriesOptions = {},
) => {
  if (!turns) {
    return [] as TranscriptEntry[];
  }

  return turns.flatMap((turn) => collectTurnEntries(turn, options));
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

export const collectComparableTranscriptItemIds = (
  turns: CodexTurn[] | undefined,
  options: Pick<CollectTranscriptEntriesOptions, "pendingDiscordInputs"> = {},
) => {
  if (!turns) {
    return [] as string[];
  }

  const pendingDiscordInputs = options.pendingDiscordInputs;
  const comparableIds: string[] = [];

  for (const turn of turns) {
    let hasFinalAssistant = false;

    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const user = item as CodexUserMessageItem;
        const text = readUserMessageText(user);

        if (text.length === 0) {
          continue;
        }

        const nextPendingInput = pendingDiscordInputs?.[0];

        if (typeof nextPendingInput === "string" && nextPendingInput === text) {
          pendingDiscordInputs?.shift();
          continue;
        }

        comparableIds.push(getUserTranscriptEntryId(turn.id));
        continue;
      }

      if (item.type === "agentMessage") {
        const assistant = item as CodexAgentMessageItem;
        const text = readAssistantMessageText(assistant);

        if (text.length === 0) {
          continue;
        }

        if (isCommentaryPhase(assistant.phase)) {
          continue;
        }

        hasFinalAssistant = true;
        continue;
      }

      if (item.type === "commandExecution") {
        continue;
      }
    }

    if (hasFinalAssistant) {
      comparableIds.push(getAssistantTranscriptEntryId(turn.id));
    }

  }

  return comparableIds;
};

const renderTranscriptEntryPayloads = (entry: TranscriptEntry): DiscordMessagePayload[] => {
  if (entry.kind === "user") {
    return buildTextPayloads(entry.text);
  }

  if (entry.kind === "process") {
    return [buildEmbedPayload({
      title: "Codex",
      description: entry.text,
      footer: entry.footer,
      color: codexProcessEmbedColor,
    })];
  }

  if (entry.kind === "assistant") {
    return buildTextPayloads(entry.text);
  }

  const exhaustiveCheck: never = entry;
  return exhaustiveCheck;
};

export const renderTranscriptEntry = (entry: TranscriptEntry) => {
  return renderTranscriptEntryPayloads(entry)[0] ?? {};
};

export const renderTranscriptMessages = (entries: TranscriptEntry[]) => {
  return entries.flatMap((entry) => {
    const payloads = renderTranscriptEntryPayloads(entry);

    return payloads.map((payload, index) => ({
      entryItemId: entry.itemId,
      entryKind: entry.kind,
      isFirstChunk: index === 0,
      itemIds: index === payloads.length - 1 ? [entry.itemId] : [],
      payload,
    }));
  });
};
