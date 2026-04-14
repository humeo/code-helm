import { Database } from "bun:sqlite";
import {
  isTerminalApprovalStatus,
  type ApprovalStatus,
} from "../../domain/approval-service";

export type ApprovalRecord = {
  approvalKey: string;
  requestId: string;
  codexThreadId: string;
  discordThreadId: string;
  status: ApprovalStatus;
  resolvedByDiscordUserId: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InsertApprovalInput = {
  approvalKey?: string;
  requestId: string | number;
  codexThreadId?: string;
  discordThreadId: string;
  status: ApprovalStatus;
  resolvedByDiscordUserId?: string | null;
  resolution?: string | null;
};

type ApprovalRow = {
  approval_key: string;
  request_id: string;
  codex_thread_id: string;
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
    approvalKey: row.approval_key,
    requestId: row.request_id,
    codexThreadId: row.codex_thread_id,
    discordThreadId: row.discord_thread_id,
    status: row.status as ApprovalStatus,
    resolvedByDiscordUserId: row.resolved_by_discord_user_id,
    resolution: row.resolution,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const now = () => new Date().toISOString();

const normalizeRequestId = (requestId: string | number) => {
  return String(requestId);
};

const normalizeApprovalKey = (approvalKey: string | undefined, requestId: string) => {
  return approvalKey ?? requestId;
};

export const createApprovalRepo = (db: Database) => {
  const insertStatement = db.prepare(
    `INSERT INTO approvals (
      approval_key,
      request_id,
      codex_thread_id,
      discord_thread_id,
      status,
      resolved_by_discord_user_id,
      resolution,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(approval_key) DO UPDATE SET
      discord_thread_id = excluded.discord_thread_id,
      codex_thread_id = excluded.codex_thread_id,
      request_id = excluded.request_id,
      status = excluded.status,
      resolved_by_discord_user_id = excluded.resolved_by_discord_user_id,
      resolution = excluded.resolution,
      updated_at = excluded.updated_at`,
  );
  const getByApprovalKeyStatement = db.prepare(
    "SELECT * FROM approvals WHERE approval_key = ?",
  );
  const getByRequestIdStatement = db.prepare(
    `SELECT * FROM approvals
      WHERE request_id = ?
      ORDER BY rowid DESC
      LIMIT 1`,
  );
  const getLatestByCodexThreadIdAndRequestIdStatement = db.prepare(
    `SELECT * FROM approvals
      WHERE codex_thread_id = ?
        AND request_id = ?
      ORDER BY rowid DESC
      LIMIT 1`,
  );
  const listPendingByDiscordThreadIdStatement = db.prepare(
    `SELECT * FROM approvals
      WHERE discord_thread_id = ?
        AND status = 'pending'
      ORDER BY rowid DESC`,
  );
  const getLatestByDiscordThreadIdStatement = db.prepare(
    `SELECT * FROM approvals
      WHERE discord_thread_id = ?
      ORDER BY rowid DESC
      LIMIT 1`,
  );
  const getCodexThreadIdByDiscordThreadIdStatement = db.prepare(
    `SELECT codex_thread_id
      FROM sessions
      WHERE discord_thread_id = ?
      LIMIT 1`,
  );

  return {
    insert(input: InsertApprovalInput) {
      const timestamp = now();
      const requestId = normalizeRequestId(input.requestId);
      const approvalKey = normalizeApprovalKey(input.approvalKey, requestId);
      const existing = mapApproval(
        getByApprovalKeyStatement.get(approvalKey) as ApprovalRow | null,
      );
      const inferredCodexThreadId = getCodexThreadIdByDiscordThreadIdStatement.get(
        input.discordThreadId,
      ) as { codex_thread_id?: string } | null;
      const codexThreadId =
        existing?.codexThreadId
        ?? input.codexThreadId
        ?? inferredCodexThreadId?.codex_thread_id;

      const resolvedByDiscordUserId =
        input.resolvedByDiscordUserId !== undefined
          ? input.resolvedByDiscordUserId
          : existing?.resolvedByDiscordUserId ?? null;
      const resolution =
        input.resolution !== undefined
          ? input.resolution
          : existing?.resolution ?? null;

      if (existing && isTerminalApprovalStatus(existing.status)) {
        return;
      }

      if (existing?.status === "resolved" && input.status === "pending") {
        return;
      }

      if (!codexThreadId) {
        throw new Error("approval insert requires a codexThreadId");
      }

      insertStatement.run(
        approvalKey,
        requestId,
        codexThreadId,
        input.discordThreadId,
        input.status,
        resolvedByDiscordUserId,
        resolution,
        timestamp,
        timestamp,
      );
    },
    getByApprovalKey(approvalKey: string) {
      return mapApproval(
        getByApprovalKeyStatement.get(approvalKey) as ApprovalRow | null,
      );
    },
    getByRequestId(requestId: string | number) {
      return mapApproval(
        getByRequestIdStatement.get(normalizeRequestId(requestId)) as ApprovalRow | null,
      );
    },
    getLatestByCodexThreadIdAndRequestId(
      codexThreadId: string,
      requestId: string | number,
    ) {
      return mapApproval(
        getLatestByCodexThreadIdAndRequestIdStatement.get(
          codexThreadId,
          normalizeRequestId(requestId),
        ) as ApprovalRow | null,
      );
    },
    listPendingByDiscordThreadId(discordThreadId: string) {
      return (
        listPendingByDiscordThreadIdStatement.all(discordThreadId) as ApprovalRow[]
      ).map((row) => mapApproval(row)!);
    },
    getLatestByDiscordThreadId(discordThreadId: string) {
      return mapApproval(
        getLatestByDiscordThreadIdStatement.get(discordThreadId) as ApprovalRow | null,
      );
    },
  };
};
