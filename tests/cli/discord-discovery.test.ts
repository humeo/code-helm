import { describe, expect, test } from "bun:test";
import { createDiscordDiscoveryServices } from "../../src/cli/discord-discovery";

type FakeGatewayGuild = {
  id: string;
  name: string;
  unavailable?: boolean;
  channels?: {
    fetch(): Promise<Map<string, { id: string; name?: string | null; type: number }>>;
  };
};

const createFakeGatewayClient = (guilds: FakeGatewayGuild[]) => {
  let loginToken: string | undefined;
  let destroyCalls = 0;

  return {
    client: {
      guilds: {
        cache: new Map(guilds.map((guild) => [guild.id, guild])),
      },
      isReady() {
        return true;
      },
      async login(token: string) {
        loginToken = token;
        return token;
      },
      destroy() {
        destroyCalls += 1;
      },
      once() {
        throw new Error("once should not be called when the fake client is already ready");
      },
    },
    getLoginToken() {
      return loginToken;
    },
    getDestroyCalls() {
      return destroyCalls;
    },
  };
};

describe("createDiscordDiscoveryServices", () => {
  test("lists guilds from the bot client cache", async () => {
    const fakeClient = createFakeGatewayClient([
      { id: "guild-2", name: "Zulu Guild" },
      { id: "guild-1", name: "Alpha Guild" },
    ]);
    const discovery = createDiscordDiscoveryServices({
      createBotClient: () => fakeClient.client,
    });

    const guilds = await discovery.listSelectableGuilds("token-1");

    expect(guilds).toEqual([
      { id: "guild-1", name: "Alpha Guild" },
      { id: "guild-2", name: "Zulu Guild" },
    ]);
    expect(fakeClient.getLoginToken()).toBe("token-1");
    expect(fakeClient.getDestroyCalls()).toBe(1);
  });

  test("filters unavailable guilds out of the selectable list", async () => {
    const fakeClient = createFakeGatewayClient([
      { id: "guild-2", name: "Unavailable Guild", unavailable: true },
      { id: "guild-1", name: "Available Guild" },
    ]);
    const discovery = createDiscordDiscoveryServices({
      createBotClient: () => fakeClient.client,
    });

    const guilds = await discovery.listSelectableGuilds("token-1");

    expect(guilds).toEqual([
      { id: "guild-1", name: "Available Guild" },
    ]);
  });

  test("lists selectable control channels from fetched guild channels", async () => {
    const fakeClient = createFakeGatewayClient([
      {
        id: "guild-1",
        name: "Alpha Guild",
        channels: {
          async fetch() {
            return new Map([
              ["channel-2", { id: "channel-2", name: "announcements", type: 5 }],
              ["channel-1", { id: "channel-1", name: "control-room", type: 0 }],
              ["channel-3", { id: "channel-3", name: "voice", type: 2 }],
            ]);
          },
        },
      },
    ]);
    const discovery = createDiscordDiscoveryServices({
      createBotClient: () => fakeClient.client,
    });

    const channels = await discovery.listSelectableControlChannels("token-1", "guild-1");

    expect(channels).toEqual([
      { id: "channel-2", name: "announcements" },
      { id: "channel-1", name: "control-room" },
    ]);
  });
});
