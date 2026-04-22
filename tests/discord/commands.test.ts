import { expect, test } from "bun:test";
import * as discordCommands from "../../src/discord/commands";
import {
  buildControlChannelCommands,
  controlChannelCommands,
  handleControlChannelCommand,
  replyWithCommandError,
  type DiscordCommandResult,
  type DiscordCommandServices,
} from "../../src/discord/commands";
import {
  buildManagedSessionCommands,
  handleManagedSessionCommand,
  managedSessionCommands,
  type ManagedSessionCommandServices,
} from "../../src/discord/managed-session-commands";

const okResult = (
  content: string,
  overrides: Partial<DiscordCommandResult> = {},
): DiscordCommandResult => ({
  reply: { content },
  ...overrides,
});

const pickCommandOptionShape = (
  option: Record<string, unknown>,
): Record<string, unknown> => {
  const { type, name, description, required, autocomplete } = option;

  return {
    type,
    name,
    description,
    required,
    autocomplete,
  };
};

const createServices = () => {
  const calls = {
    setCurrentWorkdir: [] as Array<Record<string, string>>,
    createSession: [] as Array<Record<string, string>>,
    closeSession: [] as Array<Record<string, string>>,
    syncSession: [] as Array<Record<string, string>>,
    resumeSession: [] as Array<Record<string, string>>,
    autocompleteSessionPaths: [] as Array<Record<string, string>>,
    autocompleteResumeSessions: [] as Array<Record<string, string>>,
  };

  const services: DiscordCommandServices = {
    setCurrentWorkdir(input) {
      calls.setCurrentWorkdir.push(input);
      return okResult("workdir set");
    },
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

const createManagedServices = () => {
  const calls = {
    status: [] as Array<Record<string, string>>,
    interrupt: [] as Array<Record<string, string>>,
    openModelPicker: [] as Array<Record<string, string>>,
  };

  const services: ManagedSessionCommandServices = {
    status(input) {
      calls.status.push(input);
      return okResult("status shown");
    },
    interrupt(input) {
      calls.interrupt.push(input);
      return okResult("session interrupted");
    },
    async openModelPicker({ interaction, ...input }) {
      void interaction;
      calls.openModelPicker.push(input);
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

test("/workdir forwards path to setCurrentWorkdir", async () => {
  const { calls, services } = createServices();
  const { interaction, replies, followsUps, defers } = createInteraction({
    commandName: "workdir",
    options: { path: "/tmp/workspace/api" },
  });

  const handled = await handleControlChannelCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.setCurrentWorkdir).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
      path: "/tmp/workspace/api",
    },
  ]);
  expect(defers).toEqual([null]);
  expect(replies).toEqual([]);
  expect(followsUps).toEqual([{ content: "workdir set" }]);
});

test("/workdir exists with one required path autocomplete option", () => {
  const commandsByName = new Map(
    buildControlChannelCommands().map((command) => [command.name, command]),
  );

  expect(
    (commandsByName.get("workdir")?.options ?? []).map((option) =>
      pickCommandOptionShape(option as Record<string, unknown>),
    ),
  ).toEqual([
    {
      type: 3,
      name: "path",
      description: "Path to the workspace directory",
      required: true,
      autocomplete: true,
    },
  ]);
});

test("/session-new has no options and deprecated command names are gone", () => {
  const commandsByName = new Map(
    controlChannelCommands.map((command) => [command.name, command]),
  );

  expect(commandsByName.has("workdir-list")).toBe(false);
  expect(commandsByName.has("session-list")).toBe(false);
  expect(commandsByName.get("session-new")?.options ?? []).toEqual([]);
});

test("/session-resume only has the required session autocomplete option", () => {
  const commandsByName = new Map(
    controlChannelCommands.map((command) => [command.name, command]),
  );

  expect(commandsByName.has("session-close")).toBe(true);
  expect(commandsByName.get("session-close")?.options ?? []).toEqual([]);
  expect(commandsByName.has("session-sync")).toBe(true);
  expect(commandsByName.get("session-sync")?.options ?? []).toEqual([]);
  expect(
    (commandsByName.get("session-resume")?.options ?? []).map((option) =>
      pickCommandOptionShape(option as Record<string, unknown>),
    ),
  ).toEqual([
    {
      type: 3,
      name: "session",
      description: "Codex session identifier to attach",
      required: true,
      autocomplete: true,
    },
  ]);
});

test("managed session commands register status, model, and interrupt without options", () => {
  const commandsByName = new Map(
    buildManagedSessionCommands().map((command) => [command.name, command]),
  );

  expect(managedSessionCommands).toHaveLength(3);
  expect(commandsByName.get("status")?.options ?? []).toEqual([]);
  expect(commandsByName.get("model")?.options ?? []).toEqual([]);
  expect(commandsByName.get("interrupt")?.options ?? []).toEqual([]);
});

test("/session-new forwards only actor/guild/channel context", async () => {
  const { calls, services } = createServices();
  const { interaction, replies, followsUps, defers } = createInteraction({
    commandName: "session-new",
  });

  const handled = await handleControlChannelCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.createSession).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
    },
  ]);
  expect(defers).toEqual([null]);
  expect(replies).toEqual([]);
  expect(followsUps).toEqual([{ content: "session created" }]);
});

test("/status forwards actor, guild, and thread context", async () => {
  const { calls, services } = createManagedServices();
  const { interaction, followsUps, defers } = createInteraction({
    commandName: "status",
  });

  const handled = await handleManagedSessionCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.status).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
    },
  ]);
  expect(defers).toEqual([null]);
  expect(followsUps).toEqual([{ content: "status shown" }]);
});

test("/interrupt forwards actor, guild, and thread context", async () => {
  const { calls, services } = createManagedServices();
  const { interaction, followsUps, defers } = createInteraction({
    commandName: "interrupt",
  });

  const handled = await handleManagedSessionCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.interrupt).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
    },
  ]);
  expect(defers).toEqual([null]);
  expect(followsUps).toEqual([{ content: "session interrupted" }]);
});

test("/model delegates to the model picker flow", async () => {
  const { calls, services } = createManagedServices();
  const { interaction, defers, followsUps, replies } = createInteraction({
    commandName: "model",
  });

  const handled = await handleManagedSessionCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.openModelPicker).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
    },
  ]);
  expect(defers).toEqual([]);
  expect(followsUps).toEqual([]);
  expect(replies).toEqual([]);
});

test("/workdir focused path routes to autocompleteSessionPaths", async () => {
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
    { ...interaction, commandName: "workdir" } as never,
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

test("/session-resume focused session routes to autocompleteResumeSessions", async () => {
  const { interaction, responses } = createAutocompleteInteraction({
    focusedOption: "session",
    focusedValue: "codex",
    options: {},
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
      query: "codex",
    },
  ]);
  expect(calls.autocompleteSessionPaths).toEqual([]);
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

test("/session-resume forwards only context plus codexThreadId", async () => {
  const { calls, services } = createServices();
  const { interaction, replies, followsUps, defers } = createInteraction({
    commandName: "session-resume",
    options: { session: "codex-thread-7" },
  });

  const handled = await handleControlChannelCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.resumeSession).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
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
    setCurrentWorkdir: [],
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
