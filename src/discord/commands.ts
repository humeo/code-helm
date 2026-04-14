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
  workdirId: string;
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
  workdirId: string;
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
  workdirId?: string;
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
  autocompleteResumeWorkdirs(
    input: ResumeSessionAutocompleteInput,
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

const workdirOptionDescription = "Configured workdir identifier";
const resumeOptionDescription = "Codex session identifier to attach";

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
    addWorkdirOption(
      guildOnlyCommand("session-new", "Create a new session for a workdir"),
      workdirs,
    ),
    guildOnlyCommand("session-close", "Close the current managed session thread"),
    guildOnlyCommand("session-sync", "Sync the current degraded session thread"),
    guildOnlyCommand("session-resume", "Attach Discord to an existing Codex session")
      .addStringOption((option) =>
        option
          .setName("workdir")
          .setDescription(workdirOptionDescription)
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
          workdirId: interaction.options.getString("workdir", true),
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
          workdirId: interaction.options.getString("workdir", true),
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
  if (interaction.commandName !== "session-resume") {
    await interaction.respond([]);
    return false;
  }

  const { name: focusedOption, value } = interaction.options.getFocused(true);
  const context = autocompleteContext(interaction);
  const query = String(value ?? "");

  let choices: DiscordAutocompleteChoice[] = [];

  switch (focusedOption) {
    case "workdir":
      choices = await services.autocompleteResumeWorkdirs({
        ...context,
        query,
      });
      break;
    case "session":
      choices = await services.autocompleteResumeSessions({
        ...context,
        workdirId: interaction.options.getString("workdir") ?? undefined,
        query,
      });
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
