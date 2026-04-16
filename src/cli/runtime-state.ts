import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const writeJsonFile = (path: string, value: unknown, options: { flag?: string } = {}) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: options.flag,
  });
};

const tryReadLock = (stateDir: string) => {
  const lockPath = getLockPath(stateDir);

  if (!existsSync(lockPath)) {
    return undefined;
  }

  try {
    return lockFileSchema.parse(readJsonFile(lockPath));
  } catch {
    return undefined;
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
  writeJsonFile(
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
    clearRuntimeState({ stateDir });
    return undefined;
  }

  return summary;
};

export const acquireInstanceLock = ({
  stateDir,
  pid,
  isPidAlive,
}: AcquireInstanceLockOptions): AcquireInstanceLockResult => {
  ensureStateDir(stateDir);
  const lockPath = getLockPath(stateDir);

  try {
    writeJsonFile(lockPath, lockFileSchema.parse({ pid }), { flag: "wx" });
    return {
      pid,
      cleanedStaleState: false,
    };
  } catch (error) {
    const isExistingLockError = error instanceof Error
      && "code" in error
      && error.code === "EEXIST";

    if (!isExistingLockError) {
      throw error;
    }
  }

  const existingLock = tryReadLock(stateDir);

  if (existingLock && isPidAlive(existingLock.pid)) {
    throw new Error(`CodeHelm is already running with pid ${existingLock.pid}.`);
  }

  clearRuntimeState({ stateDir });
  ensureStateDir(stateDir);
  writeJsonFile(lockPath, lockFileSchema.parse({ pid }), { flag: "wx" });

  return {
    pid,
    cleanedStaleState: true,
  };
};
