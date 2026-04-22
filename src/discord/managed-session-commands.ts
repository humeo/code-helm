import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type InteractionReplyOptions, type RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import type { DiscordCommandResult, DiscordReplyPayload } from "./commands";

export type ManagedSessionCommandInput = {
  actorId: string;
  guildId: string;
  channelId: string;
};

export type ManagedSessionModelPickerInput = ManagedSessionCommandInput & {
  interaction: ChatInputCommandInteraction;
};

export type ManagedSessionCommandServices = {
  status(
    input: ManagedSessionCommandInput,
  ): Promise<DiscordCommandResult> | DiscordCommandResult;
  interrupt(
    input: ManagedSessionCommandInput,
  ): Promise<DiscordCommandResult> | DiscordCommandResult;
  openModelPicker(
    input: ManagedSessionModelPickerInput,
  ): Promise<void> | void;
};

const guildOnlyCommand = (name: string, description: string) => {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDMPermission(false);
};

export const buildManagedSessionCommands = (): RESTPostAPIChatInputApplicationCommandsJSONBody[] =>
  [
    guildOnlyCommand("status", "Show the current managed session status"),
    guildOnlyCommand("model", "Select model and reasoning effort for this session"),
    guildOnlyCommand("interrupt", "Interrupt the current managed session turn"),
  ].map((command) => command.toJSON());

export const managedSessionCommands = buildManagedSessionCommands();

const managedSessionCommandNames = new Set([
  "status",
  "model",
  "interrupt",
]);

export const isManagedSessionCommandName = (commandName: string) => {
  return managedSessionCommandNames.has(commandName);
};

const interactionContext = (interaction: ChatInputCommandInteraction) => {
  const guildId = interaction.guildId;

  if (!guildId) {
    throw new Error("Managed session commands require a guild context");
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

export const handleManagedSessionCommand = async (
  interaction: ChatInputCommandInteraction,
  services: ManagedSessionCommandServices,
) => {
  if (!isManagedSessionCommandName(interaction.commandName)) {
    return false;
  }

  const context = interactionContext(interaction);

  switch (interaction.commandName) {
    case "status":
      await safelyDeferReply(interaction);
      await safelyReply(interaction, await services.status(context));
      return true;
    case "interrupt":
      await safelyDeferReply(interaction);
      await safelyReply(interaction, await services.interrupt(context));
      return true;
    case "model":
      await services.openModelPicker({
        interaction,
        ...context,
      });
      return true;
    default:
      return false;
  }
};
