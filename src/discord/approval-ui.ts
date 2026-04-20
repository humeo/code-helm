import {
  applyApprovalStatusPrecedence,
  normalizeApprovalRequestId,
  shouldShowApprovalControls,
  type ApprovalEvent,
  type ApprovalState,
  type PersistedApprovalDecision,
} from "../domain/approval-service";

export type ApprovalUiButton = "approve" | "decline" | "cancel";

export type ApprovalUiRender =
  | {
      kind: "controls";
      requestId: ApprovalState["requestId"];
      status: ApprovalState["status"];
      buttons: PersistedApprovalDecision[];
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
  questionText: string | null;
  displayTitle: string | null;
  commandPreview: string | null;
  justification: string | null;
  cwd: string | null;
  requestKind: string | null;
  decisions: PersistedApprovalDecision[] | null;
  resolvedProviderDecision: string | null;
  resolvedElsewhere: boolean;
  resolvedBySurface: string | null;
};

export type ApprovalLifecycleRender = {
  content: string;
  buttons: ApprovalUiButton[];
  decisions: PersistedApprovalDecision[];
};

const fallbackApprovalTitle = "Approval request";
const fallbackApprovalQuestion = "Would you like to approve this request?";
const defaultApprovalButtons: ApprovalUiButton[] = [
  "approve",
  "decline",
  "cancel",
];
const legacyFallbackDecisions: PersistedApprovalDecision[] = [
  {
    key: "accept",
    providerDecision: "accept",
    label: "Approve",
    consequence: null,
  },
  {
    key: "decline",
    providerDecision: "decline",
    label: "Decline",
    consequence: null,
  },
  {
    key: "cancel",
    providerDecision: "cancel",
    label: "Cancel",
    consequence: null,
  },
];
const fallbackQuestionByRequestKind: Record<string, string> = {
  command_execution: "Would you like to run the following command?",
  file_change: "Would you like to apply these file changes?",
  permissions: "Would you like to grant these permissions?",
};
const discordMessageCharacterLimit = 2000;
const approvalQuestionCharacterLimit = 160;
const approvalCommandPreviewCharacterLimit = 640;
const approvalJustificationCharacterLimit = 700;
const approvalCwdCharacterLimit = 180;
const approvalRequestKindCharacterLimit = 80;
const approvalRequestIdCharacterLimit = 80;
const approvalTruncationSuffix = "…";

const normalizeApprovalDisplaySnapshot = (
  approval: ApprovalState,
): ApprovalDisplaySnapshot => {
  return {
    questionText: approval.questionText ?? null,
    displayTitle: approval.displayTitle ?? null,
    commandPreview: approval.commandPreview ?? null,
    justification: approval.justification ?? null,
    cwd: approval.cwd ?? null,
    requestKind: approval.requestKind ?? null,
    decisions: approval.decisions ?? null,
    resolvedProviderDecision: approval.resolvedProviderDecision ?? null,
    resolvedElsewhere: approval.resolvedElsewhere ?? false,
    resolvedBySurface: approval.resolvedBySurface ?? null,
  };
};

const toApprovalTitle = (snapshot: ApprovalDisplaySnapshot) => {
  return snapshot.displayTitle ?? fallbackApprovalTitle;
};

const toApprovalQuestion = (snapshot: ApprovalDisplaySnapshot) => {
  return snapshot.questionText
    ?? (snapshot.requestKind
      ? fallbackQuestionByRequestKind[snapshot.requestKind]
      : null)
    ?? fallbackApprovalQuestion;
};

const toApprovalSummary = (snapshot: ApprovalDisplaySnapshot) => {
  return snapshot.commandPreview ?? snapshot.displayTitle ?? fallbackApprovalTitle;
};

const toRemoteSurfaceLabel = (surface: string | null) => {
  if (surface === "codex_remote") {
    return "codex-remote";
  }

  if (surface === "discord_thread") {
    return "Discord";
  }

  if (surface === "system") {
    return "the system";
  }

  return "another surface";
};

const toLegacyButton = (
  providerDecision: string,
): ApprovalUiButton | null => {
  if (
    providerDecision === "accept"
    || providerDecision === "acceptForSession"
    || providerDecision === "acceptWithExecpolicyAmendment"
    || providerDecision === "applyNetworkPolicyAmendment"
  ) {
    return "approve";
  }

  if (providerDecision === "decline") {
    return "decline";
  }

  if (providerDecision === "cancel") {
    return "cancel";
  }

  return null;
};

const toLegacyButtons = (decisions: PersistedApprovalDecision[]) => {
  const seen = new Set<ApprovalUiButton>();
  const buttons: ApprovalUiButton[] = [];

  for (const decision of decisions) {
    const button = toLegacyButton(decision.providerDecision);

    if (!button || seen.has(button)) {
      continue;
    }

    seen.add(button);
    buttons.push(button);
  }

  return buttons;
};

const getRenderableApprovalDecisions = (
  snapshot: ApprovalDisplaySnapshot,
) => {
  return snapshot.decisions ?? legacyFallbackDecisions;
};

const toRemoteDecisionText = ({
  status,
  resolvedProviderDecision,
}: {
  status: ApprovalState["status"];
  resolvedProviderDecision: string | null;
}) => {
  if (status === "approved") {
    if (resolvedProviderDecision === "acceptForSession") {
      return "approved for this session";
    }

    return "approved";
  }

  if (status === "declined") {
    return "declined";
  }

  if (status === "canceled") {
    return "canceled";
  }

  return "resolved";
};

export const truncateApprovalText = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= approvalTruncationSuffix.length) {
    return approvalTruncationSuffix.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - approvalTruncationSuffix.length).trimEnd()}${approvalTruncationSuffix}`;
};

const truncateApprovalMiddleText = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= approvalTruncationSuffix.length) {
    return approvalTruncationSuffix.slice(0, maxLength);
  }

  const availableLength = maxLength - approvalTruncationSuffix.length;
  const prefixLength = Math.ceil(availableLength / 2);
  const suffixLength = Math.floor(availableLength / 2);

  return `${value.slice(0, prefixLength)}${approvalTruncationSuffix}${value.slice(
    value.length - suffixLength,
  )}`;
};

const sanitizeApprovalCommandPreview = (value: string) => {
  return value.replaceAll("```", "``\u200b`");
};

export const renderApprovalRequestIdText = (
  requestId: ApprovalState["requestId"],
) => {
  return `Request ID: \`${truncateApprovalMiddleText(
    requestId,
    approvalRequestIdCharacterLimit,
  )}\``;
};

const renderPendingApprovalBody = (
  approval: ApprovalState,
  snapshot: ApprovalDisplaySnapshot,
) => {
  const lines = [
    `**${truncateApprovalText(toApprovalQuestion(snapshot), approvalQuestionCharacterLimit)}**`,
  ];

  if (snapshot.commandPreview) {
    lines.push(
      "```sh",
      truncateApprovalText(
        sanitizeApprovalCommandPreview(snapshot.commandPreview),
        approvalCommandPreviewCharacterLimit,
      ),
      "```",
    );
  }

  if (snapshot.justification) {
    lines.push(
      truncateApprovalText(
        snapshot.justification,
        approvalJustificationCharacterLimit,
      ),
    );
  }

  const metadata: string[] = [];

  if (snapshot.cwd) {
    metadata.push(
      `CWD: \`${truncateApprovalText(snapshot.cwd, approvalCwdCharacterLimit)}\``,
    );
  }

  if (snapshot.requestKind) {
    metadata.push(
      `Kind: \`${truncateApprovalText(
        snapshot.requestKind,
        approvalRequestKindCharacterLimit,
      )}\``,
    );
  }

  if (metadata.length > 0) {
    lines.push(...metadata);
  }

  const content = lines.join("\n");

  return content.length <= discordMessageCharacterLimit
    ? content
    : truncateApprovalText(content, discordMessageCharacterLimit);
};

export const renderApprovalResultLine = ({
  status,
  commandPreview,
  displayTitle = null,
  resolvedProviderDecision = null,
  resolvedElsewhere = false,
  resolvedBySurface = null,
}: {
  status: ApprovalState["status"];
  commandPreview: string | null;
  displayTitle?: string | null;
  resolvedProviderDecision?: string | null;
  resolvedElsewhere?: boolean;
  resolvedBySurface?: string | null;
}) => {
  const summary = truncateApprovalText(
    commandPreview ?? displayTitle ?? fallbackApprovalTitle,
    approvalCommandPreviewCharacterLimit,
  );

  if (resolvedElsewhere) {
    return `Handled in ${toRemoteSurfaceLabel(resolvedBySurface)}: ${
      toRemoteDecisionText({
        status,
        resolvedProviderDecision,
      })
    } ${summary}`;
  }

  if (status === "approved") {
    if (resolvedProviderDecision === "acceptForSession") {
      return `Approved for this session: ${summary}`;
    }

    if (resolvedProviderDecision === "acceptWithExecpolicyAmendment") {
      return `Approved and saved for future matching commands: ${summary}`;
    }

    if (resolvedProviderDecision === "applyNetworkPolicyAmendment") {
      return `Approved and applied the network rule: ${summary}`;
    }

    return `Approved: ${summary}`;
  }

  if (status === "declined") {
    return `Declined and continuing without it: ${summary}`;
  }

  if (status === "canceled") {
    return `Canceled. The current turn was interrupted: ${summary}`;
  }

  return `Resolved: ${summary}`;
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

  if (approval.status !== "pending") {
    return {
      content: renderApprovalResultLine({
        status: approval.status,
        commandPreview: snapshot.commandPreview,
        displayTitle: snapshot.displayTitle,
        resolvedProviderDecision: snapshot.resolvedProviderDecision,
        resolvedElsewhere: snapshot.resolvedElsewhere,
        resolvedBySurface: snapshot.resolvedBySurface,
      }),
      buttons: [],
      decisions: [],
    };
  }

  return {
    content: renderPendingApprovalBody(approval, snapshot),
    buttons:
      snapshot.decisions === null
        ? defaultApprovalButtons
        : toLegacyButtons(snapshot.decisions),
    decisions: getRenderableApprovalDecisions(snapshot),
  };
};

export const renderApprovalStaleStatusText = ({
  approval,
}: {
  approval: ApprovalState;
}) => {
  const snapshot = normalizeApprovalDisplaySnapshot(approval);
  const summary = truncateApprovalText(
    toApprovalSummary(snapshot),
    approvalCommandPreviewCharacterLimit,
  );

  if (approval.status === "approved") {
    if (snapshot.resolvedElsewhere && snapshot.resolvedBySurface === "codex_remote") {
      return `This approval was already approved in codex-remote: ${summary}`;
    }

    return `This approval was already approved: ${summary}`;
  }

  if (approval.status === "declined") {
    return `This approval was already declined and Codex continued without it: ${summary}`;
  }

  if (approval.status === "canceled") {
    return `This approval was already canceled. The turn was interrupted: ${summary}`;
  }

  if (approval.status === "resolved") {
    if (snapshot.resolvedElsewhere && snapshot.resolvedBySurface === "codex_remote") {
      return `This approval was already resolved in codex-remote: ${summary}`;
    }

    return `This approval was already resolved elsewhere: ${summary}`;
  }

  return `${toApprovalTitle(snapshot)} is already ${approval.status}.`;
};

export const renderApprovalUi = ({
  approval,
  viewerId,
  ownerId,
}: ApprovalUiInput): ApprovalUiRender => {
  const snapshot = normalizeApprovalDisplaySnapshot(approval);
  const canShowControls =
    approval.status === "pending"
    && shouldShowApprovalControls({ viewerId, ownerId });

  const decisions = getRenderableApprovalDecisions(snapshot);

  if (canShowControls && decisions.length > 0) {
    return {
      kind: "controls",
      requestId: approval.requestId,
      status: approval.status,
      buttons: decisions,
    };
  }

  return {
    kind: "status-only",
    requestId: approval.requestId,
    status: approval.status,
  };
};
