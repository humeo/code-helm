import { once } from "node:events";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";
import { buildDiscordRestOptions } from "../discord/rest";

export type DiscordBotIdentity = {
  botUser: {
    id: string;
    username: string;
  };
  application: {
    id: string;
    name: string;
  };
};

export type SelectableGuild = {
  id: string;
  name: string;
};

export type SelectableControlChannel = {
  id: string;
  name: string;
};

type DiscordGuildPayload = {
  id: string;
  name?: string;
  unavailable?: boolean;
};

type DiscordChannelPayload = {
  id: string;
  name?: string | null;
  type: number;
};

type DiscordRestClient = Pick<REST, "get">;

type DiscordBotChannel = {
  id: string;
  name?: string | null;
  type: number;
};

type DiscordBotGuild = {
  id: string;
  name?: string | null;
  unavailable?: boolean;
  channels?: {
    fetch(...args: unknown[]): Promise<unknown>;
  };
};

type DiscordBotClient = {
  guilds: {
    cache: {
      values(): Iterable<DiscordBotGuild>;
      get?(guildId: string): DiscordBotGuild | undefined;
    };
    fetch?(guildId: string): Promise<DiscordBotGuild>;
  };
  login(token: string): Promise<string>;
  destroy(): void | Promise<void>;
  isReady(): boolean;
  once(event: string | symbol, listener: () => void): void;
};

export type DiscordDiscoveryOptions = {
  createBotClient?: () => DiscordBotClient;
  createRestClient?: (token: string) => DiscordRestClient;
};

const defaultCreateRestClient = (token: string): DiscordRestClient => {
  return new REST({
    version: "10",
    ...buildDiscordRestOptions(),
  }).setToken(token);
};

const defaultCreateBotClient = (): DiscordBotClient => {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    rest: buildDiscordRestOptions(),
  }) as unknown as DiscordBotClient;
};

const toBotIdentityError = (error: unknown) => {
  if (error instanceof Error && /unauthori[sz]ed|invalid/i.test(error.message)) {
    return new Error("Invalid bot token");
  }

  return new Error("Invalid bot token");
};

export const validateBotToken = async (
  token: string,
  options: DiscordDiscoveryOptions = {},
): Promise<DiscordBotIdentity> => {
  const rest = (options.createRestClient ?? defaultCreateRestClient)(token);

  try {
    const [botUser, application] = await Promise.all([
      rest.get(Routes.user()) as Promise<{ id: string; username: string }>,
      rest.get(Routes.currentApplication()) as Promise<{ id: string; name: string }>,
    ]);

    return {
      botUser: {
        id: botUser.id,
        username: botUser.username,
      },
      application: {
        id: application.id,
        name: application.name,
      },
    };
  } catch (error) {
    throw toBotIdentityError(error);
  }
};

const withBotClient = async <T>(
  token: string,
  options: DiscordDiscoveryOptions,
  run: (client: DiscordBotClient) => Promise<T>,
) => {
  const client = (options.createBotClient ?? defaultCreateBotClient)();

  try {
    await client.login(token);

    if (!client.isReady()) {
      await once(client as unknown as Parameters<typeof once>[0], Events.ClientReady);
    }

    return await run(client);
  } finally {
    await client.destroy();
  }
};

const toSelectableGuild = (guild: DiscordBotGuild): SelectableGuild | undefined => {
  if (!guild.id || !guild.name || guild.unavailable) {
    return undefined;
  }

  return {
    id: guild.id,
    name: guild.name,
  };
};

const toSelectableControlChannel = (
  channel: DiscordBotChannel,
): SelectableControlChannel | undefined => {
  if (!channel.id || !channel.name || !isSelectableControlChannel(channel)) {
    return undefined;
  }

  return {
    id: channel.id,
    name: channel.name,
  };
};

const toChannelArray = (value: unknown): DiscordBotChannel[] => {
  if (value == null) {
    return [];
  }

  if (
    typeof value === "object"
    && value !== null
    && "values" in value
    && typeof value.values === "function"
  ) {
    return Array.from(value.values() as Iterable<DiscordBotChannel>);
  }

  if (Symbol.iterator in Object(value)) {
    return Array.from(value as Iterable<DiscordBotChannel>);
  }

  return [];
};

export const listSelectableGuilds = async (
  token: string,
  options: DiscordDiscoveryOptions = {},
): Promise<SelectableGuild[]> => {
  return withBotClient(token, options, async (client) => {
    return Array.from(client.guilds.cache.values())
      .map(toSelectableGuild)
      .filter((guild): guild is SelectableGuild => guild !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name));
  });
};

const isSelectableControlChannel = (channel: DiscordChannelPayload) => {
  return channel.type === ChannelType.GuildText
    || channel.type === ChannelType.GuildAnnouncement;
};

export const listSelectableControlChannels = async (
  token: string,
  guildId: string,
  options: DiscordDiscoveryOptions = {},
): Promise<SelectableControlChannel[]> => {
  return withBotClient(token, options, async (client) => {
    const guild = client.guilds.cache.get?.(guildId)
      ?? await client.guilds.fetch?.(guildId);

    if (!guild?.channels) {
      return [];
    }

    const channels = await guild.channels.fetch();
    const values = toChannelArray(channels);

    return values
      .map(toSelectableControlChannel)
      .filter((channel): channel is SelectableControlChannel => channel !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name));
  });
};

export const createDiscordDiscoveryServices = (
  options: DiscordDiscoveryOptions = {},
) => {
  return {
    validateBotToken(token: string) {
      return validateBotToken(token, options);
    },
    listSelectableGuilds(token: string) {
      return listSelectableGuilds(token, options);
    },
    listSelectableControlChannels(token: string, guildId: string) {
      return listSelectableControlChannels(token, guildId, options);
    },
  };
};
