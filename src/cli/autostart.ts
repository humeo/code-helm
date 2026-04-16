import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AUTOSTART_LABEL = "dev.codehelm.code-helm";

export type AutostartResult =
  | {
    kind: "enabled";
    label: string;
    launchAgentPath: string;
  }
  | {
    kind: "disabled";
    label: string;
    launchAgentPath: string;
    removed: boolean;
  }
  | {
    kind: "unsupported";
    platform: NodeJS.Platform;
  };

type BaseAutostartOptions = {
  homeDir?: string;
  label?: string;
  platform?: NodeJS.Platform;
  runLaunchctl?: (args: string[]) => void;
  uid?: number;
};

type EnableAutostartOptions = BaseAutostartOptions & {
  bunExecutablePath: string;
  cliEntrypointPath: string;
};

const escapeXml = (value: string) => {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
};

const resolveLaunchAgentPath = (
  options: BaseAutostartOptions = {},
) => {
  const homeDirectory = options.homeDir ?? homedir();
  const label = options.label ?? AUTOSTART_LABEL;

  return {
    label,
    launchAgentPath: join(homeDirectory, "Library", "LaunchAgents", `${label}.plist`),
  };
};

const defaultRunLaunchctl = (args: string[]) => {
  const result = spawnSync("launchctl", args, {
    stdio: "ignore",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`launchctl ${args.join(" ")} failed with status ${String(result.status)}.`);
  }
};

export const renderLaunchAgentPlist = (options: {
  bunExecutablePath: string;
  cliEntrypointPath: string;
  label?: string;
}) => {
  const label = options.label ?? AUTOSTART_LABEL;
  const workingDirectory = dirname(options.cliEntrypointPath);
  const args = [
    options.bunExecutablePath,
    options.cliEntrypointPath,
    "start",
    "--daemon",
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`;
};

export const enableAutostart = (
  options: EnableAutostartOptions,
): AutostartResult => {
  const platform = options.platform ?? process.platform;

  if (platform !== "darwin") {
    return {
      kind: "unsupported",
      platform,
    };
  }

  const { label, launchAgentPath } = resolveLaunchAgentPath(options);
  const runLaunchctl = options.runLaunchctl ?? defaultRunLaunchctl;
  const uid = options.uid ?? process.getuid?.() ?? 0;
  mkdirSync(dirname(launchAgentPath), { recursive: true });
  writeFileSync(launchAgentPath, renderLaunchAgentPlist({
    bunExecutablePath: options.bunExecutablePath,
    cliEntrypointPath: options.cliEntrypointPath,
    label,
  }), "utf8");

  try {
    runLaunchctl(["bootout", `gui/${uid}`, launchAgentPath]);
  } catch {
    // Refreshing an already-unloaded agent is best effort before bootstrap.
  }
  runLaunchctl(["bootstrap", `gui/${uid}`, launchAgentPath]);

  return {
    kind: "enabled",
    label,
    launchAgentPath,
  };
};

export const disableAutostart = (
  options: BaseAutostartOptions = {},
): AutostartResult => {
  const platform = options.platform ?? process.platform;

  if (platform !== "darwin") {
    return {
      kind: "unsupported",
      platform,
    };
  }

  const { label, launchAgentPath } = resolveLaunchAgentPath(options);
  const runLaunchctl = options.runLaunchctl ?? defaultRunLaunchctl;
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const removed = existsSync(launchAgentPath);

  try {
    runLaunchctl(["bootout", `gui/${uid}`, launchAgentPath]);
  } catch {
    // Disabling should still remove the plist even if the agent is not currently loaded.
  }

  rmSync(launchAgentPath, { force: true });

  return {
    kind: "disabled",
    label,
    launchAgentPath,
    removed,
  };
};
