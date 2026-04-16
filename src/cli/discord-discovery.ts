import { REST, Routes, ChannelType } from "discord.js";
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
  name?: string;
  type: number;
};

const createRestClient = (token: string) => {
  return new REST({
    version: "10",
    ...buildDiscordRestOptions(),
  }).setToken(token);
};

const toBotIdentityError = (error: unknown) => {
  if (error instanceof Error && /unauthori[sz]ed|invalid/i.test(error.message)) {
    return new Error("Invalid bot token");
  }

  return new Error("Invalid bot token");
};

export const validateBotToken = async (
  token: string,
): Promise<DiscordBotIdentity> => {
  const rest = createRestClient(token);

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

export const listSelectableGuilds = async (
  token: string,
): Promise<SelectableGuild[]> => {
  const rest = createRestClient(token);
  const guilds = await rest.get(Routes.userGuilds()) as DiscordGuildPayload[];

  return guilds
    .filter((guild) => !guild.unavailable && guild.id && guild.name)
    .map((guild) => ({
      id: guild.id,
      name: guild.name as string,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
};

const isSelectableControlChannel = (channel: DiscordChannelPayload) => {
  return channel.type === ChannelType.GuildText
    || channel.type === ChannelType.GuildAnnouncement;
};

export const listSelectableControlChannels = async (
  token: string,
  guildId: string,
): Promise<SelectableControlChannel[]> => {
  const rest = createRestClient(token);
  const channels = await rest.get(Routes.guildChannels(guildId)) as DiscordChannelPayload[];

  return channels
    .filter((channel) => channel.id && channel.name && isSelectableControlChannel(channel))
    .map((channel) => ({
      id: channel.id,
      name: channel.name as string,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
};
