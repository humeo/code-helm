import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createDatabaseClient } from "../../src/db/client";
import { applyMigrations } from "../../src/db/migrate";
import { createApprovalRepo } from "../../src/db/repos/approvals";
import { createSessionRepo, type SessionRepo } from "../../src/db/repos/sessions";
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
    approvalKey: "9",
    requestId: "9",
    codexThreadId: "codex-1",
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
  const sessionRepo = createSessionRepo(db);
  const repo = createApprovalRepo(db);

  sessionRepo.insert({
    discordThreadId: "456",
    codexThreadId: "codex-2",
    ownerDiscordUserId: "u2",
    workdirId: "wd1",
    state: "idle",
  });

  repo.insert({
    approvalKey: "turn-1:item-1",
    requestId: 9,
    codexThreadId: "codex-1",
    discordThreadId: "123",
    status: "pending",
  });
  repo.insert({
    approvalKey: "turn-2:item-1",
    requestId: 9,
    codexThreadId: "codex-2",
    discordThreadId: "456",
    status: "pending",
  });

  expect(repo.getByApprovalKey("turn-1:item-1")?.requestId).toBe("9");
  expect(repo.getByApprovalKey("turn-2:item-1")?.requestId).toBe("9");
  expect(
    repo.getLatestByCodexThreadIdAndRequestId("codex-1", "9")?.approvalKey,
  ).toBe("turn-1:item-1");
  expect(
    repo.getLatestByCodexThreadIdAndRequestId("codex-2", 9)?.approvalKey,
  ).toBe("turn-2:item-1");

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
      approvalKey: "req-3",
      requestId: "req-3",
      codexThreadId: "codex-1",
      discordThreadId: "123",
      status: "pending",
      resolvedByDiscordUserId: null,
      resolution: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
    {
      approvalKey: "req-1",
      requestId: "req-1",
      codexThreadId: "codex-1",
      discordThreadId: "123",
      status: "pending",
      resolvedByDiscordUserId: null,
      resolution: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
  ]);
  expect(repo.getLatestByDiscordThreadId("123")).toMatchObject({
    approvalKey: "req-3",
    requestId: "req-3",
    codexThreadId: "codex-1",
    status: "pending",
  });

  db.close();
});

test("approval rows follow a rebound Discord thread for the managed session", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const sessionRepo = createSessionRepo(db) as SessionRepo & {
    rebindDiscordThread(input: {
      currentDiscordThreadId: string;
      nextDiscordThreadId: string;
    }): void;
  };
  const approvalRepo = createApprovalRepo(db);

  approvalRepo.insert({
    requestId: "req-1",
    discordThreadId: "123",
    status: "pending",
  });

  sessionRepo.rebindDiscordThread({
    currentDiscordThreadId: "123",
    nextDiscordThreadId: "replacement-thread",
  });

  expect(approvalRepo.listPendingByDiscordThreadId("123")).toHaveLength(0);
  expect(approvalRepo.listPendingByDiscordThreadId("replacement-thread")).toEqual([
    {
      approvalKey: "req-1",
      requestId: "req-1",
      codexThreadId: "codex-1",
      discordThreadId: "replacement-thread",
      status: "pending",
      resolvedByDiscordUserId: null,
      resolution: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
  ]);

  db.close();
});

test("migrations rebuild legacy approvals so rebinds cascade to the replacement thread", () => {
  const db = createDatabaseClient(":memory:");

  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE workdirs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      label TEXT NOT NULL,
      absolute_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE sessions (
      discord_thread_id TEXT PRIMARY KEY,
      codex_thread_id TEXT NOT NULL UNIQUE,
      owner_discord_user_id TEXT NOT NULL,
      workdir_id TEXT NOT NULL,
      state TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      degradation_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workdir_id) REFERENCES workdirs(id)
    );

    CREATE TABLE approvals (
      request_id TEXT PRIMARY KEY,
      discord_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      resolved_by_discord_user_id TEXT,
      resolution TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (discord_thread_id) REFERENCES sessions(discord_thread_id)
    );
  `);

  db.exec(`
    INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
    VALUES ('ws1', 'Main Workspace', '/tmp/ws1', '2026-04-09T00:00:00.000Z', '2026-04-09T00:00:00.000Z');

    INSERT INTO workdirs (id, workspace_id, label, absolute_path, created_at, updated_at)
    VALUES ('wd1', 'ws1', 'App', '/tmp/ws1/app', '2026-04-09T00:00:00.000Z', '2026-04-09T00:00:00.000Z');

    INSERT INTO sessions (
      discord_thread_id,
      codex_thread_id,
      owner_discord_user_id,
      workdir_id,
      state,
      lifecycle_state,
      degradation_reason,
      created_at,
      updated_at
    ) VALUES (
      'legacy-thread',
      'legacy-codex',
      'legacy-user',
      'wd1',
      'running',
      'active',
      NULL,
      '2026-04-09T00:00:00.000Z',
      '2026-04-09T00:00:00.000Z'
    );

    INSERT INTO approvals (
      request_id,
      discord_thread_id,
      status,
      resolved_by_discord_user_id,
      resolution,
      created_at,
      updated_at
    ) VALUES (
      'legacy-approval',
      'legacy-thread',
      'pending',
      NULL,
      NULL,
      '2026-04-09T00:00:00.000Z',
      '2026-04-09T00:00:00.000Z'
    );
  `);

  applyMigrations(db);

  const sessionRepo = createSessionRepo(db) as SessionRepo & {
    rebindDiscordThread(input: {
      currentDiscordThreadId: string;
      nextDiscordThreadId: string;
    }): void;
  };
  const approvalRepo = createApprovalRepo(db);

  sessionRepo.rebindDiscordThread({
    currentDiscordThreadId: "legacy-thread",
    nextDiscordThreadId: "replacement-thread",
  });

  expect(approvalRepo.listPendingByDiscordThreadId("legacy-thread")).toHaveLength(0);
  expect(approvalRepo.listPendingByDiscordThreadId("replacement-thread")).toEqual([
    {
      approvalKey: "legacy:legacy-approval",
      requestId: "legacy-approval",
      codexThreadId: "legacy-codex",
      discordThreadId: "replacement-thread",
      status: "pending",
      resolvedByDiscordUserId: null,
      resolution: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
  ]);

  db.close();
});

test("migrations fail fast when legacy approvals contain orphaned session references", () => {
  const db = createDatabaseClient(":memory:");

  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE workdirs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      label TEXT NOT NULL,
      absolute_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE sessions (
      discord_thread_id TEXT PRIMARY KEY,
      codex_thread_id TEXT NOT NULL UNIQUE,
      owner_discord_user_id TEXT NOT NULL,
      workdir_id TEXT NOT NULL,
      state TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      degradation_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workdir_id) REFERENCES workdirs(id)
    );

    CREATE TABLE approvals (
      request_id TEXT PRIMARY KEY,
      discord_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      resolved_by_discord_user_id TEXT,
      resolution TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (discord_thread_id) REFERENCES sessions(discord_thread_id)
    );
  `);

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
    VALUES ('ws1', 'Main Workspace', '/tmp/ws1', '2026-04-09T00:00:00.000Z', '2026-04-09T00:00:00.000Z');

    INSERT INTO workdirs (id, workspace_id, label, absolute_path, created_at, updated_at)
    VALUES ('wd1', 'ws1', 'App', '/tmp/ws1/app', '2026-04-09T00:00:00.000Z', '2026-04-09T00:00:00.000Z');

    INSERT INTO approvals (
      request_id,
      discord_thread_id,
      status,
      resolved_by_discord_user_id,
      resolution,
      created_at,
      updated_at
    ) VALUES (
      'orphan-approval',
      'missing-thread',
      'pending',
      NULL,
      NULL,
      '2026-04-09T00:00:00.000Z',
      '2026-04-09T00:00:00.000Z'
    );
  `);
  db.exec("PRAGMA foreign_keys = ON");

  expect(() => applyMigrations(db)).toThrow(/foreign key/i);

  db.close();
});
