import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { confirm, isCancel } from "@clack/prompts";
import type { CliCommand } from "./args";
import {
  renderErrorPanel,
  renderSuccessPanel,
  renderRuntimePanel,
  renderWarningPanel,
} from "./output";
import {
  disableAutostart,
  enableAutostart,
  type AutostartResult,
} from "./autostart";
import { loadConfigStore, type LoadedConfigStore } from "./config-store";
import {
  readRuntimeSummary,
  resolveRuntimeStatePath,
  type RuntimeSummary,
} from "./runtime-state";
import { CodexSupervisorError } from "../codex/supervisor";
import { loadAppConfig, type AppConfig } from "../config";
import { resolveLegacyWorkspaceBootstrap, startCodeHelm } from "../index";
import {
  createDefaultDiscoveryServices,
  createOnboardingUi,
  formatCodexConnectCommand,
  runOnboarding,
  type OnboardingResult,
} from "./onboard";
import { readPackageMetadata } from "../package-metadata";
import {
  checkForUpdates,
  performPackageUpdate,
  type PackageManagerResolution,
  type PackageUpdateExecutionResult,
  type UpdateCheckResult,
} from "./update-service";

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

export type PackageUpdateResult = PackageUpdateExecutionResult;

type BackgroundRestartOutcome =
  | { kind: "restarted"; runtime: RuntimeSummary }
  | { kind: "failed"; reason: string };

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
  emitOutput: (output: string) => void;
  confirmUpdate: (input: { installedVersion: string; latestVersion: string }) => Promise<boolean>;
  readUpdateCheck: () => Promise<UpdateCheckResult>;
  onExecuteUpdateCommand: (result: UpdateCheckResult) => void;
  ensurePackageManagerExecutable: (input: PackageManagerResolution) => Promise<void>;
  runPackageUpdate: (command: string[]) => Promise<PackageUpdateResult>;
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

const defaultReadUpdateCheck = async (): Promise<UpdateCheckResult> => {
  const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

  return checkForUpdates({
    packageRoot: dirname(packageJsonPath),
    executablePath: process.argv[1],
  });
};

const defaultEnsurePackageManagerExecutable = async (
  input: PackageManagerResolution,
) => {
  const executableName = input.executableName ?? input.command?.[0];

  if (!executableName) {
    throw new Error(
      "CodeHelm could not determine whether the current installation is managed by npm or Bun.",
    );
  }

  const result = spawnSync(executableName, ["--version"], {
    encoding: "utf8",
    env: process.env,
  });

  if (result.error) {
    const errorMessage = result.error.message.toLowerCase();

    if (errorMessage.includes("enoent")) {
      throw new Error(`Package manager ${executableName} is not available on PATH.`);
    }

    throw new Error(
      `Package manager ${executableName} could not be launched: ${result.error.message}`,
    );
  }
};

const defaultRunPackageUpdate = async (
  command: string[],
  env: Record<string, string | undefined>,
): Promise<PackageUpdateResult> => {
  return performPackageUpdate(command, env);
};

const defaultConfirmUpdate: CommandServices["confirmUpdate"] = async () => {
  const confirmed = await confirm({
    message: "Update now?",
    active: "yes",
    inactive: "no",
    initialValue: true,
  });

  if (isCancel(confirmed)) {
    return false;
  }

  return confirmed;
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
  emitOutput: () => {},
  confirmUpdate: defaultConfirmUpdate,
  readUpdateCheck: defaultReadUpdateCheck,
  onExecuteUpdateCommand: () => {},
  ensurePackageManagerExecutable: defaultEnsurePackageManagerExecutable,
  runPackageUpdate: async (command) => defaultRunPackageUpdate(command, env),
  removePath: defaultRemovePath,
});

const isConfigured = (store: LoadedConfigStore) => {
  return Boolean(store.config && store.secrets);
};

const formatRuntimeStartedAt = (
  value: string,
  options: { timeZone?: string; includeTimeZoneLabel?: boolean } = {},
) => {
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

  if (options.timeZone) {
    try {
      const formatted = formatValue(options.timeZone);
      return options.includeTimeZoneLabel ? `${formatted} (${options.timeZone})` : formatted;
    } catch {}
  }

  return formatValue();
};

const resolveDisplayTimeZone = (timeZone?: string) => {
  if (!timeZone) {
    return undefined;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return undefined;
  }
};

type RuntimePanelContext = "start" | "status";

const renderRuntimeStatusOutput = (
  runtime: RuntimeSummary | undefined,
  options: {
    context: RuntimePanelContext;
    env: Record<string, string | undefined>;
    stateDir: string;
    timeZone?: string;
    headline?: string;
    isCurrentForegroundInvocation?: boolean;
  },
) => {
  const displayTimeZone = resolveDisplayTimeZone(options.timeZone);

  if (!runtime) {
    return renderRuntimePanel({
      title: "Runtime",
      headline: "CodeHelm is not running",
      sections: [
        {
          kind: "key-value",
          title: "Process",
          rows: [
            { key: "Mode", value: "not running" },
          ],
        },
        {
          kind: "steps",
          title: "Quick actions",
          items: ["code-helm start", "code-helm onboard"],
        },
      ],
      env: options.env,
    });
  }

  const nextSteps = [formatCodexConnectCommand(runtime.codex.appServerAddress)];

  if (options.context !== "status") {
    nextSteps.push("code-helm status");
  }

  if (runtime.mode === "background") {
    nextSteps.push("code-helm stop");
  } else {
    nextSteps.push(
      options.isCurrentForegroundInvocation
        ? "Stop this foreground process with Ctrl+C."
        : "Use the terminal running this foreground process to stop it.",
    );
  }

  return renderRuntimePanel({
    title: "Runtime",
    headline: options.headline ?? `CodeHelm is running in ${runtime.mode} mode`,
    sections: [
      {
        kind: "key-value",
        title: "Process",
        rows: [
          { key: "Mode", value: runtime.mode },
          {
            key: "Started",
            value: runtime.startedAt
              ? formatRuntimeStartedAt(runtime.startedAt, {
                timeZone: displayTimeZone,
                includeTimeZoneLabel: true,
              })
              : "n/a",
          },
          { key: "PID", value: String(runtime.pid) },
        ],
      },
      {
        kind: "key-value",
        title: "Connections",
        rows: [
          {
            key: "Discord",
            value: `${runtime.discord.connected === false ? "disconnected" : "connected"} guild ${runtime.discord.guildId}${runtime.discord.controlChannelId ? ` channel ${runtime.discord.controlChannelId}` : ""}`,
          },
          {
            key: "Codex App Server",
            value: `${runtime.codex.running === false ? "stopped" : "running"} ${runtime.codex.appServerAddress}`,
          },
        ],
      },
      {
        kind: "key-value",
        title: "Configuration",
        rows: [
          {
            key: "State Source",
            value: resolveRuntimeStatePath({ stateDir: options.stateDir }),
          },
        ],
      },
      {
        kind: "steps",
        title: "Quick actions",
        items: nextSteps,
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
  if (
    /certificate|x509|cert chain|self[-\s]?signed|unknown ca|local issuer|hostname mismatch|unable to verify|depth_zero_self_signed_cert|self_signed_cert_in_chain|cert_has_expired|unable_to_get_issuer_cert_locally|err_tls_cert_altname_invalid/i.test(
      message,
    )
  ) {
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
      title: "Startup Delayed",
      headline: "Managed Codex App Server startup is taking longer than expected.",
      sections: [
        {
          title: "Status",
          lines: [
            "Codex requests are not ready yet.",
            "This startup attempt did not complete.",
            "If this appears transient, try running the command again.",
          ],
        },
        {
          kind: "steps",
          title: "Try next",
          items: ["code-helm start"],
        },
      ],
      diagnostics: trimDiagnostics(error.diagnostics),
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
        title: "Startup Failed",
        headline: "Managed Codex App Server failed certificate verification during startup.",
        sections: [
          {
            kind: "steps",
            title: "Try next",
            items: [
              "Review network and proxy settings between CodeHelm and Codex App Server.",
              "Verify certificate trust setup and TLS interception policies on this machine.",
              "After fixing trust settings, try running the command again.",
              "code-helm start",
            ],
          },
        ],
        diagnostics,
        env: options.env,
      });
    }

    return renderErrorPanel({
      title: "Startup Failed",
      headline: "Managed Codex App Server failed to start.",
      sections: [
        {
          kind: "steps",
          title: "Try next",
          items: [
            "CodeHelm could not finish startup.",
            "Inspect the diagnostics below, resolve the startup issue, then try running the command again.",
            "code-helm start",
          ],
        },
      ],
      diagnostics,
      env: options.env,
    });
  }

  return null;
};

const formatAutostartResult = (
  result: AutostartResult,
  action: "enable" | "disable",
  env: Record<string, string | undefined>,
) => {
  if (result.kind === "unsupported") {
    return renderWarningPanel({
      title: "Autostart unsupported",
      headline: "On this platform, automatic startup is unavailable.",
      sections: [
        {
          kind: "key-value",
          title: "Changed",
          rows: [
            { key: "Platform", value: result.platform },
          ],
        },
      ],
      env,
    });
  }

  if (action === "enable") {
    if (result.kind !== "enabled") {
      return renderWarningPanel({
        title: "Autostart state mismatch",
        headline: "CodeHelm could not confirm the requested automatic startup state.",
        sections: [
          {
            kind: "key-value",
            title: "Changed",
            rows: [
              { key: "Requested action", value: action },
              { key: "Result kind", value: result.kind },
            ],
          },
          {
            kind: "steps",
            title: "Try next",
            items: ["code-helm autostart enable", "code-helm status"],
          },
        ],
        env,
      });
    }

    return renderSuccessPanel({
      title: "Autostart enabled",
      headline: "CodeHelm will launch automatically for this user session.",
      sections: [
        {
          kind: "key-value",
          title: "Changed",
          rows: [
            { key: "Label", value: result.label },
            { key: "Launch agent", value: result.launchAgentPath },
          ],
        },
        {
          kind: "steps",
          title: "Next steps",
          items: ["code-helm status"],
        },
      ],
      env,
    });
  }

  if (result.kind !== "disabled") {
    return renderWarningPanel({
      title: "Autostart state mismatch",
      headline: "CodeHelm could not confirm the requested automatic startup state.",
      sections: [
        {
          kind: "key-value",
          title: "Changed",
          rows: [
            { key: "Requested action", value: action },
            { key: "Result kind", value: result.kind },
          ],
        },
        {
          kind: "steps",
          title: "Try next",
          items: ["code-helm autostart disable", "code-helm status"],
        },
      ],
      env,
    });
  }

  const renderPanel = result.removed ? renderSuccessPanel : renderWarningPanel;

  return renderPanel({
    title: "Autostart disabled",
    headline: result.removed
      ? "The launch agent is no longer active."
      : "No launch agent was present for this user session.",
    sections: [
      {
        kind: "key-value",
        title: "Changed",
        rows: [
          { key: "Label", value: result.label },
          { key: "Launch agent", value: result.launchAgentPath },
          { key: "Removal", value: result.removed ? "Removed" : "Not found" },
        ],
      },
      {
        kind: "steps",
        title: "Next steps",
        items: ["code-helm status"],
      },
    ],
    env,
  });
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
    try {
      services.signalProcess(child.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }

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
      output: renderWarningPanel({
        title: "Runtime still running",
        headline: "Stop this runtime from the terminal/session that started it.",
        sections: [
          {
            kind: "key-value",
            title: "Process",
            rows: [
              { key: "Mode", value: runtime.mode },
              { key: "PID", value: String(runtime.pid) },
            ],
          },
        ],
        env: services.env,
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
    output: renderSuccessPanel({
      title: "Runtime stopped",
      headline: "The background CodeHelm process is no longer active.",
      sections: [
        {
          kind: "steps",
          title: "Next steps",
          items: ["code-helm start", "code-helm status"],
        },
      ],
      env: services.env,
    }),
  };
};

const uninstallPaths = (store: LoadedConfigStore) => {
  return [
    store.paths.configPath,
    store.paths.secretsPath,
    store.paths.databasePath,
    store.paths.stateDir,
    store.paths.appServerWorkdir,
  ];
};

const renderHelpOutput = (env: Record<string, string | undefined>) => {
  return renderSuccessPanel({
    title: "CodeHelm",
    headline: "Control Codex from Discord",
    sections: [
      {
        kind: "command-list",
        title: "Get started",
        items: [
          { command: "onboard", description: "Connect Discord and initialize local state" },
          { command: "help", description: "Show the command overview" },
          { command: "version", description: "Show the installed version" },
        ],
      },
      {
        kind: "command-list",
        title: "Runtime",
        items: [
          { command: "start", description: "Start CodeHelm in foreground" },
          { command: "start --daemon", description: "Start CodeHelm in background" },
          { command: "status", description: "Show runtime state" },
          { command: "stop", description: "Stop the background runtime" },
        ],
      },
      {
        kind: "command-list",
        title: "Automation",
        items: [
          { command: "autostart enable", description: "Enable automatic startup" },
          { command: "autostart disable", description: "Disable automatic startup" },
        ],
      },
      {
        kind: "command-list",
        title: "Maintenance",
        items: [
          { command: "check", description: "Check whether a newer version is available" },
          { command: "update", description: "Install the latest published package" },
          { command: "uninstall", description: "Remove local CodeHelm data" },
        ],
      },
      {
        kind: "steps",
        title: "Common flows",
        items: [
          "code-helm onboard",
          "code-helm start --daemon",
          "code-helm status",
        ],
      },
    ],
    env,
  });
};

const renderVersionOutput = (env: Record<string, string | undefined>) => {
  const packageMetadata = readPackageMetadata();

  return renderSuccessPanel({
    title: `CodeHelm ${packageMetadata.version}`,
    env,
  });
};

const formatUpdateDiagnostics = (result: PackageUpdateResult) => {
  const diagnostics = [
    result.error?.trim(),
    result.stderr.trim(),
    result.stdout.trim(),
  ].filter((value): value is string => Boolean(value && value.length > 0));

  return diagnostics.length > 0 ? diagnostics.join("\n\n") : undefined;
};

const buildUpdateStatusRows = (result: UpdateCheckResult) => {
  return [
    { key: "Installed version", value: result.installedVersion },
    { key: "Latest version", value: result.latestVersion },
    { key: "Package manager", value: result.packageManager.kind },
  ];
};

const renderCheckStatusOutput = (
  env: Record<string, string | undefined>,
  result: UpdateCheckResult,
) => {
  const commandPreview = result.packageManager.command?.join(" ") ?? "Unavailable";

  return renderSuccessPanel({
    title: "Update Check",
    headline: result.updateAvailable ? "Update available" : "Up to date",
    sections: [
      {
        kind: "key-value",
        title: "Status",
        rows: [
          { key: "Installed version", value: result.installedVersion },
          { key: "Latest version", value: result.latestVersion },
          { key: "Status", value: result.updateAvailable ? "Update available" : "Up to date" },
          { key: "Package manager", value: result.packageManager.kind },
          { key: "Update command", value: commandPreview },
        ],
      },
    ],
    env,
  });
};

const renderNoOpUpdateOutput = (
  env: Record<string, string | undefined>,
  result: UpdateCheckResult,
) => {
  return renderSuccessPanel({
    title: "CodeHelm Up To Date",
    headline: "Already on the latest version",
    sections: [
      {
        kind: "key-value",
        title: "Status",
        rows: buildUpdateStatusRows(result),
      },
    ],
    env,
  });
};

const renderCancelledUpdateOutput = (
  env: Record<string, string | undefined>,
  result: UpdateCheckResult,
) => {
  return renderSuccessPanel({
    title: "Update Cancelled",
    headline: `Update canceled. Installed version remains ${result.installedVersion}.`,
    sections: [
      {
        kind: "key-value",
        title: "Status",
        rows: [
          { key: "Installed version remains", value: result.installedVersion },
          { key: "Latest version", value: result.latestVersion },
          { key: "Package manager", value: result.packageManager.kind },
        ],
      },
    ],
    env,
  });
};

const renderUpdateSuccessOutput = (
  env: Record<string, string | undefined>,
  checkResult: UpdateCheckResult,
  result: PackageUpdateResult,
) => {
  return renderSuccessPanel({
    title: "CodeHelm Updated",
    headline: `Updated from ${checkResult.installedVersion} to ${checkResult.latestVersion}`,
    sections: [
      {
        kind: "key-value",
        title: "Status",
        rows: buildUpdateStatusRows(checkResult),
      },
      {
        title: "Command run",
        lines: [result.command],
      },
      {
        kind: "steps",
        title: "Next steps",
        items: ["code-helm version"],
      },
    ],
    env,
  });
};

const renderForegroundUpdateWarningOutput = (
  env: Record<string, string | undefined>,
  checkResult: UpdateCheckResult,
  result: PackageUpdateResult,
  runtime: RuntimeSummary,
) => {
  return renderWarningPanel({
    title: "CodeHelm Updated",
    headline: `Updated from ${checkResult.installedVersion} to ${checkResult.latestVersion}, but the foreground runtime is still running on ${checkResult.installedVersion}.`,
    sections: [
      {
        kind: "key-value",
        title: "Status",
        rows: buildUpdateStatusRows(checkResult),
      },
      {
        kind: "key-value",
        title: "Process",
        rows: [
          { key: "Mode", value: runtime.mode },
          { key: "PID", value: String(runtime.pid) },
        ],
      },
      {
        title: "Command run",
        lines: [result.command],
      },
      {
        kind: "steps",
        title: "Next steps",
        items: [
          "Stop the current foreground runtime and start CodeHelm again.",
          "code-helm start",
          "code-helm version",
        ],
      },
    ],
    env,
  });
};

const renderBackgroundRestartSuccessOutput = (
  env: Record<string, string | undefined>,
  checkResult: UpdateCheckResult,
  result: PackageUpdateResult,
  runtime: RuntimeSummary,
) => {
  return renderSuccessPanel({
    title: "CodeHelm Updated",
    headline: `Updated from ${checkResult.installedVersion} to ${checkResult.latestVersion}; background daemon restarted on ${checkResult.latestVersion}.`,
    sections: [
      {
        kind: "key-value",
        title: "Status",
        rows: buildUpdateStatusRows(checkResult),
      },
      {
        kind: "key-value",
        title: "Process",
        rows: [
          { key: "Mode", value: runtime.mode },
          { key: "PID", value: String(runtime.pid) },
        ],
      },
      {
        title: "Command run",
        lines: [result.command],
      },
      {
        kind: "steps",
        title: "Next steps",
        items: ["code-helm status", "code-helm version"],
      },
    ],
    env,
  });
};

const renderBackgroundRestartWarningOutput = (
  env: Record<string, string | undefined>,
  checkResult: UpdateCheckResult,
  result: PackageUpdateResult,
  reason: string,
) => {
  return renderWarningPanel({
    title: "CodeHelm Updated With Warnings",
    headline: `Updated from ${checkResult.installedVersion} to ${checkResult.latestVersion}, but the background daemon did not come back automatically.`,
    sections: [
      {
        kind: "key-value",
        title: "Status",
        rows: buildUpdateStatusRows(checkResult),
      },
      {
        title: "Runtime recovery",
        lines: [reason],
      },
      {
        title: "Command run",
        lines: [result.command],
      },
      {
        kind: "steps",
        title: "Try next",
        items: ["code-helm start --daemon", "code-helm status", "code-helm version"],
      },
    ],
    env,
  });
};

const renderTargetedUpdateFailureOutput = (
  env: Record<string, string | undefined>,
  title: string,
  headline: string,
  commandHints: string[] = [],
) => {
  return renderErrorPanel({
    title,
    headline,
    commandHints,
    env,
  });
};

const renderUpdateFailureOutput = (
  env: Record<string, string | undefined>,
  result: PackageUpdateResult,
) => {
  return renderErrorPanel({
    title: "Update Failed",
    headline: `The package update did not complete while running ${result.command}.`,
    sections: [
      {
        title: "Command run",
        lines: [result.command],
      },
      {
        kind: "steps",
        title: "Try next",
        items: [
          "Inspect the diagnostics below, resolve the package-manager issue, then retry.",
          "code-helm update",
        ],
      },
    ],
    diagnostics: formatUpdateDiagnostics(result),
    env,
  });
};

const renderUpdateFailureWithRecoveryOutput = (
  env: Record<string, string | undefined>,
  result: PackageUpdateResult,
  recovery: BackgroundRestartOutcome,
) => {
  const recoveryLines = recovery.kind === "restarted"
    ? [
      "Rollback daemon restart succeeded.",
      `The previous background daemon was restarted with PID ${recovery.runtime.pid}.`,
    ]
    : [
      "Rollback daemon restart failed.",
      recovery.reason,
    ];
  const nextSteps = recovery.kind === "restarted"
    ? ["code-helm status", "code-helm update"]
    : ["code-helm start --daemon", "code-helm status", "code-helm update"];

  return renderErrorPanel({
    title: "Update Failed",
    headline: `The package update did not complete while running ${result.command}.`,
    sections: [
      {
        title: "Command run",
        lines: [result.command],
      },
      {
        title: "Runtime recovery",
        lines: recoveryLines,
      },
      {
        kind: "steps",
        title: "Try next",
        items: [
          "Inspect the diagnostics below, resolve the package-manager issue, then retry.",
          ...nextSteps,
        ],
      },
    ],
    diagnostics: formatUpdateDiagnostics(result),
    env,
  });
};

const restartBackgroundRuntimeFromPath = async (
  store: LoadedConfigStore,
  services: CommandServices,
): Promise<BackgroundRestartOutcome> => {
  const child = services.spawnBackgroundProcess({
    command: "code-helm",
    args: ["start", "--daemon"],
    env: {
      ...process.env,
      ...services.env,
      CODE_HELM_CONFIG: store.paths.configPath,
      CODE_HELM_SECRETS: store.paths.secretsPath,
    },
  });

  if (!child.pid) {
    return {
      kind: "failed",
      reason: "Background daemon restart helper did not expose a pid.",
    };
  }

  const runtime = await services.waitForBackgroundRuntime({
    stateDir: store.paths.stateDir,
    isPidAlive: services.isPidAlive,
    timeoutMs: services.backgroundRuntimeTimeoutMs,
  });

  if (!runtime) {
    return {
      kind: "failed",
      reason: "Background daemon did not come back automatically.",
    };
  }

  return {
    kind: "restarted",
    runtime,
  };
};

const executeUpdateCommand = async (
  services: CommandServices,
  checkResult: UpdateCheckResult,
) => {
  services.onExecuteUpdateCommand(checkResult);

  if (!checkResult.updateAvailable) {
    return {
      output: renderNoOpUpdateOutput(services.env, checkResult),
    };
  }

  if (!checkResult.packageManager.command) {
    throw new Error(
      renderTargetedUpdateFailureOutput(
        services.env,
        "Update Failed",
        "CodeHelm could not determine whether the current installation is managed by npm or Bun.",
      ),
    );
  }

  try {
    await services.ensurePackageManagerExecutable(checkResult.packageManager);
  } catch (error) {
    throw new Error(
      renderTargetedUpdateFailureOutput(
        services.env,
        "Update Failed",
        error instanceof Error ? error.message : "Package manager could not be launched.",
      ),
    );
  }

  const store = services.loadConfigStore({
    env: services.env,
  });
  const runtime = services.readRuntimeSummary({
    stateDir: store.paths.stateDir,
    isPidAlive: services.isPidAlive,
  });

  if (!runtime) {
    const result = await services.runPackageUpdate(checkResult.packageManager.command);

    if (result.exitCode !== 0) {
      throw new Error(renderUpdateFailureOutput(services.env, result));
    }

    return {
      output: renderUpdateSuccessOutput(services.env, checkResult, result),
    };
  }

  if (runtime.mode === "foreground") {
    const result = await services.runPackageUpdate(checkResult.packageManager.command);

    if (result.exitCode !== 0) {
      throw new Error(renderUpdateFailureOutput(services.env, result));
    }

    return {
      output: renderForegroundUpdateWarningOutput(
        services.env,
        checkResult,
        result,
        runtime,
      ),
    };
  }

  await stopBackgroundRuntime(runtime, store, services);
  const result = await services.runPackageUpdate(checkResult.packageManager.command);

  if (result.exitCode !== 0) {
    const recovery = await restartBackgroundRuntimeFromPath(store, services);
    throw new Error(
      renderUpdateFailureWithRecoveryOutput(
        services.env,
        result,
        recovery,
      ),
    );
  }

  const restartOutcome = await restartBackgroundRuntimeFromPath(store, services);

  if (restartOutcome.kind === "failed") {
    return {
      output: renderBackgroundRestartWarningOutput(
        services.env,
        checkResult,
        result,
        restartOutcome.reason,
      ),
    };
  }

  return {
    output: renderBackgroundRestartSuccessOutput(
      services.env,
      checkResult,
      result,
      restartOutcome.runtime,
    ),
  };
};

const isInteractiveTerminal = (env: Record<string, string | undefined>) => {
  return env.CODE_HELM_CLI_IS_TTY === "1";
};

export const runCliCommand = async (
  command: CliCommand,
  overrides?: Partial<CommandServices>,
): Promise<CommandExecutionResult> => {
  const services = {
    ...createDefaultServices(overrides?.env ?? {}),
    ...overrides,
  } satisfies CommandServices;

  if (command.kind === "help") {
    return {
      output: renderHelpOutput(services.env),
    };
  }

  if (command.kind === "version") {
    return {
      output: renderVersionOutput(services.env),
    };
  }

  if (command.kind === "check") {
    const checkResult = await services.readUpdateCheck();

    if (command.yes) {
      return executeUpdateCommand(services, checkResult);
    }

    const output = renderCheckStatusOutput(services.env, checkResult);

    if (
      !checkResult.updateAvailable
      || !isInteractiveTerminal(services.env)
      || !checkResult.packageManager.command
    ) {
      return {
        output,
      };
    }

    services.emitOutput(output);
    const confirmed = await services.confirmUpdate({
      installedVersion: checkResult.installedVersion,
      latestVersion: checkResult.latestVersion,
    });

    if (!confirmed) {
      return {
        output: renderCancelledUpdateOutput(services.env, checkResult),
      };
    }

    return executeUpdateCommand(services, checkResult);
  }

  if (command.kind === "update") {
    const checkResult = await services.readUpdateCheck();
    return executeUpdateCommand(services, checkResult);
  }

  if (
    command.kind !== "start" &&
    command.kind !== "status" &&
    command.kind !== "stop" &&
    command.kind !== "onboard" &&
    command.kind !== "autostart" &&
    command.kind !== "uninstall"
  ) {
    throw new Error(`Internal error: unsupported CLI command ${(command as { kind: string }).kind}`);
  }

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
            context: "start",
            env: services.env,
            stateDir: store.paths.stateDir,
            timeZone: services.env.TZ,
            headline: "A CodeHelm runtime is already active.",
          }),
          runtime,
        };
      }

      const configuredStore = await ensureConfiguredStore(services);

      if (command.daemon) {
        const backgroundRuntime = await startInBackground(configuredStore, services);
        return {
          output: renderRuntimeStatusOutput(backgroundRuntime, {
            context: "start",
            env: services.env,
            stateDir: configuredStore.paths.stateDir,
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
          context: "start",
          env: services.env,
          stateDir: configuredStore.paths.stateDir,
          timeZone: services.env.TZ,
          isCurrentForegroundInvocation: true,
        }),
        runtime: foregroundRuntime,
      };
    }
    case "status":
      return {
        output: renderRuntimeStatusOutput(runtime, {
          context: "status",
          env: services.env,
          stateDir: store.paths.stateDir,
          timeZone: services.env.TZ,
        }),
        runtime,
      };
    case "stop":
      if (!runtime) {
        return {
          output: renderRuntimePanel({
            title: "Runtime",
            headline: "CodeHelm is not running",
            sections: [
              {
                kind: "key-value",
                title: "Process",
                rows: [
                  { key: "Mode", value: "not running" },
                ],
              },
              {
                kind: "steps",
                title: "Next steps",
                items: ["code-helm start", "code-helm onboard"],
              },
            ],
            env: services.env,
          }),
        };
      }

      return stopBackgroundRuntime(runtime, store, services);
    case "uninstall": {
      const uninstallErrors: string[] = [];
      const removedPaths: string[] = [];
      let encounteredRuntimeStopFailure = false;

      try {
        const autostartResult = await services.disableAutostart();

        if (autostartResult.kind === "disabled" && autostartResult.removed) {
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
          encounteredRuntimeStopFailure = true;
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
        const tryNext = encounteredRuntimeStopFailure
          ? ["code-helm stop", "code-helm uninstall", "Remove the listed paths manually."]
          : ["code-helm uninstall", "Remove the listed paths manually."];

        throw new Error(renderErrorPanel({
          title: "Uninstall incomplete",
          headline: "Some local CodeHelm data could not be removed.",
          sections: [
            {
              kind: "paths",
              title: "Removed",
              items: removedPaths.length > 0 ? removedPaths : ["(none)"],
            },
            {
              title: "Failed",
              lines: uninstallErrors,
            },
            {
              kind: "steps",
              title: "Try next",
              items: tryNext,
            },
          ],
          env: services.env,
        }));
      }

      return {
        output: renderSuccessPanel({
          title: "CodeHelm uninstalled",
          headline: "Local CodeHelm data was removed.",
          sections: [
            {
              kind: "paths",
              title: "Removed",
              items: removedPaths,
            },
            {
              kind: "steps",
              title: "Next steps",
              items: ["npm uninstall -g code-helm"],
            },
          ],
          env: services.env,
        }),
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
        const displayTimeZone = resolveDisplayTimeZone(services.env.TZ);
        const processRows = currentRuntime
          ? [
            { key: "Mode", value: currentRuntime.mode },
            ...(currentRuntime.startedAt
              ? [{
                key: "Started",
                value: formatRuntimeStartedAt(currentRuntime.startedAt, {
                  timeZone: displayTimeZone,
                }),
              }]
              : []),
            { key: "PID", value: String(currentRuntime.pid) },
          ]
          : [{ key: "Mode", value: "running" }];
        const tryNext = currentRuntime?.mode === "foreground"
          ? [
            "Stop the active foreground process from the terminal that started it.",
            "code-helm onboard",
          ]
          : ["code-helm stop", "code-helm onboard"];

        return {
          output: renderWarningPanel({
            title: "Onboarding blocked",
            headline: "Stop the active CodeHelm runtime before changing onboarding settings.",
            sections: [
              {
                kind: "key-value",
                title: "Process",
                rows: processRows,
              },
              {
                kind: "steps",
                title: "Try next",
                items: tryNext,
              },
            ],
            env: services.env,
          }),
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
          services.env,
        ),
      };
  }

};
