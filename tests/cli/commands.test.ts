import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliCommand } from "../../src/cli/args";
import { runCliCommand, type CommandServices } from "../../src/cli/commands";
import type { AppConfig } from "../../src/config";

const tempDirs: string[] = [];

const createTempDir = () => {
  const directory = mkdtempSync(join(tmpdir(), "codehelm-cli-commands-"));
  tempDirs.push(directory);
  return directory;
};

const createPaths = () => {
  const root = createTempDir();

  return {
    configPath: join(root, "config", "config.toml"),
    secretsPath: join(root, "config", "secrets.toml"),
    databasePath: join(root, "data", "codehelm.sqlite"),
    stateDir: join(root, "state"),
  };
};

const createConfig = (appServerUrl = "ws://127.0.0.1:4100"): AppConfig => ({
  DISCORD_APP_ID: "app-1",
  discord: {
    botToken: "token-1",
    appId: "app-1",
    guildId: "guild-1",
    controlChannelId: "channel-1",
  },
  codex: {
    appServerUrl,
  },
  databasePath: ":memory:",
  workspace: {
    id: "workspace-1",
    name: "CodeHelm",
  },
});

const createBaseServices = (): CommandServices => {
  const paths = createPaths();
  const config = createConfig();

  return {
    backgroundRuntimeTimeoutMs: 15_000,
    env: {},
    loadConfigStore: () => ({
      config: {
        discord: {
          guildId: config.discord.guildId,
          controlChannelId: config.discord.controlChannelId,
        },
        codex: {
          appServerMode: "managed",
        },
        database: {
          path: paths.databasePath,
        },
      },
      secrets: {
        discord: {
          botToken: config.discord.botToken,
        },
      },
      paths,
    }),
    loadAppConfig: () => config,
    readRuntimeSummary: () => undefined,
    isPidAlive: () => false,
    runOnboarding: async () => ({ kind: "completed" }),
    startForeground: async () => ({
      config,
      stop: async () => {},
    }),
    spawnBackgroundProcess: () => ({
      pid: 4321,
      unref() {},
    }),
    signalProcess: () => true,
    waitForRuntimeExit: async () => true,
    waitForBackgroundRuntime: async () => ({
      pid: 4321,
      mode: "background",
      discord: {
        guildId: "guild-1",
        controlChannelId: "channel-1",
        connected: true,
      },
      codex: {
        appServerAddress: "ws://127.0.0.1:4100",
        pid: 8765,
        running: true,
      },
      startedAt: "2026-04-16T08:30:00.000Z",
    }),
    removePath: () => {},
  };
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    Bun.spawnSync(["rm", "-rf", directory]);
  }
});

describe("runCliCommand", () => {
  test("start auto-enters onboarding when config is missing", async () => {
    const services = createBaseServices();
    let loadCalls = 0;
    let onboarded = false;

    services.loadConfigStore = () => {
      loadCalls += 1;

      if (!onboarded) {
        return {
          paths: createPaths(),
        };
      }

      return createBaseServices().loadConfigStore();
    };
    services.runOnboarding = async () => {
      onboarded = true;
      return { kind: "completed" };
    };

    await runCliCommand({ kind: "start", daemon: false }, services);

    expect(onboarded).toBe(true);
    expect(loadCalls).toBeGreaterThanOrEqual(2);
  });

  test("start returns current status instead of launching a second instance", async () => {
    const services = createBaseServices();
    let started = false;

    services.readRuntimeSummary = () => ({
      pid: 2222,
      mode: "background",
      discord: {
        guildId: "guild-1",
        controlChannelId: "channel-1",
        connected: true,
      },
      codex: {
        appServerAddress: "ws://127.0.0.1:4200",
        pid: 999,
        running: true,
      },
      startedAt: "2026-04-16T08:00:00.000Z",
    });
    services.startForeground = async () => {
      started = true;
      return {
        config: createConfig(),
        stop: async () => {},
      };
    };

    const result = await runCliCommand({ kind: "start", daemon: false }, services);

    expect(started).toBe(false);
    expect(result.output).toContain("CodeHelm running");
    expect(result.output).toContain("codex --remote ws://127.0.0.1:4200");
  });

  test("start --daemon records background runtime state", async () => {
    const services = createBaseServices();
    let spawnedEnv: Record<string, string | undefined> | undefined;

    services.loadConfigStore = () => ({
      ...createBaseServices().loadConfigStore(),
      paths: createPaths(),
    });
    services.spawnBackgroundProcess = ({ env }) => {
      spawnedEnv = env;
      return {
        pid: 4321,
        unref() {},
      };
    };

    const result = await runCliCommand({ kind: "start", daemon: true }, services);

    expect(result.output).toContain("Mode: background");
    expect(result.output).toContain("codex --remote ws://127.0.0.1:4100");
    expect(spawnedEnv?.CODE_HELM_CONFIG).toBeTruthy();
    expect(spawnedEnv?.CODE_HELM_SECRETS).toBeTruthy();
  });

  test("start --daemon stops the child when runtime state never appears", async () => {
    const services = createBaseServices();
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    services.spawnBackgroundProcess = () => ({
      pid: 5555,
      unref() {},
    });
    services.waitForBackgroundRuntime = async () => undefined;
    services.signalProcess = (pid, signal) => {
      signalled.push({ pid, signal });
      return true;
    };

    await expect(
      runCliCommand({ kind: "start", daemon: true }, services),
    ).rejects.toThrow(/did not publish runtime state/i);
    expect(signalled).toEqual([{ pid: 5555, signal: "SIGTERM" }]);
  });

  test("start --daemon forwards the configured runtime wait timeout", async () => {
    const services = createBaseServices();
    let receivedTimeoutMs: number | undefined;

    services.backgroundRuntimeTimeoutMs = 12_345;
    services.waitForBackgroundRuntime = async ({ timeoutMs }) => {
      receivedTimeoutMs = timeoutMs;
      return {
        pid: 4321,
        mode: "background",
        discord: {
          guildId: "guild-1",
          controlChannelId: "channel-1",
          connected: true,
        },
        codex: {
          appServerAddress: "ws://127.0.0.1:4100",
          pid: 8765,
          running: true,
        },
        startedAt: "2026-04-16T08:30:00.000Z",
      };
    };

    await runCliCommand({ kind: "start", daemon: true }, services);

    expect(receivedTimeoutMs).toBe(12_345);
  });

  test("start forwards legacy workspace bootstrap to foreground startup", async () => {
    const services = createBaseServices();
    let receivedLegacyBootstrap: unknown;

    services.env = {
      WORKSPACE_ROOT: "/tmp/workspace",
      WORKDIRS_JSON:
        '[{"id":"api","label":"API","absolutePath":"/tmp/workspace/api"}]',
    };
    services.startForeground = async (options) => {
      receivedLegacyBootstrap = options.legacyWorkspaceBootstrap;
      return {
        config: createConfig(),
        stop: async () => {},
      };
    };

    await runCliCommand({ kind: "start", daemon: false }, services);

    expect(receivedLegacyBootstrap).toEqual({
      workspaceRoot: "/tmp/workspace",
      workdirs: [
        {
          id: "api",
          label: "API",
          absolutePath: "/tmp/workspace/api",
        },
      ],
    });
  });

  test("status prints concise summary including app-server address and codex remote command", async () => {
    const services = createBaseServices();

    services.readRuntimeSummary = () => ({
      pid: 2222,
      mode: "foreground",
      discord: {
        guildId: "guild-1",
        controlChannelId: "channel-1",
        connected: true,
      },
      codex: {
        appServerAddress: "ws://127.0.0.1:4400",
        pid: 999,
        running: true,
      },
      startedAt: "2026-04-16T09:00:00.000Z",
    });

    const result = await runCliCommand({ kind: "status" }, services);

    expect(result.output).toContain("CodeHelm running");
    expect(result.output).toContain("ws://127.0.0.1:4400");
    expect(result.output).toContain("codex --remote ws://127.0.0.1:4400");
  });

  test("stop shuts down the background daemon and its managed app server", async () => {
    const services = createBaseServices();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let runtime = {
      pid: 3333,
      mode: "background" as const,
      discord: {
        guildId: "guild-1",
        controlChannelId: "channel-1",
        connected: true,
      },
      codex: {
        appServerAddress: "ws://127.0.0.1:4500",
        pid: 7777,
        running: true,
      },
      startedAt: "2026-04-16T10:00:00.000Z",
    };

    services.readRuntimeSummary = () => runtime;
    services.signalProcess = (pid, signal) => {
      signals.push({ pid, signal });
      runtime = undefined as never;
      return true;
    };

    const result = await runCliCommand({ kind: "stop" }, services);

    expect(signals).toEqual([{ pid: 3333, signal: "SIGTERM" }]);
    expect(result.output).toContain("CodeHelm stopped");
  });

  test("uninstall clears config, secrets, db, and runtime state without confirmation", async () => {
    const services = createBaseServices();
    const paths = createPaths();

    mkdirSync(join(paths.configPath, ".."), { recursive: true });
    mkdirSync(join(paths.databasePath, ".."), { recursive: true });
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.configPath, "config", "utf8");
    writeFileSync(paths.secretsPath, "secrets", "utf8");
    writeFileSync(paths.databasePath, "db", "utf8");
    writeFileSync(join(paths.stateDir, "runtime.json"), "{}", "utf8");

    services.loadConfigStore = () => ({
      ...createBaseServices().loadConfigStore(),
      paths,
    });
    services.removePath = (targetPath) => {
      Bun.spawnSync(["rm", "-rf", targetPath]);
    };

    const result = await runCliCommand({ kind: "uninstall" }, services);

    expect(existsSync(paths.configPath)).toBe(false);
    expect(existsSync(paths.secretsPath)).toBe(false);
    expect(existsSync(paths.databasePath)).toBe(false);
    expect(existsSync(paths.stateDir)).toBe(false);
    expect(result.output).toContain("Uninstall complete");
  });

  test("uninstall attempts every cleanup path before surfacing failures", async () => {
    const services = createBaseServices();
    const paths = createPaths();
    const attemptedPaths: string[] = [];

    services.loadConfigStore = () => ({
      ...createBaseServices().loadConfigStore(),
      paths,
    });
    services.removePath = (targetPath) => {
      attemptedPaths.push(targetPath);

      if (targetPath === paths.configPath) {
        throw new Error("cannot remove config");
      }
    };

    await expect(
      runCliCommand({ kind: "uninstall" }, services),
    ).rejects.toThrow(/cannot remove config/i);
    expect(attemptedPaths).toEqual([
      paths.configPath,
      paths.secretsPath,
      paths.databasePath,
      paths.stateDir,
    ]);
  });

  test("uninstall still clears local resources when stopping the background daemon fails", async () => {
    const services = createBaseServices();
    const paths = createPaths();
    const attemptedPaths: string[] = [];

    services.loadConfigStore = () => ({
      ...createBaseServices().loadConfigStore(),
      paths,
    });
    services.readRuntimeSummary = () => ({
      pid: 3333,
      mode: "background",
      discord: {
        guildId: "guild-1",
        controlChannelId: "channel-1",
        connected: true,
      },
      codex: {
        appServerAddress: "ws://127.0.0.1:4500",
        pid: 7777,
        running: true,
      },
      startedAt: "2026-04-16T10:00:00.000Z",
    });
    services.waitForRuntimeExit = async () => false;
    services.removePath = (targetPath) => {
      attemptedPaths.push(targetPath);
    };

    await expect(
      runCliCommand({ kind: "uninstall" }, services),
    ).rejects.toThrow(/did not stop before the timeout expired/i);
    expect(attemptedPaths).toEqual([
      paths.configPath,
      paths.secretsPath,
      paths.databasePath,
      paths.stateDir,
    ]);
  });
});
