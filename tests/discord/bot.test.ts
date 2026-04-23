import { expect, test } from "bun:test";
import { DefaultRestOptions, Events, type RESTOptions } from "discord.js";
import { createDiscordBot } from "../../src/discord/bot";

const createServices = () => {
  return {
    services: {
      setCurrentWorkdir() {
        return { reply: { content: "workdir set" } };
      },
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

test("createDiscordBot preserves the discord.js default REST request strategy", () => {
  const bot = createDiscordBot({
    token: "token",
    services: createServices().services,
    logger,
  });

  expect(bot.client.options.rest?.makeRequest).toBe(DefaultRestOptions.makeRequest);
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

test("createDiscordBot downgrades expired primary autocomplete responses", async () => {
  const { services } = createServices();
  const loggedErrors: unknown[][] = [];
  const loggedWarnings: unknown[][] = [];
  const bot = createDiscordBot({
    token: "token",
    services,
    logger: {
      info() {},
      warn(...args: unknown[]) {
        loggedWarnings.push(args);
      },
      error(...args: unknown[]) {
        loggedErrors.push(args);
      },
    },
  });

  let respondCalls = 0;
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
      respondCalls += 1;

      if (respondCalls === 2) {
        resolveFallbackAttempted?.();
      }

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

  expect(loggedErrors).toHaveLength(0);
  expect(loggedWarnings).toHaveLength(1);
  expect(loggedWarnings[0]?.[0]).toBe("Discord autocomplete expired before response");
});

test("createDiscordBot forwards unhandled chat commands to the optional fallback handler", async () => {
  const { services } = createServices();
  const seenCommands: string[] = [];
  const bot = createDiscordBot({
    token: "token",
    services,
    logger,
    onUnhandledInteraction(interaction) {
      seenCommands.push(interaction.commandName);
    },
  });

  let resolveHandled: (() => void) | undefined;
  const handled = new Promise<void>((resolve) => {
    resolveHandled = resolve;
  });
  const interaction = {
    commandName: "status",
    isChatInputCommand() {
      return true;
    },
    isAutocomplete() {
      return false;
    },
    guildId: "g1",
    channelId: "thread-1",
    user: { id: "u1" },
    options: {
      getString() {
        return null;
      },
    },
    async reply() {
      throw new Error("reply should not be called by the fallback routing test");
    },
    async followUp() {
      throw new Error("followUp should not be called by the fallback routing test");
    },
    async deferReply() {
      throw new Error("deferReply should not be called by the fallback routing test");
    },
  };

  bot.client.emit(Events.InteractionCreate, interaction as never);
  resolveHandled?.();
  await handled;

  expect(seenCommands).toEqual(["status"]);
});
