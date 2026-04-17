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

const approvalsTableHasSnapshotColumns = (db: Database) => {
  return hasColumn(db, "approvals", "display_title")
    && hasColumn(db, "approvals", "command_preview")
    && hasColumn(db, "approvals", "justification")
    && hasColumn(db, "approvals", "cwd")
    && hasColumn(db, "approvals", "request_kind")
    && hasColumn(db, "approvals", "thread_message_id");
};

const assertLegacySessionsCanBackfillCwd = (
  db: Database,
  hasCwdColumn: boolean,
) => {
  const orphan = hasCwdColumn
    ? db.prepare(
        `SELECT rowid
          FROM sessions
          WHERE NULLIF(TRIM(cwd), '') IS NULL
          LIMIT 1`,
      ).get()
    : db.prepare(
        `SELECT sessions.rowid
          FROM sessions
          LEFT JOIN workdirs
            ON sessions.workdir_id = workdirs.id
          WHERE NULLIF(TRIM(workdirs.absolute_path), '') IS NULL
          LIMIT 1`,
      ).get();

  if (orphan) {
    throw new Error("sessions rebuild could not backfill cwd");
  }
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
  const hasCwdColumn = hasColumn(db, "sessions", "cwd");
  const cwdSelect = hasCwdColumn
    ? "sessions.cwd"
    : "workdirs.absolute_path";
  const sessionsSource = hasCwdColumn
    ? "FROM sessions"
    : `FROM sessions
        JOIN workdirs
          ON sessions.workdir_id = workdirs.id`;
  const lifecycleStateSelect = hasLifecycleStateColumn
    ? `CASE
        WHEN sessions.lifecycle_state IN ('active', 'archived', 'deleted') THEN sessions.lifecycle_state
        ELSE 'active'
      END`
    : "'active'";

  assertLegacySessionsCanBackfillCwd(db, hasCwdColumn);

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE sessions_next (
        discord_thread_id TEXT PRIMARY KEY,
        codex_thread_id TEXT NOT NULL UNIQUE,
        owner_discord_user_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        state TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL DEFAULT 'active' ${lifecycleConstraintSql},
        degradation_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO sessions_next (
        discord_thread_id,
        codex_thread_id,
        owner_discord_user_id,
        cwd,
        state,
        lifecycle_state,
        degradation_reason,
        created_at,
        updated_at
      )
      SELECT
        sessions.discord_thread_id,
        sessions.codex_thread_id,
        sessions.owner_discord_user_id,
        ${cwdSelect},
        sessions.state,
        ${lifecycleStateSelect},
        sessions.degradation_reason,
        sessions.created_at,
        sessions.updated_at
      ${sessionsSource}
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
  const hasCwdColumn = hasColumn(db, "sessions", "cwd");

  if (
    !hasLifecycleStateColumn
    || !hasCwdColumn
    || !sessionsTableHasLifecycleConstraint(db)
  ) {
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
  const hasDisplayTitleColumn = hasColumn(db, "approvals", "display_title");
  const hasCommandPreviewColumn = hasColumn(db, "approvals", "command_preview");
  const hasJustificationColumn = hasColumn(db, "approvals", "justification");
  const hasCwdColumn = hasColumn(db, "approvals", "cwd");
  const hasRequestKindColumn = hasColumn(db, "approvals", "request_kind");
  const hasThreadMessageIdColumn = hasColumn(db, "approvals", "thread_message_id");
  const approvalKeySelect = hasApprovalKeyColumn
    ? "approval_key"
    : "printf('legacy:%s', approvals.request_id)";
  const codexThreadIdSelect = hasCodexThreadIdColumn
    ? "approvals.codex_thread_id"
    : "sessions.codex_thread_id";
  const displayTitleSelect = hasDisplayTitleColumn
    ? "approvals.display_title"
    : "NULL";
  const commandPreviewSelect = hasCommandPreviewColumn
    ? "approvals.command_preview"
    : "NULL";
  const justificationSelect = hasJustificationColumn
    ? "approvals.justification"
    : "NULL";
  const cwdSelect = hasCwdColumn ? "approvals.cwd" : "NULL";
  const requestKindSelect = hasRequestKindColumn
    ? "approvals.request_kind"
    : "NULL";
  const threadMessageIdSelect = hasThreadMessageIdColumn
    ? "approvals.thread_message_id"
    : "NULL";
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
        display_title TEXT,
        command_preview TEXT,
        justification TEXT,
        cwd TEXT,
        request_kind TEXT,
        thread_message_id TEXT,
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
        display_title,
        command_preview,
        justification,
        cwd,
        request_kind,
        thread_message_id,
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
        ${displayTitleSelect},
        ${commandPreviewSelect},
        ${justificationSelect},
        ${cwdSelect},
        ${requestKindSelect},
        ${threadMessageIdSelect},
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
    return;
  }

  if (!approvalsTableHasSnapshotColumns(db)) {
    const missingColumns = [
      ["display_title", "TEXT"],
      ["command_preview", "TEXT"],
      ["justification", "TEXT"],
      ["cwd", "TEXT"],
      ["request_kind", "TEXT"],
      ["thread_message_id", "TEXT"],
    ].filter(([columnName]) => !hasColumn(db, "approvals", columnName));

    for (const [columnName, columnType] of missingColumns) {
      db.exec(`ALTER TABLE approvals ADD COLUMN ${columnName} ${columnType}`);
    }
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
