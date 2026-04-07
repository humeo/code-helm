import { Database } from "bun:sqlite";
import type { ApprovalStatus } from "../../domain/approval-service";

export type ApprovalRecord = {
  requestId: string;
  discordThreadId: string;
  status: ApprovalStatus;
  resolvedByDiscordUserId: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InsertApprovalInput = {
  requestId: string;
  discordThreadId: string;
  status: ApprovalStatus;
  resolvedByDiscordUserId?: string | null;
  resolution?: string | null;
};

type ApprovalRow = {
  request_id: string;
  discord_thread_id: string;
  status: string;
  resolved_by_discord_user_id: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
};

const mapApproval = (row: ApprovalRow | null): ApprovalRecord | null => {
  if (!row) {
    return null;
  }

  return {
    requestId: row.request_id,
    discordThreadId: row.discord_thread_id,
    status: row.status as ApprovalStatus,
    resolvedByDiscordUserId: row.resolved_by_discord_user_id,
    resolution: row.resolution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const now = () => new Date().toISOString();

export const createApprovalRepo = (db: Database) => {
  const insertStatement = db.prepare(
    `INSERT INTO approvals (
      request_id,
      discord_thread_id,
      status,
      resolved_by_discord_user_id,
      resolution,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      discord_thread_id = excluded.discord_thread_id,
      status = excluded.status,
      resolved_by_discord_user_id = excluded.resolved_by_discord_user_id,
      resolution = excluded.resolution,
      updated_at = excluded.updated_at`,
  );
  const getByRequestIdStatement = db.prepare(
    "SELECT * FROM approvals WHERE request_id = ?",
  );

  return {
    insert(input: InsertApprovalInput) {
      const timestamp = now();
      insertStatement.run(
        input.requestId,
        input.discordThreadId,
        input.status,
        input.resolvedByDiscordUserId ?? null,
        input.resolution ?? null,
        timestamp,
        timestamp,
      );
    },
    getByRequestId(requestId: string) {
      return mapApproval(
        getByRequestIdStatement.get(requestId) as ApprovalRow | null,
      );
    },
  };
};
