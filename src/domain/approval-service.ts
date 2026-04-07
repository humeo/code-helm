import { canControlSession } from "./session-service";
import type { SessionOwnership } from "./types";

export type ApprovalStatus =
  | "pending"
  | "resolved"
  | "approved"
  | "declined"
  | "canceled";

export type ApprovalRequestId = string | number;

export type ApprovalState = {
  requestId: string;
  status: ApprovalStatus;
};

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

export const reduceApprovalEvent = (
  current: ApprovalState | undefined,
  event: ApprovalEvent,
) => {
  const requestId = normalizeApprovalRequestId(event.requestId);

  if (current && current.requestId !== requestId) {
    return current;
  }

  if (
    event.type === "serverRequest/resolved" &&
    current &&
    isTerminalApprovalStatus(current.status)
  ) {
    return current;
  }

  return createApprovalState(
    requestId,
    approvalStatusByEventType[event.type],
  );
};

export const shouldShowApprovalControls = (ownership: SessionOwnership) => {
  return canControlSession(ownership);
};
