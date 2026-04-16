import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOSTART_LABEL,
  disableAutostart,
  enableAutostart,
  renderLaunchAgentPlist,
} from "../../src/cli/autostart";

const tempDirs: string[] = [];

const createTempDir = () => {
  const directory = mkdtempSync(join(tmpdir(), "codehelm-autostart-"));
  tempDirs.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("autostart", () => {
  test("renders a macOS LaunchAgent plist for daemon startup", () => {
    const plist = renderLaunchAgentPlist({
      bunExecutablePath: "/opt/homebrew/bin/bun",
      cliEntrypointPath: "/opt/code-helm/src/cli.ts",
      label: AUTOSTART_LABEL,
    });

    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain(AUTOSTART_LABEL);
    expect(plist).toContain("/opt/homebrew/bin/bun");
    expect(plist).toContain("/opt/code-helm/src/cli.ts");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<string>--daemon</string>");
  });

  test("enable writes the LaunchAgent file on macOS", () => {
    const homeDir = createTempDir();
    const launchctlCalls: string[][] = [];

    const result = enableAutostart({
      platform: "darwin",
      homeDir,
      bunExecutablePath: "/opt/homebrew/bin/bun",
      cliEntrypointPath: "/opt/code-helm/src/cli.ts",
      runLaunchctl(args) {
        launchctlCalls.push(args);
      },
      uid: 501,
    });

    expect(result.kind).toBe("enabled");
    expect(existsSync(join(homeDir, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`))).toBe(true);
    const plist = readFileSync(
      join(homeDir, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`),
      "utf8",
    );
    expect(plist).toContain("/opt/homebrew/bin/bun");
    expect(launchctlCalls).toContainEqual([
      "bootstrap",
      "gui/501",
      join(homeDir, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`),
    ]);
  });

  test("disable removes the LaunchAgent file on macOS", () => {
    const homeDir = createTempDir();
    const launchctlCalls: string[][] = [];

    enableAutostart({
      platform: "darwin",
      homeDir,
      bunExecutablePath: "/opt/homebrew/bin/bun",
      cliEntrypointPath: "/opt/code-helm/src/cli.ts",
      runLaunchctl() {},
      uid: 501,
    });

    const result = disableAutostart({
      platform: "darwin",
      homeDir,
      runLaunchctl(args) {
        launchctlCalls.push(args);
      },
      uid: 501,
    });

    expect(result).toEqual({
      kind: "disabled",
      launchAgentPath: join(homeDir, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`),
      label: AUTOSTART_LABEL,
      removed: true,
    });
    expect(existsSync(join(homeDir, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`))).toBe(false);
    expect(launchctlCalls).toContainEqual([
      "bootout",
      "gui/501",
      join(homeDir, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`),
    ]);
  });

  test("non-macOS platforms return unsupported", () => {
    expect(enableAutostart({
      platform: "linux",
      homeDir: createTempDir(),
      bunExecutablePath: "/usr/bin/bun",
      cliEntrypointPath: "/tmp/code-helm/src/cli.ts",
    })).toEqual({
      kind: "unsupported",
      platform: "linux",
    });
  });
});
