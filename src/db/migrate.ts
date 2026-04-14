import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { parseConfig } from "../config";
import { createDatabaseClient } from "./client";

const initMigration = readFileSync(
  new URL("./migrations/001_init.sql", import.meta.url),
  "utf8",
);

type TableInfoRow = {
  name: string;
};

type SqliteMasterRow = {
  sql: string;
};

type ForeignKeyCheckRow = {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
};

const lifecycleConstraintSql =
  "CHECK (lifecycle_state IN ('active', 'archived', 'deleted'))";

const hasColumn = (db: Database, tableName: string, columnName: string) => {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as TableInfoRow[];

  return columns.some((column) => column.name === columnName);
};

const sessionsTableHasLifecycleConstraint = (db: Database) => {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
  ).get() as SqliteMasterRow | null;

  return row?.sql.includes(lifecycleConstraintSql) ?? false;
};

const approvalsTableHasCascadeUpdate = (db: Database) => {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'approvals'",
  ).get() as SqliteMasterRow | null;

  return row?.sql.includes("ON UPDATE CASCADE") ?? false;
};

const approvalsTableHasStableIdentityColumns = (db: Database) => {
  return hasColumn(db, "approvals", "approval_key")
    && hasColumn(db, "approvals", "codex_thread_id");
};

const assertNoForeignKeyViolations = (db: Database, tableName: string) => {
  const violations = db
    .prepare(`PRAGMA foreign_key_check(${tableName})`)
    .all() as ForeignKeyCheckRow[];

  if (violations.length > 0) {
    throw new Error(`${tableName} rebuild produced foreign key violations`);
  }
};

const rebuildSessionsTableWithLifecycleConstraint = (
  db: Database,
  hasLifecycleStateColumn: boolean,
) => {
  const lifecycleStateSelect = hasLifecycleStateColumn
    ? `CASE
        WHEN lifecycle_state IN ('active', 'archived', 'deleted') THEN lifecycle_state
        ELSE 'active'
      END`
    : "'active'";

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE sessions_next (
        discord_thread_id TEXT PRIMARY KEY,
        codex_thread_id TEXT NOT NULL UNIQUE,
        owner_discord_user_id TEXT NOT NULL,
        workdir_id TEXT NOT NULL,
        state TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL DEFAULT 'active' ${lifecycleConstraintSql},
        degradation_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workdir_id) REFERENCES workdirs(id)
      )
    `);
    db.exec(`
      INSERT INTO sessions_next (
        discord_thread_id,
        codex_thread_id,
        owner_discord_user_id,
        workdir_id,
        state,
        lifecycle_state,
        degradation_reason,
        created_at,
        updated_at
      )
      SELECT
        discord_thread_id,
        codex_thread_id,
        owner_discord_user_id,
        workdir_id,
        state,
        ${lifecycleStateSelect},
        degradation_reason,
        created_at,
        updated_at
      FROM sessions
    `);
    db.exec("DROP TABLE sessions");
    db.exec("ALTER TABLE sessions_next RENAME TO sessions");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
};

const upgradeSessionsLifecycleState = (db: Database) => {
  const hasLifecycleStateColumn = hasColumn(db, "sessions", "lifecycle_state");

  if (!hasLifecycleStateColumn || !sessionsTableHasLifecycleConstraint(db)) {
    rebuildSessionsTableWithLifecycleConstraint(db, hasLifecycleStateColumn);
  }

  db.exec(`
    UPDATE sessions
    SET lifecycle_state = 'active'
    WHERE lifecycle_state IS NULL
  `);
};

const assertLegacyApprovalsSessionRefsExist = (db: Database) => {
  const orphan = db.prepare(
    `SELECT approvals.rowid
      FROM approvals
      LEFT JOIN sessions
        ON approvals.discord_thread_id = sessions.discord_thread_id
      WHERE sessions.discord_thread_id IS NULL
      LIMIT 1`,
  ).get();

  if (orphan) {
    throw new Error("approvals rebuild produced foreign key violations");
  }
};

const rebuildApprovalsTableWithStableIdentity = (db: Database) => {
  const hasApprovalKeyColumn = hasColumn(db, "approvals", "approval_key");
  const hasCodexThreadIdColumn = hasColumn(db, "approvals", "codex_thread_id");
  const approvalKeySelect = hasApprovalKeyColumn
    ? "approval_key"
    : "printf('legacy:%s', approvals.request_id)";
  const codexThreadIdSelect = hasCodexThreadIdColumn
    ? "approvals.codex_thread_id"
    : "sessions.codex_thread_id";
  const approvalsSource = hasCodexThreadIdColumn
    ? "FROM approvals"
    : `FROM approvals
        JOIN sessions
          ON approvals.discord_thread_id = sessions.discord_thread_id`;

  if (!hasCodexThreadIdColumn) {
    assertLegacyApprovalsSessionRefsExist(db);
  }

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE approvals_next (
        approval_key TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        codex_thread_id TEXT NOT NULL,
        discord_thread_id TEXT NOT NULL,
        status TEXT NOT NULL,
        resolved_by_discord_user_id TEXT,
        resolution TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (discord_thread_id)
          REFERENCES sessions(discord_thread_id)
          ON UPDATE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO approvals_next (
        approval_key,
        request_id,
        codex_thread_id,
        discord_thread_id,
        status,
        resolved_by_discord_user_id,
        resolution,
        created_at,
        updated_at
      )
      SELECT
        ${approvalKeySelect},
        approvals.request_id,
        ${codexThreadIdSelect},
        approvals.discord_thread_id,
        approvals.status,
        approvals.resolved_by_discord_user_id,
        approvals.resolution,
        approvals.created_at,
        approvals.updated_at
      ${approvalsSource}
    `);
    assertNoForeignKeyViolations(db, "approvals_next");
    db.exec("DROP TABLE approvals");
    db.exec("ALTER TABLE approvals_next RENAME TO approvals");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
};

const upgradeApprovalsSchema = (db: Database) => {
  if (
    !approvalsTableHasCascadeUpdate(db)
    || !approvalsTableHasStableIdentityColumns(db)
  ) {
    rebuildApprovalsTableWithStableIdentity(db);
  }
};

export const applyMigrations = (db: Database) => {
  db.exec(initMigration);
  upgradeSessionsLifecycleState(db);
  upgradeApprovalsSchema(db);
};

if (import.meta.main) {
  const config = parseConfig(Bun.env);
  const db = createDatabaseClient(config.databasePath);

  applyMigrations(db);
  db.close();
  console.log(`Applied migrations to ${config.databasePath}`);
}
