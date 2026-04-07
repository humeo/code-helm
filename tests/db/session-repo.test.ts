import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createDatabaseClient } from "../../src/db/client";
import { applyMigrations } from "../../src/db/migrate";
import { createApprovalRepo } from "../../src/db/repos/approvals";
import { createSessionRepo } from "../../src/db/repos/sessions";
import { createWorkdirRepo } from "../../src/db/repos/workdirs";
import { createWorkspaceRepo } from "../../src/db/repos/workspaces";

const seedWorkspaceGraph = (db: Database) => {
  const workspaceRepo = createWorkspaceRepo(db);
  const workdirRepo = createWorkdirRepo(db);

  workspaceRepo.insert({
    id: "ws1",
    name: "Main Workspace",
    rootPath: "/tmp/ws1",
  });
  workdirRepo.insert({
    id: "wd1",
    workspaceId: "ws1",
    label: "App",
    absolutePath: "/tmp/ws1/app",
  });
};

const createMigratedDb = () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  return db;
};

test("repo creation does not apply migrations implicitly", () => {
  const db = createDatabaseClient(":memory:");

  expect(() => createSessionRepo(db)).toThrow(
    /no such table: sessions/,
  );

  db.close();
});

test("stores Discord thread to Codex session binding and supports lookups", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = createSessionRepo(db);

  repo.insert({
    discordThreadId: "123",
    codexThreadId: "abc",
    ownerDiscordUserId: "u1",
    workdirId: "wd1",
    state: "idle",
  });

  expect(repo.getByDiscordThreadId("123")?.codexThreadId).toBe("abc");
  expect(repo.getByCodexThreadId("abc")?.discordThreadId).toBe("123");

  db.close();
});

test("rejects sessions for unknown workdirs", () => {
  const db = createMigratedDb();
  const repo = createSessionRepo(db);

  expect(() =>
    repo.insert({
      discordThreadId: "123",
      codexThreadId: "abc",
      ownerDiscordUserId: "u1",
      workdirId: "missing-workdir",
      state: "idle",
    }),
  ).toThrow(/FOREIGN KEY constraint failed/);

  db.close();
});

test("updates stored session state", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = createSessionRepo(db);

  repo.insert({
    discordThreadId: "123",
    codexThreadId: "abc",
    ownerDiscordUserId: "u1",
    workdirId: "wd1",
    state: "idle",
  });
  repo.updateState("123", "running");

  expect(repo.getByDiscordThreadId("123")?.state).toBe("running");

  db.close();
});

test("marks externally modified sessions as degraded with a reason", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = createSessionRepo(db);

  repo.insert({
    discordThreadId: "123",
    codexThreadId: "abc",
    ownerDiscordUserId: "u1",
    workdirId: "wd1",
    state: "idle",
  });
  repo.markExternallyModified("123", "native_cli_write");

  const session = repo.getByDiscordThreadId("123");

  expect(session?.state).toBe("degraded");
  expect(session?.degradationReason).toBe("native_cli_write");

  db.close();
});

test("exposes only the narrow session repository API", () => {
  const db = createMigratedDb();
  const repo = createSessionRepo(db);

  expect(Object.keys(repo).sort()).toEqual([
    "getByCodexThreadId",
    "getByDiscordThreadId",
    "insert",
    "markExternallyModified",
    "updateState",
  ]);

  db.close();
});

test("keeps non-session repository surfaces narrow", () => {
  const db = createMigratedDb();

  expect(Object.keys(createWorkspaceRepo(db)).sort()).toEqual([
    "getById",
    "insert",
  ]);
  expect(Object.keys(createWorkdirRepo(db)).sort()).toEqual([
    "getById",
    "insert",
  ]);
  expect(Object.keys(createApprovalRepo(db)).sort()).toEqual([
    "getByRequestId",
    "insert",
  ]);

  db.close();
});
