import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonRpcClient,
  type JsonRpcTransport,
  type TransportHandlers,
} from "../../src/codex/jsonrpc-client";
import { readThreadForSnapshotReconciliation } from "../../src/index";
import type { StartTurnParams } from "../../src/codex/protocol-types";
import { SessionController } from "../../src/codex/session-controller";
import { initializeLogger, shutdownLogger } from "../../src/logger";
import { readPackageMetadata } from "../../src/package-metadata";

const createTransportStub = () => {
  const sent: string[] = [];
  let handlers: TransportHandlers | undefined;
  let isClosed = false;

  const transport: JsonRpcTransport = {
    async connect() {
      isClosed = false;
    },
    setHandlers(nextHandlers) {
      handlers = nextHandlers;
    },
    send(message) {
      if (isClosed) {
        throw new Error("transport closed");
      }
      sent.push(message);
    },
    close() {
      isClosed = true;
      handlers?.onClose?.();
    },
  };

  return {
    transport,
    sent,
    receive(message: unknown) {
      handlers?.onMessage(JSON.stringify(message));
    },
    fail(error: unknown) {
      handlers?.onError?.(error);
    },
    close() {
      transport.close();
    },
  };
};

const readLogRecords = (logDir: string) => {
  return readFileSync(join(logDir, "codehelm-2026-04-26.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const readSentMethods = (sent: string[]) =>
  sent
    .map((message) => JSON.parse(message) as { method?: string })
    .map((message) => message.method)
    .filter((method): method is string => typeof method === "string");

const initializeClient = async (client: JsonRpcClient, stub: ReturnType<typeof createTransportStub>) => {
  const initializePromise = client.initialize();

  await Promise.resolve();
  stub.receive({ id: 1, result: {} });
  await initializePromise;
};

test("routes command requestApproval and resolved events to subscribers", async () => {
  const client = new JsonRpcClient("ws://example.test");
  const seenApproval: Array<number | string> = [];
  const seenResolved: Array<number | string> = [];

  const unsubscribeApproval = client.on(
    "item/commandExecution/requestApproval",
    (event) => {
      seenApproval.push(event.requestId);
    },
  );
  const unsubscribe = client.on("serverRequest/resolved", (event) => {
    seenResolved.push(event.requestId);
  });

  client.handleMessage({
    method: "item/commandExecution/requestApproval",
    id: 7,
    params: { threadId: "t1", turnId: "turn1", itemId: "call1" },
  });

  expect(seenApproval).toEqual([7]);
  expect(client.lastApprovalRequest?.requestId).toBe(7);
  expect(client.getPendingApprovalRequest(7)?.itemId).toBe("call1");

  client.handleMessage({
    method: "serverRequest/resolved",
    params: { requestId: 7 },
  });

  expect(seenResolved).toEqual([7]);
  expect(client.getPendingApprovalRequest(7)).toBeUndefined();

  unsubscribeApproval();
  unsubscribe();
});

test("routes file and permissions approval requests to subscribers", () => {
  const client = new JsonRpcClient("ws://example.test");
  const seenFileApproval: Array<number | string> = [];
  const seenPermissionsApproval: Array<number | string> = [];

  const unsubscribeFileApproval = client.on(
    "item/fileChange/requestApproval",
    (event) => {
      seenFileApproval.push(event.requestId);
    },
  );
  const unsubscribePermissionsApproval = client.on(
    "item/permissions/requestApproval",
    (event) => {
      seenPermissionsApproval.push(event.requestId);
    },
  );

  client.handleMessage({
    method: "item/fileChange/requestApproval",
    id: 8,
    params: { threadId: "t1", turnId: "turn1", itemId: "file1" },
  });
  client.handleMessage({
    method: "item/permissions/requestApproval",
    id: 9,
    params: { threadId: "t1", turnId: "turn1", itemId: "perm1" },
  });

  expect(seenFileApproval).toEqual([8]);
  expect(seenPermissionsApproval).toEqual([9]);
  expect(client.getPendingApprovalRequest(8)?.itemId).toBe("file1");
  expect(client.getPendingApprovalRequest(9)?.itemId).toBe("perm1");

  unsubscribeFileApproval();
  unsubscribePermissionsApproval();
});

test("routes agentMessage delta events to subscribers", () => {
  const client = new JsonRpcClient("ws://example.test");
  const seen: Array<{ itemId?: string; delta?: string }> = [];
  const unsubscribe = client.on("item/agentMessage/delta", (event) => {
    seen.push({
      itemId: event.itemId,
      delta: event.delta,
    });
  });

  client.handleMessage({
    method: "item/agentMessage/delta",
    params: {
      threadId: "t1",
      turnId: "turn1",
      itemId: "msg1",
      delta: "Running",
    },
  });

  expect(seen).toEqual([
    {
      itemId: "msg1",
      delta: "Running",
    },
  ]);

  unsubscribe();
});

test("routes thread token-usage updates to subscribers", () => {
  const client = new JsonRpcClient("ws://example.test");
  const seen: Array<{ threadId?: string; totalTokens?: number }> = [];
  const unsubscribe = client.on("thread/tokenUsage/updated", (event) => {
    seen.push({
      threadId: event.threadId,
      totalTokens: event.tokenUsage?.total.totalTokens,
    });
  });

  client.handleMessage({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "t1",
      turnId: "turn1",
      tokenUsage: {
        total: {
          totalTokens: 2048,
          inputTokens: 1024,
          cachedInputTokens: 24,
          outputTokens: 1000,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: 2048,
          inputTokens: 1024,
          cachedInputTokens: 24,
          outputTokens: 1000,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 272000,
      },
    },
  });

  expect(seen).toEqual([
    {
      threadId: "t1",
      totalTokens: 2048,
    },
  ]);

  unsubscribe();
});

test("initialize sends initialize request before initialized notification", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });
  const expectedMetadata = readPackageMetadata();
  const initializePromise = client.initialize();

  await Promise.resolve();

  expect(stub.sent).toHaveLength(1);
  expect(JSON.parse(stub.sent[0])).toMatchObject({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: expectedMetadata.name,
        title: "CodeHelm",
        version: expectedMetadata.version,
      },
      capabilities: {
        experimentalApi: true,
      },
    },
  });

  stub.receive({ id: 1, result: { serverInfo: { name: "codex-app" } } });
  await initializePromise;

  expect(JSON.parse(stub.sent[1])).toMatchObject({
    jsonrpc: "2.0",
    method: "initialized",
  });
});

test("debug logging records JSON-RPC request lifecycle without payloads", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "codehelm-jsonrpc-log-"));
  const stub = createTransportStub();

  initializeLogger({
    env: {
      CODE_HELM_LOG_DIR: logDir,
      CODE_HELM_LOG_LEVEL: "debug",
    },
    console: false,
    now: () => new Date(2026, 3, 26, 12),
  });

  try {
    const client = new JsonRpcClient("ws://example.test", {
      transport: stub.transport,
    });
    const startPromise = client.startThread({ cwd: "/tmp/project" });

    await Promise.resolve();
    stub.receive({ id: 1, result: {} });
    await Bun.sleep(0);
    stub.receive({
      id: 2,
      result: {
        thread: {
          id: "thread-123",
          cwd: "/tmp/project",
          preview: "hello",
          status: { type: "idle" },
        },
      },
    });
    await startPromise;
    shutdownLogger();

    const records = readLogRecords(logDir);
    const sent = records.find((record) =>
      record.msg === "JSON-RPC request sent"
      && record.method === "thread/start"
    );
    const completed = records.find((record) =>
      record.msg === "JSON-RPC request completed"
      && record.method === "thread/start"
    );

    expect(sent).toMatchObject({
      component: "codex",
      operation: "jsonrpc",
      requestId: 2,
      method: "thread/start",
    });
    expect(completed).toMatchObject({
      component: "codex",
      operation: "jsonrpc",
      requestId: 2,
      method: "thread/start",
    });
    expect(sent?.params).toBeUndefined();
    expect(completed?.result).toBeUndefined();
  } finally {
    shutdownLogger();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("replies to server requests with the original request id and arbitrary result payloads", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });

  const initializePromise = client.initialize();

  await Promise.resolve();
  stub.receive({ id: 1, result: {} });
  await initializePromise;

  client.handleMessage({
    method: "item/commandExecution/requestApproval",
    id: 9,
    params: { threadId: "t1", turnId: "turn1", itemId: "call1" },
  });
  await client.replyToServerRequest({
    requestId: 9,
    result: {
      permissions: {
        network: { enabled: true },
      },
      scope: "session",
    },
  });

  expect(JSON.parse(stub.sent[2])).toEqual({
    jsonrpc: "2.0",
    id: 9,
    result: {
      permissions: {
        network: { enabled: true },
      },
      scope: "session",
    },
  });
});

test("pending approval state is populated and then cleared on resolution", () => {
  const client = new JsonRpcClient("ws://example.test");

  client.handleMessage({
    method: "item/commandExecution/requestApproval",
    id: 11,
    params: { threadId: "t1", turnId: "turn1", itemId: "call1" },
  });

  expect(client.getPendingApprovalRequest(11)?.threadId).toBe("t1");

  client.handleMessage({
    method: "serverRequest/resolved",
    params: { requestId: 11 },
  });

  expect(client.getPendingApprovalRequest(11)).toBeUndefined();
});

test("rejects and clears in-flight RPCs when the transport closes", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });

  const initializePromise = client.initialize();

  await Promise.resolve();
  stub.receive({ id: 1, result: {} });
  await initializePromise;

  const threadPromise = client.startThread({ cwd: "/tmp/project" });

  await Promise.resolve();
  stub.close();

  await expect(threadPromise).rejects.toThrow("JSON-RPC transport closed");
  expect(client.getPendingRequestCount()).toBe(0);
});

test("timed-out readThread requests clear their pending entry", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });

  await initializeClient(client, stub);

  const readPromise = client.readThread(
    {
      threadId: "thread-timeout",
      includeTurns: true,
    },
    {
      timeoutMs: 1,
      timeoutMessage: "readThread timed out",
    },
  );

  await Promise.resolve();
  expect(client.getPendingRequestCount()).toBe(1);

  const outcome = await Promise.race([
    readPromise.then(() => "resolved", (error) => `rejected:${(error as Error).message}`),
    Bun.sleep(20).then(() => "still-pending"),
  ]);

  expect(outcome).toBe("rejected:readThread timed out");
  expect(client.getPendingRequestCount()).toBe(0);
});

test("late readThread responses after timeout are ignored", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });

  await initializeClient(client, stub);

  const readPromise = client.readThread(
    {
      threadId: "thread-late",
      includeTurns: true,
    },
    {
      timeoutMs: 1,
      timeoutMessage: "readThread timed out",
    },
  );
  const outcomePromise = readPromise.then(
    () => "resolved",
    (error) => `rejected:${(error as Error).message}`,
  );

  await Bun.sleep(5);
  stub.receive({
    id: 2,
    result: {
      thread: {
        id: "thread-late",
        cwd: "/tmp/project",
        preview: "",
        status: { type: "idle" },
      },
    },
  });

  const outcome = await Promise.race([
    outcomePromise,
    Bun.sleep(20).then(() => "still-pending"),
  ]);

  expect(outcome).toBe("rejected:readThread timed out");
  expect(client.getPendingRequestCount()).toBe(0);
});

test("snapshot read timeout ignores late not-loaded errors without resuming", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });

  await initializeClient(client, stub);

  const readPromise = readThreadForSnapshotReconciliation({
    codexClient: client,
    threadId: "thread-late-error",
    timeoutMs: 1,
    timeoutMessage: "snapshot read timed out",
  });
  const outcomePromise = readPromise.then(
    () => "resolved",
    (error) => `rejected:${(error as Error).message}`,
  );

  await Bun.sleep(5);
  stub.receive({
    id: 2,
    error: {
      code: -32000,
      message: "thread not loaded: thread-late-error",
    },
  });
  await Promise.resolve();

  expect(readSentMethods(stub.sent)).not.toContain("thread/resume");

  const outcome = await Promise.race([
    outcomePromise,
    Bun.sleep(20).then(() => "still-pending"),
  ]);

  expect(outcome).toBe("rejected:snapshot read timed out");
  expect(client.getPendingRequestCount()).toBe(0);
});

test("synchronous loopback transports resolve requests without dropping replies", async () => {
  let handlers: TransportHandlers | undefined;

  const transport: JsonRpcTransport = {
    async connect() {},
    setHandlers(nextHandlers) {
      handlers = nextHandlers;
    },
    send(message) {
      const parsed = JSON.parse(message) as {
        id?: number | string;
        method?: string;
      };

      if (parsed.id === undefined || !parsed.method) {
        return;
      }

      handlers?.onMessage(
        JSON.stringify({
          id: parsed.id,
          result:
            parsed.method === "initialize"
              ? { serverInfo: { name: "codex-app" } }
              : { threadId: "thread-sync" },
        }),
      );
    },
    close() {},
  };

  const client = new JsonRpcClient("ws://example.test", { transport });
  const result = await Promise.race([
    client.startThread({ cwd: "/tmp/project" }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("request timed out")), 50);
    }),
  ]);

  expect(result).toEqual({ threadId: "thread-sync" });
});

test("default transport rejects initialize if the socket closes before opening", async () => {
  const OriginalWebSocket = globalThis.WebSocket;
  const socket = {
    readyState: 0,
    onopen: null as ((event: unknown) => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as ((event: unknown) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    send() {},
    close() {
      socket.readyState = 3;
      socket.onclose?.({});
    },
  };

  (globalThis as { WebSocket: typeof WebSocket }).WebSocket = class {
    constructor(url: string) {
      void url;
      return socket as unknown as WebSocket;
    }
  } as unknown as typeof WebSocket;

  try {
    const client = new JsonRpcClient("ws://example.test");
    const initializePromise = Promise.race([
      client.initialize(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("initialize timed out")), 50);
      }),
    ]);

    socket.onclose?.({});

    await expect(initializePromise).rejects.toThrow("JSON-RPC transport closed");
  } finally {
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket =
      OriginalWebSocket;
  }
});

test("session controller updates active thread only after startTurn succeeds", async () => {
  let shouldReject = true;

  const controller = new SessionController({
    initialize() {
      return Promise.resolve();
    },
    startThread() {
      return Promise.resolve(undefined);
    },
    resumeThread() {
      return Promise.resolve(undefined);
    },
    startTurn(params: StartTurnParams) {
      if (shouldReject) {
        return Promise.reject(new Error(`turn failed for ${params.threadId}`));
      }

      return Promise.resolve({ ok: true });
    },
    replyToServerRequest() {
      return Promise.resolve();
    },
  } as unknown as JsonRpcClient);

  controller.activeThreadId = "existing-thread";
  await expect(
    controller.startTurn({ threadId: "next-thread", input: "hi" }),
  ).rejects.toThrow("turn failed for next-thread");
  expect(controller.activeThreadId).toBe("existing-thread");

  shouldReject = false;
  await controller.startTurn({ threadId: "next-thread", input: "hi" });
  expect(controller.activeThreadId).toBe("next-thread");
});

test("session controller reads active thread id from thread/start result.thread.id", async () => {
  const controller = new SessionController({
    initialize() {
      return Promise.resolve();
    },
    startThread() {
      return Promise.resolve({
        thread: {
          id: "thread-from-start",
          cwd: "/tmp/project",
          preview: "",
          status: { type: "idle" },
        },
      });
    },
    resumeThread() {
      return Promise.resolve(undefined);
    },
    startTurn() {
      return Promise.resolve(undefined);
    },
    replyToServerRequest() {
      return Promise.resolve();
    },
  } as unknown as JsonRpcClient);

  await controller.startThread({ cwd: "/tmp/project" });

  expect(controller.activeThreadId).toBe("thread-from-start");
});

test("readThread sends the official thread/read request", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });

  const readPromise = client.readThread({
    threadId: "thread-123",
    includeTurns: true,
  });

  await Promise.resolve();
  expect(JSON.parse(stub.sent[0])).toMatchObject({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });

  stub.receive({ id: 1, result: {} });
  await Bun.sleep(0);

  expect(JSON.parse(stub.sent[2])).toMatchObject({
    jsonrpc: "2.0",
    id: 2,
    method: "thread/read",
    params: {
      threadId: "thread-123",
      includeTurns: true,
    },
  });

  stub.receive({
    id: 2,
    result: {
      thread: {
        id: "thread-123",
        cwd: "/tmp/project",
        preview: "hello",
        status: { type: "idle" },
      },
    },
  });

  await expect(readPromise).resolves.toEqual({
    thread: {
      id: "thread-123",
      cwd: "/tmp/project",
      preview: "hello",
      status: { type: "idle" },
    },
  });
});

test("listThreads supports cwd filtering via thread/list", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });

  const listPromise = client.listThreads({
    cwd: "/tmp/project",
    limit: 5,
  });

  await Promise.resolve();
  stub.receive({ id: 1, result: {} });
  await Bun.sleep(0);

  expect(JSON.parse(stub.sent[2])).toMatchObject({
    jsonrpc: "2.0",
    id: 2,
    method: "thread/list",
    params: {
      cwd: "/tmp/project",
      limit: 5,
    },
  });

  stub.receive({
    id: 2,
    result: {
      data: [
        {
          id: "thread-123",
          cwd: "/tmp/project",
          preview: "hello",
          status: { type: "notLoaded" },
        },
      ],
      nextCursor: null,
    },
  });

  await expect(listPromise).resolves.toEqual({
    data: [
      {
        id: "thread-123",
        cwd: "/tmp/project",
        preview: "hello",
        status: { type: "notLoaded" },
      },
    ],
    nextCursor: null,
  });
});

test("turnSteer sends turn/steer with expected turn id", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });

  const steerPromise = client.turnSteer({
    threadId: "thread-123",
    expectedTurnId: "turn-123",
    input: [{ type: "text", text: "Please continue." }],
  });

  await Promise.resolve();
  stub.receive({ id: 1, result: {} });
  await Bun.sleep(0);

  expect(JSON.parse(stub.sent[2])).toMatchObject({
    jsonrpc: "2.0",
    id: 2,
    method: "turn/steer",
    params: {
      threadId: "thread-123",
      expectedTurnId: "turn-123",
      input: [{ type: "text", text: "Please continue." }],
    },
  });

  stub.receive({ id: 2, result: {} });
  await expect(steerPromise).resolves.toEqual({});
});

test("turnInterrupt sends turn/interrupt for the active turn", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });

  const interruptPromise = client.turnInterrupt({
    threadId: "thread-123",
    turnId: "turn-123",
  });

  await Promise.resolve();
  stub.receive({ id: 1, result: {} });
  await Bun.sleep(0);

  expect(JSON.parse(stub.sent[2])).toMatchObject({
    jsonrpc: "2.0",
    id: 2,
    method: "turn/interrupt",
    params: {
      threadId: "thread-123",
      turnId: "turn-123",
    },
  });

  stub.receive({ id: 2, result: {} });
  await expect(interruptPromise).resolves.toEqual({});
});

test("listModels requests model/list", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });

  const listPromise = client.listModels({
    includeHidden: true,
    limit: 10,
  });

  await Promise.resolve();
  stub.receive({ id: 1, result: {} });
  await Bun.sleep(0);

  expect(JSON.parse(stub.sent[2])).toMatchObject({
    jsonrpc: "2.0",
    id: 2,
    method: "model/list",
    params: {
      includeHidden: true,
      limit: 10,
    },
  });

  stub.receive({
    id: 2,
    result: {
      data: [
        {
          model: "gpt-5.4",
          displayName: "GPT-5.4",
          description: "Frontier model",
          supportedReasoningEfforts: ["medium", "high", "xhigh"],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
      nextCursor: null,
    },
  });

  await expect(listPromise).resolves.toEqual({
    data: [
      {
        model: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "Frontier model",
        supportedReasoningEfforts: ["medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ],
    nextCursor: null,
  });
});

test("getAccountRateLimits requests account/rateLimits/read", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });

  const rateLimitsPromise = client.getAccountRateLimits();

  await Promise.resolve();
  stub.receive({ id: 1, result: {} });
  await Bun.sleep(0);

  expect(JSON.parse(stub.sent[2])).toMatchObject({
    jsonrpc: "2.0",
    id: 2,
    method: "account/rateLimits/read",
  });

  stub.receive({
    id: 2,
    result: {
      rateLimits: {
        limitId: null,
        limitName: null,
        primary: null,
        secondary: null,
        credits: null,
        planType: null,
      },
      rateLimitsByLimitId: null,
    },
  });

  await expect(rateLimitsPromise).resolves.toEqual({
    rateLimits: {
      limitId: null,
      limitName: null,
      primary: null,
      secondary: null,
      credits: null,
      planType: null,
    },
    rateLimitsByLimitId: null,
  });
});
