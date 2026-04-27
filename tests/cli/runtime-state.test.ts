import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireInstanceLock,
  clearStartupError,
  clearRuntimeState,
  readStartupError,
  readRuntimeSummary,
  releaseInstanceLock,
  writeStartupError,
  writeRuntimeSummary,
  type RuntimeSummary,
} from "../../src/cli/runtime-state";

const tempDirs: string[] = [];

const createTempDir = () => {
  const directory = mkdtempSync(join(tmpdir(), "codehelm-runtime-state-"));
  tempDirs.push(directory);
  return directory;
};

const createStateDir = () => join(createTempDir(), "state");

const createRuntimeSummary = (pid = 1234): RuntimeSummary => ({
  pid,
  mode: "foreground",
  discord: {
    guildId: "guild-1",
  },
  codex: {
    appServerAddress: "ws://127.0.0.1:4500",
  },
});

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime-state", () => {
  test("acquires a fresh instance lock", () => {
    const stateDir = createStateDir();

    const result = acquireInstanceLock({
      stateDir,
      pid: 1234,
      isPidAlive: () => true,
    });

    expect(result).toMatchObject({
      pid: 1234,
      cleanedStaleState: false,
    });
    expect(existsSync(join(stateDir, "instance.lock"))).toBe(true);
  });

  test("rejects a second active lock", () => {
    const stateDir = createStateDir();

    acquireInstanceLock({
      stateDir,
      pid: 1234,
      isPidAlive: () => true,
    });

    expect(() =>
      acquireInstanceLock({
        stateDir,
        pid: 5678,
        isPidAlive: (pid) => pid === 1234,
      }),
    ).toThrow(/already running/i);
  });

  test("cleans stale state when the pid no longer exists", () => {
    const stateDir = createStateDir();
    const lockPath = join(stateDir, "instance.lock");
    const runtimePath = join(stateDir, "runtime.json");

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 1234 }), "utf8");
    writeRuntimeSummary({
      stateDir,
      summary: createRuntimeSummary(1234),
    });

    const result = acquireInstanceLock({
      stateDir,
      pid: 5678,
      isPidAlive: () => false,
    });

    expect(result).toMatchObject({
      pid: 5678,
      cleanedStaleState: true,
    });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: 5678,
    });
    expect(existsSync(runtimePath)).toBe(false);
  });

  test("drops stale runtime.json without clearing a live instance lock", () => {
    const stateDir = createStateDir();
    const lockPath = join(stateDir, "instance.lock");
    const runtimePath = join(stateDir, "runtime.json");

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 5678 }), "utf8");
    writeRuntimeSummary({
      stateDir,
      summary: createRuntimeSummary(1234),
    });

    expect(
      readRuntimeSummary({
        stateDir,
        isPidAlive: (pid) => pid === 5678,
      }),
    ).toBeUndefined();
    expect(existsSync(runtimePath)).toBe(false);
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: 5678,
    });
  });

  test("writes and reads runtime.json", () => {
    const stateDir = createStateDir();

    writeRuntimeSummary({
      stateDir,
      summary: createRuntimeSummary(),
    });

    expect(
      readRuntimeSummary({
        stateDir,
        isPidAlive: (pid) => pid === 1234,
      }),
    ).toMatchObject({
      pid: 1234,
      mode: "foreground",
      discord: { guildId: "guild-1" },
      codex: { appServerAddress: "ws://127.0.0.1:4500" },
    });
  });

  test("writes and reads runtime.json with codex startup state", () => {
    const stateDir = createStateDir();

    writeRuntimeSummary({
      stateDir,
      summary: {
        ...createRuntimeSummary(),
        codex: {
          ...createRuntimeSummary().codex,
          startupState: "ready",
        },
      } as RuntimeSummary,
    });

    expect(
      readRuntimeSummary({
        stateDir,
        isPidAlive: (pid) => pid === 1234,
      }),
    ).toMatchObject({
      codex: {
        appServerAddress: "ws://127.0.0.1:4500",
        startupState: "ready",
      },
    });
  });

  test("writes reads and clears startup-error.json", () => {
    const directory = createTempDir();

    writeStartupError({
      stateDir: directory,
      error: {
        stage: "managed-app-server",
        appServerAddress: "ws://127.0.0.1:4201",
        message: "Managed Codex App Server failed to start.",
        diagnostics: "address already in use",
        occurredAt: "2026-04-27T12:00:00.000Z",
      },
    });

    expect(readStartupError({ stateDir: directory })).toEqual({
      stage: "managed-app-server",
      appServerAddress: "ws://127.0.0.1:4201",
      message: "Managed Codex App Server failed to start.",
      diagnostics: "address already in use",
      occurredAt: "2026-04-27T12:00:00.000Z",
    });

    clearStartupError({ stateDir: directory });
    expect(readStartupError({ stateDir: directory })).toBeUndefined();
  });

  test("readStartupError removes invalid startup-error state", () => {
    const directory = createTempDir();
    writeFileSync(join(directory, "startup-error.json"), "{bad json");

    expect(readStartupError({ stateDir: directory })).toBeUndefined();
    expect(existsSync(join(directory, "startup-error.json"))).toBe(false);
  });

  test("cleans corrupt runtime.json without masking a real active conflict", () => {
    const stateDir = createStateDir();
    const runtimePath = join(stateDir, "runtime.json");
    const lockPath = join(stateDir, "instance.lock");

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(runtimePath, "{not-valid-json", "utf8");
    writeFileSync(lockPath, JSON.stringify({ pid: 1234 }), "utf8");

    expect(
      readRuntimeSummary({
        stateDir,
        isPidAlive: () => true,
      }),
    ).toBeUndefined();
    expect(existsSync(runtimePath)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);

    expect(() =>
      acquireInstanceLock({
        stateDir,
        pid: 5678,
        isPidAlive: (pid) => pid === 1234,
      }),
    ).toThrow(/already running/i);
  });

  test("rejects unreadable lock files instead of silently stealing the lock", () => {
    const stateDir = createStateDir();
    const lockPath = join(stateDir, "instance.lock");

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(lockPath, "{not-valid-json", "utf8");

    expect(() =>
      acquireInstanceLock({
        stateDir,
        pid: 5678,
        isPidAlive: () => false,
      }),
    ).toThrow(/unreadable/i);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("releases the instance lock", () => {
    const stateDir = createStateDir();
    const lockPath = join(stateDir, "instance.lock");

    acquireInstanceLock({
      stateDir,
      pid: 1234,
      isPidAlive: () => true,
    });

    releaseInstanceLock({ stateDir });

    expect(existsSync(lockPath)).toBe(false);
  });

  test("clears both runtime.json and instance.lock", () => {
    const stateDir = createStateDir();
    const lockPath = join(stateDir, "instance.lock");
    const runtimePath = join(stateDir, "runtime.json");

    acquireInstanceLock({
      stateDir,
      pid: 1234,
      isPidAlive: () => true,
    });
    writeRuntimeSummary({
      stateDir,
      summary: createRuntimeSummary(),
    });

    clearRuntimeState({ stateDir });

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(runtimePath)).toBe(false);
  });
});
