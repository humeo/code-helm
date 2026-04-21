import {
  Client,
  DiscordjsErrorCodes,
  Events,
  GatewayIntentBits,
  type Awaitable,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type ClientOptions,
  type Interaction,
} from "discord.js";
import {
  controlChannelCommands,
  handleControlChannelAutocomplete,
  handleControlChannelCommand,
  replyWithCommandError,
  type DiscordCommandServices,
} from "./commands";
import { buildDiscordRestOptions } from "./rest";

export type DiscordBotLogger = {
  info(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export type CreateDiscordBotOptions = {
  token: string;
  services: DiscordCommandServices;
  logger: DiscordBotLogger;
  onUnhandledInteraction?: (
    interaction: ChatInputCommandInteraction,
  ) => Awaitable<void>;
  clientOptions?: Omit<ClientOptions, "intents">;
};

const discordIntents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.MessageContent,
] as const;

const isControlCommandInteraction = (
  interaction: Interaction,
): interaction is ChatInputCommandInteraction => {
  return interaction.isChatInputCommand();
};

const isControlAutocompleteInteraction = (
  interaction: Interaction,
): interaction is AutocompleteInteraction => {
  return interaction.isAutocomplete();
};

const isIgnorableInteractionResponseError = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return error.code === 10062
    || error.code === DiscordjsErrorCodes.InteractionAlreadyReplied;
};

const logAutocompleteInteractionError = (
  logger: DiscordBotLogger,
  interaction: AutocompleteInteraction,
  error: unknown,
) => {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === 10062
  ) {
    const log = logger.warn ?? logger.info;
    log("Discord autocomplete expired before response", {
      channelId: interaction.channelId,
      commandName: interaction.commandName,
      guildId: interaction.guildId,
      userId: interaction.user.id,
    }, error);
    return;
  }

  logger.error("Discord autocomplete failed", error);
};

const safelyRespondToAutocompleteInteraction = async (
  interaction: AutocompleteInteraction,
  choices: Array<{ name: string; value: string }>,
) => {
  try {
    await interaction.respond(choices);
  } catch (error) {
    if (isIgnorableInteractionResponseError(error)) {
      return;
    }

    throw error;
  }
};

export const createDiscordBot = ({
  token,
  services,
  logger,
  onUnhandledInteraction,
  clientOptions,
}: CreateDiscordBotOptions) => {
  const client = new Client({
    ...clientOptions,
    intents: [...discordIntents],
    rest: buildDiscordRestOptions(clientOptions?.rest),
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Discord bot ready as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (isControlAutocompleteInteraction(interaction)) {
      try {
        await handleControlChannelAutocomplete(interaction, services);
      } catch (error) {
        logAutocompleteInteractionError(logger, interaction, error);
        await safelyRespondToAutocompleteInteraction(interaction, []);
      }
      return;
    }

    if (!isControlCommandInteraction(interaction)) {
      return;
    }

    try {
      const handled = await handleControlChannelCommand(interaction, services);

      if (!handled && onUnhandledInteraction) {
        await onUnhandledInteraction(interaction);
      }
    } catch (error) {
      logger.error("Discord interaction failed", error);
      await replyWithCommandError(interaction);
    }
  });

  return {
    client,
    commands: controlChannelCommands,
    intents: [...discordIntents],
    start() {
      return client.login(token);
    },
    async stop() {
      await client.destroy();
    },
  };
};
