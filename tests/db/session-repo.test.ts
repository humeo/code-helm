import { expect, test } from "bun:test";
import { createSessionRepo } from "../../src/db/repos/sessions";

test("stores Discord thread to Codex session binding", () => {
  const repo = createSessionRepo(":memory:");

  repo.insert({
    discordThreadId: "123",
    codexThreadId: "abc",
    ownerDiscordUserId: "u1",
    workdirId: "wd1",
    state: "idle",
  });

  expect(repo.getByDiscordThreadId("123")?.codexThreadId).toBe("abc");
});
