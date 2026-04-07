import {
  isTerminalApprovalStatus,
  shouldShowApprovalControls,
  normalizeApprovalRequestId,
  type ApprovalState,
  type ApprovalEvent,
} from "../domain/approval-service";

export type ApprovalUiButton = "approve" | "decline" | "cancel";

export type ApprovalUiRender =
  | {
      kind: "controls";
      requestId: ApprovalState["requestId"];
      status: ApprovalState["status"];
      buttons: ApprovalUiButton[];
    }
  | {
      kind: "status-only";
      requestId: ApprovalState["requestId"];
      status: ApprovalState["status"];
    };

export type ApprovalUiInput = {
  approval: ApprovalState;
  viewerId: string;
  ownerId: string;
};

export type ApprovalResolutionSignal = Extract<
  ApprovalEvent,
  { type: "serverRequest/resolved" }
>;

export type ApprovalResolutionOutcome = {
  approval: ApprovalState;
  closeActiveUi: boolean;
};

const approvalButtons: ApprovalUiButton[] = [
  "approve",
  "decline",
  "cancel",
];

export const applyApprovalResolutionSignal = (
  approval: ApprovalState,
  signal: ApprovalResolutionSignal,
): ApprovalResolutionOutcome => {
  const requestId = normalizeApprovalRequestId(signal.requestId);

  if (approval.requestId !== requestId) {
    return {
      approval,
      closeActiveUi: false,
    };
  }

  if (isTerminalApprovalStatus(approval.status)) {
    return {
      approval,
      closeActiveUi: true,
    };
  }

  return {
    approval: {
      requestId,
      status: "resolved",
    },
    closeActiveUi: true,
  };
};

export const renderApprovalUi = ({
  approval,
  viewerId,
  ownerId,
}: ApprovalUiInput): ApprovalUiRender => {
  const canShowControls =
    approval.status === "pending" &&
    shouldShowApprovalControls({ viewerId, ownerId });

  if (canShowControls) {
    return {
      kind: "controls",
      requestId: approval.requestId,
      status: approval.status,
      buttons: approvalButtons,
    };
  }

  return {
    kind: "status-only",
    requestId: approval.requestId,
    status: approval.status,
  };
};
