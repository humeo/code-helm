import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  cleanupOldLogFiles,
  formatLocalLogDate,
  getLogFileDate,
  startLogRetention,
} from "../../src/logger/retention";

const tempDirs: string[] = [];

const createTempDir = () => {
  const directory = mkdtempSync(join(tmpdir(), "codehelm-log-retention-"));
  tempDirs.push(directory);
  return directory;
};

const touch = (path: string) => {
  writeFileSync(path, "\n", "utf8");
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("logger retention", () => {
  test("formats local log dates for daily log filenames", () => {
    expect(formatLocalLogDate(new Date(2026, 3, 6, 23, 59, 58))).toBe("2026-04-06");
  });

  test("recognizes only CodeHelm daily log files", () => {
    expect(getLogFileDate("codehelm-2026-04-26.jsonl")).toBe("2026-04-26");
    expect(getLogFileDate("codehelm-error-2026-04-26.jsonl")).toBe("2026-04-26");
    expect(getLogFileDate("codehelm-debug-2026-04-26.jsonl")).toBeUndefined();
    expect(getLogFileDate("notes-2026-04-26.jsonl")).toBeUndefined();
    expect(getLogFileDate("codehelm-2026-04-26.txt")).toBeUndefined();
  });

  test("keeps today plus the previous 13 local dates and deletes older matching files", () => {
    const logDir = createTempDir();
    const keptToday = join(logDir, "codehelm-2026-04-26.jsonl");
    const keptCutoff = join(logDir, "codehelm-error-2026-04-13.jsonl");
    const removedOld = join(logDir, "codehelm-2026-04-12.jsonl");
    const ignored = join(logDir, "notes-2026-01-01.jsonl");

    for (const path of [keptToday, keptCutoff, removedOld, ignored]) {
      touch(path);
    }

    const result = cleanupOldLogFiles({
      logDir,
      now: new Date(2026, 3, 26, 12),
      retainDays: 14,
    });

    expect(result.deleted.map((path) => basename(path))).toEqual([
      "codehelm-2026-04-12.jsonl",
    ]);
    expect(result.warnings).toEqual([]);
    expect(existsSync(keptToday)).toBe(true);
    expect(existsSync(keptCutoff)).toBe(true);
    expect(existsSync(removedOld)).toBe(false);
    expect(existsSync(ignored)).toBe(true);
  });

  test("returns warnings when cleanup cannot delete an old matching file", () => {
    const result = cleanupOldLogFiles({
      logDir: "/tmp/codehelm-logs",
      now: new Date(2026, 3, 26, 12),
      retainDays: 14,
      listFiles: () => ["codehelm-error-2026-04-01.jsonl"],
      removeFile: () => {
        throw new Error("permission denied");
      },
    });

    expect(result.deleted).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.path).toBe("/tmp/codehelm-logs/codehelm-error-2026-04-01.jsonl");
    expect(result.warnings[0]?.error).toBeInstanceOf(Error);
  });

  test("retention runner cleans immediately, schedules daily cleanup, and can stop", () => {
    const cleanupRuns: string[] = [];
    const warned: unknown[][] = [];
    const scheduled: Array<{ callback: () => void; intervalMs: number }> = [];
    const cleared: unknown[] = [];
    const timer = { id: "timer-1", unrefCalled: false, unref() { this.unrefCalled = true; } };

    const retention = startLogRetention({
      logDir: "/tmp/codehelm-logs",
      retainDays: 14,
      intervalMs: 86_400_000,
      logger: {
        warn: (...args: unknown[]) => warned.push(args),
      },
      now: () => new Date(2026, 3, 26, 12),
      listFiles: () => {
        cleanupRuns.push("run");
        return [];
      },
      setIntervalFn: (callback, intervalMs) => {
        scheduled.push({ callback, intervalMs });
        return timer;
      },
      clearIntervalFn: (value) => {
        cleared.push(value);
      },
    });

    expect(cleanupRuns).toEqual(["run"]);
    expect(warned).toEqual([]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.intervalMs).toBe(86_400_000);
    expect(timer.unrefCalled).toBe(true);

    scheduled[0]?.callback();
    expect(cleanupRuns).toEqual(["run", "run"]);

    retention.stop();
    expect(cleared).toEqual([timer]);
  });
});
