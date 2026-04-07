import {
  DiscordjsErrorCodes,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

export type DiscordCommandResponse = {
  content: string;
  ephemeral?: boolean;
};

export type ListWorkdirsInput = {
  actorId: string;
  guildId: string;
  channelId: string;
};

export type CreateSessionInput = {
  actorId: string;
  guildId: string;
  channelId: string;
  workdirId: string;
};

export type ImportSessionInput = {
  actorId: string;
  guildId: string;
  channelId: string;
  workdirId: string;
  sessionId: string;
};

export type ListSessionsInput = {
  actorId: string;
  guildId: string;
  channelId: string;
};

export type DiscordCommandServices = {
  listWorkdirs(input: ListWorkdirsInput): Promise<DiscordCommandResponse> | DiscordCommandResponse;
  createSession(input: CreateSessionInput): Promise<DiscordCommandResponse> | DiscordCommandResponse;
  importSession(input: ImportSessionInput): Promise<DiscordCommandResponse> | DiscordCommandResponse;
  listSessions(input: ListSessionsInput): Promise<DiscordCommandResponse> | DiscordCommandResponse;
};

const guildOnlyCommand = (name: string, description: string) => {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDMPermission(false);
};

const workdirOptionDescription = "Configured workdir identifier";
const importOptionDescription = "Codex session identifier to import";

export const controlChannelCommands: RESTPostAPIChatInputApplicationCommandsJSONBody[] =
  [
    guildOnlyCommand("workdir-list", "List configured workdirs"),
    guildOnlyCommand("session-new", "Create a new session for a workdir")
      .addStringOption((option) =>
        option
          .setName("workdir")
          .setDescription(workdirOptionDescription)
          .setRequired(true),
      ),
    guildOnlyCommand("session-import", "Import an idle session into Discord")
      .addStringOption((option) =>
        option
          .setName("workdir")
          .setDescription(workdirOptionDescription)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("session")
          .setDescription(importOptionDescription)
          .setRequired(true),
      ),
    guildOnlyCommand("session-list", "List known sessions"),
  ].map((command) => command.toJSON());

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

const toReplyOptions = ({
  content,
  ephemeral,
}: DiscordCommandResponse): InteractionReplyOptions => {
  return ephemeral
    ? { content, flags: MessageFlags.Ephemeral }
    : { content };
};

const safelyReply = async (
  interaction: ChatInputCommandInteraction,
  response: DiscordCommandResponse,
) => {
  const options = toReplyOptions(response);

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(options);
    return;
  }

  await interaction.reply(options);
};

export const handleControlChannelCommand = async (
  interaction: ChatInputCommandInteraction,
  services: DiscordCommandServices,
) => {
  const context = interactionContext(interaction);

  switch (interaction.commandName) {
    case "workdir-list":
      await safelyReply(interaction, await services.listWorkdirs(context));
      return true;
    case "session-new":
      await safelyReply(
        interaction,
        await services.createSession({
          ...context,
          workdirId: interaction.options.getString("workdir", true),
        }),
      );
      return true;
    case "session-import":
      await safelyReply(
        interaction,
        await services.importSession({
          ...context,
          workdirId: interaction.options.getString("workdir", true),
          sessionId: interaction.options.getString("session", true),
        }),
      );
      return true;
    case "session-list":
      await safelyReply(interaction, await services.listSessions(context));
      return true;
    default:
      return false;
  }
};

export const replyWithCommandError = async (
  interaction: ChatInputCommandInteraction,
  message = "Command failed.",
) => {
  const response = { content: message, ephemeral: true } satisfies DiscordCommandResponse;

  try {
    await safelyReply(interaction, response);
  } catch (error) {
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
