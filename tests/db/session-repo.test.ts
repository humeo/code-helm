import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createDatabaseClient } from "../../src/db/client";
import { applyMigrations } from "../../src/db/migrate";
import type { SessionRepo } from "../../src/db/repos/sessions";
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

const insertSession = (db: Database, overrides: Record<string, string> = {}) => {
  const repo = createSessionRepo(db);

  repo.insert({
    discordThreadId: "123",
    codexThreadId: "abc",
    ownerDiscordUserId: "u1",
    cwd: "/tmp/ws1/app",
    state: "idle",
    ...overrides,
  });

  return repo;
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
  const repo = insertSession(db);

  expect(repo.getByDiscordThreadId("123")?.codexThreadId).toBe("abc");
  expect(repo.getByCodexThreadId("abc")?.discordThreadId).toBe("123");
  expect(repo.getByDiscordThreadId("123")?.cwd).toBe("/tmp/ws1/app");

  db.close();
});

test("inserts a session row with cwd and no seeded workdir", () => {
  const db = createMigratedDb();
  const repo = createSessionRepo(db);

  repo.insert({
    discordThreadId: "123",
    codexThreadId: "abc",
    ownerDiscordUserId: "u1",
    cwd: "/tmp/ws1/app",
    state: "idle",
  });

  expect(repo.getByDiscordThreadId("123")).toMatchObject({
    discordThreadId: "123",
    codexThreadId: "abc",
    cwd: "/tmp/ws1/app",
  });

  db.close();
});

test("updates stored session state", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = insertSession(db);
  repo.updateState("123", "running");

  expect(repo.getByDiscordThreadId("123")?.state).toBe("running");

  db.close();
});

test("defaults new sessions to an active lifecycle state", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = insertSession(db);

  expect(repo.getByDiscordThreadId("123")).toMatchObject({
    discordThreadId: "123",
    codexThreadId: "abc",
    state: "idle",
    lifecycleState: "active",
    degradationReason: null,
  });

  db.close();
});

test("archives and unarchives sessions without overwriting runtime state", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = insertSession(db, {
    discordThreadId: "archive-me",
    codexThreadId: "codex-archive-me",
    state: "running",
  });

  repo.updateLifecycleState("archive-me", "archived");

  expect(repo.getByDiscordThreadId("archive-me")).toMatchObject({
    discordThreadId: "archive-me",
    state: "running",
    lifecycleState: "archived",
    cwd: "/tmp/ws1/app",
  });

  repo.updateLifecycleState("archive-me", "active");

  expect(repo.getByDiscordThreadId("archive-me")).toMatchObject({
    discordThreadId: "archive-me",
    state: "running",
    lifecycleState: "active",
    cwd: "/tmp/ws1/app",
  });

  db.close();
});

test("marks deleted Discord thread containers without erasing runtime state", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = insertSession(db, {
    discordThreadId: "deleted-thread",
    codexThreadId: "codex-deleted-thread",
    state: "waiting-approval",
  });

  repo.markDeleted("deleted-thread");

  expect(repo.getByDiscordThreadId("deleted-thread")).toMatchObject({
    discordThreadId: "deleted-thread",
    state: "waiting-approval",
    lifecycleState: "deleted",
    cwd: "/tmp/ws1/app",
  });

  db.close();
});

test("lists persisted sessions with runtime, lifecycle, degradation, and cwd semantics intact", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = createSessionRepo(db);

  repo.insert({
    discordThreadId: "active-session",
    codexThreadId: "codex-active",
    ownerDiscordUserId: "u1",
    cwd: "/tmp/ws1/app",
    state: "idle",
  });
  repo.insert({
    discordThreadId: "archived-session",
    codexThreadId: "codex-archived",
    ownerDiscordUserId: "u2",
    cwd: "/tmp/ws1/app",
    state: "running",
  });
  repo.insert({
    discordThreadId: "deleted-session",
    codexThreadId: "codex-deleted",
    ownerDiscordUserId: "u3",
    cwd: "/tmp/ws1/app",
    state: "degraded",
  });
  repo.updateLifecycleState("archived-session", "archived");
  repo.markDeleted("deleted-session");
  repo.markExternallyModified("deleted-session", "native_cli_write");

  expect(repo.listArchived()).toEqual([
    {
      discordThreadId: "archived-session",
      codexThreadId: "codex-archived",
      ownerDiscordUserId: "u2",
      cwd: "/tmp/ws1/app",
      state: "running",
      lifecycleState: "archived",
      degradationReason: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
  ]);
  expect(
    repo.listAll().map((session) => ({
      discordThreadId: session.discordThreadId,
      cwd: session.cwd,
      state: session.state,
      lifecycleState: session.lifecycleState,
      degradationReason: session.degradationReason,
    })),
  ).toEqual([
    {
      discordThreadId: "active-session",
      cwd: "/tmp/ws1/app",
      state: "idle",
      lifecycleState: "active",
      degradationReason: null,
    },
    {
      discordThreadId: "archived-session",
      cwd: "/tmp/ws1/app",
      state: "running",
      lifecycleState: "archived",
      degradationReason: null,
    },
    {
      discordThreadId: "deleted-session",
      cwd: "/tmp/ws1/app",
      state: "degraded",
      lifecycleState: "deleted",
      degradationReason: "native_cli_write",
    },
  ]);

  db.close();
});

test("marks externally modified sessions as degraded with a reason", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = insertSession(db);
  repo.markExternallyModified("123", "native_cli_write");

  const session = repo.getByDiscordThreadId("123");

  expect(session?.state).toBe("degraded");
  expect(session?.lifecycleState).toBe("active");
  expect(session?.degradationReason).toBe("native_cli_write");
  expect(session?.cwd).toBe("/tmp/ws1/app");

  db.close();
});

test("rebinds a managed session to a replacement Discord thread without changing the Codex thread", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = insertSession(db, {
    discordThreadId: "deleted-thread",
    codexThreadId: "codex-thread-1",
  }) as SessionRepo & {
    rebindDiscordThread(input: {
      currentDiscordThreadId: string;
      nextDiscordThreadId: string;
    }): void;
  };

  repo.rebindDiscordThread({
    currentDiscordThreadId: "deleted-thread",
    nextDiscordThreadId: "replacement-thread",
  });

  expect(repo.getByDiscordThreadId("deleted-thread")).toBeNull();
  expect(repo.getByDiscordThreadId("replacement-thread")).toMatchObject({
    discordThreadId: "replacement-thread",
    codexThreadId: "codex-thread-1",
    ownerDiscordUserId: "u1",
    cwd: "/tmp/ws1/app",
    state: "idle",
    lifecycleState: "active",
  });

  db.close();
});

test("sync-state updates can clear a stale degradation reason", () => {
  const db = createMigratedDb();
  seedWorkspaceGraph(db);
  const repo = insertSession(db);

  repo.markExternallyModified("123", "snapshot_mismatch");
  repo.syncState("123", "idle");

  expect(repo.getByDiscordThreadId("123")).toMatchObject({
    discordThreadId: "123",
    state: "idle",
    lifecycleState: "active",
    degradationReason: null,
  });

  db.close();
});

test("upgrades existing databases by adding lifecycle state with an active default", () => {
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
      degradation_reason,
      created_at,
      updated_at
    ) VALUES (
      'legacy-thread',
      'legacy-codex',
      'legacy-user',
      'wd1',
      'running',
      NULL,
      '2026-04-09T00:00:00.000Z',
      '2026-04-09T00:00:00.000Z'
    );
  `);

  applyMigrations(db);

  expect(createSessionRepo(db).getByDiscordThreadId("legacy-thread")).toMatchObject({
    discordThreadId: "legacy-thread",
    state: "running",
    lifecycleState: "active",
  });
  expect(() =>
    db.exec(`
      UPDATE sessions
      SET lifecycle_state = 'invalid'
      WHERE discord_thread_id = 'legacy-thread'
    `),
  ).toThrow(/CHECK constraint failed/);

  db.close();
});

test("upgrades legacy lifecycle values by normalizing invalid states to active", () => {
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
      'bogus',
      NULL,
      '2026-04-09T00:00:00.000Z',
      '2026-04-09T00:00:00.000Z'
    );
  `);

  applyMigrations(db);

  expect(createSessionRepo(db).getByDiscordThreadId("legacy-thread")).toMatchObject({
    discordThreadId: "legacy-thread",
    state: "running",
    lifecycleState: "active",
  });

  db.close();
});

test("rebuilds legacy sessions and backfills cwd from workdirs.absolute_path", () => {
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
  `);

  applyMigrations(db);

  expect(createSessionRepo(db).getByDiscordThreadId("legacy-thread")).toMatchObject({
    discordThreadId: "legacy-thread",
    codexThreadId: "legacy-codex",
    cwd: "/tmp/ws1/app",
    state: "running",
    lifecycleState: "active",
  });

  db.close();
});

test("upgrades the pre-change init schema by backfilling cwd when lifecycle state already exists", () => {
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
      lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'archived', 'deleted')),
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
      'archived',
      NULL,
      '2026-04-09T00:00:00.000Z',
      '2026-04-09T00:00:00.000Z'
    );
  `);

  applyMigrations(db);

  expect(createSessionRepo(db).getByDiscordThreadId("legacy-thread")).toMatchObject({
    discordThreadId: "legacy-thread",
    codexThreadId: "legacy-codex",
    cwd: "/tmp/ws1/app",
    state: "running",
    lifecycleState: "archived",
  });

  db.close();
});

test("fails legacy session rebuild when cwd cannot be backfilled to a non-empty path", () => {
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
    VALUES ('wd1', 'ws1', 'App', '', '2026-04-09T00:00:00.000Z', '2026-04-09T00:00:00.000Z');

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
  `);

  expect(() => applyMigrations(db)).toThrow(/backfill cwd/i);

  db.close();
});

test("session mutation methods fail when the target session row does not exist", () => {
  const db = createMigratedDb();
  const repo = createSessionRepo(db) as ReturnType<typeof createSessionRepo> & {
    rebindDiscordThread(input: {
      currentDiscordThreadId: string;
      nextDiscordThreadId: string;
    }): void;
  };

  expect(() => repo.updateState("missing-thread", "running")).toThrow(
    /session not found/i,
  );
  expect(() => repo.updateLifecycleState("missing-thread", "archived")).toThrow(
    /session not found/i,
  );
  expect(() => repo.markExternallyModified("missing-thread", "native_cli_write")).toThrow(
    /session not found/i,
  );
  expect(() => repo.syncState("missing-thread", "idle")).toThrow(/session not found/i);
  expect(() => repo.markDeleted("missing-thread")).toThrow(/session not found/i);
  expect(() =>
    repo.rebindDiscordThread({
      currentDiscordThreadId: "missing-thread",
      nextDiscordThreadId: "replacement-thread",
    }),
  ).toThrow(/session not found/i);

  db.close();
});

test("exposes only the narrow session repository API", () => {
  const db = createMigratedDb();
  const repo = createSessionRepo(db);

  expect(Object.keys(repo).sort()).toEqual([
    "getByCodexThreadId",
    "getByDiscordThreadId",
    "insert",
    "listAll",
    "listArchived",
    "markDeleted",
    "markExternallyModified",
    "rebindDiscordThread",
    "syncState",
    "updateLifecycleState",
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
    "getByApprovalKey",
    "getByRequestId",
    "getLatestByCodexThreadIdAndRequestId",
    "getLatestByDiscordThreadId",
    "getUniqueByRequestId",
    "insert",
    "listPendingByDiscordThreadId",
  ]);

  db.close();
});
