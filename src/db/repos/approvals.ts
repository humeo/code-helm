import { createDatabaseClient, type DatabaseTarget } from "../client";

export type ApprovalRecord = {
  requestId: string;
  discordThreadId: string;
  status: string;
  resolvedByDiscordUserId: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InsertApprovalInput = {
  requestId: string;
  discordThreadId: string;
  status: string;
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
    status: row.status,
    resolvedByDiscordUserId: row.resolved_by_discord_user_id,
    resolution: row.resolution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const now = () => new Date().toISOString();

export const createApprovalRepo = (target: DatabaseTarget) => {
  const db = createDatabaseClient(target);
  const insertStatement = db.prepare(
    `INSERT INTO approvals (
      request_id,
      discord_thread_id,
      status,
      resolved_by_discord_user_id,
      resolution,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
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
