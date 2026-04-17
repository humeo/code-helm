import {
  applyApprovalStatusPrecedence,
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

export type ApprovalDisplaySnapshot = {
  displayTitle: string | null;
  commandPreview: string | null;
  justification: string | null;
  cwd: string | null;
  requestKind: string | null;
};

export type ApprovalLifecycleRender = {
  content: string;
  buttons: ApprovalUiButton[];
};

const approvalButtons: ApprovalUiButton[] = [
  "approve",
  "decline",
  "cancel",
];

const fallbackApprovalTitle = "Approval request";

const normalizeApprovalDisplaySnapshot = (
  approval: ApprovalState,
): ApprovalDisplaySnapshot => {
  return {
    displayTitle: approval.displayTitle ?? null,
    commandPreview: approval.commandPreview ?? null,
    justification: approval.justification ?? null,
    cwd: approval.cwd ?? null,
    requestKind: approval.requestKind ?? null,
  };
};

const toApprovalTitle = (snapshot: ApprovalDisplaySnapshot) => {
  return snapshot.displayTitle ?? fallbackApprovalTitle;
};

const toApprovalStatusLabel = (status: ApprovalState["status"]) => {
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
};

const renderApprovalLifecycleBody = (
  approval: ApprovalState,
  snapshot: ApprovalDisplaySnapshot,
) => {
  const lines = [
    `**${toApprovalTitle(snapshot)}**`,
    `Status: \`${toApprovalStatusLabel(approval.status)}\``,
  ];

  if (snapshot.commandPreview) {
    lines.push("", "```sh", snapshot.commandPreview, "```");
  }

  if (snapshot.justification) {
    lines.push("", snapshot.justification);
  }

  const metadata: string[] = [];

  if (snapshot.cwd) {
    metadata.push(`CWD: \`${snapshot.cwd}\``);
  }

  if (snapshot.requestKind) {
    metadata.push(`Kind: \`${snapshot.requestKind}\``);
  }

  metadata.push(`Request ID: \`${approval.requestId}\``);

  if (metadata.length > 0) {
    lines.push("", ...metadata);
  }

  return lines.join("\n");
};

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

  const nextStatus = applyApprovalStatusPrecedence(approval.status, "resolved");

  return {
    approval:
      nextStatus === approval.status
        ? approval
        : {
            ...approval,
            requestId,
            status: nextStatus,
          },
    closeActiveUi: true,
  };
};

export const renderApprovalLifecyclePayload = ({
  approval,
}: {
  approvalKey?: string;
  approval: ApprovalState;
}): ApprovalLifecycleRender => {
  const snapshot = normalizeApprovalDisplaySnapshot(approval);

  return {
    content: renderApprovalLifecycleBody(approval, snapshot),
    buttons: approval.status === "pending" ? approvalButtons : [],
  };
};

export const renderApprovalStaleStatusText = ({
  approval,
}: {
  approval: ApprovalState;
}) => {
  const snapshot = normalizeApprovalDisplaySnapshot(approval);

  return `${toApprovalTitle(snapshot)} is already ${approval.status}.`;
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
