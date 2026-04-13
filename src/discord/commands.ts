import {
  DiscordjsErrorCodes,
  MessageFlags,
  SlashCommandBuilder,
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
  codexThreadId: string;
};

export type DiscordCommandServices = {
  listWorkdirs(
    input: ListWorkdirsInput,
  ): Promise<DiscordCommandResult> | DiscordCommandResult;
  createSession(
    input: CreateSessionInput,
  ): Promise<DiscordCommandResult> | DiscordCommandResult;
  importSession(
    input: ImportSessionInput,
  ): Promise<DiscordCommandResult> | DiscordCommandResult;
  listSessions(
    input: ListSessionsInput,
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
};

const guildOnlyCommand = (name: string, description: string) => {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDMPermission(false);
};

const workdirOptionDescription = "Configured workdir identifier";
const importOptionDescription = "Codex session identifier to import";
const resumeOptionDescription = "Managed Codex thread identifier to resume";

type CommandWorkdir = {
  id: string;
  label: string;
};

const addWorkdirOption = (
  command: SlashCommandBuilder,
  workdirs: CommandWorkdir[],
) => {
  return command.addStringOption((option) => {
    option
      .setName("workdir")
      .setDescription(workdirOptionDescription)
      .setRequired(true);

    for (const workdir of workdirs.slice(0, 25)) {
      option.addChoices({
        name: `${workdir.label} (${workdir.id})`,
        value: workdir.id,
      });
    }

    return option;
  });
};

export const buildControlChannelCommands = (
  workdirs: CommandWorkdir[] = [],
): RESTPostAPIChatInputApplicationCommandsJSONBody[] =>
  [
    guildOnlyCommand("workdir-list", "List configured workdirs"),
    addWorkdirOption(
      guildOnlyCommand("session-new", "Create a new session for a workdir"),
      workdirs,
    ),
    addWorkdirOption(
      guildOnlyCommand("session-import", "Import an idle session into Discord"),
      workdirs,
    ).addStringOption((option) =>
      option
        .setName("session")
        .setDescription(importOptionDescription)
        .setRequired(true),
    ),
    guildOnlyCommand("session-list", "List known sessions"),
    guildOnlyCommand("session-close", "Close the current managed session thread"),
    guildOnlyCommand("session-sync", "Sync the current degraded session thread"),
    guildOnlyCommand("session-resume", "Resume a managed session thread")
      .addStringOption((option) =>
        option
          .setName("session")
          .setDescription(resumeOptionDescription)
          .setRequired(true),
      ),
  ].map((command) => command.toJSON());

export const controlChannelCommands = buildControlChannelCommands();

const controlCommandNames = new Set([
  "workdir-list",
  "session-new",
  "session-import",
  "session-list",
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
    case "workdir-list": {
      await safelyDeferReply(interaction);
      await safelyReply(interaction, await services.listWorkdirs(context));
      return true;
    }
    case "session-new": {
      await safelyDeferReply(interaction);
      await safelyReply(
        interaction,
        await services.createSession({
          ...context,
          workdirId: interaction.options.getString("workdir", true),
        }),
      );
      return true;
    }
    case "session-import": {
      await safelyDeferReply(interaction);
      await safelyReply(
        interaction,
        await services.importSession({
          ...context,
          workdirId: interaction.options.getString("workdir", true),
          sessionId: interaction.options.getString("session", true),
        }),
      );
      return true;
    }
    case "session-list":
      await safelyDeferReply(interaction);
      await safelyReply(interaction, await services.listSessions(context));
      return true;
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
          codexThreadId: interaction.options.getString("session", true),
        }),
      );
      return true;
    default:
      return false;
  }
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
