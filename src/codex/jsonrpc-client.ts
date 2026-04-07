import { EventRouter } from "./event-router";
import {
  isRoutedEventMethod,
  type ApprovalRequestEvent,
  type ApprovalRequestParams,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcIncomingMessage,
  type JsonRpcNotification,
  type JsonRpcOutgoingMessage,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type ReplyToServerRequestParams,
  type ResumeThreadParams,
  type RoutedEventMap,
  type ServerRequestResolvedEvent,
  type StartThreadParams,
  type StartTurnParams,
} from "./protocol-types";

export type TransportHandlers = {
  onMessage: (message: string) => void;
  onClose?: () => void;
  onError?: (error: unknown) => void;
};

export interface JsonRpcTransport {
  connect(): Promise<void>;
  setHandlers(handlers: TransportHandlers): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type JsonRpcClientOptions = {
  transport?: JsonRpcTransport;
};

type WebSocketLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

const webSocketOpenState = 1;

const toRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
};

const toTransportMessage = (data: unknown) => {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }

  throw new Error("Received non-text JSON-RPC message");
};

class WebSocketTransport implements JsonRpcTransport {
  private socket: WebSocketLike | undefined;
  private handlers: TransportHandlers = {
    onMessage() {},
  };
  private connectPromise: Promise<void> | undefined;

  constructor(private readonly url: string) {}

  setHandlers(handlers: TransportHandlers) {
    this.handlers = handlers;
  }

  connect() {
    if (this.socket && this.socket.readyState === webSocketOpenState) {
      return Promise.resolve();
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url) as unknown as WebSocketLike;

      this.socket = socket;
      socket.onopen = () => {
        this.connectPromise = undefined;
        resolve();
      };
      socket.onmessage = (event) => {
        this.handlers.onMessage(toTransportMessage(event.data));
      };
      socket.onclose = () => {
        this.handlers.onClose?.();
      };
      socket.onerror = (error) => {
        const nextError = new Error("JSON-RPC transport error");

        this.handlers.onError?.(error);
        this.connectPromise = undefined;
        reject(nextError);
      };
    });

    return this.connectPromise;
  }

  send(message: string) {
    if (!this.socket || this.socket.readyState !== webSocketOpenState) {
      throw new Error("JSON-RPC transport is not connected");
    }

    this.socket.send(message);
  }

  close(code?: number, reason?: string) {
    this.socket?.close(code, reason);
  }
}

export class JsonRpcClient {
  private readonly transport: JsonRpcTransport;
  private readonly eventRouter = new EventRouter<RoutedEventMap>();
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  readonly pendingApprovalRequests = new Map<JsonRpcId, ApprovalRequestEvent>();

  private nextRequestId = 1;
  private initializePromise: Promise<void> | undefined;
  private isInitialized = false;

  lastApprovalRequest: ApprovalRequestEvent | undefined;
  lastResolvedRequest: ServerRequestResolvedEvent | undefined;

  constructor(
    private readonly url: string,
    options: JsonRpcClientOptions = {},
  ) {
    this.transport = options.transport ?? new WebSocketTransport(url);
    this.transport.setHandlers({
      onMessage: (message) => {
        this.handleRawMessage(message);
      },
      onClose: () => {
        this.isInitialized = false;
        this.initializePromise = undefined;
      },
      onError: (error) => {
        for (const pendingRequest of this.pendingRequests.values()) {
          pendingRequest.reject(
            error instanceof Error
              ? error
              : new Error("JSON-RPC transport error"),
          );
        }
        this.pendingRequests.clear();
        this.isInitialized = false;
        this.initializePromise = undefined;
      },
    });
  }

  on<TKey extends keyof RoutedEventMap>(
    eventName: TKey,
    handler: (event: RoutedEventMap[TKey]) => void,
  ) {
    return this.eventRouter.subscribe(eventName, handler);
  }

  async initialize() {
    if (this.isInitialized) {
      return;
    }

    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = (async () => {
      await this.transport.connect();
      await this.sendRequest("initialize", {});
      this.sendNotification("initialized", {});
      this.isInitialized = true;
    })();

    try {
      await this.initializePromise;
      this.initializePromise = undefined;
    } catch (error) {
      this.initializePromise = undefined;
      throw error;
    }
  }

  async startThread(params: StartThreadParams) {
    await this.initialize();
    return this.sendRequest("thread/start", params);
  }

  async resumeThread(params: ResumeThreadParams) {
    await this.initialize();
    return this.sendRequest("thread/resume", params);
  }

  async startTurn(params: StartTurnParams) {
    await this.initialize();
    return this.sendRequest("turn/start", params);
  }

  async replyToServerRequest({
    requestId,
    decision,
  }: ReplyToServerRequestParams) {
    await this.initialize();
    this.sendMessage({
      jsonrpc: "2.0",
      id: requestId,
      result: { decision },
    });
  }

  handleMessage(message: JsonRpcIncomingMessage) {
    if ("method" in message && typeof message.method === "string") {
      this.routeIncomingMethod(message as JsonRpcRequest | JsonRpcNotification);
      return;
    }

    if ("result" in message && "id" in message) {
      const pendingRequest = this.pendingRequests.get(message.id);

      if (!pendingRequest) {
        return;
      }

      this.pendingRequests.delete(message.id);
      pendingRequest.resolve(message.result);
      return;
    }

    if ("error" in message) {
      const failure = message as JsonRpcFailure;

      if (failure.id === null) {
        return;
      }

      const pendingRequest = this.pendingRequests.get(failure.id);

      if (!pendingRequest) {
        return;
      }

      this.pendingRequests.delete(failure.id);
      pendingRequest.reject(new Error(failure.error.message));
    }
  }

  close(code?: number, reason?: string) {
    this.transport.close(code, reason);
  }

  private handleRawMessage(rawMessage: string) {
    this.handleMessage(JSON.parse(rawMessage) as JsonRpcIncomingMessage);
  }

  private routeIncomingMethod(message: JsonRpcRequest | JsonRpcNotification) {
    const { method } = message;

    if (!isRoutedEventMethod(method)) {
      return;
    }

    if (method === "item/commandExecution/requestApproval") {
      if (!("id" in message)) {
        return;
      }

      const approvalEvent = {
        ...toRecord(message.params) as ApprovalRequestParams,
        requestId: message.id,
      };

      this.lastApprovalRequest = approvalEvent;
      this.pendingApprovalRequests.set(approvalEvent.requestId, approvalEvent);
      this.eventRouter.publish(method, approvalEvent);
      return;
    }

    if (method === "serverRequest/resolved") {
      const params = toRecord(message.params);
      const requestId =
        (params.requestId as JsonRpcId | undefined) ??
        ("id" in message ? message.id : undefined);

      if (requestId === undefined) {
        return;
      }

      const resolvedEvent = {
        ...params,
        requestId,
      };

      this.lastResolvedRequest = resolvedEvent;
      this.pendingApprovalRequests.delete(requestId);
      this.eventRouter.publish(method, resolvedEvent);
      return;
    }

    this.eventRouter.publish(method, message.params as RoutedEventMap[typeof method]);
  }

  private sendNotification(method: string, params?: unknown) {
    this.sendMessage({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  private sendMessage(message: JsonRpcOutgoingMessage) {
    this.transport.send(JSON.stringify(message));
  }

  private sendRequest<TResult = unknown>(method: string, params?: unknown) {
    const id = this.nextRequestId++;

    this.sendMessage({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return new Promise<TResult>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (result) => {
          resolve(result as TResult);
        },
        reject,
      });
    });
  }
}

export type { RoutedEventMap };
