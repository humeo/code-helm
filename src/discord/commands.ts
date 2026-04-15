import {
  DiscordjsErrorCodes,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

export type DiscordReplyPayload = {
  content: string;
  ephemeral?: boolean;
};

export type DiscordCommandIntent =
  | {
      kind: "open-session-thread";
      sessionId?: string;
      threadName?: string;
    }
  | undefined;

export type DiscordCommandResult = {
  reply: DiscordReplyPayload;
  intent?: DiscordCommandIntent;
};

export type CreateSessionInput = {
  actorId: string;
  guildId: string;
  channelId: string;
  path: string;
};

export type CloseSessionInput = {
  actorId: string;
  guildId: string;
  channelId: string;
};

export type SyncSessionInput = {
  actorId: string;
  guildId: string;
  channelId: string;
};

export type ResumeSessionInput = {
  actorId: string;
  guildId: string;
  channelId: string;
  path: string;
  codexThreadId: string;
};

export type DiscordAutocompleteChoice = {
  name: string;
  value: string;
};

export type ResumeSessionAutocompleteInput = {
  actorId: string;
  guildId: string;
  channelId: string;
  path?: string;
  query: string;
};

export type SessionPathAutocompleteInput = {
  actorId: string;
  guildId: string;
  channelId: string;
  path?: string;
  query: string;
};

export type DiscordCommandServices = {
  createSession(
    input: CreateSessionInput,
  ): Promise<DiscordCommandResult> | DiscordCommandResult;
  closeSession(
    input: CloseSessionInput,
  ): Promise<DiscordCommandResult> | DiscordCommandResult;
  syncSession(
    input: SyncSessionInput,
  ): Promise<DiscordCommandResult> | DiscordCommandResult;
  resumeSession(
    input: ResumeSessionInput,
  ): Promise<DiscordCommandResult> | DiscordCommandResult;
  autocompleteSessionPaths(
    input: SessionPathAutocompleteInput,
  ): Promise<DiscordAutocompleteChoice[]> | DiscordAutocompleteChoice[];
  autocompleteResumeSessions(
    input: ResumeSessionAutocompleteInput,
  ): Promise<DiscordAutocompleteChoice[]> | DiscordAutocompleteChoice[];
};

const guildOnlyCommand = (name: string, description: string) => {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDMPermission(false);
};

const pathOptionDescription = "Path to the workspace directory";
const resumeOptionDescription = "Codex session identifier to attach";

export const buildControlChannelCommands = (): RESTPostAPIChatInputApplicationCommandsJSONBody[] =>
  [
    guildOnlyCommand("session-new", "Create a new session for a path")
      .addStringOption((option) =>
        option
          .setName("path")
          .setDescription(pathOptionDescription)
          .setRequired(true)
          .setAutocomplete(true),
      ),
    guildOnlyCommand("session-close", "Close the current managed session thread"),
    guildOnlyCommand("session-sync", "Sync the current degraded session thread"),
    guildOnlyCommand("session-resume", "Attach Discord to an existing Codex session")
      .addStringOption((option) =>
        option
          .setName("path")
          .setDescription(pathOptionDescription)
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName("session")
          .setDescription(resumeOptionDescription)
          .setRequired(true)
          .setAutocomplete(true),
      ),
  ].map((command) => command.toJSON());

export const controlChannelCommands = buildControlChannelCommands();

const controlCommandNames = new Set([
  "session-new",
  "session-close",
  "session-sync",
  "session-resume",
]);

export const isControlChannelCommandName = (commandName: string) => {
  return controlCommandNames.has(commandName);
};

const interactionContext = (interaction: ChatInputCommandInteraction) => {
  const guildId = interaction.guildId;

  if (!guildId) {
    throw new Error("Control commands require a guild context");
  }

  return {
    actorId: interaction.user.id,
    guildId,
    channelId: interaction.channelId,
  };
};

const autocompleteContext = (interaction: AutocompleteInteraction) => {
  const guildId = interaction.guildId;

  if (!guildId) {
    throw new Error("Control commands require a guild context");
  }

  return {
    actorId: interaction.user.id,
    guildId,
    channelId: interaction.channelId,
  };
};

const toReplyOptions = ({
  content,
  ephemeral,
}: DiscordReplyPayload): InteractionReplyOptions => {
  return ephemeral
    ? { content, flags: MessageFlags.Ephemeral }
    : { content };
};

const safelyReply = async (
  interaction: ChatInputCommandInteraction,
  result: DiscordCommandResult,
) => {
  const options = toReplyOptions(result.reply);

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(options);
    return;
  }

  await interaction.reply(options);
};

const safelyDeferReply = async (interaction: ChatInputCommandInteraction) => {
  if (interaction.replied || interaction.deferred) {
    return;
  }

  await interaction.deferReply();
};

export const handleControlChannelCommand = async (
  interaction: ChatInputCommandInteraction,
  services: DiscordCommandServices,
) => {
  if (!isControlChannelCommandName(interaction.commandName)) {
    return false;
  }

  const context = interactionContext(interaction);

  switch (interaction.commandName) {
    case "session-new": {
      await safelyDeferReply(interaction);
      await safelyReply(
        interaction,
        await services.createSession({
          ...context,
          path: interaction.options.getString("path", true),
        }),
      );
      return true;
    }
    case "session-close":
      await safelyDeferReply(interaction);
      await safelyReply(interaction, await services.closeSession(context));
      return true;
    case "session-sync":
      await safelyDeferReply(interaction);
      await safelyReply(interaction, await services.syncSession(context));
      return true;
    case "session-resume":
      await safelyDeferReply(interaction);
      await safelyReply(
        interaction,
        await services.resumeSession({
          ...context,
          path: interaction.options.getString("path", true),
          codexThreadId: interaction.options.getString("session", true),
        }),
      );
      return true;
    default:
      return false;
  }
};

export const handleControlChannelAutocomplete = async (
  interaction: AutocompleteInteraction,
  services: DiscordCommandServices,
) => {
  const { name: focusedOption, value } = interaction.options.getFocused(true);
  const context = autocompleteContext(interaction);
  const query = String(value ?? "");

  let choices: DiscordAutocompleteChoice[] = [];

  switch (interaction.commandName) {
    case "session-new":
      if (focusedOption !== "path") {
        await interaction.respond([]);
        return false;
      }

      choices = await services.autocompleteSessionPaths({
        ...context,
        path: interaction.options.getString("path") ?? undefined,
        query,
      });
      break;
    case "session-resume":
      switch (focusedOption) {
        case "path":
          choices = await services.autocompleteSessionPaths({
            ...context,
            path: interaction.options.getString("path") ?? undefined,
            query,
          });
          break;
        case "session":
          choices = await services.autocompleteResumeSessions({
            ...context,
            path: interaction.options.getString("path") ?? undefined,
            query,
          });
          break;
        default:
          await interaction.respond([]);
          return false;
      }
      break;
    default:
      await interaction.respond([]);
      return false;
  }

  await interaction.respond(choices.slice(0, 25));
  return true;
};

export const replyWithCommandError = async (
  interaction: ChatInputCommandInteraction,
  message = "Command failed.",
) => {
  const result = {
    reply: { content: message, ephemeral: true },
  } satisfies DiscordCommandResult;

  try {
    await safelyReply(interaction, result);
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === 10062
    ) {
      return;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === DiscordjsErrorCodes.InteractionAlreadyReplied
    ) {
      return;
    }

    throw error;
  }
};
