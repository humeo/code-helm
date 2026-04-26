import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { logger } from "../logger";

const execFileAsync = promisify(execFile);

export type StartupDisposition = "delayed" | "failed";

export class CodexSupervisorError extends Error {
  constructor(
    readonly code:
      | "CODEX_BINARY_NOT_FOUND"
      | "CODEX_APP_SERVER_FAILED_TO_START"
      | "CODEX_APP_SERVER_FAILED_TO_STOP"
      | "CODEX_APP_SERVER_STOP_TIMEOUT",
    message: string,
    details: {
      startupDisposition?: StartupDisposition;
      diagnostics?: string;
      startupTimeoutMs?: number;
    } = {},
  ) {
    super(message);
    this.name = "CodexSupervisorError";
    this.startupDisposition = details.startupDisposition;
    this.diagnostics = details.diagnostics;
    this.startupTimeoutMs = details.startupTimeoutMs;
  }

  readonly startupDisposition?: StartupDisposition;
  readonly diagnostics?: string;
  readonly startupTimeoutMs?: number;
}

export interface ChildProcessLike {
  pid: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  stderr?: {
    on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
  } | null;
}

export type ManagedCodexAppServer = {
  pid: number;
  address: string;
  stop: (options?: StopManagedCodexAppServerOptions) => Promise<void>;
};

type ResolveBinary = (binaryName: string) => Promise<string | null>;
type AllocatePort = () => Promise<number>;
type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessLike;

export type DetectCodexBinaryOptions = {
  resolveBinary?: ResolveBinary;
};

export type StartManagedCodexAppServerOptions = {
  cwd?: string;
  resolveBinary?: ResolveBinary;
  allocatePort?: AllocatePort;
  spawnProcess?: SpawnProcess;
  waitForReady?: WaitForReady;
};

export type StopManagedCodexAppServerOptions = {
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  timeoutMs?: number;
};

type ManagedCodexAppServerHandle = {
  pid: number;
  address: string;
  child: ChildProcessLike;
};

type WaitForReady = (
  options: {
    address: string;
    child: ChildProcessLike;
    timeoutMs: number;
    getDiagnostics: () => string | undefined;
  },
) => Promise<void>;

const defaultResolveBinary: ResolveBinary = async (binaryName) => {
  const lookupCommand = process.platform === "win32" ? "where" : "which";

  try {
    const { stdout } = await execFileAsync(lookupCommand, [binaryName]);
    const path = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    return path ?? null;
  } catch {
    return null;
  }
};

const defaultAllocatePort: AllocatePort = async () => {
  const server = createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });

    const address = server.address();

    if (!address || typeof address === "string") {
      throw new CodexSupervisorError(
        "CODEX_APP_SERVER_FAILED_TO_START",
        "Failed to allocate a loopback port for the managed Codex App Server.",
      );
    }

    return address.port;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
};

const defaultSpawnProcess: SpawnProcess = (command, args, options) => {
  return spawn(command, args, options) as unknown as ChildProcessLike;
};

const appendDiagnosticChunk = (buffer: string[], chunk: string | Uint8Array) => {
  buffer.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));

  const combined = buffer.join("");

  if (combined.length <= 4_000) {
    return;
  }

  buffer.splice(0, buffer.length, combined.slice(-4_000));
};

const withDiagnostics = (message: string, diagnostics?: string) => {
  const trimmed = diagnostics?.trim();
  return trimmed ? `${message}\nDiagnostics:\n${trimmed}` : message;
};

const createStartupFailureError = ({
  message,
  startupDisposition,
  diagnostics,
  startupTimeoutMs,
}: {
  message: string;
  startupDisposition: StartupDisposition;
  diagnostics?: string;
  startupTimeoutMs?: number;
}) => {
  return new CodexSupervisorError(
    "CODEX_APP_SERVER_FAILED_TO_START",
    withDiagnostics(message, diagnostics),
    {
      startupDisposition,
      diagnostics,
      startupTimeoutMs,
    },
  );
};

const waitForChildExit = async (child: ChildProcessLike, timeoutMs: number) => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const exitPromise = once(child as unknown as NodeJS.EventEmitter, "exit") as Promise<
      [number | null, NodeJS.Signals | null]
    >;
    const errorPromise = once(child as unknown as NodeJS.EventEmitter, "error").then(
      ([error]) => {
        throw error;
      },
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new CodexSupervisorError(
          "CODEX_APP_SERVER_STOP_TIMEOUT",
          "Managed Codex App Server did not stop before the timeout expired.",
        ));
      }, timeoutMs);
    });

    const [code, signal] = await Promise.race([
      exitPromise,
      errorPromise,
      timeoutPromise,
    ]);

    if (
      code !== 0
      && signal !== "SIGTERM"
      && signal !== "SIGINT"
      && signal !== "SIGKILL"
    ) {
      throw new CodexSupervisorError(
        "CODEX_APP_SERVER_FAILED_TO_STOP",
        `Managed Codex App Server exited uncleanly (code: ${String(code)}, signal: ${String(signal)}).`,
      );
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

export const waitForManagedCodexAppServerReady: WaitForReady = ({
  address,
  child,
  timeoutMs,
  getDiagnostics,
}) => {
  const readinessUrl = new URL(address);
  readinessUrl.protocol = readinessUrl.protocol === "wss:" ? "https:" : "http:";
  readinessUrl.pathname = "/readyz";
  readinessUrl.search = "";
  readinessUrl.hash = "";

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      settled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      child.off("exit", handleExit);
      child.off("error", handleError);
    };

    const finishError = (error: CodexSupervisorError) => {
      cleanup();
      reject(error);
    };

    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finishError(createStartupFailureError({
        message:
          `Managed Codex App Server exited before becoming ready (code: ${String(code)}, signal: ${String(signal)}).`,
        startupDisposition: "failed",
        diagnostics: getDiagnostics(),
      }));
    };

    const handleError = (error: Error) => {
      finishError(createStartupFailureError({
        message:
          `Managed Codex App Server failed before becoming ready: ${error.message}`,
        startupDisposition: "failed",
        diagnostics: getDiagnostics(),
      }));
    };

    const tryConnect = async () => {
      if (settled) {
        return;
      }

      try {
        const response = await fetch(readinessUrl);

        if (settled) {
          return;
        }

        if (response.ok) {
          cleanup();
          resolve();
          return;
        }
      } catch {
        // Retry on transient startup failures until timeout or child exit.
      }

      if (!settled) {
        retryTimer = setTimeout(() => {
          void tryConnect();
        }, 50);
      }
    };

    child.once("exit", handleExit);
    child.once("error", handleError);
    timeoutId = setTimeout(() => {
      finishError(createStartupFailureError({
        message: "Managed Codex App Server did not become ready before the startup timeout expired.",
        startupDisposition: "delayed",
        diagnostics: getDiagnostics(),
        startupTimeoutMs: timeoutMs,
      }));
    }, timeoutMs);

    void tryConnect();
  });
};

const defaultWaitForReady = waitForManagedCodexAppServerReady;

export const detectCodexBinary = async (
  options: DetectCodexBinaryOptions = {},
) => {
  const resolveBinary = options.resolveBinary ?? defaultResolveBinary;
  const binaryPath = await resolveBinary("codex");

  if (!binaryPath) {
    throw new CodexSupervisorError(
      "CODEX_BINARY_NOT_FOUND",
      "Codex CLI was not found in PATH.",
    );
  }

  return binaryPath;
};

export const startManagedCodexAppServer = async (
  options: StartManagedCodexAppServerOptions = {},
): Promise<ManagedCodexAppServer> => {
  const log = logger.child({
    component: "codex",
    operation: "managed-app-server",
  });
  const binaryPath = await detectCodexBinary({
    resolveBinary: options.resolveBinary,
  });
  const allocatePort = options.allocatePort ?? defaultAllocatePort;
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  const waitForReady = options.waitForReady ?? defaultWaitForReady;
  const port = await allocatePort();
  const address = `ws://127.0.0.1:${port}`;
  let child: ChildProcessLike;

  log.info("Starting managed Codex App Server", {
    appServerAddress: address,
    cwd: options.cwd,
  });

  if (options.cwd) {
    mkdirSync(options.cwd, { recursive: true });
  }

  try {
    child = spawnProcess(
      binaryPath,
      ["app-server", "--listen", address],
      {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error("Managed Codex App Server spawn failed", {
      appServerAddress: address,
      cwd: options.cwd,
      error,
    });

    throw createStartupFailureError({
      message: `Managed Codex App Server failed before becoming ready: ${detail}`,
      startupDisposition: "failed",
      diagnostics: detail,
    });
  }

  const stderrBuffer: string[] = [];

  child.stderr?.on("data", (chunk) => {
    appendDiagnosticChunk(stderrBuffer, chunk);
  });

  if (!child.pid) {
    log.error("Managed Codex App Server did not expose a child pid", {
      appServerAddress: address,
    });
    throw createStartupFailureError({
      message: "Managed Codex App Server did not expose a child pid.",
      startupDisposition: "failed",
    });
  }

  const getDiagnostics = () => {
    const combined = stderrBuffer.join("").trim();
    return combined.length > 0 ? combined : undefined;
  };

  try {
    await waitForReady({
      address,
      child,
      timeoutMs: 5_000,
      getDiagnostics,
    });
  } catch (error) {
    log.error("Managed Codex App Server readiness failed", {
      appServerAddress: address,
      appServerPid: child.pid,
      diagnostics: getDiagnostics(),
      error,
    });
    await stopManagedCodexAppServer(
      {
        pid: child.pid,
        address,
        child,
      },
      {
        timeoutMs: 1_000,
      },
    ).catch(() => undefined);

    if (error instanceof CodexSupervisorError) {
      throw error;
    }

    const detail = error instanceof Error ? error.message : String(error);

    throw createStartupFailureError({
      message: `Managed Codex App Server failed before becoming ready: ${detail}`,
      startupDisposition: "failed",
      diagnostics: getDiagnostics() ?? detail,
    });
  }

  log.info("Managed Codex App Server ready", {
    appServerAddress: address,
    appServerPid: child.pid,
  });

  return {
    pid: child.pid,
    address,
    stop: (stopOptions) => {
      return stopManagedCodexAppServer(
        {
          pid: child.pid as number,
          address,
          child,
        },
        stopOptions,
      );
    },
  };
};

export const stopManagedCodexAppServer = async (
  server: ManagedCodexAppServer | ManagedCodexAppServerHandle,
  options: StopManagedCodexAppServerOptions = {},
) => {
  if (!("child" in server)) {
    return server.stop(options);
  }

  const timeoutMs = options.timeoutMs ?? 5_000;
  const killProcess = options.killProcess ?? process.kill;
  const signalServer = (signal: NodeJS.Signals) => {
    if (process.platform !== "win32") {
      try {
        killProcess(-server.pid, signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }

    return server.child.kill(signal);
  };
  const waitForTermExit = waitForChildExit(server.child, timeoutMs);
  const didSignal = signalServer("SIGTERM");

  if (!didSignal) {
    throw new CodexSupervisorError(
      "CODEX_APP_SERVER_FAILED_TO_STOP",
      "Managed Codex App Server could not be signaled for shutdown.",
    );
  }

  try {
    await waitForTermExit;
  } catch (error) {
    if (!(error instanceof CodexSupervisorError) || error.code !== "CODEX_APP_SERVER_STOP_TIMEOUT") {
      throw error;
    }

    const waitForKillExit = waitForChildExit(server.child, timeoutMs);
    const didForceSignal = signalServer("SIGKILL");

    if (!didForceSignal) {
      throw error;
    }

    await waitForKillExit;
  }
};
