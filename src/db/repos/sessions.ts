import { createDatabaseClient, type DatabaseTarget } from "../client";

export type SessionState = string;

export type SessionRecord = {
  discordThreadId: string;
  codexThreadId: string;
  ownerDiscordUserId: string;
  workdirId: string;
  state: SessionState;
  degradationReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InsertSessionInput = {
  discordThreadId: string;
  codexThreadId: string;
  ownerDiscordUserId: string;
  workdirId: string;
  state: SessionState;
};

type SessionRow = {
  discord_thread_id: string;
  codex_thread_id: string;
  owner_discord_user_id: string;
  workdir_id: string;
  state: string;
  degradation_reason: string | null;
  created_at: string;
  updated_at: string;
};

const mapSession = (row: SessionRow | null): SessionRecord | null => {
  if (!row) {
    return null;
  }

  return {
    discordThreadId: row.discord_thread_id,
    codexThreadId: row.codex_thread_id,
    ownerDiscordUserId: row.owner_discord_user_id,
    workdirId: row.workdir_id,
    state: row.state,
    degradationReason: row.degradation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const now = () => new Date().toISOString();

export const createSessionRepo = (target: DatabaseTarget) => {
  const db = createDatabaseClient(target);
  const insertStatement = db.prepare(
    `INSERT INTO sessions (
      discord_thread_id,
      codex_thread_id,
      owner_discord_user_id,
      workdir_id,
      state,
      degradation_reason,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const getByDiscordThreadIdStatement = db.prepare(
    "SELECT * FROM sessions WHERE discord_thread_id = ?",
  );
  const getByCodexThreadIdStatement = db.prepare(
    "SELECT * FROM sessions WHERE codex_thread_id = ?",
  );
  const updateStateStatement = db.prepare(
    "UPDATE sessions SET state = ?, updated_at = ? WHERE discord_thread_id = ?",
  );
  const markExternallyModifiedStatement = db.prepare(
    `UPDATE sessions
      SET state = ?, degradation_reason = ?, updated_at = ?
      WHERE discord_thread_id = ?`,
  );

  return {
    insert(input: InsertSessionInput) {
      const timestamp = now();

      insertStatement.run(
        input.discordThreadId,
        input.codexThreadId,
        input.ownerDiscordUserId,
        input.workdirId,
        input.state,
        timestamp,
        timestamp,
      );
    },
    getByDiscordThreadId(discordThreadId: string) {
      return mapSession(
        getByDiscordThreadIdStatement.get(discordThreadId) as SessionRow | null,
      );
    },
    getByCodexThreadId(codexThreadId: string) {
      return mapSession(
        getByCodexThreadIdStatement.get(codexThreadId) as SessionRow | null,
      );
    },
    updateState(discordThreadId: string, state: SessionState) {
      updateStateStatement.run(state, now(), discordThreadId);
    },
    markExternallyModified(
      discordThreadId: string,
      reason = "externally_modified",
    ) {
      markExternallyModifiedStatement.run(
        "degraded",
        reason,
        now(),
        discordThreadId,
      );
    },
  };
};

export type SessionRepo = ReturnType<typeof createSessionRepo>;
