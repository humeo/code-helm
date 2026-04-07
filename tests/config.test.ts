import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";

describe("parseConfig", () => {
  test("requires Discord, Codex, and database settings", () => {
    expect(() => parseConfig({})).toThrow(/DISCORD_BOT_TOKEN/);
  });
});
