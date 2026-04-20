import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliCommand } from "./args";
import {
  renderErrorPanel,
  renderKeyValueRows,
  renderRuntimePanel,
  renderWarningPanel,
} from "./output";
import {
  disableAutostart,
  enableAutostart,
  type AutostartResult,
} from "./autostart";
import { loadConfigStore, type LoadedConfigStore } from "./config-store";
import { readRuntimeSummary, type RuntimeSummary } from "./runtime-state";
import { CodexSupervisorError } from "../codex/supervisor";
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

const formatRuntimeStartedAt = (value: string, timeZone?: string) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const formatValue = (resolvedTimeZone?: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: resolvedTimeZone,
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

  if (timeZone) {
    try {
      return `${formatValue(timeZone)} (${timeZone})`;
    } catch {}
  }

  return formatValue();
};

const formatRuntimeSummary = (
  runtime?: RuntimeSummary,
  options: { timeZone?: string } = {},
) => {
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
    lines.splice(3, 0, `Started: ${formatRuntimeStartedAt(runtime.startedAt, options.timeZone)}`);
  }

  return lines.join("\n");
};

const renderRuntimeStatusOutput = (
  runtime: RuntimeSummary | undefined,
  options: {
    env: Record<string, string | undefined>;
    timeZone?: string;
    alreadyRunningNote?: string;
  },
) => {
  if (!runtime) {
    return renderRuntimePanel({
      title: "CodeHelm Runtime",
      sections: [
        {
          title: "Status",
          lines: ["CodeHelm is not running."],
        },
        {
          title: "Quick Actions",
          lines: [
            "code-helm start",
            "code-helm onboard",
          ],
        },
      ],
      env: options.env,
    });
  }

  const statusRows = [
    { key: "Status", value: "running" },
    { key: "Mode", value: runtime.mode },
    { key: "PID", value: String(runtime.pid) },
    {
      key: "Discord",
      value: `${runtime.discord.connected === false ? "disconnected" : "connected"} guild ${runtime.discord.guildId}${runtime.discord.controlChannelId ? ` channel ${runtime.discord.controlChannelId}` : ""}`,
    },
    {
      key: "Codex App Server",
      value: `${runtime.codex.running === false ? "stopped" : "running"} ${runtime.codex.appServerAddress}`,
    },
  ];

  if (runtime.startedAt) {
    statusRows.splice(3, 0, {
      key: "Started",
      value: formatRuntimeStartedAt(runtime.startedAt, options.timeZone),
    });
  }

  return renderRuntimePanel({
    title: "CodeHelm Runtime",
    headline: options.alreadyRunningNote,
    sections: [
      {
        title: "Status",
        lines: renderKeyValueRows(statusRows),
      },
      {
        title: "Quick Actions",
        lines: [
          `codex --remote ${runtime.codex.appServerAddress}`,
          "code-helm status",
          "code-helm stop",
        ],
      },
    ],
    env: options.env,
  });
};

const trimDiagnostics = (diagnostics?: string) => {
  const trimmed = diagnostics?.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed;
};

const classifyStartupFailure = (message: string) => {
  if (/certificate|verification|tls|ssl/i.test(message)) {
    return "certificate";
  }

  return "generic";
};

const formatStartupFailure = (
  error: unknown,
  options: { env: Record<string, string | undefined> },
) => {
  if (
    !(error instanceof CodexSupervisorError)
    || error.code !== "CODEX_APP_SERVER_FAILED_TO_START"
  ) {
    return null;
  }

  if (error.startupDisposition === "delayed") {
    return renderWarningPanel({
      title: "CodeHelm Startup Delayed",
      headline: "Managed Codex App Server startup is taking longer than expected.",
      sections: [
        {
          title: "Status",
          lines: [
            "Codex requests are not ready yet.",
            "Wait briefly, then try running the command again.",
          ],
        },
      ],
      diagnostics: trimDiagnostics(error.diagnostics),
      commandHints: ["code-helm start", "code-helm status"],
      env: options.env,
    });
  }

  if (error.startupDisposition === "failed") {
    const diagnostics = trimDiagnostics(error.diagnostics ?? error.message);
    const classification = classifyStartupFailure(
      `${error.message}\n${diagnostics ?? ""}`,
    );

    if (classification === "certificate") {
      return renderErrorPanel({
        title: "CodeHelm Startup Failed",
        headline: "Managed Codex App Server failed certificate verification during startup.",
        sections: [
          {
            title: "How To Fix",
            lines: [
              "Review network and proxy settings between CodeHelm and Codex App Server.",
              "Verify certificate trust setup and TLS interception policies on this machine.",
              "After fixing trust settings, try running the command again.",
            ],
          },
        ],
        diagnostics,
        commandHints: ["code-helm start"],
        env: options.env,
      });
    }

    return renderErrorPanel({
      title: "CodeHelm Startup Failed",
      headline: "Managed Codex App Server failed to start.",
      sections: [
        {
          title: "How To Fix",
          lines: [
            "CodeHelm could not finish startup.",
            "Inspect the diagnostics below, resolve the startup issue, then try running the command again.",
          ],
        },
      ],
      diagnostics,
      commandHints: ["code-helm start"],
      env: options.env,
    });
  }

  return null;
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
      output: formatRuntimeSummary(runtime, {
        timeZone: services.env.TZ,
      }),
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
          output: renderRuntimeStatusOutput(runtime, {
            env: services.env,
            timeZone: services.env.TZ,
            alreadyRunningNote: "CodeHelm is already running; showing the current runtime details.",
          }),
          runtime,
        };
      }

      const configuredStore = await ensureConfiguredStore(services);

      if (command.daemon) {
        const backgroundRuntime = await startInBackground(configuredStore, services);
        return {
          output: renderRuntimeStatusOutput(backgroundRuntime, {
            env: services.env,
            timeZone: services.env.TZ,
          }),
          runtime: backgroundRuntime,
        };
      }

      const config = services.loadAppConfig({
        ...services.env,
        CODE_HELM_CONFIG: configuredStore.paths.configPath,
        CODE_HELM_SECRETS: configuredStore.paths.secretsPath,
      });
      let handle: StartHandle;

      try {
        handle = await services.startForeground({
          config,
          legacyWorkspaceBootstrap: resolveLegacyWorkspaceBootstrap(services.env),
          stateDir: configuredStore.paths.stateDir,
        });
      } catch (error) {
        const formattedStartupFailure = formatStartupFailure(error, { env: services.env });

        if (formattedStartupFailure) {
          throw new Error(formattedStartupFailure);
        }

        throw error;
      }

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
          startupState: "ready" as const,
        },
        startedAt: new Date().toISOString(),
      };

      return {
        output: renderRuntimeStatusOutput(foregroundRuntime, {
          env: services.env,
          timeZone: services.env.TZ,
        }),
        runtime: foregroundRuntime,
      };
    }
    case "status":
      return {
        output: renderRuntimeStatusOutput(runtime, {
          env: services.env,
          timeZone: services.env.TZ,
        }),
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
          formatRuntimeSummary(currentRuntime, {
            timeZone: services.env.TZ,
          }),
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
