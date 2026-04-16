import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliCommand } from "./args";
import {
  disableAutostart,
  enableAutostart,
  type AutostartResult,
} from "./autostart";
import { loadConfigStore, type LoadedConfigStore } from "./config-store";
import { readRuntimeSummary, type RuntimeSummary } from "./runtime-state";
import { loadAppConfig, type AppConfig } from "../config";
import { resolveLegacyWorkspaceBootstrap, startCodeHelm } from "../index";
import {
  createDefaultDiscoveryServices,
  createOnboardingUi,
  runOnboarding,
  type OnboardingResult,
} from "./onboard";

type StartHandle = {
  config: AppConfig;
  stop: () => Promise<void>;
};

export type BackgroundProcessHandle = {
  pid: number | undefined;
  unref(): void;
};

export type CommandExecutionResult = {
  output: string;
  runtime?: RuntimeSummary;
};

export type CommandServices = {
  backgroundRuntimeTimeoutMs: number;
  disableAutostart: () => Promise<AutostartResult>;
  enableAutostart: () => Promise<AutostartResult>;
  env: Record<string, string | undefined>;
  loadConfigStore: (options?: { env: Record<string, string | undefined> }) => LoadedConfigStore;
  loadAppConfig: (env: Record<string, string | undefined>) => AppConfig;
  readRuntimeSummary: (options: {
    stateDir: string;
    isPidAlive: (pid: number) => boolean;
  }) => RuntimeSummary | undefined;
  isPidAlive: (pid: number) => boolean;
  runOnboarding: (options: {
    env: Record<string, string | undefined>;
    homeDir?: string;
  }) => Promise<OnboardingResult>;
  startForeground: (options: {
    config: AppConfig;
    legacyWorkspaceBootstrap: ReturnType<typeof resolveLegacyWorkspaceBootstrap>;
    stateDir: string;
  }) => Promise<StartHandle>;
  spawnBackgroundProcess: (options: {
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
  }) => BackgroundProcessHandle;
  signalProcess: (pid: number, signal: NodeJS.Signals) => boolean;
  waitForBackgroundRuntime: (options: {
    stateDir: string;
    isPidAlive: (pid: number) => boolean;
    timeoutMs?: number;
  }) => Promise<RuntimeSummary | undefined>;
  waitForRuntimeExit: (options: {
    stateDir: string;
    isPidAlive: (pid: number) => boolean;
    timeoutMs?: number;
  }) => Promise<boolean>;
  removePath: (targetPath: string) => void;
};

const defaultIsPidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const defaultSpawnBackgroundProcess = ({
  command,
  args,
  env,
}: {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}) => {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: env as Record<string, string>,
  } satisfies SpawnOptions);

  child.unref();
  return {
    pid: child.pid,
    unref() {
      child.unref();
    },
  };
};

const defaultWaitForRuntimeExit: CommandServices["waitForRuntimeExit"] = async ({
  stateDir,
  isPidAlive,
  timeoutMs = 5_000,
}) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const runtime = readRuntimeSummary({
      stateDir,
      isPidAlive,
    });

    if (!runtime) {
      return true;
    }

    await Bun.sleep(50);
  }

  return false;
};

const defaultStartForeground: CommandServices["startForeground"] = ({
  config,
  legacyWorkspaceBootstrap,
  stateDir,
}) => {
  return startCodeHelm(config, {
    legacyWorkspaceBootstrap,
    mode: "foreground",
    stateDir,
  });
};

const defaultRemovePath = (targetPath: string) => {
  if (!existsSync(targetPath)) {
    return;
  }

  rmSync(targetPath, { recursive: true, force: true });
};

const defaultRunOnboarding: CommandServices["runOnboarding"] = async (options) => {
  return runOnboarding({
    env: options.env,
    homeDir: options.homeDir,
    ui: createOnboardingUi(),
    discovery: createDefaultDiscoveryServices(),
    readRuntimeSummary,
    isPidAlive: defaultIsPidAlive,
  });
};

const createDefaultServices = (
  env: Record<string, string | undefined>,
): CommandServices => ({
  backgroundRuntimeTimeoutMs: 15_000,
  disableAutostart: async () => disableAutostart(),
  enableAutostart: async () => enableAutostart({
    bunExecutablePath: process.execPath,
    cliEntrypointPath: fileURLToPath(new URL("../../bin/code-helm", import.meta.url)),
  }),
  env,
  loadConfigStore: (options) => loadConfigStore({ env: options?.env ?? env }),
  loadAppConfig,
  readRuntimeSummary,
  isPidAlive: defaultIsPidAlive,
  runOnboarding: ({ env: nextEnv, homeDir }) => defaultRunOnboarding({ env: nextEnv, homeDir }),
  startForeground: defaultStartForeground,
  spawnBackgroundProcess: defaultSpawnBackgroundProcess,
  signalProcess: (pid, signal) => process.kill(pid, signal),
  waitForBackgroundRuntime: (options) =>
    waitForRuntimeSummary({
      stateDir: options.stateDir,
      isPidAlive: options.isPidAlive,
      timeoutMs: options.timeoutMs,
    }, { readRuntimeSummary }),
  waitForRuntimeExit: defaultWaitForRuntimeExit,
  removePath: defaultRemovePath,
});

const isConfigured = (store: LoadedConfigStore) => {
  return Boolean(store.config && store.secrets);
};

const formatRuntimeSummary = (runtime?: RuntimeSummary) => {
  if (!runtime) {
    return "CodeHelm stopped";
  }

  const lines = [
    "CodeHelm running",
    `Mode: ${runtime.mode}`,
    `PID: ${runtime.pid}`,
    `Discord: ${runtime.discord.connected === false ? "disconnected" : "connected"} guild ${runtime.discord.guildId}${runtime.discord.controlChannelId ? ` channel ${runtime.discord.controlChannelId}` : ""}`,
    `Codex App Server: ${runtime.codex.running === false ? "stopped" : "running"} ${runtime.codex.appServerAddress}`,
    `Connect: codex --remote ${runtime.codex.appServerAddress}`,
  ];

  if (runtime.startedAt) {
    lines.splice(3, 0, `Started: ${runtime.startedAt}`);
  }

  return lines.join("\n");
};

const formatAutostartResult = (
  result: AutostartResult,
  action: "enable" | "disable",
) => {
  if (result.kind === "unsupported") {
    return `Autostart is unsupported on ${result.platform}.`;
  }

  return action === "enable"
    ? `Autostart enabled\nLaunchAgent: ${result.launchAgentPath}`
    : `Autostart disabled\nLaunchAgent: ${result.launchAgentPath}`;
};

const waitForRuntimeSummary = async (
  options: {
    stateDir: string;
    isPidAlive: (pid: number) => boolean;
    timeoutMs?: number;
  },
  services: Pick<CommandServices, "readRuntimeSummary">,
) => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const runtime = services.readRuntimeSummary(options);

    if (runtime) {
      return runtime;
    }

    await Bun.sleep(50);
  }

  return undefined;
};

const ensureConfiguredStore = async (
  services: CommandServices,
): Promise<LoadedConfigStore> => {
  let store = services.loadConfigStore({
    env: services.env,
  });

  if (isConfigured(store)) {
    return store;
  }

  const onboardingResult = await services.runOnboarding({
    env: services.env,
  });

  if (onboardingResult.kind === "already-running") {
    return services.loadConfigStore({
      env: services.env,
    });
  }

  if (onboardingResult.kind !== "completed") {
    throw new Error("CodeHelm onboarding did not complete.");
  }

  store = services.loadConfigStore({
    env: services.env,
  });

  if (!isConfigured(store)) {
    throw new Error("CodeHelm onboarding completed without saving config.");
  }

  return store;
};

const startInBackground = async (
  store: LoadedConfigStore,
  services: CommandServices,
) => {
  const env = {
    ...process.env,
    ...services.env,
    CODE_HELM_CONFIG: store.paths.configPath,
    CODE_HELM_SECRETS: store.paths.secretsPath,
    CODE_HELM_DAEMON_MODE: "background",
  };
  const indexEntryPath = resolve(dirname(new URL(import.meta.url).pathname), "../index.ts");

  const child = services.spawnBackgroundProcess({
    command: "bun",
    args: ["run", indexEntryPath],
    env,
  });

  if (!child.pid) {
    throw new Error("Background CodeHelm daemon did not expose a pid.");
  }

  const runtime = await services.waitForBackgroundRuntime({
    stateDir: store.paths.stateDir,
    isPidAlive: services.isPidAlive,
    timeoutMs: services.backgroundRuntimeTimeoutMs,
  });

  if (!runtime) {
    services.signalProcess(child.pid, "SIGTERM");
    throw new Error("Background CodeHelm daemon did not publish runtime state.");
  }

  return runtime;
};

const stopBackgroundRuntime = async (
  runtime: RuntimeSummary,
  store: LoadedConfigStore,
  services: CommandServices,
) => {
  if (runtime.mode !== "background") {
    return {
      output: formatRuntimeSummary(runtime),
      runtime,
    };
  }

  const didSignal = services.signalProcess(runtime.pid, "SIGTERM");

  if (!didSignal) {
    throw new Error(`Failed to signal background CodeHelm process ${runtime.pid}.`);
  }

  const didExit = await services.waitForRuntimeExit({
    stateDir: store.paths.stateDir,
    isPidAlive: services.isPidAlive,
  });

  if (!didExit) {
    throw new Error("Background CodeHelm daemon did not stop before the timeout expired.");
  }

  return {
    output: "CodeHelm stopped",
  };
};

const uninstallPaths = (store: LoadedConfigStore) => {
  return [
    store.paths.configPath,
    store.paths.secretsPath,
    store.paths.databasePath,
    store.paths.stateDir,
  ];
};

export const runCliCommand = async (
  command: CliCommand,
  overrides?: Partial<CommandServices>,
): Promise<CommandExecutionResult> => {
  const services = {
    ...createDefaultServices(overrides?.env ?? {}),
    ...overrides,
  } satisfies CommandServices;
  const store = services.loadConfigStore({
    env: services.env,
  });
  const runtime = services.readRuntimeSummary({
    stateDir: store.paths.stateDir,
    isPidAlive: services.isPidAlive,
  });

  switch (command.kind) {
    case "start": {
      if (runtime) {
        return {
          output: formatRuntimeSummary(runtime),
          runtime,
        };
      }

      const configuredStore = await ensureConfiguredStore(services);

      if (command.daemon) {
        const backgroundRuntime = await startInBackground(configuredStore, services);
        return {
          output: formatRuntimeSummary(backgroundRuntime),
          runtime: backgroundRuntime,
        };
      }

      const config = services.loadAppConfig({
        ...services.env,
        CODE_HELM_CONFIG: configuredStore.paths.configPath,
        CODE_HELM_SECRETS: configuredStore.paths.secretsPath,
      });
      const handle = await services.startForeground({
        config,
        legacyWorkspaceBootstrap: resolveLegacyWorkspaceBootstrap(services.env),
        stateDir: configuredStore.paths.stateDir,
      });
      const foregroundRuntime = {
        pid: process.pid,
        mode: "foreground" as const,
        discord: {
          guildId: handle.config.discord.guildId,
          controlChannelId: handle.config.discord.controlChannelId,
          connected: true,
        },
        codex: {
          appServerAddress: handle.config.codex.appServerUrl,
          running: true,
        },
        startedAt: new Date().toISOString(),
      };

      return {
        output: formatRuntimeSummary(foregroundRuntime),
        runtime: foregroundRuntime,
      };
    }
    case "status":
      return {
        output: formatRuntimeSummary(runtime),
        runtime,
      };
    case "stop":
      if (!runtime) {
        return {
          output: "CodeHelm not running",
        };
      }

      return stopBackgroundRuntime(runtime, store, services);
    case "uninstall": {
      const uninstallErrors: string[] = [];
      const removedPaths: string[] = [];

      try {
        const autostartResult = await services.disableAutostart();

        if (autostartResult.kind !== "unsupported") {
          removedPaths.push(autostartResult.launchAgentPath);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        uninstallErrors.push(`autostart: ${message}`);
      }

      if (runtime?.mode === "background") {
        try {
          await stopBackgroundRuntime(runtime, store, services);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          uninstallErrors.push(`background daemon: ${message}`);
        }
      }

      for (const targetPath of uninstallPaths(store)) {
        try {
          services.removePath(targetPath);
          removedPaths.push(targetPath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          uninstallErrors.push(`${targetPath}: ${message}`);
        }
      }

      if (uninstallErrors.length > 0) {
        throw new Error([
          "Uninstall completed with errors.",
          removedPaths.length > 0 ? `Removed:\n${removedPaths.join("\n")}` : undefined,
          `Failed:\n${uninstallErrors.join("\n")}`,
        ].filter(Boolean).join("\n"));
      }

      return {
        output: "Uninstall complete\nRemove the global package with: npm uninstall -g code-helm",
      };
    }
    case "onboard": {
      const onboardingResult = await services.runOnboarding({
        env: services.env,
      });

      if (onboardingResult.kind === "already-running") {
        const currentRuntime = services.readRuntimeSummary({
          stateDir: store.paths.stateDir,
          isPidAlive: services.isPidAlive,
        });
        const lines = [
          formatRuntimeSummary(currentRuntime),
          "Stop the running instance with `code-helm stop`, then run `code-helm onboard` again.",
        ];

        return {
          output: lines.join("\n"),
          runtime: currentRuntime,
        };
      }

      return {
        output: onboardingResult.kind === "completed"
          ? "Onboarding complete. Run `code-helm start`."
          : "Onboarding cancelled.",
      };
    }
    case "autostart":
      return {
        output: formatAutostartResult(
          command.action === "enable"
            ? await services.enableAutostart()
            : await services.disableAutostart(),
          command.action,
        ),
      };
  }
};
