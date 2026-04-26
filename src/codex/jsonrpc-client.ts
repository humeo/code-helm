import { EventRouter } from "./event-router";
import { logger, type CodeHelmLogger } from "../logger";
import { readPackageMetadata } from "../package-metadata";
import {
  isApprovalRequestMethod,
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
  type ModelListParams,
  type ModelListResult,
  type GetAccountRateLimitsResult,
  type ThreadListParams,
  type ThreadListResult,
  type ThreadReadParams,
  type ThreadReadResult,
  type ReplyToServerRequestParams,
  type ResumeThreadParams,
  type RoutedEventMap,
  type ServerRequestResolvedEvent,
  type StartThreadParams,
  type StartTurnParams,
  type TurnInterruptParams,
  type TurnSteerParams,
  type ThreadResumeResult,
  type ThreadStartResult,
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
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

type JsonRpcClientOptions = {
  transport?: JsonRpcTransport;
};

export type JsonRpcRequestOptions = {
  timeoutMs?: number;
  timeoutMessage?: string;
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
const packageMetadata = readPackageMetadata();
const initializeParams = {
  clientInfo: {
    name: packageMetadata.name,
    title: "CodeHelm",
    version: packageMetadata.version,
  },
  capabilities: {
    experimentalApi: true,
  },
} as const;

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
  private connectReject: ((error: Error) => void) | undefined;

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

      this.connectReject = reject;
      this.socket = socket;
      socket.onopen = () => {
        this.connectPromise = undefined;
        this.connectReject = undefined;
        resolve();
      };
      socket.onmessage = (event) => {
        this.handlers.onMessage(toTransportMessage(event.data));
      };
      socket.onclose = () => {
        if (this.connectReject) {
          const rejectConnect = this.connectReject;

          this.connectPromise = undefined;
          this.connectReject = undefined;
          rejectConnect(new Error("JSON-RPC transport closed"));
        }
        this.handlers.onClose?.();
      };
      socket.onerror = (error) => {
        const nextError = new Error("JSON-RPC transport error");

        this.handlers.onError?.(error);
        this.connectPromise = undefined;
        this.connectReject = undefined;
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
  private readonly pendingApprovalRequests = new Map<JsonRpcId, ApprovalRequestEvent>();
  private readonly log: CodeHelmLogger;

  private nextRequestId = 1;
  private initializePromise: Promise<void> | undefined;
  private isInitialized = false;

  lastApprovalRequest: ApprovalRequestEvent | undefined;
  lastResolvedRequest: ServerRequestResolvedEvent | undefined;

  constructor(
    private readonly url: string,
    options: JsonRpcClientOptions = {},
  ) {
    this.log = logger.child({
      component: "codex",
      operation: "jsonrpc",
      appServerAddress: url,
    });
    this.transport = options.transport ?? new WebSocketTransport(url);
    this.transport.setHandlers({
      onMessage: (message) => {
        this.handleRawMessage(message);
      },
      onClose: () => {
        this.log.warn("JSON-RPC transport closed", {
          pendingRequestCount: this.pendingRequests.size,
        });
        this.rejectPendingRequests(new Error("JSON-RPC transport closed"));
        this.isInitialized = false;
        this.initializePromise = undefined;
      },
      onError: (error) => {
        this.log.error("JSON-RPC transport error", error);
        this.rejectPendingRequests(
          error instanceof Error
            ? error
            : new Error("JSON-RPC transport error"),
        );
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
      await this.sendRequest("initialize", initializeParams);
      this.sendNotification("initialized", {});
      this.isInitialized = true;
      this.log.info("JSON-RPC client initialized");
    })();

    try {
      await this.initializePromise;
      this.initializePromise = undefined;
    } catch (error) {
      this.log.error("JSON-RPC client initialization failed", error);
      this.initializePromise = undefined;
      throw error;
    }
  }

  async startThread(params: StartThreadParams) {
    await this.initialize();
    return this.sendRequest<ThreadStartResult>("thread/start", params);
  }

  async resumeThread(params: ResumeThreadParams, options?: JsonRpcRequestOptions) {
    await this.initialize();
    return this.sendRequest<ThreadResumeResult>("thread/resume", params, options);
  }

  async readThread(params: ThreadReadParams, options?: JsonRpcRequestOptions) {
    await this.initialize();
    return this.sendRequest<ThreadReadResult>("thread/read", params, options);
  }

  async listThreads(params: ThreadListParams = {}) {
    await this.initialize();
    return this.sendRequest<ThreadListResult>("thread/list", params);
  }

  async startTurn(params: StartTurnParams) {
    await this.initialize();
    return this.sendRequest("turn/start", params);
  }

  async turnSteer(params: TurnSteerParams) {
    await this.initialize();
    return this.sendRequest("turn/steer", params);
  }

  async turnInterrupt(params: TurnInterruptParams) {
    await this.initialize();
    return this.sendRequest("turn/interrupt", params);
  }

  async listModels(params: ModelListParams = {}) {
    await this.initialize();
    return this.sendRequest<ModelListResult>("model/list", params);
  }

  async getAccountRateLimits() {
    await this.initialize();
    return this.sendRequest<GetAccountRateLimitsResult>("account/rateLimits/read");
  }

  async replyToServerRequest({
    requestId,
    result,
  }: ReplyToServerRequestParams) {
    await this.initialize();
    logger.debug("Sending server request reply", {
      requestId,
      requestIdType: typeof requestId,
      result,
    });
    this.sendMessage({
      jsonrpc: "2.0",
      id: requestId,
      result,
    });
  }

  handleMessage(message: JsonRpcIncomingMessage) {
    if ("method" in message && typeof message.method === "string") {
      this.routeIncomingMethod(message as JsonRpcRequest | JsonRpcNotification);
      return;
    }

    if ("result" in message && "id" in message) {
      const pendingRequest = this.takePendingRequest(message.id);

      if (!pendingRequest) {
        return;
      }

      this.log.debug("JSON-RPC request completed", {
        requestId: message.id,
        method: pendingRequest.method,
      });
      pendingRequest.resolve(message.result);
      return;
    }

    if ("error" in message) {
      const failure = message as JsonRpcFailure;

      if (failure.id === null) {
        return;
      }

      const pendingRequest = this.takePendingRequest(failure.id);

      if (!pendingRequest) {
        return;
      }

      this.log.warn("JSON-RPC request failed", {
        requestId: failure.id,
        method: pendingRequest.method,
        error: failure.error,
      });
      pendingRequest.reject(new Error(failure.error.message));
    }
  }

  close(code?: number, reason?: string) {
    this.transport.close(code, reason);
  }

  getPendingApprovalRequest(requestId: JsonRpcId) {
    return this.pendingApprovalRequests.get(requestId);
  }

  getPendingRequestCount() {
    return this.pendingRequests.size;
  }

  private handleRawMessage(rawMessage: string) {
    try {
      this.handleMessage(JSON.parse(rawMessage) as JsonRpcIncomingMessage);
    } catch (error) {
      this.log.error("Failed to parse JSON-RPC message", {
        messageLength: rawMessage.length,
        error,
      });
      throw error;
    }
  }

  private routeIncomingMethod(message: JsonRpcRequest | JsonRpcNotification) {
    const { method } = message;

    if (!isRoutedEventMethod(method)) {
      return;
    }

    if (isApprovalRequestMethod(method)) {
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

  private sendRequest<TResult = unknown>(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {},
  ) {
    const id = this.nextRequestId++;

    return new Promise<TResult>((resolve, reject) => {
      const pendingRequest: PendingRequest = {
        method,
        resolve: (result) => {
          resolve(result as TResult);
        },
        reject,
      };

      if (options.timeoutMs !== undefined) {
        pendingRequest.timeout = setTimeout(() => {
          const timedOutRequest = this.takePendingRequest(id);

          if (!timedOutRequest) {
            return;
          }

          this.log.warn("JSON-RPC request timed out", {
            requestId: id,
            method,
          });
          timedOutRequest.reject(new Error(
            options.timeoutMessage ?? `JSON-RPC request timed out for ${method}`,
          ));
        }, options.timeoutMs);
      }

      this.pendingRequests.set(id, pendingRequest);

      try {
        this.sendMessage({
          jsonrpc: "2.0",
          id,
          method,
          params,
        });
        this.log.debug("JSON-RPC request sent", {
          requestId: id,
          method,
        });
      } catch (error) {
        this.takePendingRequest(id);
        this.log.error("JSON-RPC request send failed", {
          requestId: id,
          method,
          error,
        });
        reject(error instanceof Error ? error : new Error("Failed to send JSON-RPC request"));
      }
    });
  }

  private takePendingRequest(id: JsonRpcId) {
    const pendingRequest = this.pendingRequests.get(id);

    if (!pendingRequest) {
      return undefined;
    }

    this.pendingRequests.delete(id);

    if (pendingRequest.timeout) {
      clearTimeout(pendingRequest.timeout);
    }

    return pendingRequest;
  }

  private rejectPendingRequests(error: Error) {
    for (const pendingRequest of this.pendingRequests.values()) {
      if (pendingRequest.timeout) {
        clearTimeout(pendingRequest.timeout);
      }

      pendingRequest.reject(error);
    }

    this.pendingRequests.clear();
  }
}

export type { RoutedEventMap };
