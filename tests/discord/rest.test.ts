import { expect, test } from "bun:test";
import { REST, type RESTOptions } from "discord.js";
import { buildDiscordRestOptions } from "../../src/discord/rest";

test("buildDiscordRestOptions overrides the default REST request strategy", () => {
  const rest = new REST({ version: "10" });
  const options = buildDiscordRestOptions();

  expect(options.makeRequest).not.toBe(rest.options.makeRequest);
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
