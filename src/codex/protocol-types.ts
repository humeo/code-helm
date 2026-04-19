export type JsonRpcId = number | string;

export type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcRequest<TParams = unknown> = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: TParams;
};

export type JsonRpcNotification<TParams = unknown> = {
  jsonrpc?: "2.0";
  method: string;
  params?: TParams;
};

export type JsonRpcSuccess<TResult = unknown> = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result: TResult;
};

export type JsonRpcFailure = {
  jsonrpc?: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
};

export type JsonRpcIncomingMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export type JsonRpcOutgoingMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export type StartThreadParams = {
  cwd: string;
};

export type ThreadReadParams = {
  threadId: string;
  includeTurns?: boolean;
};

export type ThreadListParams = {
  archived?: boolean | null;
  cursor?: string | null;
  cwd?: string | null;
  limit?: number | null;
  searchTerm?: string | null;
  sortKey?: "created_at" | "updated_at" | null;
};

export type ResumeThreadParams = {
  threadId: string;
};

export type StartTurnParams = {
  threadId: string;
  input: unknown;
  approvalPolicy?: string;
  sandboxPolicy?: string;
};

export type ReplyToServerRequestParams = {
  requestId: JsonRpcId;
  decision: unknown;
};

export type NotificationPayload = Record<string, unknown> | undefined;

export type ApprovalRequestParams = {
  threadId: string;
  turnId: string;
  itemId: string;
} & Record<string, unknown>;

export type ApprovalRequestEvent = ApprovalRequestParams & {
  requestId: JsonRpcId;
};

export type ApprovalRequestDecisionPayload = {
  decision: string;
  label?: string | null;
  consequence?: string | null;
} & Record<string, unknown>;

const asApprovalDecisionPayload = (
  value: unknown,
): ApprovalRequestDecisionPayload | null => {
  if (typeof value === "string") {
    return {
      decision: value,
    };
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const providerDecisionCandidate =
    candidate.decision
    ?? candidate.providerDecision
    ?? candidate.key;

  if (typeof providerDecisionCandidate !== "string" || providerDecisionCandidate.length === 0) {
    return null;
  }

  const label =
    typeof candidate.label === "string"
      ? candidate.label
      : typeof candidate.title === "string"
        ? candidate.title
        : undefined;
  const consequence =
    typeof candidate.consequence === "string"
      ? candidate.consequence
      : candidate.consequence === null
        ? null
        : typeof candidate.description === "string"
          ? candidate.description
          : undefined;

  return {
    ...candidate,
    decision: providerDecisionCandidate,
    label,
    consequence,
  };
};

export const getApprovalRequestDecisionPayloads = (
  event: ApprovalRequestEvent,
): ApprovalRequestDecisionPayload[] | null => {
  const candidate = event as Record<string, unknown>;
  const availableDecisions =
    candidate.availableDecisions ?? candidate.available_decisions;

  if (!Array.isArray(availableDecisions)) {
    return null;
  }

  return availableDecisions
    .map(asApprovalDecisionPayload)
    .filter((payload): payload is ApprovalRequestDecisionPayload => payload !== null);
};

export const approvalRequestMethods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
] as const;

export type ApprovalRequestMethod = (typeof approvalRequestMethods)[number];

export type ServerRequestResolvedEvent = {
  threadId?: string;
  requestId: JsonRpcId;
} & Record<string, unknown>;

export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

export type CodexTextContentPart = {
  type: "text";
  text: string;
  text_elements?: unknown[];
} & Record<string, unknown>;

export type CodexUserMessageItem = {
  type: "userMessage";
  id: string;
  content: CodexTextContentPart[];
} & Record<string, unknown>;

export type CodexAgentMessageItem = {
  type: "agentMessage";
  id: string;
  text: string;
  phase?: string | null;
  memoryCitation?: unknown;
} & Record<string, unknown>;

export type CodexCommandExecutionItem = {
  type: "commandExecution";
  id: string;
  command: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
} & Record<string, unknown>;

export type CodexReasoningItem = {
  type: "reasoning";
  id: string;
  summary?: unknown[];
  content?: unknown[];
} & Record<string, unknown>;

export type CodexTurnItem =
  | CodexUserMessageItem
  | CodexAgentMessageItem
  | CodexCommandExecutionItem
  | CodexReasoningItem
  | ({
      type: string;
      id?: string;
    } & Record<string, unknown>);

export type CodexTurn = {
  id: string;
  items: CodexTurnItem[];
  status?: string;
  error?: unknown;
} & Record<string, unknown>;

export type CodexThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | {
      type: "active";
      activeFlags: ThreadActiveFlag[];
    };

export type CodexThread = {
  id: string;
  cwd: string;
  preview: string;
  status: CodexThreadStatus;
  name?: string | null;
  createdAt?: number;
  updatedAt?: number;
  turns?: CodexTurn[];
} & Record<string, unknown>;

export type ThreadStartResult = {
  thread: CodexThread;
  cwd: string;
} & Record<string, unknown>;

export type ThreadResumeResult = {
  thread: CodexThread;
  cwd: string;
} & Record<string, unknown>;

export type ThreadReadResult = {
  thread: CodexThread;
} & Record<string, unknown>;

export type ThreadListResult = {
  data: CodexThread[];
  nextCursor: string | null;
} & Record<string, unknown>;

export type RoutedEventMap = {
  "turn/started": {
    threadId?: string;
    turn?: {
      id?: string;
    };
  } & Record<string, unknown>;
  "turn/completed": {
    threadId?: string;
    turn?: CodexTurn & {
      result?: unknown;
    };
  } & Record<string, unknown>;
  "thread/status/changed": {
    threadId?: string;
    status?: CodexThreadStatus | string;
  } & Record<string, unknown>;
  "item/started": {
    threadId?: string;
    turnId?: string;
    item?: CodexTurnItem;
  } & Record<string, unknown>;
  "item/completed": {
    threadId?: string;
    turnId?: string;
    item?: CodexTurnItem;
  } & Record<string, unknown>;
  "item/agentMessage/delta": {
    threadId?: string;
    turnId?: string;
    itemId?: string;
    delta?: string;
  } & Record<string, unknown>;
  "item/commandExecution/requestApproval": ApprovalRequestEvent;
  "item/fileChange/requestApproval": ApprovalRequestEvent;
  "item/permissions/requestApproval": ApprovalRequestEvent;
  "serverRequest/resolved": ServerRequestResolvedEvent;
};

export const routedEventMethods = [
  "turn/started",
  "turn/completed",
  "thread/status/changed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "serverRequest/resolved",
] as const;

export type RoutedEventMethod = (typeof routedEventMethods)[number];

export const isRoutedEventMethod = (
  method: string,
): method is RoutedEventMethod => {
  return routedEventMethods.includes(method as RoutedEventMethod);
};

export const isApprovalRequestMethod = (
  method: string,
): method is ApprovalRequestMethod => {
  return approvalRequestMethods.includes(method as ApprovalRequestMethod);
};
