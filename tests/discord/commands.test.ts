import { expect, test } from "bun:test";
import {
  buildControlChannelCommands,
  controlChannelCommands,
  handleControlChannelCommand,
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
  };

  const services: DiscordCommandServices = {
    listWorkdirs() {
      return okResult("workdirs");
    },
    createSession(input) {
      calls.createSession.push(input);
      return okResult("session created");
    },
    importSession() {
      return okResult("session imported");
    },
    listSessions() {
      return okResult("sessions");
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

test("/session-new delegates with the configured workdir", async () => {
  const { calls, services } = createServices();
  const { interaction, replies, followsUps, defers } = createInteraction({
    commandName: "session-new",
    options: { workdir: "wd-42" },
  });

  const handled = await handleControlChannelCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.createSession).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
      workdirId: "wd-42",
    },
  ]);
  expect(defers).toEqual([null]);
  expect(replies).toEqual([]);
  expect(followsUps).toEqual([{ content: "session created" }]);
});

test("command registration removes deprecated command names and keeps session-new workdir choices", () => {
  const commandsByName = new Map(
    buildControlChannelCommands([
      {
        id: "example",
        label: "Code Agent Helm Example",
      },
      {
        id: "web",
        label: "Web App",
      },
    ]).map((command) => [command.name, command]),
  );

  expect(commandsByName.has("workdir-list")).toBe(false);
  expect(commandsByName.has("session-list")).toBe(false);
  expect(commandsByName.has("session-import")).toBe(false);

  expect(commandsByName.get("session-new")?.options).toEqual([
    {
      type: 3,
      name: "workdir",
      description: "Configured workdir identifier",
      required: true,
      choices: [
        {
          name: "Code Agent Helm Example (example)",
          value: "example",
        },
        {
          name: "Web App (web)",
          value: "web",
        },
      ],
    },
  ]);
});

test("command registration locks /session-resume to workdir and session autocomplete", () => {
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
      name: "workdir",
      description: "Configured workdir identifier",
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

test("/session-resume extracts workdir and session, defers, and delegates", async () => {
  const { calls, services } = createServices();
  const { interaction, replies, followsUps, defers } = createInteraction({
    commandName: "session-resume",
    options: { workdir: "example", session: "codex-thread-7" },
  });

  const handled = await handleControlChannelCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.resumeSession).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
      workdirId: "example",
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
