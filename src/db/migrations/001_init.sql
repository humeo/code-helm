CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workdirs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  label TEXT NOT NULL,
  absolute_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  discord_thread_id TEXT PRIMARY KEY,
  codex_thread_id TEXT NOT NULL UNIQUE,
  owner_discord_user_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  state TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'archived', 'deleted')),
  degradation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS current_workdirs (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id, discord_user_id)
);

CREATE TABLE IF NOT EXISTS approvals (
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
);
