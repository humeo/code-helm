import { canControlSession } from "./session-service";
import type {
  ApprovalRequestDecisionPayload,
  ApprovalRequestMethod,
} from "../codex/protocol-types";
import type { SessionOwnership } from "./types";

export type ApprovalStatus =
  | "pending"
  | "resolved"
  | "approved"
  | "declined"
  | "canceled";

export type ApprovalRequestId = string | number;

export type ApprovalSnapshotFields = {
  questionText?: string | null;
  displayTitle?: string | null;
  commandPreview?: string | null;
  justification?: string | null;
  cwd?: string | null;
  requestKind?: string | null;
  decisions?: PersistedApprovalDecision[] | null;
  resolvedProviderDecision?: string | null;
  resolvedElsewhere?: boolean;
  resolvedBySurface?: string | null;
};

export type PersistedApprovalDecision = {
  key: string;
  providerDecision: string;
  label: string;
  consequence?: string | null;
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

const commandDecisionLabels: Record<string, string> = {
  accept: "Yes, proceed",
  acceptForSession: "Yes, and don't ask again for this command in this session",
  acceptWithExecpolicyAmendment:
    "Yes, proceed and save this decision for this command policy",
  applyNetworkPolicyAmendment:
    "Yes, proceed and apply this network policy amendment",
  decline: "No, continue without running it",
  cancel: "No, and tell Codex what to do differently",
};

const fileChangeDecisionLabels: Record<string, string> = {
  accept: "Yes, proceed",
  acceptForSession: "Yes, and don't ask again for these files",
  decline: "No, continue without applying it",
  cancel: "No, and tell Codex what to do differently",
};

const toDecisionLabelsByMethod = (
  requestMethod: ApprovalRequestMethod,
): Record<string, string> => {
  if (requestMethod === "item/commandExecution/requestApproval") {
    return commandDecisionLabels;
  }

  if (requestMethod === "item/fileChange/requestApproval") {
    return fileChangeDecisionLabels;
  }

  return {};
};

const humanizeProviderDecision = (providerDecision: string) => {
  return providerDecision
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (first) => first.toUpperCase());
};

export const createPersistedApprovalDecisions = ({
  availableDecisions,
  requestMethod,
}: {
  availableDecisions: ReadonlyArray<ApprovalRequestDecisionPayload | string>;
  requestMethod: ApprovalRequestMethod;
}) => {
  const labelsByDecision = toDecisionLabelsByMethod(requestMethod);
  const seen = new Set<string>();
  const decisions: PersistedApprovalDecision[] = [];

  for (const candidate of availableDecisions) {
    const normalizedCandidate =
      typeof candidate === "string"
        ? { decision: candidate }
        : candidate;
    const providerDecision = normalizedCandidate.decision?.trim();

    if (!providerDecision || seen.has(providerDecision)) {
      continue;
    }

    seen.add(providerDecision);
    decisions.push({
      key: providerDecision,
      providerDecision,
      label:
        normalizedCandidate.label?.trim()
        || labelsByDecision[providerDecision]
        || humanizeProviderDecision(providerDecision),
      consequence:
        normalizedCandidate.consequence !== undefined
          ? normalizedCandidate.consequence
          : null,
    });
  }

  return decisions;
};
