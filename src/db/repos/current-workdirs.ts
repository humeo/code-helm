import { Database } from "bun:sqlite";

export type CurrentWorkdirRecord = {
  guildId: string;
  channelId: string;
  discordUserId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
};

type CurrentWorkdirRow = {
  guild_id: string;
  channel_id: string;
  discord_user_id: string;
  cwd: string;
  created_at: string;
  updated_at: string;
};

type MutationResult = {
  changes: number;
};

const now = () => new Date().toISOString();

const mapCurrentWorkdir = (
  row: CurrentWorkdirRow | null,
): CurrentWorkdirRecord | null => {
  if (!row) {
    return null;
  }

  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    discordUserId: row.discord_user_id,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export const createCurrentWorkdirRepo = (db: Database) => {
  const getStatement = db.prepare(
    `SELECT *
      FROM current_workdirs
      WHERE guild_id = ? AND channel_id = ? AND discord_user_id = ?`,
  );
  const upsertStatement = db.prepare(
    `INSERT INTO current_workdirs (
      guild_id,
      channel_id,
      discord_user_id,
      cwd,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (guild_id, channel_id, discord_user_id)
    DO UPDATE SET
      cwd = excluded.cwd,
      updated_at = excluded.updated_at`,
  );

  return {
    get(input: { guildId: string; channelId: string; discordUserId: string }) {
      return mapCurrentWorkdir(
        getStatement.get(
          input.guildId,
          input.channelId,
          input.discordUserId,
        ) as CurrentWorkdirRow | null,
      );
    },
    upsert(input: {
      guildId: string;
      channelId: string;
      discordUserId: string;
      cwd: string;
    }) {
      const timestamp = now();

      const result = upsertStatement.run(
        input.guildId,
        input.channelId,
        input.discordUserId,
        input.cwd,
        timestamp,
        timestamp,
      ) as MutationResult;

      if (result.changes === 0) {
        throw new Error(
          `Failed to persist current workdir for ${input.guildId}/${input.channelId}/${input.discordUserId}`,
        );
      }
    },
  };
};
