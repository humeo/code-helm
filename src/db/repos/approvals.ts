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
  displayTitle: string | null;
  commandPreview: string | null;
  justification: string | null;
  cwd: string | null;
  requestKind: string | null;
  threadMessageId: string | null;
  decisionCatalog: string | null;
  resolvedProviderDecision: string | null;
  resolvedBySurface: string | null;
  resolvedElsewhere: boolean;
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
  displayTitle?: string | null;
  commandPreview?: string | null;
  justification?: string | null;
  cwd?: string | null;
  requestKind?: string | null;
  decisionCatalog?: string | null;
  resolvedProviderDecision?: string | null;
  resolvedBySurface?: string | null;
  resolvedElsewhere?: boolean;
  resolvedByDiscordUserId?: string | null;
  resolution?: string | null;
};

type ApprovalRow = {
  approval_key: string;
  request_id: string;
  codex_thread_id: string;
  discord_thread_id: string;
  status: string;
  display_title: string | null;
  command_preview: string | null;
  justification: string | null;
  cwd: string | null;
  request_kind: string | null;
  thread_message_id: string | null;
  decision_catalog: string | null;
  resolved_provider_decision: string | null;
  resolved_by_surface: string | null;
  resolved_elsewhere: number;
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
    displayTitle: row.display_title,
    commandPreview: row.command_preview,
    justification: row.justification,
    cwd: row.cwd,
    requestKind: row.request_kind,
    threadMessageId: row.thread_message_id,
    decisionCatalog: row.decision_catalog,
    resolvedProviderDecision: row.resolved_provider_decision,
    resolvedBySurface: row.resolved_by_surface,
    resolvedElsewhere: row.resolved_elsewhere === 1,
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

const mergeSnapshotField = (
  existingValue: string | null | undefined,
  nextValue: string | null | undefined,
) => {
  if (existingValue !== null && existingValue !== undefined) {
    return existingValue;
  }

  if (nextValue !== undefined) {
    return nextValue;
  }

  return null;
};

const hasResolutionOriginMetadata = (input: InsertApprovalInput) => {
  return input.resolvedProviderDecision !== undefined
    || input.resolvedBySurface !== undefined
    || input.resolvedElsewhere !== undefined;
};

export const createApprovalRepo = (db: Database) => {
  const insertStatement = db.prepare(
    `INSERT INTO approvals (
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
      decision_catalog,
      resolved_provider_decision,
      resolved_by_surface,
      resolved_elsewhere,
      resolved_by_discord_user_id,
      resolution,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(approval_key) DO UPDATE SET
      discord_thread_id = excluded.discord_thread_id,
      codex_thread_id = excluded.codex_thread_id,
      request_id = excluded.request_id,
      status = excluded.status,
      display_title = excluded.display_title,
      command_preview = excluded.command_preview,
      justification = excluded.justification,
      cwd = excluded.cwd,
      request_kind = excluded.request_kind,
      thread_message_id = COALESCE(excluded.thread_message_id, approvals.thread_message_id),
      decision_catalog = excluded.decision_catalog,
      resolved_provider_decision = excluded.resolved_provider_decision,
      resolved_by_surface = excluded.resolved_by_surface,
      resolved_elsewhere = excluded.resolved_elsewhere,
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
  const getUniqueByRequestIdStatement = db.prepare(
    `SELECT * FROM approvals
      WHERE request_id = ?
      ORDER BY rowid DESC
      LIMIT 2`,
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
  const updateThreadMessageIdStatement = db.prepare(
    `UPDATE approvals
      SET thread_message_id = ?,
          updated_at = ?
      WHERE approval_key = ?`,
  );
  const updateResolutionOriginMetadataStatement = db.prepare(
    `UPDATE approvals
      SET resolved_provider_decision = ?,
          resolved_by_surface = ?,
          resolved_elsewhere = ?,
          updated_at = ?
      WHERE approval_key = ?`,
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
      const displayTitle = mergeSnapshotField(
        existing?.displayTitle,
        input.displayTitle,
      );
      const commandPreview = mergeSnapshotField(
        existing?.commandPreview,
        input.commandPreview,
      );
      const justification = mergeSnapshotField(
        existing?.justification,
        input.justification,
      );
      const cwd = mergeSnapshotField(existing?.cwd, input.cwd);
      const requestKind = mergeSnapshotField(
        existing?.requestKind,
        input.requestKind,
      );
      const decisionCatalog = mergeSnapshotField(
        existing?.decisionCatalog,
        input.decisionCatalog,
      );
      const resolvedProviderDecision =
        input.resolvedProviderDecision !== undefined
          ? input.resolvedProviderDecision
          : existing?.resolvedProviderDecision ?? null;
      const resolvedBySurface =
        input.resolvedBySurface !== undefined
          ? input.resolvedBySurface
          : existing?.resolvedBySurface ?? null;
      const resolvedElsewhere =
        input.resolvedElsewhere !== undefined
          ? input.resolvedElsewhere
          : existing?.resolvedElsewhere ?? false;

      if (existing && isTerminalApprovalStatus(existing.status)) {
        if (input.status === "resolved" && hasResolutionOriginMetadata(input)) {
          updateResolutionOriginMetadataStatement.run(
            resolvedProviderDecision,
            resolvedBySurface,
            resolvedElsewhere ? 1 : 0,
            timestamp,
            approvalKey,
          );
        }
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
        displayTitle,
        commandPreview,
        justification,
        cwd,
        requestKind,
        existing?.threadMessageId ?? null,
        decisionCatalog,
        resolvedProviderDecision,
        resolvedBySurface,
        resolvedElsewhere ? 1 : 0,
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
    getUniqueByRequestId(requestId: string | number) {
      const rows = getUniqueByRequestIdStatement.all(
        normalizeRequestId(requestId),
      ) as ApprovalRow[];

      return rows.length === 1 ? mapApproval(rows[0]) : null;
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
    updateThreadMessageId(approvalKey: string, threadMessageId: string | null) {
      updateThreadMessageIdStatement.run(
        threadMessageId,
        now(),
        approvalKey,
      );
    },
  };
};
