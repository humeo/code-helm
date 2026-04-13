import { expect, test } from "bun:test";
import { Client, GatewayIntentBits, type RESTOptions } from "discord.js";
import { createDiscordBot } from "../../src/discord/bot";

const createServices = () => ({
  listWorkdirs: () => ({ reply: { content: "workdirs" } }),
  createSession: () => ({ reply: { content: "session created" } }),
  importSession: () => ({ reply: { content: "session imported" } }),
  listSessions: () => ({ reply: { content: "sessions" } }),
  closeSession: () => ({ reply: { content: "session closed" } }),
  syncSession: () => ({ reply: { content: "session synced" } }),
  resumeSession: () => ({ reply: { content: "session resumed" } }),
});

const logger = {
  info() {},
  error() {},
};

test("createDiscordBot overrides discord.js default REST request strategy", () => {
  const defaultClient = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  const bot = createDiscordBot({
    token: "token",
    services: createServices(),
    logger,
  });

  expect(bot.client.options.rest?.makeRequest).not.toBe(
    defaultClient.options.rest?.makeRequest,
  );
});

test("createDiscordBot preserves an explicit REST request strategy override", () => {
  const customMakeRequest: RESTOptions["makeRequest"] = async () => {
    return new Response("{}");
  };

  const bot = createDiscordBot({
    token: "token",
    services: createServices(),
    logger,
    clientOptions: {
      rest: {
        makeRequest: customMakeRequest,
      },
    },
  });

  expect(bot.client.options.rest?.makeRequest).toBe(customMakeRequest);
});
