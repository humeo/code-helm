import { expect, test } from "bun:test";
import { Client, Events, GatewayIntentBits, type RESTOptions } from "discord.js";
import { createDiscordBot } from "../../src/discord/bot";

const createServices = () => {
  return {
    services: {
      createSession: () => ({ reply: { content: "session created" } }),
      closeSession: () => ({ reply: { content: "session closed" } }),
      syncSession: () => ({ reply: { content: "session synced" } }),
      resumeSession: () => ({ reply: { content: "session resumed" } }),
      autocompleteSessionPaths() {
        return [{ name: "/tmp/workspace/example", value: "/tmp/workspace/example" }];
      },
      autocompleteResumeSessions() {
        return [{ name: "codex-thread-7", value: "codex-thread-7" }];
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
  const { services } = createServices();
  const bot = createDiscordBot({
    token: "token",
    services,
    logger,
  });

  const responses: unknown[] = [];
  let resolveResponded: (() => void) | undefined;
  const responded = new Promise<void>((resolve) => {
    resolveResponded = resolve;
  });
  const interaction = {
    commandName: "session-resume",
    isChatInputCommand() {
      return false;
    },
    isAutocomplete() {
      return true;
    },
    guildId: "g1",
    channelId: "c1",
    user: { id: "u1" },
    options: {
      getFocused(withName?: boolean) {
        return withName
          ? { name: "session", value: "exa" }
          : "exa";
      },
      getString(name: string) {
        return name === "path" ? "/tmp/workspace/example" : null;
      },
    },
    async respond(payload: unknown) {
      responses.push(payload);
      resolveResponded?.();
    },
  };

  bot.client.emit(Events.InteractionCreate, interaction as never);
  await Promise.race([
    responded,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Autocomplete response was not observed"));
      }, 100);
    }),
  ]);

  expect(responses).toEqual([
    [{ name: "codex-thread-7", value: "codex-thread-7" }],
  ]);
});

test("createDiscordBot swallows expired autocomplete fallback responses", async () => {
  const { services } = createServices();
  services.autocompleteResumeSessions = () => {
    throw new Error("Autocomplete exploded");
  };

  const loggedErrors: unknown[][] = [];
  const bot = createDiscordBot({
    token: "token",
    services,
    logger: {
      info() {},
      error(...args: unknown[]) {
        loggedErrors.push(args);
      },
    },
  });

  let resolveFallbackAttempted: (() => void) | undefined;
  const fallbackAttempted = new Promise<void>((resolve) => {
    resolveFallbackAttempted = resolve;
  });
  const interaction = {
    commandName: "session-resume",
    isChatInputCommand() {
      return false;
    },
    isAutocomplete() {
      return true;
    },
    guildId: "g1",
    channelId: "c1",
    user: { id: "u1" },
    options: {
      getFocused(withName?: boolean) {
        return withName
          ? { name: "session", value: "exa" }
          : "exa";
      },
      getString(name: string) {
        return name === "path" ? "/tmp/workspace/example" : null;
      },
    },
    async respond() {
      resolveFallbackAttempted?.();
      const error = new Error("Unknown interaction") as Error & { code: number };
      error.code = 10062;
      throw error;
    },
  };

  bot.client.emit(Events.InteractionCreate, interaction as never);
  await Promise.race([
    fallbackAttempted,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Autocomplete fallback response was not attempted"));
      }, 100);
    }),
  ]);
  await Bun.sleep(0);

  expect(loggedErrors).toHaveLength(1);
  expect(loggedErrors[0]?.[0]).toBe("Discord autocomplete failed");
});
