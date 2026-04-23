import { expect, test } from "bun:test";
import { DefaultRestOptions, type RESTOptions } from "discord.js";
import { buildDiscordRestOptions } from "../../src/discord/rest";

test("buildDiscordRestOptions preserves the discord.js default REST request strategy", () => {
  const options = buildDiscordRestOptions();

  expect(options.makeRequest).toBe(DefaultRestOptions.makeRequest);
});

test("buildDiscordRestOptions preserves an explicit request strategy override", () => {
  const customMakeRequest: RESTOptions["makeRequest"] = async () => {
    return new Response("{}");
  };

  const options = buildDiscordRestOptions({
    makeRequest: customMakeRequest,
  });

  expect(options.makeRequest).toBe(customMakeRequest);
});
