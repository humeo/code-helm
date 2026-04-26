import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
  createDailyJsonlStreams,
  getDailyLogFilePath,
} from "../../src/logger/sinks";

const tempDirs: string[] = [];

const createTempDir = () => {
  const directory = mkdtempSync(join(tmpdir(), "codehelm-log-sink-"));
  tempDirs.push(directory);
  return directory;
};

const readJsonl = (path: string) => {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("daily JSONL sinks", () => {
  test("builds daily main and error file paths", () => {
    const logDir = "/tmp/codehelm-logs";
    const date = new Date(2026, 3, 26, 12);

    expect(getDailyLogFilePath({ logDir, kind: "main", date })).toBe(
      "/tmp/codehelm-logs/codehelm-2026-04-26.jsonl",
    );
    expect(getDailyLogFilePath({ logDir, kind: "error", date })).toBe(
      "/tmp/codehelm-logs/codehelm-error-2026-04-26.jsonl",
    );
  });

  test("writes all records to the main file and only errors to the error file", () => {
    const logDir = createTempDir();
    const streams = createDailyJsonlStreams({
      logDir,
      level: "debug",
      now: () => new Date(2026, 3, 26, 12),
    });
    const logger = pino({ base: undefined, timestamp: false }, pino.multistream(streams));

    logger.info({ component: "runtime" }, "started");
    logger.error({ component: "codex" }, "failed");

    const mainPath = join(logDir, "codehelm-2026-04-26.jsonl");
    const errorPath = join(logDir, "codehelm-error-2026-04-26.jsonl");

    expect(readJsonl(mainPath).map((record) => record.msg)).toEqual([
      "started",
      "failed",
    ]);
    expect(readJsonl(errorPath).map((record) => record.msg)).toEqual([
      "failed",
    ]);
  });

  test("switches files when the local date changes", () => {
    const logDir = createTempDir();
    let currentDate = new Date(2026, 3, 26, 23, 59);
    const streams = createDailyJsonlStreams({
      logDir,
      level: "info",
      now: () => currentDate,
    });
    const logger = pino({ base: undefined, timestamp: false }, pino.multistream(streams));

    logger.info("before midnight");
    currentDate = new Date(2026, 3, 27, 0, 1);
    logger.info("after midnight");

    expect(readJsonl(join(logDir, "codehelm-2026-04-26.jsonl")).map((record) => record.msg))
      .toEqual(["before midnight"]);
    expect(readJsonl(join(logDir, "codehelm-2026-04-27.jsonl")).map((record) => record.msg))
      .toEqual(["after midnight"]);
  });

  test("writes JSONL and never pretty text", () => {
    const logDir = createTempDir();
    const streams = createDailyJsonlStreams({
      logDir,
      level: "info",
      now: () => new Date(2026, 3, 26, 12),
    });
    const logger = pino({ base: undefined, timestamp: false }, pino.multistream(streams));

    logger.info({ service: "code-helm" }, "hello");

    const mainPath = join(logDir, "codehelm-2026-04-26.jsonl");
    const raw = readFileSync(mainPath, "utf8");

    expect(raw).toStartWith("{");
    expect(raw).not.toContain("[");
    expect(readJsonl(mainPath)[0]).toMatchObject({
      level: 30,
      service: "code-helm",
      msg: "hello",
    });
    expect(existsSync(join(logDir, "codehelm-error-2026-04-26.jsonl"))).toBe(false);
  });
});
