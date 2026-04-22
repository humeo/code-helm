import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliCommand } from "../../src/cli/args";
import {
  runCliCommand,
  type CommandServices,
} from "../../src/cli/commands";
import type {
  PackageManagerResolution,
  PackageUpdateExecutionResult,
  UpdateCheckResult,
} from "../../src/cli/update-service";
import { CodexSupervisorError } from "../../src/codex/supervisor";
import type { AppConfig } from "../../src/config";
import type { RuntimeSummary } from "../../src/cli/runtime-state";
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
  const defaultPackageManager: PackageManagerResolution = {
    kind: "npm",
    command: ["npm", "install", "-g", "code-helm@latest"],
    executableName: "npm",
    packageRoot: "/usr/local/lib/node_modules/code-helm",
  };

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
    waitForBackgroundRuntime: async () => createRuntimeSummary(),
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
    readUpdateCheck: async () => ({
      installedVersion: "0.2.0",
      latestVersion: "0.2.1",
      packageManager: defaultPackageManager,
      updateAvailable: true,
    }),
    emitOutput: () => {},
    confirmUpdate: async () => false,
    onExecuteUpdateCommand: () => {},
    ensurePackageManagerExecutable: async () => {},
    runPackageUpdate: async () => ({
      command: "npm install -g code-helm@latest",
      exitCode: 0,
      stdout: "changed 1 package",
      stderr: "",
    }),
    removePath: () => {},
  };
};

const createUpdateCheckResult = (
  overrides: Partial<UpdateCheckResult> = {},
): UpdateCheckResult => {
  const packageManager = overrides.packageManager ?? {
    kind: "npm",
    command: ["npm", "install", "-g", "code-helm@latest"],
    executableName: "npm",
    packageRoot: "/usr/local/lib/node_modules/code-helm",
  } satisfies PackageManagerResolution;

  return {
    installedVersion: "0.2.0",
    latestVersion: "0.2.1",
    packageManager,
    updateAvailable: true,
    ...overrides,
  };
};

const createPackageUpdateResult = (
  overrides: Partial<PackageUpdateExecutionResult> = {},
): PackageUpdateExecutionResult => {
  return {
    command: "npm install -g code-helm@latest",
    exitCode: 0,
    stdout: "changed 1 package",
    stderr: "",
    ...overrides,
  };
};

const createRuntimeSummary = (
  overrides: Partial<RuntimeSummary> = {},
): RuntimeSummary => {
  const defaultDiscord = {
    guildId: "guild-1",
    controlChannelId: "channel-1",
    connected: true,
  };
  const defaultCodex = {
    appServerAddress: "ws://127.0.0.1:4100",
    pid: 8765,
    running: true,
  };

  return {
    pid: 4321,
    mode: "background",
    discord: {
      ...defaultDiscord,
      ...overrides.discord,
    },
    codex: {
      ...defaultCodex,
      ...overrides.codex,
    },
    startedAt: "2026-04-16T08:30:00.000Z",
    ...overrides,
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
    expect(result.output).toContain("check");
    expect(result.output).toContain("Check whether a newer version is available");
    expect(result.output).toContain("update");
    expect(result.output).toContain("Install the latest published package");
    expect(result.output.indexOf("check")).toBeLessThan(result.output.indexOf("update"));
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
    expect(result.output.trim().split("\n")).toEqual([`CodeHelm ${expectedMetadata.version}`]);
    expect(result.output).not.toContain("CodeHelm Version");
  });

  test("unsupported internal commands stop before touching config or runtime loaders", async () => {
    const services = createBaseServices();
    let loadConfigStoreCalls = 0;
    let readRuntimeSummaryCalls = 0;

    services.loadConfigStore = () => {
      loadConfigStoreCalls += 1;
      throw new Error("unsupported command should not load config");
    };
    services.readRuntimeSummary = () => {
      readRuntimeSummaryCalls += 1;
      throw new Error("unsupported command should not read runtime");
    };

    await expect(
      runCliCommand({ kind: "bogus" } as unknown as CliCommand, services),
    ).rejects.toThrow(/Internal error: unsupported CLI command bogus/);
    expect(loadConfigStoreCalls).toBe(0);
    expect(readRuntimeSummaryCalls).toBe(0);
  });

  test("check shows up-to-date status in non-interactive mode without touching config or runtime", async () => {
    const services = createBaseServices();
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
    services.readUpdateCheck = async () => createUpdateCheckResult({
      installedVersion: "0.2.1",
      latestVersion: "0.2.1",
      updateAvailable: false,
    });

    const result = await runCliCommand({ kind: "check", yes: false }, services);

    expect(loadConfigStoreCalls).toBe(0);
    expect(readRuntimeSummaryCalls).toBe(0);
    expect(result.output).toContain("Installed version");
    expect(result.output).toContain("Latest version");
    expect(result.output).toContain("Up to date");
    expect(result.output).toContain("Package manager");
    expect(result.output).toContain("npm install -g code-helm@latest");
  });

  test("check shows update availability in non-tty mode without touching config or runtime", async () => {
    const services = createBaseServices();
    let loadConfigStoreCalls = 0;
    let readRuntimeSummaryCalls = 0;

    services.loadConfigStore = () => {
      loadConfigStoreCalls += 1;
      throw new Error("check should not load config");
    };
    services.readRuntimeSummary = () => {
      readRuntimeSummaryCalls += 1;
      throw new Error("check should not read runtime");
    };
    services.readUpdateCheck = async () => createUpdateCheckResult({
      installedVersion: "0.2.0",
      latestVersion: "0.2.1",
      updateAvailable: true,
    });

    const result = await runCliCommand({ kind: "check", yes: false }, services);

    expect(loadConfigStoreCalls).toBe(0);
    expect(readRuntimeSummaryCalls).toBe(0);
    expect(result.output).toContain("Installed version");
    expect(result.output).toContain("Latest version");
    expect(result.output).toContain("Update available");
    expect(result.output).toContain("Package manager");
    expect(result.output).toContain("Update command");
    expect(result.output).toContain("npm install -g code-helm@latest");
  });

  test("tty check with update available prompts once", async () => {
    const emittedOutputs: string[] = [];
    const services = createBaseServices();
    let confirmCalls = 0;

    services.env = { CODE_HELM_CLI_IS_TTY: "1", CODE_HELM_CLI_STDIN_IS_TTY: "1" };
    services.emitOutput = (output) => {
      emittedOutputs.push(output);
    };
    services.confirmUpdate = async () => {
      confirmCalls += 1;
      return false;
    };
    services.readUpdateCheck = async () => createUpdateCheckResult({
      installedVersion: "0.2.0",
      latestVersion: "0.2.1",
      updateAvailable: true,
    });

    const result = await runCliCommand({ kind: "check", yes: false }, services);

    expect(confirmCalls).toBe(1);
    expect(emittedOutputs).toHaveLength(1);
    expect(emittedOutputs[0]).toContain("Installed version");
    expect(result.output).toContain("Update canceled");
  });

  test("tty check acceptance emits the check status first, then returns the update result", async () => {
    const emittedOutputs: string[] = [];
    const services = createBaseServices();
    let confirmCalls = 0;

    services.env = { CODE_HELM_CLI_IS_TTY: "1", CODE_HELM_CLI_STDIN_IS_TTY: "1" };
    services.emitOutput = (output) => {
      emittedOutputs.push(output);
    };
    services.confirmUpdate = async () => {
      confirmCalls += 1;
      return true;
    };
    services.readUpdateCheck = async () => createUpdateCheckResult({
      installedVersion: "0.2.0",
      latestVersion: "0.2.1",
      updateAvailable: true,
    });

    const result = await runCliCommand({ kind: "check", yes: false }, services);

    expect(confirmCalls).toBe(1);
    expect(emittedOutputs).toHaveLength(1);
    expect(emittedOutputs[0]).toContain("Installed version");
    expect(emittedOutputs[0]).toContain("Update available");
    expect(result.output).toContain("Updated from 0.2.0 to 0.2.1");
    expect(result.output).not.toEqual(emittedOutputs[0]);
  });

  test("tty check decline keeps the original check output visible and returns a clear no-op result", async () => {
    const emittedOutputs: string[] = [];
    const services = createBaseServices();
    let confirmCalls = 0;
    let updateCalls = 0;

    services.env = { CODE_HELM_CLI_IS_TTY: "1", CODE_HELM_CLI_STDIN_IS_TTY: "1" };
    services.emitOutput = (output) => {
      emittedOutputs.push(output);
    };
    services.confirmUpdate = async () => {
      confirmCalls += 1;
      return false;
    };
    services.runPackageUpdate = async () => {
      updateCalls += 1;
      return createPackageUpdateResult();
    };

    const result = await runCliCommand({ kind: "check", yes: false }, services);

    expect(confirmCalls).toBe(1);
    expect(updateCalls).toBe(0);
    expect(emittedOutputs).toHaveLength(1);
    expect(emittedOutputs[0]).toContain("Installed version");
    expect(emittedOutputs[0]).toContain("Update available");
    expect(result.output).toContain("Update canceled");
    expect(result.output).toContain("Installed version remains 0.2.0");
  });

  test("non-tty check never prompts", async () => {
    const emittedOutputs: string[] = [];
    const services = createBaseServices();
    let confirmCalls = 0;

    services.env = { CODE_HELM_CLI_IS_TTY: "0" };
    services.emitOutput = (output) => {
      emittedOutputs.push(output);
    };
    services.confirmUpdate = async () => {
      confirmCalls += 1;
      return true;
    };

    const result = await runCliCommand({ kind: "check", yes: false }, services);

    expect(confirmCalls).toBe(0);
    expect(emittedOutputs).toHaveLength(0);
    expect(result.output).toContain("Update available");
  });

  test("check --yes never prompts even in tty mode", async () => {
    const emittedOutputs: string[] = [];
    const services = createBaseServices();
    let confirmCalls = 0;

    services.env = { CODE_HELM_CLI_IS_TTY: "1", CODE_HELM_CLI_STDIN_IS_TTY: "1" };
    services.emitOutput = (output) => {
      emittedOutputs.push(output);
    };
    services.confirmUpdate = async () => {
      confirmCalls += 1;
      return true;
    };

    const result = await runCliCommand({ kind: "check", yes: true }, services);

    expect(confirmCalls).toBe(0);
    expect(emittedOutputs).toHaveLength(0);
    expect(result.output).toContain("Updated from 0.2.0 to 0.2.1");
  });

  test("interactive check with unknown install source does not prompt and shows the unavailable update command", async () => {
    const emittedOutputs: string[] = [];
    const services = createBaseServices();
    let confirmCalls = 0;

    services.env = { CODE_HELM_CLI_IS_TTY: "1" };
    services.emitOutput = (output) => {
      emittedOutputs.push(output);
    };
    services.confirmUpdate = async () => {
      confirmCalls += 1;
      return true;
    };
    services.readUpdateCheck = async () => createUpdateCheckResult({
      packageManager: {
        kind: "unknown",
        command: undefined,
        packageRoot: "/tmp/custom-install",
      },
      updateAvailable: true,
    });

    const result = await runCliCommand({ kind: "check", yes: false }, services);

    expect(confirmCalls).toBe(0);
    expect(emittedOutputs).toHaveLength(0);
    expect(result.output).toContain("Update available");
    expect(result.output).toContain("Package manager");
    expect(result.output).toContain("unknown");
    expect(result.output).toContain("Update command");
    expect(result.output).toContain("Unavailable");
  });

  test("check --yes delegates into the update execution path", async () => {
    const services = createBaseServices();
    let ensureCalls = 0;
    let updateCalls = 0;
    let executeCalls = 0;

    services.readUpdateCheck = async () => createUpdateCheckResult({
      installedVersion: "0.2.0",
      latestVersion: "0.2.1",
      updateAvailable: true,
    });
    services.onExecuteUpdateCommand = () => {
      executeCalls += 1;
    };
    services.ensurePackageManagerExecutable = async (input) => {
      ensureCalls += 1;
      expect(input.executableName).toBe("npm");
    };
    services.runPackageUpdate = async (command) => {
      updateCalls += 1;
      expect(command).toEqual(["npm", "install", "-g", "code-helm@latest"]);
      return createPackageUpdateResult();
    };

    const result = await runCliCommand({ kind: "check", yes: true }, services);

    expect(executeCalls).toBe(1);
    expect(ensureCalls).toBe(1);
    expect(updateCalls).toBe(1);
    expect(result.output).toContain("Updated from 0.2.0 to 0.2.1");
    expect(result.output).toContain("Package manager");
  });

  test("check --yes on the latest version still enters the shared update execution path", async () => {
    const services = createBaseServices();
    let executeCalls = 0;
    let ensureCalls = 0;
    let updateCalls = 0;

    services.readUpdateCheck = async () => createUpdateCheckResult({
      installedVersion: "0.2.1",
      latestVersion: "0.2.1",
      updateAvailable: false,
    });
    services.onExecuteUpdateCommand = () => {
      executeCalls += 1;
    };
    services.ensurePackageManagerExecutable = async () => {
      ensureCalls += 1;
    };
    services.runPackageUpdate = async () => {
      updateCalls += 1;
      return createPackageUpdateResult();
    };

    const result = await runCliCommand({ kind: "check", yes: true }, services);

    expect(executeCalls).toBe(1);
    expect(ensureCalls).toBe(0);
    expect(updateCalls).toBe(0);
    expect(result.output).toContain("Already on the latest version");
    expect(result.output).toContain("Installed version");
    expect(result.output).toContain("Latest version");
  });

  test("update reports when already on the latest version", async () => {
    const services = createBaseServices();

    services.readUpdateCheck = async () => createUpdateCheckResult({
      installedVersion: "0.2.1",
      latestVersion: "0.2.1",
      updateAvailable: false,
    });
    services.runPackageUpdate = async () => {
      throw new Error("update should not run install when already current");
    };

    const result = await runCliCommand({ kind: "update" }, services);

    expect(result.output).toContain("Already on the latest version");
    expect(result.output).toContain("Installed version");
    expect(result.output).toContain("Latest version");
  });

  test("update reports the version transition and package manager after a successful install", async () => {
    const services = createBaseServices();

    services.readUpdateCheck = async () => createUpdateCheckResult({
      installedVersion: "0.2.0",
      latestVersion: "0.2.1",
      updateAvailable: true,
    });
    services.runPackageUpdate = async (command) => {
      expect(command).toEqual(["npm", "install", "-g", "code-helm@latest"]);
      return createPackageUpdateResult();
    };

    const result = await runCliCommand({ kind: "update" }, services);

    expect(result.output).toContain("Updated from 0.2.0 to 0.2.1");
    expect(result.output).toContain("Package manager");
    expect(result.output).toContain("npm");
  });

  test("update fails before install when the install source is unknown", async () => {
    const services = createBaseServices();

    services.readUpdateCheck = async () => createUpdateCheckResult({
      packageManager: {
        kind: "unknown",
        command: undefined,
        packageRoot: "/tmp/custom-install",
      },
    });
    services.runPackageUpdate = async () => {
      throw new Error("install command should not run for unknown source");
    };

    await expect(
      runCliCommand({ kind: "update" }, services),
    ).rejects.toThrow(/could not determine/i);
    await expect(
      runCliCommand({ kind: "update" }, services),
    ).rejects.toThrow(/npm or Bun/i);
  });

  test("check surfaces registry check failures without touching config or runtime", async () => {
    const services = createBaseServices();
    let loadConfigStoreCalls = 0;
    let readRuntimeSummaryCalls = 0;

    services.loadConfigStore = () => {
      loadConfigStoreCalls += 1;
      throw new Error("check should not load config");
    };
    services.readRuntimeSummary = () => {
      readRuntimeSummaryCalls += 1;
      throw new Error("check should not read runtime");
    };
    services.readUpdateCheck = async () => {
      throw new Error("Could not determine the latest published version for code-helm from the npm registry response.");
    };

    await expect(
      runCliCommand({ kind: "check", yes: false }, services),
    ).rejects.toThrow(/npm registry response/i);
    expect(loadConfigStoreCalls).toBe(0);
    expect(readRuntimeSummaryCalls).toBe(0);
  });

  test("tty check with update available and unknown install source skips prompting", async () => {
    const services = createBaseServices();
    let confirmCalls = 0;

    services.env = { CODE_HELM_CLI_IS_TTY: "1", CODE_HELM_CLI_STDIN_IS_TTY: "1" };
    services.confirmUpdate = async () => {
      confirmCalls += 1;
      return true;
    };
    services.readUpdateCheck = async () => createUpdateCheckResult({
      packageManager: {
        kind: "unknown",
        command: undefined,
        packageRoot: "/tmp/custom-install",
      },
    });

    const result = await runCliCommand({ kind: "check", yes: false }, services);

    expect(confirmCalls).toBe(0);
    expect(result.output).toContain("Update available");
    expect(result.output).toContain("Package manager");
    expect(result.output).toContain("unknown");
    expect(result.output).toContain("Update command");
    expect(result.output).toContain("Unavailable");
  });

  test("update warns when foreground runtime stays on the old version", async () => {
    const services = createBaseServices();
    let signalCalls = 0;
    let installCalls = 0;
    let restartCalls = 0;

    services.readRuntimeSummary = () => createRuntimeSummary({
      mode: "foreground",
      pid: 7788,
    });
    services.signalProcess = () => {
      signalCalls += 1;
      return true;
    };
    services.runPackageUpdate = async () => {
      installCalls += 1;
      return createPackageUpdateResult();
    };
    services.spawnBackgroundProcess = () => {
      restartCalls += 1;
      return {
        pid: 9988,
        unref() {},
      };
    };

    const result = await runCliCommand({ kind: "update" }, services);

    expect(installCalls).toBe(1);
    expect(signalCalls).toBe(0);
    expect(restartCalls).toBe(0);
    expect(result.output).toContain("CodeHelm Updated");
    expect(result.output).toContain("foreground");
    expect(result.output).toContain("still running on 0.2.0");
  });

  test("update stops and restarts background runtime around a successful install", async () => {
    const services = createBaseServices();
    const store = services.loadConfigStore();
    const callOrder: string[] = [];

    services.readRuntimeSummary = () => createRuntimeSummary({
      mode: "background",
      pid: 2233,
    });
    services.ensurePackageManagerExecutable = async () => {
      callOrder.push("ensure");
    };
    services.signalProcess = () => {
      callOrder.push("signal-stop");
      return true;
    };
    services.waitForRuntimeExit = async () => {
      callOrder.push("wait-stop");
      return true;
    };
    services.runPackageUpdate = async () => {
      callOrder.push("install");
      return createPackageUpdateResult();
    };
    services.spawnBackgroundProcess = ({ command, args, env }) => {
      callOrder.push("spawn-restart");
      expect(command).toBe("code-helm");
      expect(args).toEqual(["start", "--daemon"]);
      expect(env.CODE_HELM_CONFIG).toBe(store.paths.configPath);
      expect(env.CODE_HELM_SECRETS).toBe(store.paths.secretsPath);
      return {
        pid: 4567,
        unref() {},
      };
    };
    services.waitForBackgroundRuntime = async () => {
      callOrder.push("wait-restart");
      return createRuntimeSummary({
        pid: 4567,
      });
    };

    const result = await runCliCommand({ kind: "update" }, services);

    expect(callOrder).toEqual([
      "ensure",
      "signal-stop",
      "wait-stop",
      "install",
      "spawn-restart",
      "wait-restart",
    ]);
    expect(result.output).toContain("CodeHelm Updated");
    expect(result.output).toContain("background daemon restarted on 0.2.1");
  });

  test("update install failure after stopping background runtime attempts rollback restart", async () => {
    const services = createBaseServices();
    const callOrder: string[] = [];

    services.readRuntimeSummary = () => createRuntimeSummary({
      mode: "background",
      pid: 3333,
    });
    services.ensurePackageManagerExecutable = async () => {
      callOrder.push("ensure");
    };
    services.signalProcess = () => {
      callOrder.push("signal-stop");
      return true;
    };
    services.waitForRuntimeExit = async () => {
      callOrder.push("wait-stop");
      return true;
    };
    services.runPackageUpdate = async () => {
      callOrder.push("install");
      return createPackageUpdateResult({
        exitCode: 1,
        stderr: "npm ERR! code EACCES",
      });
    };
    services.spawnBackgroundProcess = () => {
      callOrder.push("spawn-rollback");
      return {
        pid: 7444,
        unref() {},
      };
    };
    services.waitForBackgroundRuntime = async () => {
      callOrder.push("wait-rollback");
      return createRuntimeSummary({
        pid: 7444,
      });
    };

    await expect(
      runCliCommand({ kind: "update" }, services),
    ).rejects.toThrow(/Rollback daemon restart succeeded/i);
    expect(callOrder).toEqual([
      "ensure",
      "signal-stop",
      "wait-stop",
      "install",
      "spawn-rollback",
      "wait-rollback",
    ]);
  });

  test("update keeps install success but warns when background restart fails", async () => {
    const services = createBaseServices();

    services.readRuntimeSummary = () => createRuntimeSummary({
      mode: "background",
      pid: 4433,
    });
    services.signalProcess = () => true;
    services.waitForRuntimeExit = async () => true;
    services.runPackageUpdate = async () => createPackageUpdateResult();
    services.spawnBackgroundProcess = ({ command, args }) => {
      expect(command).toBe("code-helm");
      expect(args).toEqual(["start", "--daemon"]);
      return {
        pid: 9555,
        unref() {},
      };
    };
    services.waitForBackgroundRuntime = async () => undefined;

    const result = await runCliCommand({ kind: "update" }, services);

    expect(result.output).toContain("CodeHelm Updated With Warnings");
    expect(result.output).toContain("Background daemon did not come back automatically");
    expect(result.output).toContain("code-helm start --daemon");
  });

  test("update reports a missing package-manager executable before background stop", async () => {
    const services = createBaseServices();
    let signalCalls = 0;

    services.readUpdateCheck = async () => createUpdateCheckResult();
    services.readRuntimeSummary = () => createRuntimeSummary({
      mode: "background",
      pid: 9921,
    });
    services.ensurePackageManagerExecutable = async () => {
      throw new Error("Package manager npm is not available on PATH.");
    };
    services.signalProcess = () => {
      signalCalls += 1;
      return true;
    };
    services.runPackageUpdate = async () => {
      throw new Error("install command should not run when executable is missing");
    };

    await expect(
      runCliCommand({ kind: "update" }, services),
    ).rejects.toThrow(/Package manager npm is not available on PATH/i);
    expect(signalCalls).toBe(0);
  });

  test("update reports install command failures with the attempted command", async () => {
    const services = createBaseServices();

    services.readUpdateCheck = async () => createUpdateCheckResult();
    services.runPackageUpdate = async () => createPackageUpdateResult({
      exitCode: 1,
      stderr: "npm ERR! code EACCES",
    });

    await expect(
      runCliCommand({ kind: "update" }, services),
    ).rejects.toThrow(/Update Failed/i);
    await expect(
      runCliCommand({ kind: "update" }, services),
    ).rejects.toThrow(/npm install -g code-helm@latest/i);
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
    const expectedStatePath = join(services.loadConfigStore().paths.stateDir, "runtime.json");

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
    expect(result.output).toContain("Quick actions");
    expect(result.output).toContain("State Source");
    expect(result.output).toContain(expectedStatePath);
    expect(result.output).not.toContain("Time Zone");
    expect(result.output).not.toContain("Runtime State");
    expect(result.output).toContain("codex --remote ws://127.0.0.1:4200");
    expect(result.output).toContain("code-helm status");
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

  test("start with invalid TZ omits the invalid timezone while keeping shared runtime panel metadata", async () => {
    const services = createBaseServices();
    const expectedStatePath = join(services.loadConfigStore().paths.stateDir, "runtime.json");
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

    expect(result.output).toContain("Quick actions");
    expect(result.output).toContain("State Source");
    expect(result.output).toContain(expectedStatePath);
    expect(result.output).not.toContain("Time Zone");
    expect(result.output).not.toContain("Runtime State");
    expect(result.output).not.toContain("Mars/Phobos");
  });

  test("start foreground success renders runtime panel output", async () => {
    const services = createBaseServices();
    const expectedStatePath = join(services.loadConfigStore().paths.stateDir, "runtime.json");

    const result = await runCliCommand({ kind: "start", daemon: false }, services);

    expect(result.output).toContain("Runtime");
    expect(result.output).toContain("Process");
    expect(result.output).toContain("Connections");
    expect(result.output).toContain("Configuration");
    expect(result.output).toContain("Quick actions");
    expect(result.output).toContain("State Source");
    expect(result.output).toContain(expectedStatePath);
    expect(result.output).not.toContain("Time Zone");
    expect(result.output).not.toContain("Runtime State");
    expect(result.output).toMatch(/Mode\s+foreground/);
    expect(result.output).toMatch(/Started\s+/);
    expect(result.output).toMatch(/PID\s+\d+/);
    expect(result.output).toContain("codex --remote ws://127.0.0.1:4100");
    expect(result.output).toContain("code-helm status");
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
    const paths = createPaths();

    services.loadConfigStore = () => ({
      ...createBaseServices().loadConfigStore(),
      paths,
    });
    const expectedStatePath = join(paths.stateDir, "runtime.json");
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
    expect(result.output).toContain("Quick actions");
    expect(result.output).toContain("State Source");
    expect(result.output).toContain(expectedStatePath);
    expect(result.output).not.toContain("Time Zone");
    expect(result.output).not.toContain("Runtime State");
    expect(result.output).toMatch(/Mode\s+background/);
    expect(result.output).toMatch(/Started\s+/);
    expect(result.output).toMatch(/PID\s+\d+/);
    expect(result.output).toContain("codex --remote ws://127.0.0.1:4100");
    expect(result.output).toContain("code-helm status");
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
    const expectedStatePath = join(services.loadConfigStore().paths.stateDir, "runtime.json");

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
    expect(result.output).toContain("Quick actions");
    expect(result.output).toContain("State Source");
    expect(result.output).toContain(expectedStatePath);
    expect(result.output).not.toContain("Time Zone");
    expect(result.output).not.toContain("Runtime State");
    expect(result.output).toMatch(/Mode\s+foreground/);
    expect(result.output).toMatch(/Started\s+/);
    expect(result.output).toMatch(/PID\s+2222/);
    expect(result.output).toContain("ws://127.0.0.1:4400");
    expect(result.output).toContain("codex --remote ws://127.0.0.1:4400");
    expect(result.output).not.toContain("code-helm status");
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
    expect(result.output).toContain("Quick actions");
    expect(result.output).not.toContain("State Source");
    expect(result.output).not.toContain("Time Zone");
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
    expect(result.output).toContain("Autostart enabled");
    expect(result.output).toContain("Changed");
    expect(result.output).toContain("Label");
    expect(result.output).toContain("dev.codehelm.code-helm");
    expect(result.output).toContain("Launch agent");
    expect(result.output).toContain("/tmp/code-helm.plist");
    expect(result.output).toContain("Next steps");
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
    expect(result.output).toContain("Autostart disabled");
    expect(result.output).toContain("Changed");
    expect(result.output).toContain("Removal");
    expect(result.output).toContain("Removed");
    expect(result.output).toContain("Next steps");
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

    expect(result.output).toContain("Autostart state mismatch");
    expect(result.output).toContain("Changed");
    expect(result.output).toContain("Requested action");
    expect(result.output).toContain("enable");
    expect(result.output).toContain("Result kind");
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

    expect(result.output).toContain("Autostart disabled");
    expect(result.output).toContain("Changed");
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

    expect(result.output).toContain("Autostart unsupported");
    expect(result.output).toContain("Changed");
    expect(result.output).toContain("Platform");
    expect(result.output).toContain("linux");
    expect(result.output).toContain("automatic startup is unavailable");
  });

  test("onboard already-running renders blocked warning-family output", async () => {
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

    expect(result.output).toContain("Onboarding blocked");
    expect(result.output).toContain("Process");
    expect(result.output).toContain("Try next");
    expect(result.output).toMatch(/Mode\s+background/);
    expect(result.output).toMatch(/PID\s+2222/);
    expect(result.output).toContain("code-helm stop");
    expect(result.output).toContain("code-helm onboard");
    expect(result.output).not.toContain("CodeHelm running");
  });

  test("onboard already-running with TZ set keeps display-formatted timestamps in blocked output", async () => {
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
    const escapedStarted = formatStartedAtForDisplay(startedAt, "Asia/Shanghai")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    expect(result.output).toContain("Onboarding blocked");
    expect(result.output).toContain("Process");
    expect(result.output).toMatch(
      new RegExp(`Started\\s+${escapedStarted}`),
    );
    expect(result.output).not.toContain("(Asia/Shanghai)");
    expect(result.output).not.toContain("CodeHelm running");
  });

  test("onboard cancellation stays concise at the command layer", async () => {
    const services = createBaseServices();

    services.runOnboarding = async () => ({ kind: "cancelled" });

    const result = await runCliCommand({ kind: "onboard" }, services);

    expect(result.output).toBe("Onboarding cancelled.");
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
    expect(result.output).toContain("CodeHelm uninstalled");
    expect(result.output).toContain("Removed");
    expect(result.output).toContain("Next steps");
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

    expect(result.output).toContain("CodeHelm uninstalled");
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
    expect(message).toMatch(/Try next/i);
    expect(message).toContain("/tmp/code-helm.plist");
    expect(message).toContain(paths.configPath);
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
