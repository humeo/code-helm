import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";

describe("parseConfig", () => {
  test("returns parsed config for valid env", () => {
    const env = {
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_APP_ID: "app-id",
      DISCORD_GUILD_ID: "guild-id",
      DISCORD_CONTROL_CHANNEL_ID: "channel-id",
      CODEX_APP_SERVER_URL: "ws://127.0.0.1:4090",
      DATABASE_PATH: "/tmp/code-helm.db",
      WORKSPACE_ID: "workspace-id",
      WORKSPACE_NAME: "Main Workspace",
    };

    const config = parseConfig(env);

    expect(config).toEqual({
      DISCORD_APP_ID: "app-id",
      discord: {
        botToken: "bot-token",
        appId: "app-id",
        guildId: "guild-id",
        controlChannelId: "channel-id",
      },
      codex: {
        appServerUrl: "ws://127.0.0.1:4090",
      },
      databasePath: "/tmp/code-helm.db",
      workspace: {
        id: "workspace-id",
        name: "Main Workspace",
      },
    });

    expect(config.workspace).not.toHaveProperty("rootPath");
    expect(config).not.toHaveProperty("workdirs");
  });

  test("rejects invalid Codex server URLs", () => {
    expect(() =>
      parseConfig({
        DISCORD_BOT_TOKEN: "bot-token",
        DISCORD_APP_ID: "app-id",
        DISCORD_GUILD_ID: "guild-id",
        DISCORD_CONTROL_CHANNEL_ID: "channel-id",
        CODEX_APP_SERVER_URL: "not-a-url",
        DATABASE_PATH: "/tmp/code-helm.db",
        WORKSPACE_ID: "workspace-id",
        WORKSPACE_NAME: "Main Workspace",
      }),
    ).toThrow(/URL|CODEX_APP_SERVER_URL/);
  });

  test("requires Discord, Codex, and database settings", () => {
    expect(() => parseConfig({})).toThrow(/DISCORD_BOT_TOKEN/);
  });

  test("keeps the legacy DISCORD_APP_ID field for the entrypoint", () => {
    const config = parseConfig({
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_APP_ID: "app-id",
      DISCORD_GUILD_ID: "guild-id",
      DISCORD_CONTROL_CHANNEL_ID: "channel-id",
      CODEX_APP_SERVER_URL: "ws://127.0.0.1:4090",
      DATABASE_PATH: "/tmp/code-helm.db",
      WORKSPACE_ID: "workspace-id",
      WORKSPACE_NAME: "Main Workspace",
    });

    expect(config.DISCORD_APP_ID).toBe("app-id");
    expect(config.discord.appId).toBe("app-id");
  });
});
