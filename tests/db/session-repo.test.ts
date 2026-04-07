import { expect, test } from "bun:test";
import { createApprovalRepo } from "../../src/db/repos/approvals";
import { createSessionRepo } from "../../src/db/repos/sessions";
import { createWorkdirRepo } from "../../src/db/repos/workdirs";
import { createWorkspaceRepo } from "../../src/db/repos/workspaces";

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

test("exposes only the narrow session repository API", () => {
  const repo = createSessionRepo(":memory:");

  expect(Object.keys(repo).sort()).toEqual([
    "getByCodexThreadId",
    "getByDiscordThreadId",
    "insert",
    "markExternallyModified",
    "updateState",
  ]);
});

test("keeps non-session repository surfaces narrow", () => {
  expect(Object.keys(createWorkspaceRepo(":memory:")).sort()).toEqual([
    "getById",
    "insert",
  ]);

  expect(Object.keys(createWorkdirRepo(":memory:")).sort()).toEqual([
    "getById",
    "insert",
  ]);

  expect(Object.keys(createApprovalRepo(":memory:")).sort()).toEqual([
    "getByRequestId",
    "insert",
  ]);
});
