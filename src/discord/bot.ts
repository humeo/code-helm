import {
  Client,
  Events,
  GatewayIntentBits,
  type Awaitable,
  type ChatInputCommandInteraction,
  type ClientOptions,
  type Interaction,
} from "discord.js";
import {
  controlChannelCommands,
  handleControlChannelCommand,
  replyWithCommandError,
  type DiscordCommandServices,
} from "./commands";

export type DiscordBotLogger = {
  info(...args: unknown[]): void;
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
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Discord bot ready as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
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
