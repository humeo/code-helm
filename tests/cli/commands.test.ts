import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliCommand } from "../../src/cli/args";
import {
  buildDefaultPackageUpdateCommand,
  runCliCommand,
  type CommandServices,
} from "../../src/cli/commands";
import { CodexSupervisorError } from "../../src/codex/supervisor";
import type { AppConfig } from "../../src/config";
import { readPackageMetadata } from "../../src/package-metadata";

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
    enableAutostart: async () => ({
      kind: "enabled",
      label: "dev.codehelm.code-helm",
      launchAgentPath: "/tmp/code-helm.plist",
    }),
    disableAutostart: async () => ({
      kind: "disabled",
      label: "dev.codehelm.code-helm",
      launchAgentPath: "/tmp/code-helm.plist",
      removed: true,
    }),
    runPackageUpdate: async () => ({
      command: buildDefaultPackageUpdateCommand().join(" "),
      exitCode: 0,
      stdout: "changed 1 package",
      stderr: "",
    }),
    removePath: () => {},
  };
};

const formatStartedAtForDisplay = (value: string, timeZone?: string) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  }).formatToParts(date);

  const readPart = (type: Intl.DateTimeFormatPartTypes) => {
    return parts.find((part) => part.type === type)?.value ?? "";
  };

  return `${readPart("year")}-${readPart("month")}-${readPart("day")} ${readPart("hour")}:${readPart("minute")}:${readPart("second")} ${readPart("timeZoneName")}`;
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    Bun.spawnSync(["rm", "-rf", directory]);
  }
});

describe("runCliCommand", () => {
  test("default package update command targets npm global latest install", () => {
    expect(buildDefaultPackageUpdateCommand()).toEqual([
      "npm",
      "install",
      "-g",
      "code-helm@latest",
    ]);
  });

  test("help renders the full operator-facing command surface without touching config or runtime", async () => {
    const services = createBaseServices();
    let loadConfigStoreCalls = 0;
    let readRuntimeSummaryCalls = 0;

    services.loadConfigStore = () => {
      loadConfigStoreCalls += 1;
      throw new Error("help should not load config");
    };
    services.readRuntimeSummary = () => {
      readRuntimeSummaryCalls += 1;
      throw new Error("help should not read runtime");
    };

    const result = await runCliCommand({ kind: "help" }, services);

    expect(loadConfigStoreCalls).toBe(0);
    expect(readRuntimeSummaryCalls).toBe(0);
    expect(result.output).toContain("CodeHelm");
    expect(result.output).toContain("Get started");
    expect(result.output).toContain("Runtime");
    expect(result.output).toContain("Automation");
    expect(result.output).toContain("Maintenance");
    expect(result.output).toContain("Common flows");
    expect(result.output).toContain("onboard");
    expect(result.output).toContain("Connect Discord and initialize local state");
    expect(result.output).toContain("start --daemon");
    expect(result.output).toContain("Start CodeHelm in background");
    expect(result.output).toContain("autostart enable");
    expect(result.output).toContain("Enable automatic startup");
    expect(result.output).toContain("uninstall");
    expect(result.output).toContain("Remove local CodeHelm data");
    expect(result.output).not.toContain("Overview");
  });

  test("version renders package metadata without touching config or runtime", async () => {
    const services = createBaseServices();
    const expectedMetadata = readPackageMetadata();
    let loadConfigStoreCalls = 0;
    let readRuntimeSummaryCalls = 0;

    services.loadConfigStore = () => {
      loadConfigStoreCalls += 1;
      throw new Error("version should not load config");
    };
    services.readRuntimeSummary = () => {
      readRuntimeSummaryCalls += 1;
      throw new Error("version should not read runtime");
    };

    const result = await runCliCommand({ kind: "version" }, services);

    expect(loadConfigStoreCalls).toBe(0);
    expect(readRuntimeSummaryCalls).toBe(0);
    expect(result.output).toContain(`CodeHelm ${expectedMetadata.version}`);
    expect(result.output).toContain(expectedMetadata.name);
    expect(result.output).not.toContain("CodeHelm Version");
  });

  test("update renders a success panel without touching config or runtime", async () => {
    const services = createBaseServices() as CommandServices & {
      runPackageUpdate: () => Promise<{
        command: string;
        exitCode: number;
        stdout: string;
        stderr: string;
        error?: string;
      }>;
    };
    let loadConfigStoreCalls = 0;
    let readRuntimeSummaryCalls = 0;

    services.loadConfigStore = () => {
      loadConfigStoreCalls += 1;
      throw new Error("update should not load config");
    };
    services.readRuntimeSummary = () => {
      readRuntimeSummaryCalls += 1;
      throw new Error("update should not read runtime");
    };
    services.runPackageUpdate = async () => ({
      command: buildDefaultPackageUpdateCommand().join(" "),
      exitCode: 0,
      stdout: "changed 1 package",
      stderr: "",
    });

    const result = await runCliCommand({ kind: "update" }, services);

    expect(loadConfigStoreCalls).toBe(0);
    expect(readRuntimeSummaryCalls).toBe(0);
    expect(result.output).toContain("CodeHelm Updated");
    expect(result.output).toContain("Command run");
    expect(result.output).toContain("npm install -g code-helm@latest");
    expect(result.output).toContain("Next steps");
    expect(result.output).toContain("code-helm version");
  });

  test("update surfaces a failed npm exit as an error panel", async () => {
    const services = createBaseServices() as CommandServices & {
      runPackageUpdate: () => Promise<{
        command: string;
        exitCode: number;
        stdout: string;
        stderr: string;
        error?: string;
      }>;
    };

    services.runPackageUpdate = async () => ({
      command: buildDefaultPackageUpdateCommand().join(" "),
      exitCode: 1,
      stdout: "",
      stderr: "npm ERR! code EACCES",
    });

    await expect(
      runCliCommand({ kind: "update" }, services),
    ).rejects.toThrow(/Update Failed/);
  });

  test("update reports missing npm with explicit failure copy", async () => {
    const services = createBaseServices() as CommandServices & {
      runPackageUpdate: () => Promise<{
        command: string;
        exitCode: number;
        stdout: string;
        stderr: string;
        error?: string;
      }>;
    };

    services.runPackageUpdate = async () => ({
      command: buildDefaultPackageUpdateCommand().join(" "),
      exitCode: 1,
      stdout: "",
      stderr: "",
      error: "spawn npm ENOENT",
    });

    await expect(
      runCliCommand({ kind: "update" }, services),
    ).rejects.toThrow(/npm/i);
  });

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
    expect(result.output).toContain("Runtime");
    expect(result.output).toContain("Process");
    expect(result.output).toContain("Connections");
    expect(result.output).toContain("Next steps");
    expect(result.output).toContain("codex --remote ws://127.0.0.1:4200");
    expect(result.output).toContain("already active");
    expect(result.output).not.toContain("CodeHelm running\nMode:");
  });

  test("start renders runtime start time in local display format instead of raw UTC iso", async () => {
    const services = createBaseServices();
    const startedAt = "2026-04-17T08:22:19.208Z";
    services.env = {
      ...services.env,
      TZ: "Asia/Shanghai",
    };

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
      startedAt,
    });

    const result = await runCliCommand({ kind: "start", daemon: false }, services);

    const escapedStarted = formatStartedAtForDisplay(startedAt, "Asia/Shanghai")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(result.output).toMatch(
      new RegExp(`Started\\s+${escapedStarted}\\s*\\(Asia\\/Shanghai\\)`),
    );
    expect(result.output).not.toContain(`Started  ${startedAt}`);
  });

  test("start with invalid TZ falls back to system-default timezone display in runtime panel", async () => {
    const services = createBaseServices();
    services.env = {
      ...services.env,
      TZ: "Mars/Phobos",
    };
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
      startedAt: "2026-04-17T08:22:19.208Z",
    });

    const result = await runCliCommand({ kind: "start", daemon: false }, services);

    expect(result.output).toMatch(/Time Zone\s+system default/);
    expect(result.output).not.toContain("Mars/Phobos");
  });

  test("start foreground success renders runtime panel output", async () => {
    const services = createBaseServices();

    const result = await runCliCommand({ kind: "start", daemon: false }, services);

    expect(result.output).toContain("Runtime");
    expect(result.output).toContain("Process");
    expect(result.output).toContain("Connections");
    expect(result.output).toContain("Configuration");
    expect(result.output).toContain("Next steps");
    expect(result.output).toMatch(/Mode\s+foreground/);
    expect(result.output).toMatch(/Started\s+/);
    expect(result.output).toMatch(/PID\s+\d+/);
    expect(result.output).toContain("codex --remote ws://127.0.0.1:4100");
    expect(result.output).not.toContain("code-helm stop");
    expect(result.output).toContain("Ctrl+C");
    expect(result.output).not.toContain("CodeHelm running\nMode:");
  });

  test("start renders delayed managed startup as warning-style copy", async () => {
    const services = createBaseServices();
    let startedRuntime = false;

    services.startForeground = async () => {
      startedRuntime = true;
      throw new CodexSupervisorError(
        "CODEX_APP_SERVER_FAILED_TO_START",
        "Managed Codex App Server did not become ready before the startup timeout expired.",
        {
          startupDisposition: "delayed",
          diagnostics: "last stderr line",
          startupTimeoutMs: 5_000,
        },
      );
    };

    await expect(
      runCliCommand({ kind: "start", daemon: false }, services),
    ).rejects.toThrow(
      /taking longer than expected/i,
    );
    await expect(
      runCliCommand({ kind: "start", daemon: false }, services),
    ).rejects.toThrow(/try running the command again/i);
    await expect(
      runCliCommand({ kind: "start", daemon: false }, services),
    ).rejects.toThrow(/last stderr line/i);
    expect(startedRuntime).toBe(true);
  });

  test("start renders failed managed startup explicitly", async () => {
    const services = createBaseServices();

    services.startForeground = async () => {
      throw new CodexSupervisorError(
        "CODEX_APP_SERVER_FAILED_TO_START",
        "Managed Codex App Server failed before becoming ready: spawn boom",
        {
          startupDisposition: "failed",
          diagnostics: "spawn boom",
        },
      );
    };

    await expect(
      runCliCommand({ kind: "start", daemon: false }, services),
    ).rejects.toThrow(/failed to start/i);
    await expect(
      runCliCommand({ kind: "start", daemon: false }, services),
    ).rejects.toThrow(/Startup Failed/i);
    await expect(
      runCliCommand({ kind: "start", daemon: false }, services),
    ).rejects.toThrow(/try running the command again/i);
    await expect(
      runCliCommand({ kind: "start", daemon: false }, services),
    ).rejects.toThrow(/spawn boom/i);
  });

  test("start renders certificate verification startup failures with targeted certificate guidance", async () => {
    const services = createBaseServices();

    services.startForeground = async () => {
      throw new CodexSupervisorError(
        "CODEX_APP_SERVER_FAILED_TO_START",
        "Managed Codex App Server failed before becoming ready: tls certificate verify failed",
        {
          startupDisposition: "failed",
          diagnostics: "tls: failed to verify certificate chain",
        },
      );
    };

    await expect(
      runCliCommand({ kind: "start", daemon: false }, services),
    ).rejects.toThrow(/certificate trust setup/i);
    await expect(
      runCliCommand({ kind: "start", daemon: false }, services),
    ).rejects.toThrow(/Startup Failed/i);
    await expect(
      runCliCommand({ kind: "start", daemon: false }, services),
    ).rejects.toThrow(/proxy/i);
    await expect(
      runCliCommand({ kind: "start", daemon: false }, services),
    ).rejects.toThrow(/tls: failed to verify certificate chain/i);
  });

  test("start treats known certificate error-code signatures as certificate guidance failures", async () => {
    const services = createBaseServices();
    const certificateCodes = [
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "CERT_HAS_EXPIRED",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ];

    for (const certificateCode of certificateCodes) {
      services.startForeground = async () => {
        throw new CodexSupervisorError(
          "CODEX_APP_SERVER_FAILED_TO_START",
          `Managed Codex App Server failed before becoming ready: ${certificateCode}`,
          {
            startupDisposition: "failed",
            diagnostics: `startup failed with ${certificateCode}`,
          },
        );
      };

      await expect(
        runCliCommand({ kind: "start", daemon: false }, services),
      ).rejects.toThrow(/Startup Failed/i);
      await expect(
        runCliCommand({ kind: "start", daemon: false }, services),
      ).rejects.toThrow(/certificate trust setup/i);
    }
  });

  test("start keeps non-certificate tls failures on generic startup-failed guidance", async () => {
    const services = createBaseServices();

    services.startForeground = async () => {
      throw new CodexSupervisorError(
        "CODEX_APP_SERVER_FAILED_TO_START",
        "Managed Codex App Server failed before becoming ready: tls handshake timeout",
        {
          startupDisposition: "failed",
          diagnostics: "tls handshake timeout while connecting to upstream",
        },
      );
    };

    let thrown: unknown;

    try {
      await runCliCommand({ kind: "start", daemon: false }, services);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/Startup Failed/i);
    expect(message).toMatch(/failed to start/i);
    expect(message).not.toMatch(/certificate trust setup/i);
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

    expect(result.output).toContain("Runtime");
    expect(result.output).toContain("Process");
    expect(result.output).toContain("Connections");
    expect(result.output).toContain("Next steps");
    expect(result.output).toMatch(/Mode\s+background/);
    expect(result.output).toMatch(/Started\s+/);
    expect(result.output).toMatch(/PID\s+\d+/);
    expect(result.output).toContain("codex --remote ws://127.0.0.1:4100");
    expect(result.output).toContain("code-helm stop");
    expect(result.output).not.toContain("CodeHelm running\nMode:");
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

  test("status renders the runtime panel including app-server address and codex remote command", async () => {
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

    expect(result.output).toContain("Runtime");
    expect(result.output).toContain("Process");
    expect(result.output).toContain("Connections");
    expect(result.output).toContain("Next steps");
    expect(result.output).toMatch(/Mode\s+foreground/);
    expect(result.output).toMatch(/Started\s+/);
    expect(result.output).toMatch(/PID\s+2222/);
    expect(result.output).toContain("ws://127.0.0.1:4400");
    expect(result.output).toContain("codex --remote ws://127.0.0.1:4400");
    expect(result.output).not.toContain("code-helm stop");
    expect(result.output).not.toContain("Ctrl+C");
    expect(result.output).toContain("Use the terminal running this foreground process to stop it.");
    expect(result.output).not.toContain("CodeHelm running\nMode:");
  });

  test("status renders a not-running runtime panel when no instance is active", async () => {
    const services = createBaseServices();

    const result = await runCliCommand({ kind: "status" }, services);

    expect(result.output).toContain("Runtime");
    expect(result.output).toContain("Process");
    expect(result.output).toContain("Next steps");
    expect(result.output).toContain("not running");
    expect(result.output).toMatch(/Mode\s+not running/);
    expect(result.output).not.toContain("Started  n/a");
    expect(result.output).not.toContain("PID  n/a");
    expect(result.output).not.toContain("CodeHelm stopped");
  });

  test("autostart enable delegates to the autostart service", async () => {
    const services = createBaseServices();
    let called = false;

    services.enableAutostart = async () => {
      called = true;
      return {
        kind: "enabled",
        label: "dev.codehelm.code-helm",
        launchAgentPath: "/tmp/code-helm.plist",
      };
    };

    const result = await runCliCommand({ kind: "autostart", action: "enable" }, services);

    expect(called).toBe(true);
    expect(result.output).toContain("Autostart Enabled");
    expect(result.output).toContain("Configuration");
    expect(result.output).toContain("Current State");
    expect(result.output).toContain("Enabled");
    expect(result.output).toContain("Label");
    expect(result.output).toContain("dev.codehelm.code-helm");
    expect(result.output).toContain("Launch Agent");
    expect(result.output).toContain("/tmp/code-helm.plist");
  });

  test("autostart disable delegates to the autostart service", async () => {
    const services = createBaseServices();
    let called = false;

    services.disableAutostart = async () => {
      called = true;
      return {
        kind: "disabled",
        label: "dev.codehelm.code-helm",
        launchAgentPath: "/tmp/code-helm.plist",
        removed: true,
      };
    };

    const result = await runCliCommand({ kind: "autostart", action: "disable" }, services);

    expect(called).toBe(true);
    expect(result.output).toContain("Autostart Disabled");
    expect(result.output).toContain("Status");
    expect(result.output).toContain("Removal");
    expect(result.output).toContain("Removed");
  });

  test("autostart enable renders a mismatch warning when service returns disabled", async () => {
    const services = createBaseServices();

    services.enableAutostart = async () => ({
      kind: "disabled",
      label: "dev.codehelm.code-helm",
      launchAgentPath: "/tmp/code-helm.plist",
      removed: true,
    });

    const result = await runCliCommand({ kind: "autostart", action: "enable" }, services);

    expect(result.output).toContain("Autostart State Mismatch");
    expect(result.output).toContain("Requested Action");
    expect(result.output).toContain("enable");
    expect(result.output).toContain("Result Kind");
    expect(result.output).toContain("disabled");
  });

  test("autostart disable renders not-found status when launch agent was absent", async () => {
    const services = createBaseServices();

    services.disableAutostart = async () => ({
      kind: "disabled",
      label: "dev.codehelm.code-helm",
      launchAgentPath: "/tmp/code-helm.plist",
      removed: false,
    });

    const result = await runCliCommand({ kind: "autostart", action: "disable" }, services);

    expect(result.output).toContain("Autostart Disabled");
    expect(result.output).toContain("Removal");
    expect(result.output).toContain("Not found");
  });

  test("autostart unsupported renders a warning-style panel", async () => {
    const services = createBaseServices();

    services.enableAutostart = async () => ({
      kind: "unsupported",
      platform: "linux",
    });

    const result = await runCliCommand({ kind: "autostart", action: "enable" }, services);

    expect(result.output).toContain("Autostart Unsupported");
    expect(result.output).toContain("Status");
    expect(result.output).toContain("Platform");
    expect(result.output).toContain("linux");
    expect(result.output).not.toContain("Autostart is unsupported on linux.");
  });

  test("onboard already-running keeps the non-panel style output path", async () => {
    const services = createBaseServices();

    services.runOnboarding = async () => ({ kind: "already-running" });
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

    const result = await runCliCommand({ kind: "onboard" }, services);

    expect(result.output).toContain("CodeHelm running");
    expect(result.output).toContain("Mode: background");
    expect(result.output).toContain(
      "Stop the running instance with `code-helm stop`, then run `code-helm onboard` again.",
    );
    expect(result.output).not.toContain("CodeHelm Runtime");
  });

  test("onboard already-running with TZ set keeps legacy runtime-summary formatting", async () => {
    const services = createBaseServices();
    const startedAt = "2026-04-16T08:00:00.000Z";

    services.env = {
      ...services.env,
      TZ: "Asia/Shanghai",
    };
    services.runOnboarding = async () => ({ kind: "already-running" });
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
      startedAt,
    });

    const result = await runCliCommand({ kind: "onboard" }, services);

    expect(result.output).toContain("CodeHelm running");
    expect(result.output).toContain(
      `Started: ${formatStartedAtForDisplay(startedAt, "Asia/Shanghai")}`,
    );
    expect(result.output).not.toContain("(Asia/Shanghai)");
    expect(result.output).not.toContain("CodeHelm Runtime");
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
    expect(result.output).toContain("Runtime stopped");
    expect(result.output).toContain("no longer active");
    expect(result.output).toContain("Next steps");
  });

  test("stop on foreground runtime renders a panel that explains it must be stopped from the owning terminal", async () => {
    const services = createBaseServices();
    let signaled = false;

    services.readRuntimeSummary = () => ({
      pid: 3333,
      mode: "foreground",
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
    services.signalProcess = () => {
      signaled = true;
      return true;
    };

    const result = await runCliCommand({ kind: "stop" }, services);

    expect(signaled).toBe(false);
    expect(result.output).toContain("Runtime still running");
    expect(result.output).toContain("Process");
    expect(result.output).toMatch(/Mode\s+foreground/);
    expect(result.output).toMatch(/PID\s+3333/);
    expect(result.output).toContain("Stop this runtime from the terminal/session that started it.");
    expect(result.output).not.toContain("CodeHelm running\nMode:");
  });

  test("stop when not running renders an inactive panel", async () => {
    const services = createBaseServices();

    const result = await runCliCommand({ kind: "stop" }, services);

    expect(result.output).toContain("Runtime");
    expect(result.output).toContain("not running");
    expect(result.output).toContain("Next steps");
    expect(result.output).toContain("not running");
  });

  test("uninstall clears config, secrets, db, and runtime state without confirmation", async () => {
    const services = createBaseServices();
    const paths = createPaths();
    let disabledAutostart = false;

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
    services.disableAutostart = async () => {
      disabledAutostart = true;
      return {
        kind: "disabled",
        label: "dev.codehelm.code-helm",
        launchAgentPath: "/tmp/code-helm.plist",
        removed: true,
      };
    };

    const result = await runCliCommand({ kind: "uninstall" }, services);

    expect(disabledAutostart).toBe(true);
    expect(existsSync(paths.configPath)).toBe(false);
    expect(existsSync(paths.secretsPath)).toBe(false);
    expect(existsSync(paths.databasePath)).toBe(false);
    expect(existsSync(paths.stateDir)).toBe(false);
    expect(result.output).toContain("Uninstall Complete");
    expect(result.output).toContain("Removed");
    expect(result.output).toContain("Next Step");
    expect(result.output).toContain("npm uninstall -g code-helm");
  });

  test("uninstall does not list launch-agent path when autostart disable reports not found", async () => {
    const services = createBaseServices();
    const paths = createPaths();

    services.loadConfigStore = () => ({
      ...createBaseServices().loadConfigStore(),
      paths,
    });
    services.disableAutostart = async () => ({
      kind: "disabled",
      label: "dev.codehelm.code-helm",
      launchAgentPath: "/tmp/code-helm.plist",
      removed: false,
    });

    const result = await runCliCommand({ kind: "uninstall" }, services);

    expect(result.output).toContain("Uninstall Complete");
    expect(result.output).toContain("Removed");
    expect(result.output).not.toContain("/tmp/code-helm.plist");
    expect(result.output).toContain(paths.configPath);
    expect(result.output).toContain(paths.secretsPath);
    expect(result.output).toContain(paths.databasePath);
    expect(result.output).toContain(paths.stateDir);
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

    let thrown: unknown;

    try {
      await runCliCommand({ kind: "uninstall" }, services);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/Uninstall Incomplete/i);
    expect(message).toMatch(/Removed/i);
    expect(message).toMatch(/Failed/i);
    expect(message).toContain("/tmp/code-helm.plist");
    expect(message).toContain(paths.secretsPath);
    expect(message).toContain(paths.databasePath);
    expect(message).toContain(paths.stateDir);
    expect(message).toMatch(/cannot remove config/i);
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
