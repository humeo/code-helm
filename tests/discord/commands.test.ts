import { expect, test } from "bun:test";
import {
  handleControlChannelCommand,
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
    listWorkdirs: [] as Array<Record<string, string>>,
    createSession: [] as Array<Record<string, string>>,
    importSession: [] as Array<Record<string, string>>,
    listSessions: [] as Array<Record<string, string>>,
  };

  const services: DiscordCommandServices = {
    listWorkdirs(input) {
      calls.listWorkdirs.push(input);
      return okResult("workdirs");
    },
    createSession(input) {
      calls.createSession.push(input);
      return okResult("session created");
    },
    importSession(input) {
      calls.importSession.push(input);
      return okResult("session imported");
    },
    listSessions(input) {
      calls.listSessions.push(input);
      return okResult("sessions");
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
    },
    replies,
    followsUps,
  };
};

test("/workdir-list delegates to listWorkdirs", async () => {
  const { calls, services } = createServices();
  const { interaction, replies } = createInteraction({
    commandName: "workdir-list",
  });

  const handled = await handleControlChannelCommand(interaction as never, services);

  expect(handled).toBe(true);
  expect(calls.listWorkdirs).toEqual([
    {
      actorId: "u1",
      guildId: "g1",
      channelId: "c1",
    },
  ]);
  expect(replies).toEqual([{ content: "workdirs" }]);
});

test("/session-new extracts the workdir option correctly", async () => {
  const { calls, services } = createServices();
  const { interaction, replies } = createInteraction({
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
  expect(replies).toEqual([{ content: "session created" }]);
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
    listWorkdirs: [],
    createSession: [],
    importSession: [],
    listSessions: [],
  });
  expect(replies).toEqual([]);
  expect(followsUps).toEqual([]);
});
