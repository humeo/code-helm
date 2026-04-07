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

export type ServerRequestResolvedEvent = {
  requestId: JsonRpcId;
} & Record<string, unknown>;

export type RoutedEventMap = {
  "turn/started": NotificationPayload;
  "turn/completed": NotificationPayload;
  "thread/status/changed": NotificationPayload;
  "item/started": NotificationPayload;
  "item/completed": NotificationPayload;
  "item/commandExecution/requestApproval": ApprovalRequestEvent;
  "serverRequest/resolved": ServerRequestResolvedEvent;
};

export const routedEventMethods = [
  "turn/started",
  "turn/completed",
  "thread/status/changed",
  "item/started",
  "item/completed",
  "item/commandExecution/requestApproval",
  "serverRequest/resolved",
] as const;

export type RoutedEventMethod = (typeof routedEventMethods)[number];

export const isRoutedEventMethod = (
  method: string,
): method is RoutedEventMethod => {
  return routedEventMethods.includes(method as RoutedEventMethod);
};
