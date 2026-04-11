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

export const applyMigrations = (db: Database) => {
  db.exec(initMigration);
  upgradeSessionsLifecycleState(db);
};

if (import.meta.main) {
  const config = parseConfig(Bun.env);
  const db = createDatabaseClient(config.databasePath);

  applyMigrations(db);
  db.close();
  console.log(`Applied migrations to ${config.databasePath}`);
}
