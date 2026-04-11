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
  const sessionRepo = createSessionRepo(db);

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
  sessionRepo.insert({
    discordThreadId: "123",
    codexThreadId: "codex-1",
    ownerDiscordUserId: "u1",
    workdirId: "wd1",
    state: "idle",
  });
};

const createMigratedDb = () => {
  const db = createDatabaseClient(":memory:");
  applyMigrations(db);
  return db;
};

test("repo upsert preserves terminal status and resolution metadata on resolved ack", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = createApprovalRepo(db);

  repo.insert({
    requestId: 9,
    discordThreadId: "123",
    status: "approved",
    resolvedByDiscordUserId: "u1",
    resolution: "approved",
  });

  repo.insert({
    requestId: "9",
    discordThreadId: "123",
    status: "resolved",
  });

  expect(repo.getByRequestId(9)).toEqual({
    requestId: "9",
    discordThreadId: "123",
    status: "approved",
    resolvedByDiscordUserId: "u1",
    resolution: "approved",
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });

  db.close();
});

test("repo ignores stale pending replays after a terminal approval", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = createApprovalRepo(db);

  repo.insert({
    requestId: 10,
    discordThreadId: "123",
    status: "approved",
    resolvedByDiscordUserId: "u1",
    resolution: "approved",
  });

  const beforeReplay = repo.getByRequestId(10);

  repo.insert({
    requestId: "10",
    discordThreadId: "123",
    status: "pending",
  });

  expect(repo.getByRequestId(10)).toEqual(beforeReplay);

  db.close();
});

test("repo ignores stale pending replays after a resolved ack", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = createApprovalRepo(db);

  repo.insert({
    requestId: 10,
    discordThreadId: "123",
    status: "resolved",
  });

  const beforeReplay = repo.getByRequestId(10);

  repo.insert({
    requestId: "10",
    discordThreadId: "123",
    status: "pending",
  });

  expect(repo.getByRequestId(10)).toEqual(beforeReplay);

  db.close();
});

test("repo ignores stale terminal overwrites after a terminal approval", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = createApprovalRepo(db);

  repo.insert({
    requestId: 11,
    discordThreadId: "123",
    status: "approved",
    resolvedByDiscordUserId: "u1",
    resolution: "approved",
  });

  const beforeReplay = repo.getByRequestId(11);

  repo.insert({
    requestId: "11",
    discordThreadId: "123",
    status: "declined",
    resolvedByDiscordUserId: "u2",
    resolution: "declined",
  });

  expect(repo.getByRequestId(11)).toEqual(beforeReplay);

  db.close();
});

test("numeric approval request ids round-trip through persistence", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = createApprovalRepo(db);

  repo.insert({
    requestId: 9,
    discordThreadId: "123",
    status: "pending",
  });

  expect(repo.getByRequestId("9")?.requestId).toBe("9");
  expect(repo.getByRequestId(9)?.requestId).toBe("9");

  db.close();
});

test("repo can list pending approvals for a Discord thread newest first", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const sessionRepo = createSessionRepo(db);
  const repo = createApprovalRepo(db);

  sessionRepo.insert({
    discordThreadId: "other-thread",
    codexThreadId: "codex-2",
    ownerDiscordUserId: "u2",
    workdirId: "wd1",
    state: "idle",
  });

  repo.insert({
    requestId: "req-1",
    discordThreadId: "123",
    status: "pending",
  });
  repo.insert({
    requestId: "req-2",
    discordThreadId: "123",
    status: "approved",
  });
  repo.insert({
    requestId: "req-3",
    discordThreadId: "123",
    status: "pending",
  });
  repo.insert({
    requestId: "req-4",
    discordThreadId: "other-thread",
    status: "pending",
  });

  expect(repo.listPendingByDiscordThreadId("123")).toEqual([
    {
      requestId: "req-3",
      discordThreadId: "123",
      status: "pending",
      resolvedByDiscordUserId: null,
      resolution: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
    {
      requestId: "req-1",
      discordThreadId: "123",
      status: "pending",
      resolvedByDiscordUserId: null,
      resolution: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
  ]);
  expect(repo.getLatestByDiscordThreadId("123")).toMatchObject({
    requestId: "req-3",
    status: "pending",
  });

  db.close();
});
