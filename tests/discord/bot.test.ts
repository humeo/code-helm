import { expect, test } from "bun:test";
import { Client, Events, GatewayIntentBits, type RESTOptions } from "discord.js";
import { createDiscordBot } from "../../src/discord/bot";

const createServices = () => {
  const calls = {
    autocomplete: [] as unknown[],
  };

  return {
    calls,
    services: {
      listWorkdirs: () => ({ reply: { content: "workdirs" } }),
      createSession: () => ({ reply: { content: "session created" } }),
      importSession: () => ({ reply: { content: "session imported" } }),
      listSessions: () => ({ reply: { content: "sessions" } }),
      closeSession: () => ({ reply: { content: "session closed" } }),
      syncSession: () => ({ reply: { content: "session synced" } }),
      resumeSession: () => ({ reply: { content: "session resumed" } }),
      autocomplete(interaction: unknown) {
        calls.autocomplete.push(interaction);
      },
    },
  };
};

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
    services: createServices().services,
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
    services: createServices().services,
    logger,
    clientOptions: {
      rest: {
        makeRequest: customMakeRequest,
      },
    },
  });

  expect(bot.client.options.rest?.makeRequest).toBe(customMakeRequest);
});

test("createDiscordBot routes autocomplete interactions to the autocomplete handler", async () => {
  const { calls, services } = createServices();
  const bot = createDiscordBot({
    token: "token",
    services,
    logger,
  });

  const interaction = {
    isChatInputCommand() {
      return false;
    },
    isAutocomplete() {
      return true;
    },
  };

  bot.client.emit(Events.InteractionCreate, interaction as never);
  await Promise.resolve();

  expect(calls.autocomplete).toEqual([interaction]);
});
