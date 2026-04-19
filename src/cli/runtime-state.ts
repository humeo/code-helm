import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const lockFileSchema = z.object({
  pid: z.number().int().positive(),
});

const wsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  }, "Runtime codex app server address must use ws:// or wss://");

const runtimeSummarySchema = z.object({
  pid: z.number().int().positive(),
  mode: z.enum(["foreground", "background"]),
  discord: z.object({
    guildId: z.string().min(1),
    controlChannelId: z.string().min(1).optional(),
    connected: z.boolean().optional(),
  }),
  codex: z.object({
    appServerAddress: wsUrlSchema,
    pid: z.number().int().positive().optional(),
    running: z.boolean().optional(),
    startupState: z.enum(["starting", "ready", "delayed", "failed"]).optional(),
  }),
  startedAt: z.string().datetime().optional(),
});

export type RuntimeSummary = z.infer<typeof runtimeSummarySchema>;

export type RuntimeStateOptions = {
  stateDir: string;
};

export type PidLivenessChecker = (pid: number) => boolean;

export type AcquireInstanceLockOptions = RuntimeStateOptions & {
  pid: number;
  isPidAlive: PidLivenessChecker;
};

export type AcquireInstanceLockResult = {
  pid: number;
  cleanedStaleState: boolean;
};

export type ReadRuntimeSummaryOptions = RuntimeStateOptions & {
  isPidAlive: PidLivenessChecker;
};

const getLockPath = (stateDir: string) => {
  return join(stateDir, "instance.lock");
};

const getRuntimePath = (stateDir: string) => {
  return join(stateDir, "runtime.json");
};

const ensureStateDir = (stateDir: string) => {
  mkdirSync(stateDir, { recursive: true });
};

const removeFileIfExists = (path: string) => {
  rmSync(path, { force: true });
};

const readJsonFile = (path: string) => {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
};

const hasErrorCode = (error: unknown, code: string) => {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
};

const writeJsonFile = (path: string, value: unknown, options: { flag?: string } = {}) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: options.flag,
  });
};

const writeJsonFileAtomically = (path: string, value: unknown) => {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;

  try {
    writeJsonFile(tempPath, value);
    renameSync(tempPath, path);
  } finally {
    removeFileIfExists(tempPath);
  }
};

const tryReadLock = (stateDir: string) => {
  const lockPath = getLockPath(stateDir);

  if (!existsSync(lockPath)) {
    return { kind: "missing" as const };
  }

  try {
    return {
      kind: "valid" as const,
      lock: lockFileSchema.parse(readJsonFile(lockPath)),
    };
  } catch {
    return { kind: "unreadable" as const };
  }
};

export const releaseInstanceLock = ({ stateDir }: RuntimeStateOptions) => {
  removeFileIfExists(getLockPath(stateDir));
};

export const clearRuntimeState = ({ stateDir }: RuntimeStateOptions) => {
  removeFileIfExists(getRuntimePath(stateDir));
  removeFileIfExists(getLockPath(stateDir));
};

export const writeRuntimeSummary = (
  options: RuntimeStateOptions & {
    summary: RuntimeSummary;
  },
) => {
  ensureStateDir(options.stateDir);
  writeJsonFileAtomically(
    getRuntimePath(options.stateDir),
    runtimeSummarySchema.parse(options.summary),
  );
};

export const readRuntimeSummary = ({ stateDir, isPidAlive }: ReadRuntimeSummaryOptions) => {
  const runtimePath = getRuntimePath(stateDir);

  if (!existsSync(runtimePath)) {
    return undefined;
  }

  let summary: RuntimeSummary;

  try {
    summary = runtimeSummarySchema.parse(readJsonFile(runtimePath));
  } catch {
    removeFileIfExists(runtimePath);
    return undefined;
  }

  if (!isPidAlive(summary.pid)) {
    removeFileIfExists(runtimePath);
    return undefined;
  }

  return summary;
};

const claimStaleLock = (stateDir: string, existingPid: number, pid: number) => {
  const lockPath = getLockPath(stateDir);
  const claimedPath = join(
    stateDir,
    `instance.lock.stale.${existingPid}.${pid}.${Date.now()}`,
  );

  try {
    renameSync(lockPath, claimedPath);
    return claimedPath;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
};

export const acquireInstanceLock = ({
  stateDir,
  pid,
  isPidAlive,
}: AcquireInstanceLockOptions): AcquireInstanceLockResult => {
  ensureStateDir(stateDir);
  const lockPath = getLockPath(stateDir);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeJsonFile(lockPath, lockFileSchema.parse({ pid }), { flag: "wx" });
      return {
        pid,
        cleanedStaleState: false,
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }

    const existingLock = tryReadLock(stateDir);

    if (existingLock.kind === "missing") {
      continue;
    }

    if (existingLock.kind === "unreadable") {
      throw new Error(
        "CodeHelm instance lock is unreadable. Remove the stale lock manually before retrying.",
      );
    }

    if (isPidAlive(existingLock.lock.pid)) {
      throw new Error(`CodeHelm is already running with pid ${existingLock.lock.pid}.`);
    }

    const claimedStaleLockPath = claimStaleLock(stateDir, existingLock.lock.pid, pid);

    if (!claimedStaleLockPath) {
      continue;
    }

    try {
      removeFileIfExists(getRuntimePath(stateDir));

      try {
        writeJsonFile(lockPath, lockFileSchema.parse({ pid }), { flag: "wx" });
        return {
          pid,
          cleanedStaleState: true,
        };
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw error;
        }
      }
    } finally {
      removeFileIfExists(claimedStaleLockPath);
    }

    const replacementLock = tryReadLock(stateDir);

    if (replacementLock.kind === "valid" && isPidAlive(replacementLock.lock.pid)) {
      throw new Error(`CodeHelm is already running with pid ${replacementLock.lock.pid}.`);
    }
  }

  throw new Error("CodeHelm instance lock changed during stale recovery. Retry the command.");
};
