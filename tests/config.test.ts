import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";

describe("parseConfig", () => {
  test("returns parsed config for valid env", () => {
    const env = {
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_APP_ID: "app-id",
      CODEX_APP_SERVER_URL: "http://127.0.0.1:4090",
      DATABASE_PATH: "/tmp/code-helm.db",
    };

    expect(parseConfig(env)).toEqual(env);
  });

  test("rejects invalid Codex server URLs", () => {
    expect(() =>
      parseConfig({
        DISCORD_BOT_TOKEN: "bot-token",
        DISCORD_APP_ID: "app-id",
        CODEX_APP_SERVER_URL: "not-a-url",
        DATABASE_PATH: "/tmp/code-helm.db",
      }),
    ).toThrow(/CODEX_APP_SERVER_URL/);
  });

  test("requires Discord, Codex, and database settings", () => {
    expect(() => parseConfig({})).toThrow(/DISCORD_BOT_TOKEN/);
  });
});
