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

test("repo upsert preserves existing resolution metadata when omitted", () => {
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
    status: "resolved",
    resolvedByDiscordUserId: "u1",
    resolution: "approved",
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });

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
