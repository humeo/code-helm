import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export type LogRetentionWarning = {
  path: string;
  error: unknown;
};

export type LogRetentionResult = {
  deleted: string[];
  warnings: LogRetentionWarning[];
};

export type RetentionLogger = {
  warn(...args: unknown[]): void;
};

type RetentionTimer = {
  unref?: () => void;
};

type CleanupOldLogFilesOptions = {
  logDir: string;
  now?: Date;
  retainDays?: number;
  listFiles?: (logDir: string) => string[];
  removeFile?: (path: string) => void;
};

type StartLogRetentionOptions = Omit<CleanupOldLogFilesOptions, "now"> & {
  intervalMs?: number;
  logger: RetentionLogger;
  now?: () => Date;
  setIntervalFn?: (callback: () => void, intervalMs: number) => RetentionTimer;
  clearIntervalFn?: (timer: RetentionTimer) => void;
};

const codeHelmLogFilePattern = /^codehelm(?:-error)?-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const defaultRetainDays = 14;
const defaultRetentionIntervalMs = 24 * 60 * 60 * 1000;

const defaultSetInterval = (callback: () => void, intervalMs: number): RetentionTimer => {
  return setInterval(callback, intervalMs);
};

const defaultClearInterval = (timer: RetentionTimer) => {
  clearInterval(timer as ReturnType<typeof setInterval>);
};

const pad2 = (value: number) => {
  return String(value).padStart(2, "0");
};

export const formatLocalLogDate = (date: Date) => {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join("-");
};

export const getLogFileDate = (filename: string) => {
  return codeHelmLogFilePattern.exec(filename)?.[1];
};

const getRetentionCutoffDate = (now: Date, retainDays: number) => {
  if (!Number.isInteger(retainDays) || retainDays <= 0) {
    throw new Error("Log retention days must be a positive integer.");
  }

  return formatLocalLogDate(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - retainDays + 1),
  );
};

const defaultListFiles = (logDir: string) => {
  try {
    return readdirSync(logDir);
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }
};

const defaultRemoveFile = (path: string) => {
  rmSync(path);
};

export const cleanupOldLogFiles = ({
  logDir,
  now = new Date(),
  retainDays = defaultRetainDays,
  listFiles = defaultListFiles,
  removeFile = defaultRemoveFile,
}: CleanupOldLogFilesOptions): LogRetentionResult => {
  const cutoffDate = getRetentionCutoffDate(now, retainDays);
  const deleted: string[] = [];
  const warnings: LogRetentionWarning[] = [];

  for (const filename of listFiles(logDir)) {
    const fileDate = getLogFileDate(filename);

    if (!fileDate || fileDate >= cutoffDate) {
      continue;
    }

    const path = join(logDir, filename);

    try {
      removeFile(path);
      deleted.push(path);
    } catch (error) {
      warnings.push({ path, error });
    }
  }

  return { deleted, warnings };
};

export const startLogRetention = ({
  logger,
  intervalMs = defaultRetentionIntervalMs,
  now = () => new Date(),
  setIntervalFn = defaultSetInterval,
  clearIntervalFn = defaultClearInterval,
  ...cleanupOptions
}: StartLogRetentionOptions) => {
  const runCleanup = () => {
    const result = cleanupOldLogFiles({
      ...cleanupOptions,
      now: now(),
    });

    for (const warning of result.warnings) {
      logger.warn("Failed to remove old CodeHelm log file", warning);
    }

    return result;
  };

  runCleanup();

  const timer = setIntervalFn(() => {
    runCleanup();
  }, intervalMs);
  timer.unref?.();

  return {
    runNow: runCleanup,
    stop() {
      clearIntervalFn(timer);
    },
  };
};
