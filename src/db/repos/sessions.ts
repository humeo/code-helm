import { Database } from "bun:sqlite";

export type SessionState = string;
export type SessionLifecycleState = "active" | "archived" | "deleted";

export type SessionRecord = {
  discordThreadId: string;
  codexThreadId: string;
  ownerDiscordUserId: string;
  cwd: string;
  state: SessionState;
  lifecycleState: SessionLifecycleState;
  degradationReason: string | null;
  modelOverride: string | null;
  reasoningEffortOverride: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InsertSessionInput = {
  discordThreadId: string;
  codexThreadId: string;
  ownerDiscordUserId: string;
  cwd: string;
  state: SessionState;
};

type SessionRow = {
  discord_thread_id: string;
  codex_thread_id: string;
  owner_discord_user_id: string;
  cwd: string;
  state: string;
  lifecycle_state: SessionLifecycleState;
  degradation_reason: string | null;
  model_override: string | null;
  reasoning_effort_override: string | null;
  created_at: string;
  updated_at: string;
};

type MutationResult = {
  changes: number;
};

const mapSession = (row: SessionRow | null): SessionRecord | null => {
  if (!row) {
    return null;
  }

  return {
    discordThreadId: row.discord_thread_id,
    codexThreadId: row.codex_thread_id,
    ownerDiscordUserId: row.owner_discord_user_id,
    cwd: row.cwd,
    state: row.state,
    lifecycleState: row.lifecycle_state,
    degradationReason: row.degradation_reason,
    modelOverride: row.model_override,
    reasoningEffortOverride: row.reasoning_effort_override,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const now = () => new Date().toISOString();

const assertSessionUpdated = (
  result: MutationResult,
  discordThreadId: string,
) => {
  if (result.changes === 0) {
    throw new Error(
      `Session not found for Discord thread ${discordThreadId}`,
    );
  }
};

export const createSessionRepo = (db: Database) => {
  const insertStatement = db.prepare(
    `INSERT INTO sessions (
      discord_thread_id,
      codex_thread_id,
      owner_discord_user_id,
      cwd,
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
  const listAllStatement = db.prepare(
    "SELECT * FROM sessions ORDER BY created_at ASC",
  );
  const listArchivedStatement = db.prepare(
    "SELECT * FROM sessions WHERE lifecycle_state = 'archived' ORDER BY created_at ASC",
  );
  const updateStateStatement = db.prepare(
    "UPDATE sessions SET state = ?, updated_at = ? WHERE discord_thread_id = ?",
  );
  const syncStateStatement = db.prepare(
    `UPDATE sessions
      SET state = ?, degradation_reason = ?, updated_at = ?
      WHERE discord_thread_id = ?`,
  );
  const updateLifecycleStateStatement = db.prepare(
    `UPDATE sessions
      SET lifecycle_state = ?, updated_at = ?
      WHERE discord_thread_id = ?`,
  );
  const updateModelOverrideStatement = db.prepare(
    `UPDATE sessions
      SET model_override = ?, reasoning_effort_override = ?, updated_at = ?
      WHERE discord_thread_id = ?`,
  );
  const markExternallyModifiedStatement = db.prepare(
    `UPDATE sessions
      SET state = ?, degradation_reason = ?, updated_at = ?
      WHERE discord_thread_id = ?`,
  );
  const markDeletedStatement = db.prepare(
    `UPDATE sessions
      SET lifecycle_state = 'deleted', updated_at = ?
      WHERE discord_thread_id = ?`,
  );
  const rebindDiscordThreadStatement = db.prepare(
    `UPDATE sessions
      SET discord_thread_id = ?, updated_at = ?
      WHERE discord_thread_id = ?`,
  );

  return {
    insert(input: InsertSessionInput) {
      const timestamp = now();

      insertStatement.run(
        input.discordThreadId,
        input.codexThreadId,
        input.ownerDiscordUserId,
        input.cwd,
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
    listAll() {
      return (listAllStatement.all() as SessionRow[]).map((row) => mapSession(row)!);
    },
    listArchived() {
      return (listArchivedStatement.all() as SessionRow[]).map((row) => mapSession(row)!);
    },
    updateState(discordThreadId: string, state: SessionState) {
      assertSessionUpdated(
        updateStateStatement.run(
          state,
          now(),
          discordThreadId,
        ) as MutationResult,
        discordThreadId,
      );
    },
    syncState(
      discordThreadId: string,
      state: SessionState,
      degradationReason: string | null = null,
    ) {
      assertSessionUpdated(
        syncStateStatement.run(
          state,
          degradationReason,
          now(),
          discordThreadId,
        ) as MutationResult,
        discordThreadId,
      );
    },
    updateLifecycleState(
      discordThreadId: string,
      lifecycleState: SessionLifecycleState,
    ) {
      assertSessionUpdated(
        updateLifecycleStateStatement.run(
          lifecycleState,
          now(),
          discordThreadId,
        ) as MutationResult,
        discordThreadId,
      );
    },
    updateModelOverride(
      discordThreadId: string,
      overrides: {
        modelOverride: string | null;
        reasoningEffortOverride: string | null;
      },
    ) {
      assertSessionUpdated(
        updateModelOverrideStatement.run(
          overrides.modelOverride,
          overrides.reasoningEffortOverride,
          now(),
          discordThreadId,
        ) as MutationResult,
        discordThreadId,
      );
    },
    markExternallyModified(
      discordThreadId: string,
      reason = "externally_modified",
    ) {
      assertSessionUpdated(
        markExternallyModifiedStatement.run(
          "degraded",
          reason,
          now(),
          discordThreadId,
        ) as MutationResult,
        discordThreadId,
      );
    },
    markDeleted(discordThreadId: string) {
      assertSessionUpdated(
        markDeletedStatement.run(
          now(),
          discordThreadId,
        ) as MutationResult,
        discordThreadId,
      );
    },
    rebindDiscordThread({
      currentDiscordThreadId,
      nextDiscordThreadId,
    }: {
      currentDiscordThreadId: string;
      nextDiscordThreadId: string;
    }) {
      assertSessionUpdated(
        rebindDiscordThreadStatement.run(
          nextDiscordThreadId,
          now(),
          currentDiscordThreadId,
        ) as MutationResult,
        currentDiscordThreadId,
      );
    },
  };
};

export type SessionRepo = ReturnType<typeof createSessionRepo>;
