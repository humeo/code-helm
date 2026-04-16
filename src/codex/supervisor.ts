import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class CodexSupervisorError extends Error {
  constructor(
    readonly code:
      | "CODEX_BINARY_NOT_FOUND"
      | "CODEX_APP_SERVER_FAILED_TO_START"
      | "CODEX_APP_SERVER_FAILED_TO_STOP"
      | "CODEX_APP_SERVER_STOP_TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "CodexSupervisorError";
  }
}

export interface ChildProcessLike {
  pid: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type ManagedCodexAppServer = {
  pid: number;
  address: string;
  child: ChildProcessLike;
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
  resolveBinary?: ResolveBinary;
  allocatePort?: AllocatePort;
  spawnProcess?: SpawnProcess;
};

export type StopManagedCodexAppServerOptions = {
  timeoutMs?: number;
};

type ManagedCodexAppServerHandle = {
  child: ChildProcessLike;
};

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

    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
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
  const binaryPath = await detectCodexBinary({
    resolveBinary: options.resolveBinary,
  });
  const allocatePort = options.allocatePort ?? defaultAllocatePort;
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  const port = await allocatePort();
  const address = `ws://127.0.0.1:${port}`;
  const child = spawnProcess(
    binaryPath,
    ["app-server", "--listen", address],
    {
      stdio: "ignore",
    },
  );

  if (!child.pid) {
    throw new CodexSupervisorError(
      "CODEX_APP_SERVER_FAILED_TO_START",
      "Managed Codex App Server did not expose a child pid.",
    );
  }

  return {
    pid: child.pid,
    address,
    child,
    stop: (stopOptions) => {
      return stopManagedCodexAppServer({ child }, stopOptions);
    },
  };
};

export const stopManagedCodexAppServer = async (
  server: ManagedCodexAppServerHandle,
  options: StopManagedCodexAppServerOptions = {},
) => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const waitForExit = waitForChildExit(server.child, timeoutMs);
  const didSignal = server.child.kill("SIGTERM");

  if (!didSignal) {
    throw new CodexSupervisorError(
      "CODEX_APP_SERVER_FAILED_TO_STOP",
      "Managed Codex App Server could not be signaled for shutdown.",
    );
  }

  await waitForExit;
};
