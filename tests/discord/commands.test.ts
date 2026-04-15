import { beforeEach, expect, test } from "bun:test";
import * as discordCommands from "../../src/discord/commands";
import {
  buildControlChannelCommands,
  controlChannelCommands,
  handleControlChannelCommand,
  resetAutocompletePathMemoryForTests,
  replyWithCommandError,
  type DiscordCommandResult,
  type DiscordCommandServices,
} from "../../src/discord/commands";

const okResult = (
  content: string,
  overrides: Partial<DiscordCommandResult> = {},
): DiscordCommandResult => ({
  reply: { content },
  ...overrides,
});

const createServices = () => {
  const calls = {
    createSession: [] as Array<Record<string, string>>,
    closeSession: [] as Array<Record<string, string>>,
    syncSession: [] as Array<Record<string, string>>,
    resumeSession: [] as Array<Record<string, string>>,
    autocompleteSessionPaths: [] as Array<Record<string, string>>,
    autocompleteResumeSessions: [] as Array<Record<string, string>>,
  };

  const services: DiscordCommandServices = {
    createSession(input) {
      calls.createSession.push(input);
      return okResult("session created");
    },
    closeSession(input) {
      calls.closeSession.push(input);
      return okResult("session closed");
    },
    syncSession(input) {
      calls.syncSession.push(input);
      return okResult("session synced");
    },
    resumeSession(input) {
      calls.resumeSession.push(input);
      return okResult("session resumed");
    },
    autocompleteSessionPaths(input: Record<string, string>) {
      calls.autocompleteSessionPaths.push(input);
      return [
        { name: `path:${input.query}`, value: "/tmp/workspace/example" },
      ];
    },
    autocompleteResumeSessions(input) {
      calls.autocompleteResumeSessions.push(input);
      return [
        { name: `session:${input.query}`, value: "codex-thread-7" },
      ];
    },
  };

  return { calls, services };
};

const createInteraction = ({
  commandName,
  guildId = "g1",
  options = {},
}: {
  commandName: string;
  guildId?: string | null;
  options?: Record<string, string>;
}) => {
  const replies: unknown[] = [];
  const followsUps: unknown[] = [];
  const defers: unknown[] = [];

  return {
    interaction: {
      commandName,
      guildId,
      channelId: "c1",
      user: { id: "u1" },
      replied: false,
      deferred: false,
      options: {
        getString(name: string, required?: boolean) {
          const value = options[name];

          if (value === undefined && required) {
            throw new Error(`Missing required option: ${name}`);
          }

          return value ?? null;
        },
      },
      async reply(payload: unknown) {
        replies.push(payload);
      },
      async followUp(payload: unknown) {
        followsUps.push(payload);
      },
      async deferReply(payload?: unknown) {
        defers.push(payload ?? null);
        this.deferred = true;
      },
    },
    replies,
    followsUps,
    defers,
  };
};

const createAutocompleteInteraction = ({
  guildId = "g1",
  channelId = "c1",
  focusedOption,
  focusedValue = "",
  options = {},
}: {
  guildId?: string | null;
  channelId?: string;
  focusedOption: string;
  focusedValue?: string;
  options?: Record<string, string>;
}) => {
  const responses: unknown[] = [];

  return {
    interaction: {
      guildId,
      channelId,
      user: { id: "u1" },
      options: {
        getFocused(withName?: boolean) {
          return withName
            ? { name: focusedOption, value: focusedValue }
            : focusedValue;
        },
        getString(name: string, required?: boolean) {
          const value = options[name];

          if (value === undefined && required) {
            throw new Error(`Missing required option: ${name}`);
          }

          return value ?? null;
        },
      },
      async respond(payload: unknown) {
        responses.push(payload);
      },
    },
    responses,
  };
};

const getHandleControlChannelAutocomplete = () => {
  return (discordCommands as Record<string, unknown>)
    .handleControlChannelAutocomplete;
};

beforeEach(() => {
  resetAutocompletePathMemoryForTests();
});

test("/session-new forwards path", async () => {
  const { calls, services } = createServices();
  const { interaction, replies, followsUps, defers } = createInteraction({
    commandName: "session-new",
    options: { path: "/tmp/workspace/api" },
  });

  const handled = await handleControlChannelCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.createSession).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
      path: "/tmp/workspace/api",
    },
  ]);
  expect(defers).toEqual([null]);
  expect(replies).toEqual([]);
  expect(followsUps).toEqual([{ content: "session created" }]);
});

test("command registration removes deprecated command names and uses path options", () => {
  const commandsByName = new Map(
    buildControlChannelCommands().map((command) => [command.name, command]),
  );

  expect(commandsByName.has("workdir-list")).toBe(false);
  expect(commandsByName.has("session-list")).toBe(false);
  expect(commandsByName.has("session-import")).toBe(false);

  expect(commandsByName.get("session-new")?.options).toEqual([
    {
      type: 3,
      name: "path",
      description: "Path to the workspace directory",
      required: true,
      autocomplete: true,
    },
  ]);
});

test("command registration locks /session-resume to path and session autocomplete", () => {
  const commandsByName = new Map(
    controlChannelCommands.map((command) => [command.name, command]),
  );

  expect(commandsByName.has("session-close")).toBe(true);
  expect(commandsByName.get("session-close")?.options ?? []).toEqual([]);
  expect(commandsByName.has("session-sync")).toBe(true);
  expect(commandsByName.get("session-sync")?.options ?? []).toEqual([]);
  expect(commandsByName.get("session-resume")?.options).toEqual([
    {
      type: 3,
      name: "path",
      description: "Path to the workspace directory",
      required: true,
      autocomplete: true,
    },
    {
      type: 3,
      name: "session",
      description: "Codex session identifier to attach",
      required: true,
      autocomplete: true,
    },
  ]);
});

test("command registration enables path autocomplete on both session commands", () => {
  const commandsByName = new Map(
    controlChannelCommands.map((command) => [command.name, command]),
  );

  expect(commandsByName.get("session-new")?.options).toEqual([
    {
      type: 3,
      name: "path",
      description: "Path to the workspace directory",
      required: true,
      autocomplete: true,
    },
  ]);
  expect(commandsByName.get("session-resume")?.options).toEqual([
    {
      type: 3,
      name: "path",
      description: "Path to the workspace directory",
      required: true,
      autocomplete: true,
    },
    {
      type: 3,
      name: "session",
      description: "Codex session identifier to attach",
      required: true,
      autocomplete: true,
    },
  ]);
});

test("/session-new path autocomplete delegates to shared path autocomplete", async () => {
  const { interaction, responses } = createAutocompleteInteraction({
    focusedOption: "path",
    focusedValue: "exa",
    options: { path: "/tmp/workspace/example" },
  });
  const calls = {
    autocompleteSessionPaths: [] as Array<Record<string, string>>,
    autocompleteResumeSessions: [] as Array<Record<string, string>>,
  };
  const services = {
    autocompleteSessionPaths(input: Record<string, string>) {
      calls.autocompleteSessionPaths.push(input);
      return [
        { name: "path:/tmp/workspace/example", value: "/tmp/workspace/example" },
      ];
    },
    autocompleteResumeSessions(input: Record<string, string>) {
      calls.autocompleteResumeSessions.push(input);
      return [
        { name: "codex-thread-7", value: "codex-thread-7" },
      ];
    },
  };

  const handleControlChannelAutocomplete =
    getHandleControlChannelAutocomplete();
  expect(typeof handleControlChannelAutocomplete).toBe("function");
  if (typeof handleControlChannelAutocomplete !== "function") {
    throw new Error("handleControlChannelAutocomplete export is missing");
  }

  await handleControlChannelAutocomplete(
    { ...interaction, commandName: "session-new" } as never,
    services as never,
  );

  expect(calls.autocompleteSessionPaths).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
      path: "/tmp/workspace/example",
      query: "exa",
    },
  ]);
  expect(calls.autocompleteResumeSessions).toEqual([]);
  expect(responses).toEqual([
    [{ name: "path:/tmp/workspace/example", value: "/tmp/workspace/example" }],
  ]);
});

test("/session-resume path autocomplete delegates to shared path autocomplete", async () => {
  const { interaction, responses } = createAutocompleteInteraction({
    focusedOption: "path",
    focusedValue: "exa",
    options: { path: "/tmp/workspace/example" },
  });
  const calls = {
    autocompleteSessionPaths: [] as Array<Record<string, string>>,
    autocompleteResumeSessions: [] as Array<Record<string, string>>,
  };
  const services = {
    autocompleteSessionPaths(input: Record<string, string>) {
      calls.autocompleteSessionPaths.push(input);
      return [
        { name: "path:/tmp/workspace/example", value: "/tmp/workspace/example" },
      ];
    },
    autocompleteResumeSessions(input: Record<string, string>) {
      calls.autocompleteResumeSessions.push(input);
      return [
        { name: "codex-thread-7", value: "codex-thread-7" },
      ];
    },
  };

  const handleControlChannelAutocomplete =
    getHandleControlChannelAutocomplete();
  expect(typeof handleControlChannelAutocomplete).toBe("function");
  if (typeof handleControlChannelAutocomplete !== "function") {
    throw new Error("handleControlChannelAutocomplete export is missing");
  }

  await handleControlChannelAutocomplete(
    { ...interaction, commandName: "session-resume" } as never,
    services as never,
  );

  expect(calls.autocompleteSessionPaths).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
      path: "/tmp/workspace/example",
      query: "exa",
    },
  ]);
  expect(calls.autocompleteResumeSessions).toEqual([]);
  expect(responses).toEqual([
    [{ name: "path:/tmp/workspace/example", value: "/tmp/workspace/example" }],
  ]);
});

test("/session-resume session autocomplete still uses the session service", async () => {
  const { interaction, responses } = createAutocompleteInteraction({
    focusedOption: "session",
    focusedValue: "codex",
    options: { path: "/tmp/workspace/example" },
  });
  const calls = {
    autocompleteSessionPaths: [] as Array<Record<string, string>>,
    autocompleteResumeSessions: [] as Array<Record<string, string>>,
  };
  const services = {
    autocompleteSessionPaths(input: Record<string, string>) {
      calls.autocompleteSessionPaths.push(input);
      return [
        { name: "path:/tmp/workspace/example", value: "/tmp/workspace/example" },
      ];
    },
    autocompleteResumeSessions(input: Record<string, string>) {
      calls.autocompleteResumeSessions.push(input);
      return [
        { name: "codex-thread-7", value: "codex-thread-7" },
      ];
    },
  };

  const handleControlChannelAutocomplete =
    getHandleControlChannelAutocomplete();
  expect(typeof handleControlChannelAutocomplete).toBe("function");
  if (typeof handleControlChannelAutocomplete !== "function") {
    throw new Error("handleControlChannelAutocomplete export is missing");
  }

  await handleControlChannelAutocomplete(
    { ...interaction, commandName: "session-resume" } as never,
    services as never,
  );

  expect(calls.autocompleteResumeSessions).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
      path: "/tmp/workspace/example",
      query: "codex",
    },
  ]);
  expect(calls.autocompleteSessionPaths).toEqual([]);
  expect(responses).toEqual([
    [{ name: "codex-thread-7", value: "codex-thread-7" }],
  ]);
});

test("/session-resume session autocomplete falls back to the recent path when Discord omits it", async () => {
  const pathCalls = [] as Array<Record<string, string>>;
  const sessionCalls = [] as Array<Record<string, string>>;
  const services = {
    autocompleteSessionPaths(input: Record<string, string>) {
      pathCalls.push(input);
      return [
        {
          name: "path:/tmp/workspace/example",
          value: "/tmp/workspace/example",
        },
      ];
    },
    autocompleteResumeSessions(input: Record<string, string>) {
      sessionCalls.push(input);
      return [
        { name: "codex-thread-7", value: "codex-thread-7" },
      ];
    },
  };
  const handleControlChannelAutocomplete =
    getHandleControlChannelAutocomplete();

  expect(typeof handleControlChannelAutocomplete).toBe("function");
  if (typeof handleControlChannelAutocomplete !== "function") {
    throw new Error("handleControlChannelAutocomplete export is missing");
  }

  const { interaction: pathInteraction } = createAutocompleteInteraction({
    focusedOption: "path",
    focusedValue: "/tmp/workspace/example",
    options: {},
  });

  await handleControlChannelAutocomplete(
    { ...pathInteraction, commandName: "session-resume" } as never,
    services as never,
  );

  const { interaction: sessionInteraction, responses } = createAutocompleteInteraction({
    focusedOption: "session",
    focusedValue: "codex",
    options: {},
  });

  await handleControlChannelAutocomplete(
    { ...sessionInteraction, commandName: "session-resume" } as never,
    services as never,
  );

  expect(pathCalls).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
      path: "/tmp/workspace/example",
      query: "/tmp/workspace/example",
    },
  ]);
  expect(sessionCalls).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
      path: "/tmp/workspace/example",
      query: "codex",
    },
  ]);
  expect(responses).toEqual([
    [{ name: "codex-thread-7", value: "codex-thread-7" }],
  ]);
});

test("/session-close defers and delegates using the current thread context", async () => {
  const { calls, services } = createServices();
  const { interaction, replies, followsUps, defers } = createInteraction({
    commandName: "session-close",
  });
  interaction.channelId = "thread-42";

  const handled = await handleControlChannelCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.closeSession).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "thread-42",
    },
  ]);
  expect(defers).toEqual([null]);
  expect(replies).toEqual([]);
  expect(followsUps).toEqual([{ content: "session closed" }]);
});

test("/session-sync defers and delegates using the current thread context", async () => {
  const { calls, services } = createServices();
  const { interaction, replies, followsUps, defers } = createInteraction({
    commandName: "session-sync",
  });
  interaction.channelId = "thread-42";

  const handled = await handleControlChannelCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.syncSession).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "thread-42",
    },
  ]);
  expect(defers).toEqual([null]);
  expect(replies).toEqual([]);
  expect(followsUps).toEqual([{ content: "session synced" }]);
});

test("/session-resume forwards path and codexThreadId", async () => {
  const { calls, services } = createServices();
  const { interaction, replies, followsUps, defers } = createInteraction({
    commandName: "session-resume",
    options: { path: "/tmp/workspace/example", session: "codex-thread-7" },
  });

  const handled = await handleControlChannelCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.resumeSession).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
      path: "/tmp/workspace/example",
      codexThreadId: "codex-thread-7",
    },
  ]);
  expect(defers).toEqual([null]);
  expect(replies).toEqual([]);
  expect(followsUps).toEqual([{ content: "session resumed" }]);
});

test("unknown commands return unhandled without requiring guild context", async () => {
  const { calls, services } = createServices();
  const { interaction, replies, followsUps } = createInteraction({
    commandName: "something-else",
    guildId: null,
  });

  const handled = await handleControlChannelCommand(interaction as never, services);

  expect(handled).toBe(false);
  expect(calls).toEqual({
    createSession: [],
    closeSession: [],
    syncSession: [],
    resumeSession: [],
    autocompleteSessionPaths: [],
    autocompleteResumeSessions: [],
  });
  expect(replies).toEqual([]);
  expect(followsUps).toEqual([]);
});

test("replyWithCommandError swallows expired Discord interactions", async () => {
  const { interaction } = createInteraction({
    commandName: "session-sync",
  });
  let attempts = 0;

  interaction.reply = async () => {
    attempts += 1;
    const error = new Error("Unknown interaction");
    (error as Error & { code: number }).code = 10062;
    throw error;
  };

  await expect(replyWithCommandError(interaction as never)).resolves.toBeUndefined();
  expect(attempts).toBe(1);
});
