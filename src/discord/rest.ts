import { DefaultRestOptions, type RESTOptions } from "discord.js";

export const buildDiscordRestOptions = (
  overrides: Partial<RESTOptions> = {},
): Partial<RESTOptions> => {
  return {
    ...overrides,
    makeRequest: overrides.makeRequest ?? DefaultRestOptions.makeRequest,
  };
};
