import {
  shouldShowApprovalControls,
  type ApprovalState,
} from "../domain/approval-service";

export type ApprovalUiButton = "approve" | "decline" | "cancel";

export type ApprovalUiRender =
  | {
      kind: "controls";
      requestId: ApprovalState["requestId"];
      status: ApprovalState["status"];
      buttons: ApprovalUiButton[];
      closeOnResolved: boolean;
    }
  | {
      kind: "status-only";
      requestId: ApprovalState["requestId"];
      status: ApprovalState["status"];
      closeOnResolved: boolean;
    };

export type ApprovalUiInput = {
  approval: ApprovalState;
  viewerId: string;
  ownerId: string;
};

const approvalButtons: ApprovalUiButton[] = [
  "approve",
  "decline",
  "cancel",
];

export const shouldCloseApprovalUi = ({ status }: ApprovalState) => {
  return status === "resolved";
};

export const renderApprovalUi = ({
  approval,
  viewerId,
  ownerId,
}: ApprovalUiInput): ApprovalUiRender => {
  const closeOnResolved = shouldCloseApprovalUi(approval);
  const canShowControls =
    approval.status === "pending" &&
    shouldShowApprovalControls({ viewerId, ownerId });

  if (canShowControls) {
    return {
      kind: "controls",
      requestId: approval.requestId,
      status: approval.status,
      buttons: approvalButtons,
      closeOnResolved,
    };
  }

  return {
    kind: "status-only",
    requestId: approval.requestId,
    status: approval.status,
    closeOnResolved,
  };
};
