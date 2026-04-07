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
  requestId: ApprovalRequestId;
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
  requestId: ApprovalRequestId,
  status: ApprovalStatus,
): ApprovalState => {
  return {
    requestId,
    status,
  };
};

export const reduceApprovalEvent = (
  current: ApprovalState | undefined,
  event: ApprovalEvent,
) => {
  if (current && current.requestId !== event.requestId) {
    return current;
  }

  return createApprovalState(
    event.requestId,
    approvalStatusByEventType[event.type],
  );
};

export const shouldShowApprovalControls = (ownership: SessionOwnership) => {
  return canControlSession(ownership);
};
