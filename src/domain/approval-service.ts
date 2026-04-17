import { canControlSession } from "./session-service";
import type { SessionOwnership } from "./types";

export type ApprovalStatus =
  | "pending"
  | "resolved"
  | "approved"
  | "declined"
  | "canceled";

export type ApprovalRequestId = string | number;

export type ApprovalSnapshotFields = {
  displayTitle?: string | null;
  commandPreview?: string | null;
  justification?: string | null;
  cwd?: string | null;
  requestKind?: string | null;
};

export type ApprovalState = {
  requestId: string;
  status: ApprovalStatus;
} & ApprovalSnapshotFields;

export type ApprovalEvent =
  | {
      type: "requestApproval";
      requestId: ApprovalRequestId;
    }
  | {
      type: "serverRequest/resolved";
      requestId: ApprovalRequestId;
    }
  | {
      type: "approved";
      requestId: ApprovalRequestId;
    }
  | {
      type: "declined";
      requestId: ApprovalRequestId;
    }
  | {
      type: "canceled";
      requestId: ApprovalRequestId;
    };

const approvalStatusByEventType: Record<
  ApprovalEvent["type"],
  ApprovalStatus
> = {
  requestApproval: "pending",
  "serverRequest/resolved": "resolved",
  approved: "approved",
  declined: "declined",
  canceled: "canceled",
};

const createApprovalState = (
  requestId: string,
  status: ApprovalStatus,
): ApprovalState => {
  return {
    requestId,
    status,
  };
};

export const normalizeApprovalRequestId = (requestId: ApprovalRequestId) => {
  return String(requestId);
};

export const isTerminalApprovalStatus = (status: ApprovalStatus) => {
  return status === "approved" || status === "declined" || status === "canceled";
};

const approvalStatusPrecedence: Record<ApprovalStatus, number> = {
  pending: 0,
  resolved: 1,
  approved: 2,
  declined: 2,
  canceled: 2,
};

export const applyApprovalStatusPrecedence = (
  currentStatus: ApprovalStatus | undefined,
  nextStatus: ApprovalStatus,
) => {
  if (!currentStatus) {
    return nextStatus;
  }

  if (isTerminalApprovalStatus(currentStatus)) {
    return currentStatus;
  }

  if (isTerminalApprovalStatus(nextStatus)) {
    return nextStatus;
  }

  return approvalStatusPrecedence[nextStatus] >= approvalStatusPrecedence[currentStatus]
    ? nextStatus
    : currentStatus;
};

export const reduceApprovalEvent = (
  current: ApprovalState | undefined,
  event: ApprovalEvent,
) => {
  const requestId = normalizeApprovalRequestId(event.requestId);

  if (current && current.requestId !== requestId) {
    return current;
  }

  const nextStatus = applyApprovalStatusPrecedence(
    current?.status,
    approvalStatusByEventType[event.type],
  );

  if (current) {
    if (current.status === nextStatus) {
      return current;
    }

    return {
      ...current,
      requestId,
      status: nextStatus,
    };
  }

  return createApprovalState(requestId, nextStatus);
};

export const shouldShowApprovalControls = (ownership: SessionOwnership) => {
  return canControlSession(ownership);
};
