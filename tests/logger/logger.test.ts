import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodeHelmLogger,
  initializeLogger,
  parseLogLevel,
  shutdownLogger,
} from "../../src/logger";

const tempDirs: string[] = [];

const createTempDir = () => {
  const directory = mkdtempSync(join(tmpdir(), "codehelm-pino-logger-"));
  tempDirs.push(directory);
  return directory;
};

const readMessages = (logDir: string, filename = "codehelm-2026-04-26.jsonl") => {
  return readFileSync(join(logDir, filename), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

afterEach(() => {
  shutdownLogger();

  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CodeHelm logger facade", () => {
  test("defaults to info level and filters debug logs", () => {
    const logDir = createTempDir();
    const runtime = createCodeHelmLogger({
      env: {
        CODE_HELM_LOG_DIR: logDir,
      },
      console: false,
      now: () => new Date(2026, 3, 26, 12),
    });

    runtime.logger.debug("hidden");
    runtime.logger.info("visible");
    runtime.shutdown();

    expect(readMessages(logDir).map((record) => record.msg)).toEqual(["visible"]);
  });

  test("enables debug logs with CODE_HELM_LOG_LEVEL", () => {
    const logDir = createTempDir();
    const runtime = createCodeHelmLogger({
      env: {
        CODE_HELM_LOG_DIR: logDir,
        CODE_HELM_LOG_LEVEL: "debug",
      },
      console: false,
      now: () => new Date(2026, 3, 26, 12),
    });

    runtime.logger.debug({ component: "runtime" }, "debug detail");
    runtime.shutdown();

    expect(readMessages(logDir)[0]).toMatchObject({
      level: 20,
      service: "code-helm",
      component: "runtime",
      msg: "debug detail",
    });
  });

  test("rejects invalid log levels with a clear error", () => {
    expect(() => parseLogLevel("verbose")).toThrow(
      "Invalid CODE_HELM_LOG_LEVEL: verbose",
    );
  });

  test("child loggers include bindings in JSONL records", () => {
    const logDir = createTempDir();
    const runtime = createCodeHelmLogger({
      env: {
        CODE_HELM_LOG_DIR: logDir,
      },
      console: false,
      now: () => new Date(2026, 3, 26, 12),
    });
    const sessionLogger = runtime.logger.child({
      component: "session",
      codexThreadId: "codex-thread-1",
      discordThreadId: "discord-thread-1",
    });

    sessionLogger.info("session resumed");
    runtime.shutdown();

    expect(readMessages(logDir)[0]).toMatchObject({
      component: "session",
      codexThreadId: "codex-thread-1",
      discordThreadId: "discord-thread-1",
      msg: "session resumed",
    });
  });

  test("normalizes old console-style calls into structured records", () => {
    const logDir = createTempDir();
    const runtime = createCodeHelmLogger({
      env: {
        CODE_HELM_LOG_DIR: logDir,
      },
      console: false,
      now: () => new Date(2026, 3, 26, 12),
    });

    runtime.logger.error("Failed to handle Discord thread message", new Error("Unknown Message"));
    runtime.shutdown();

    expect(readMessages(logDir)[0]).toMatchObject({
      level: 50,
      msg: "Failed to handle Discord thread message",
      err: {
        name: "Error",
        message: "Unknown Message",
      },
    });
  });

  test("exposes trace because the accepted level list includes trace", () => {
    const logDir = createTempDir();
    const runtime = createCodeHelmLogger({
      env: {
        CODE_HELM_LOG_DIR: logDir,
        CODE_HELM_LOG_LEVEL: "trace",
      },
      console: false,
      now: () => new Date(2026, 3, 26, 12),
    });

    runtime.logger.trace("trace detail");
    runtime.shutdown();

    expect(readMessages(logDir)[0]).toMatchObject({
      level: 10,
      msg: "trace detail",
    });
  });

  test("initializeLogger starts retention and shutdownLogger stops it", () => {
    const logDir = createTempDir();
    const scheduled: unknown[] = [];
    const cleared: unknown[] = [];
    const timer = { unref() {} };

    initializeLogger({
      env: {
        CODE_HELM_LOG_DIR: logDir,
      },
      console: false,
      now: () => new Date(2026, 3, 26, 12),
      setIntervalFn: (callback, intervalMs) => {
        scheduled.push({ callback, intervalMs });
        return timer;
      },
      clearIntervalFn: (value) => {
        cleared.push(value);
      },
    });

    expect(scheduled).toHaveLength(1);

    shutdownLogger();

    expect(cleared).toEqual([timer]);
  });
});
