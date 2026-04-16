import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  CodexSupervisorError,
  detectCodexBinary,
  startManagedCodexAppServer,
  stopManagedCodexAppServer,
  type ChildProcessLike,
} from "../../src/codex/supervisor";

class ChildProcessStub extends EventEmitter implements ChildProcessLike {
  killedSignals: Array<NodeJS.Signals | number> = [];

  constructor(public pid: number | undefined) {
    super();
  }

  kill(signal?: NodeJS.Signals | number) {
    this.killedSignals.push(signal ?? "SIGTERM");
    return true;
  }
}

test("detectCodexBinary returns a structured error when codex is unavailable", async () => {
  await expect(
    detectCodexBinary({
      resolveBinary: async () => null,
    }),
  ).rejects.toMatchObject({
    code: "CODEX_BINARY_NOT_FOUND",
  } satisfies Partial<CodexSupervisorError>);
});

test("startManagedCodexAppServer uses the codex app-server listen command", async () => {
  const child = new ChildProcessStub(4242);
  let spawnCall:
    | {
        command: string;
        args: string[];
        stdio: string[];
      }
    | undefined;
  let readyChecked = false;

  const server = await startManagedCodexAppServer({
    resolveBinary: async () => "/usr/local/bin/codex",
    allocatePort: async () => 4511,
    spawnProcess: (command, args, options) => {
      spawnCall = {
        command,
        args,
        stdio: options.stdio as string[],
      };
      return child;
    },
    waitForReady: async ({ address }) => {
      readyChecked = true;
      expect(address).toBe("ws://127.0.0.1:4511");
    },
  });

  expect(spawnCall).toEqual({
    command: "/usr/local/bin/codex",
    args: ["app-server", "--listen", "ws://127.0.0.1:4511"],
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(server.pid).toBe(4242);
  expect(server.address).toBe("ws://127.0.0.1:4511");
  expect(readyChecked).toBe(true);
});

test("startManagedCodexAppServer fails clearly when readiness never arrives", async () => {
  const child = new ChildProcessStub(4242);
  child.kill = (signal?: NodeJS.Signals | number) => {
    child.killedSignals.push(signal ?? "SIGTERM");
    queueMicrotask(() => {
      child.emit("exit", 0, "SIGTERM");
    });
    return true;
  };

  await expect(
    startManagedCodexAppServer({
      resolveBinary: async () => "/usr/local/bin/codex",
      allocatePort: async () => 4511,
      spawnProcess: () => child,
      waitForReady: async () => {
        throw new CodexSupervisorError(
          "CODEX_APP_SERVER_FAILED_TO_START",
          "Managed Codex App Server did not become ready.",
        );
      },
    }),
  ).rejects.toMatchObject({
    code: "CODEX_APP_SERVER_FAILED_TO_START",
  } satisfies Partial<CodexSupervisorError>);
  expect(child.killedSignals).toEqual(["SIGTERM"]);
});

test("stopManagedCodexAppServer sends SIGTERM and waits for a clean exit", async () => {
  const child = new ChildProcessStub(4242);
  const server = await startManagedCodexAppServer({
    resolveBinary: async () => "/usr/local/bin/codex",
    allocatePort: async () => 4511,
    spawnProcess: () => child,
    waitForReady: async () => {},
  });

  const stopPromise = stopManagedCodexAppServer(server, {
    timeoutMs: 100,
  });
  queueMicrotask(() => {
    child.emit("exit", 0, "SIGTERM");
  });

  await expect(stopPromise).resolves.toBeUndefined();
  expect(child.killedSignals).toEqual(["SIGTERM"]);
});

test("stopManagedCodexAppServer still succeeds when the child exits immediately on SIGTERM", async () => {
  const child = new ChildProcessStub(4242);
  child.kill = (signal?: NodeJS.Signals | number) => {
    child.killedSignals.push(signal ?? "SIGTERM");
    child.emit("exit", 0, "SIGTERM");
    return true;
  };

  const server = await startManagedCodexAppServer({
    resolveBinary: async () => "/usr/local/bin/codex",
    allocatePort: async () => 4511,
    spawnProcess: () => child,
    waitForReady: async () => {},
  });

  await expect(
    stopManagedCodexAppServer(server, {
      timeoutMs: 100,
    }),
  ).resolves.toBeUndefined();
  expect(child.killedSignals).toEqual(["SIGTERM"]);
});

test("stopManagedCodexAppServer returns a clear failure when the child does not exit", async () => {
  const child = new ChildProcessStub(4242);
  const server = await startManagedCodexAppServer({
    resolveBinary: async () => "/usr/local/bin/codex",
    allocatePort: async () => 4511,
    spawnProcess: () => child,
    waitForReady: async () => {},
  });

  await expect(
    stopManagedCodexAppServer(server, {
      timeoutMs: 10,
    }),
  ).rejects.toMatchObject({
    code: "CODEX_APP_SERVER_STOP_TIMEOUT",
  } satisfies Partial<CodexSupervisorError>);
});
