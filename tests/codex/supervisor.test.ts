import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  CodexSupervisorError,
  detectCodexBinary,
  startManagedCodexAppServer,
  stopManagedCodexAppServer,
  waitForManagedCodexAppServerReady,
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
        cwd?: string;
      }
    | undefined;
  let readyChecked = false;

  const server = await startManagedCodexAppServer({
    cwd: "/tmp/codehelm-app-server-workdir",
    resolveBinary: async () => "/usr/local/bin/codex",
    allocatePort: async () => 4511,
    spawnProcess: (command, args, options) => {
      spawnCall = {
        command,
        args,
        stdio: options.stdio as string[],
        cwd: options.cwd as string | undefined,
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
    cwd: "/tmp/codehelm-app-server-workdir",
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

test("waitForManagedCodexAppServerReady waits until readyz reports healthy", async () => {
  const child = new ChildProcessStub(4242);
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    attempts += 1;
    expect(String(input)).toBe("http://127.0.0.1:4511/readyz");

    return new Response(null, {
      status: attempts >= 3 ? 200 : 503,
    });
  }) as unknown as typeof fetch;

  try {
    await expect(
      waitForManagedCodexAppServerReady({
        address: "ws://127.0.0.1:4511",
        child,
        timeoutMs: 1_000,
        getDiagnostics: () => undefined,
      }),
    ).resolves.toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(attempts).toBeGreaterThanOrEqual(3);
});

test("waitForManagedCodexAppServerReady classifies timeouts as delayed startup", async () => {
  const child = new ChildProcessStub(4242);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response("not ready", { status: 503 });
  }) as unknown as typeof fetch;

  try {
    await expect(
      waitForManagedCodexAppServerReady({
        address: "ws://127.0.0.1:4511",
        child,
        timeoutMs: 25,
        getDiagnostics: () => "stderr tail",
      }),
    ).rejects.toMatchObject({
      code: "CODEX_APP_SERVER_FAILED_TO_START",
      startupDisposition: "delayed",
      startupTimeoutMs: 25,
      diagnostics: "stderr tail",
    } satisfies Partial<CodexSupervisorError>);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("startManagedCodexAppServer classifies spawn failures as failed startup", async () => {
  await expect(
    startManagedCodexAppServer({
      resolveBinary: async () => "/usr/local/bin/codex",
      allocatePort: async () => 4511,
      spawnProcess: () => {
        throw new Error("spawn boom");
      },
    }),
  ).rejects.toMatchObject({
    code: "CODEX_APP_SERVER_FAILED_TO_START",
    startupDisposition: "failed",
  } satisfies Partial<CodexSupervisorError>);
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
  const signals: Array<NodeJS.Signals | number> = [];

  const server = await startManagedCodexAppServer({
    resolveBinary: async () => "/usr/local/bin/codex",
    allocatePort: async () => 4511,
    spawnProcess: () => child,
    waitForReady: async () => {},
  });

  await expect(
    stopManagedCodexAppServer(server, {
      timeoutMs: 100,
      killProcess: (_pid, signal) => {
        signals.push(signal);
        child.emit("exit", 0, "SIGTERM");
      },
    }),
  ).resolves.toBeUndefined();
  expect(signals).toEqual(["SIGTERM"]);
});

test("startManagedCodexAppServer starts the app-server in its own process group on Unix", async () => {
  const child = new ChildProcessStub(4242);
  let detached: boolean | undefined;

  await startManagedCodexAppServer({
    resolveBinary: async () => "/usr/local/bin/codex",
    allocatePort: async () => 4511,
    spawnProcess: (_command, _args, options) => {
      detached = options.detached;
      return child;
    },
    waitForReady: async () => {},
  });

  expect(detached).toBe(process.platform !== "win32");
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
      killProcess: () => {},
    }),
  ).rejects.toMatchObject({
    code: "CODEX_APP_SERVER_STOP_TIMEOUT",
  } satisfies Partial<CodexSupervisorError>);
});

test("stopManagedCodexAppServer escalates to SIGKILL when SIGTERM does not exit", async () => {
  const child = new ChildProcessStub(4242);
  const signals: Array<NodeJS.Signals | number> = [];
  const server = await startManagedCodexAppServer({
    resolveBinary: async () => "/usr/local/bin/codex",
    allocatePort: async () => 4511,
    spawnProcess: () => child,
    waitForReady: async () => {},
  });

  const stopPromise = stopManagedCodexAppServer(server, {
    timeoutMs: 1,
    killProcess: (_pid, signal) => {
      signals.push(signal);

      if (signal === "SIGKILL") {
        queueMicrotask(() => {
          child.emit("exit", null, "SIGKILL");
        });
      }
    },
  });

  await expect(stopPromise).resolves.toBeUndefined();
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});
