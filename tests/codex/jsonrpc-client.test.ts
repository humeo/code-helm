import { expect, test } from "bun:test";
import {
  JsonRpcClient,
  type JsonRpcTransport,
  type TransportHandlers,
} from "../../src/codex/jsonrpc-client";

const createTransportStub = () => {
  const sent: string[] = [];
  let handlers: TransportHandlers | undefined;

  const transport: JsonRpcTransport = {
    async connect() {},
    setHandlers(nextHandlers) {
      handlers = nextHandlers;
    },
    send(message) {
      sent.push(message);
    },
    close() {},
  };

  return {
    transport,
    sent,
    receive(message: unknown) {
      handlers?.onMessage(JSON.stringify(message));
    },
  };
};

test("routes requestApproval and resolved events to subscribers", async () => {
  const client = new JsonRpcClient("ws://example.test");
  const seenResolved: Array<number | string> = [];

  const unsubscribe = client.on("serverRequest/resolved", (event) => {
    seenResolved.push(event.requestId);
  });

  client.handleMessage({
    method: "item/commandExecution/requestApproval",
    id: 7,
    params: { threadId: "t1", turnId: "turn1", itemId: "call1" },
  });
  client.handleMessage({
    method: "serverRequest/resolved",
    params: { requestId: 7 },
  });

  expect(client.lastApprovalRequest?.requestId).toBe(7);
  expect(seenResolved).toEqual([7]);

  unsubscribe();
});

test("initialize sends initialize request before initialized notification", async () => {
  const stub = createTransportStub();
  const client = new JsonRpcClient("ws://example.test", {
    transport: stub.transport,
  });
  const initializePromise = client.initialize();

  await Promise.resolve();

  expect(stub.sent).toHaveLength(1);
  expect(JSON.parse(stub.sent[0])).toMatchObject({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });

  stub.receive({ id: 1, result: { serverInfo: { name: "codex-app" } } });
  await initializePromise;

  expect(JSON.parse(stub.sent[1])).toMatchObject({
    jsonrpc: "2.0",
    method: "initialized",
  });
});

test("replies to server requests with the original request id", async () => {
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
  await client.replyToServerRequest({ requestId: 9, decision: "approved" });

  expect(JSON.parse(stub.sent[2])).toEqual({
    jsonrpc: "2.0",
    id: 9,
    result: { decision: "approved" },
  });
});
