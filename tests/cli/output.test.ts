import { describe, expect, test } from "bun:test";
import {
  detectCliCharset,
  renderCliCaughtError,
  renderErrorPanel,
  renderKeyValueRows,
  renderSuccessPanel,
  renderWarningPanel,
} from "../../src/cli/output";

describe("cli output renderer", () => {
  const ansiPattern = /\u001B\[[0-9;]*m/gu;

  const expectNoFrameCharacters = (output: string) => {
    expect(output).not.toContain("┌");
    expect(output).not.toContain("┐");
    expect(output).not.toContain("└");
    expect(output).not.toContain("┘");
  };

  const stripAnsi = (output: string) => output.replace(ansiPattern, "");

  test("uses frame-free output by default", () => {
    const output = renderSuccessPanel({
      title: "CodeHelm Stopped",
      sections: [{ title: "Result", lines: ["The runtime is no longer active."] }],
      env: {},
    });

    expect(output).toContain("CodeHelm Stopped");
    expect(output).toContain("Result");
    expect(output).toContain("The runtime is no longer active.");
    expectNoFrameCharacters(output);
  });

  test("adds semantic ansi color in interactive terminals", () => {
    const successOutput = renderSuccessPanel({
      title: "Runtime stopped",
      headline: "The runtime is no longer active.",
      sections: [{ title: "Next steps", lines: ["code-helm start"] }],
      env: { CODE_HELM_CLI_IS_TTY: "1" },
    });
    const warningOutput = renderWarningPanel({
      title: "Startup delayed",
      headline: "Managed Codex App Server startup is taking longer than expected.",
      env: { CODE_HELM_CLI_IS_TTY: "1" },
    });
    const errorOutput = renderCliCaughtError(
      new Error("boom"),
      { CODE_HELM_CLI_IS_TTY: "1" },
    );

    expect(successOutput).toContain("\u001B[1;92mRuntime stopped\u001B[0m");
    expect(warningOutput).toContain("\u001B[1;93mStartup delayed\u001B[0m");
    expect(errorOutput).toContain("\u001B[1;91mCommand Failed\u001B[0m");
    expect(stripAnsi(successOutput)).toContain("Runtime stopped");
    expect(stripAnsi(errorOutput)).toContain("Command Failed");
  });

  test("keeps frame-free structure when TERM is dumb", () => {
    const output = renderSuccessPanel({
      title: "CodeHelm",
      sections: [
        {
          kind: "steps",
          title: "Next steps",
          items: ["code-helm start", "code-helm status"],
        },
      ],
      env: { TERM: "dumb" },
    });

    expect(output).toContain("CodeHelm");
    expect(output).toContain("Next steps");
    expect(output).toContain("  code-helm start");
    expect(output).toContain("  code-helm status");
    expectNoFrameCharacters(output);
  });

  test("keeps frame-free structure when CODE_HELM_CLI_ASCII is enabled", () => {
    const output = renderSuccessPanel({
      title: "CodeHelm",
      sections: [
        {
          kind: "steps",
          title: "Next steps",
          items: ["code-helm start"],
        },
      ],
      env: { CODE_HELM_CLI_ASCII: "1" },
    });

    expect(output).toContain("CodeHelm");
    expect(output).toContain("Next steps");
    expect(output).toContain("  code-helm start");
    expectNoFrameCharacters(output);
  });

  test("renders aligned command-list sections", () => {
    const output = renderSuccessPanel({
      title: "CodeHelm",
      headline: "Control Codex from Discord",
      sections: [
        {
          kind: "command-list",
          title: "Runtime",
          items: [
            { command: "start", description: "Start CodeHelm in foreground" },
            { command: "status", description: "Show runtime state" },
          ],
        },
      ],
      env: { CODE_HELM_CLI_IS_TTY: "1" },
    });

    expect(output).toMatch(/\u001B\[[0-9;]*mCodeHelm\u001B\[0m/u);
    expect(output).toContain("Control Codex from Discord");
    expect(output).toContain("\u001B[36mRuntime\u001B[0m");
    expect(output).toMatch(/\u001B\[[0-9;]*mstart\s*\u001B\[0m\s+Start CodeHelm in foreground/u);
    expect(output).toMatch(/\u001B\[[0-9;]*mstatus\u001B\[0m\s+Show runtime state/u);
    expectNoFrameCharacters(output);
  });

  test("renders aligned key-value rows inside a titled screen", () => {
    const output = renderSuccessPanel({
      title: "CodeHelm running",
      sections: [
        {
          title: "Runtime",
          lines: renderKeyValueRows([
            { key: "Mode", value: "background" },
            { key: "PID", value: "1234" },
            { key: "Started", value: "2026-04-20 10:00:00 +08:00" },
          ]),
        },
      ],
      env: {},
    });

    expect(output).toContain("Runtime");
    expect(output).toContain("Mode     background");
    expect(output).toContain("PID      1234");
    expect(output).toContain("Started  2026-04-20 10:00:00 +08:00");
  });

  test("aligns key-value rows for mixed ascii and cjk keys", () => {
    const rows = renderKeyValueRows([
      { key: "模式", value: "后台" },
      { key: "PID", value: "1234" },
      { key: "状态", value: "运行中" },
    ]);

    expect(rows).toEqual(["模式  后台", "PID   1234", "状态  运行中"]);
  });

  test("renders step-list sections for next steps", () => {
    const output = renderSuccessPanel({
      title: "Runtime stopped",
      sections: [
        {
          kind: "steps",
          title: "Next steps",
          items: ["code-helm start", "code-helm status"],
        },
      ],
      env: {},
    });

    expect(output).toContain("Runtime stopped");
    expect(output).toContain("Next steps");
    expect(output).toContain("  code-helm start");
    expect(output).toContain("  code-helm status");
  });

  test("renders warning panels with version rows and recovery steps without frame characters", () => {
    const output = renderWarningPanel({
      title: "CodeHelm Updated With Warnings",
      headline: "Background daemon did not come back automatically.",
      sections: [
        {
          kind: "key-value",
          title: "Status",
          rows: [
            { key: "Installed version", value: "0.2.0" },
            { key: "Latest version", value: "0.2.1" },
            { key: "Package manager", value: "npm" },
          ],
        },
        {
          kind: "steps",
          title: "Try next",
          items: ["code-helm start --daemon", "code-helm status"],
        },
      ],
      env: {},
    });

    expect(output).toContain("CodeHelm Updated With Warnings");
    expect(output).toContain("Status");
    expect(output).toContain("Installed version  0.2.0");
    expect(output).toContain("Latest version     0.2.1");
    expect(output).toContain("Package manager    npm");
    expect(output).toContain("Try next");
    expect(output).toContain("  code-helm start --daemon");
    expect(output).toContain("  code-helm status");
    expectNoFrameCharacters(output);
  });

  test("renders diagnostics after the headline instead of before it", () => {
    const output = renderErrorPanel({
      title: "CodeHelm Start Failed",
      headline: "Managed Codex App Server failed to start.",
      diagnostics:
        "listen EADDRINUSE: address already in use 127.0.0.1:4100",
      env: {},
    });

    const headlineIndex = output.indexOf("Managed Codex App Server failed to start.");
    const diagnosticsIndex = output.indexOf("Diagnostics");

    expect(headlineIndex).toBeGreaterThan(-1);
    expect(diagnosticsIndex).toBeGreaterThan(headlineIndex);
  });

  test("renders plain caught errors as Problem and Details sections", () => {
    const output = renderCliCaughtError(new Error("boom"), {});

    expect(output).toContain("Command Failed");
    expect(output).toContain("Problem");
    expect(output).toContain("Unhandled CLI error.");
    expect(output).toContain("Details");
    expect(output).toContain("boom");
    expectNoFrameCharacters(output);
  });

  test("splits usage-shaped caught errors into Problem and Usage sections", () => {
    const output = renderCliCaughtError(
      new Error("Unknown command: wat\nUsage: code-helm <...>"),
      {},
    );

    expect(output).toContain("Invalid Arguments");
    expect(output).toContain("Problem");
    expect(output).toContain("Unknown command: wat");
    expect(output).toContain("Usage");
    expect(output).toContain("code-helm <...>");
    expect(output).not.toContain("Details");
  });

  test("preserves already-rendered screen errors without wrapping them again", () => {
    const screenError = renderErrorPanel({
      title: "Uninstall Incomplete",
      sections: [{ title: "Problem", lines: ["Could not remove launch agent."] }],
      env: {},
    });

    const output = renderCliCaughtError(new Error(screenError), {});

    expect(output).toBe(screenError);
  });

  test("formats usage-only errors with generic Problem and grouped Usage lines", () => {
    const output = renderCliCaughtError(
      new Error("Usage: code-helm autostart <enable|disable>\nUsage: code-helm <help|onboard|start|status|stop|version|check|update|autostart|uninstall>"),
      {},
    );

    expect(output).toContain("Invalid Arguments");
    expect(output).toContain("Problem");
    expect(output).toContain("Invalid command arguments.");
    expect(output).toContain("Usage");
    expect(output).toContain("Usage: code-helm autostart <enable|disable>");
    expect(output).toContain("Usage: code-helm <help|onboard|start|status|stop|version|check|update|autostart|uninstall>");
    expect(output).not.toContain("Details");
  });

  test("does not classify non-code-helm usage text as Invalid Arguments", () => {
    const output = renderCliCaughtError(
      new Error("helper failed\nUsage: helper [opts]"),
      {},
    );

    expect(output).toContain("Command Failed");
    expect(output).toContain("Problem");
    expect(output).toContain("Unhandled CLI error.");
    expect(output).toContain("Details");
    expect(output).toContain("helper failed");
    expect(output).toContain("Usage: helper [opts]");
    expect(output).not.toContain("Invalid Arguments");
  });

  test("keeps diagnostics in a dedicated Diagnostics section for caught errors", () => {
    const output = renderCliCaughtError(
      new Error("boom"),
      {},
      "listen EADDRINUSE: address already in use",
    );

    const detailsIndex = output.indexOf("Details");
    const diagnosticsIndex = output.indexOf("Diagnostics");

    expect(detailsIndex).toBeGreaterThan(-1);
    expect(diagnosticsIndex).toBeGreaterThan(detailsIndex);
    expect(output).not.toContain("Command Failed: listen EADDRINUSE");
  });

  test("preserves intentional blank lines in diagnostics output", () => {
    const output = renderErrorPanel({
      title: "CodeHelm Start Failed",
      headline: "Managed Codex App Server failed to start.",
      diagnostics: "line 1\n\nline 3",
      env: {},
    });

    const lines = output.split("\n");
    const line1Index = lines.findIndex((line) => line.trim() === "line 1");
    const line3Index = lines.findIndex((line) => line.trim() === "line 3");

    expect(line1Index).toBeGreaterThan(-1);
    expect(line3Index).toBeGreaterThan(line1Index);
    expect(lines.slice(line1Index + 1, line3Index).some((line) => line.trim() === "")).toBe(true);
  });

  test("renders command hints as a dedicated section", () => {
    const output = renderSuccessPanel({
      title: "CodeHelm Stopped",
      sections: [{ title: "Result", lines: ["The runtime is no longer active."] }],
      commandHints: ["code-helm start", "code-helm status"],
      env: { CODE_HELM_CLI_IS_TTY: "1" },
    });

    expect(output).toContain("\u001B[36mCommand Hints\u001B[0m");
    expect(output).toMatch(/\$ \u001B\[[0-9;]*mcode-helm start\u001B\[0m/u);
    expect(output).toMatch(/\$ \u001B\[[0-9;]*mcode-helm status\u001B\[0m/u);
  });

  test("disables ansi color when NO_COLOR is set", () => {
    const output = renderSuccessPanel({
      title: "CodeHelm",
      sections: [{ title: "Next steps", lines: ["code-helm start"] }],
      env: { CODE_HELM_CLI_IS_TTY: "1", NO_COLOR: "1" },
    });

    expect(output).not.toMatch(ansiPattern);
    expect(output).toContain("CodeHelm");
  });

  test("disables ansi color for non-tty output", () => {
    const output = renderErrorPanel({
      title: "Command Failed",
      headline: "Unhandled CLI error.",
      env: { CODE_HELM_CLI_IS_TTY: "0" },
    });

    expect(output).not.toMatch(ansiPattern);
    expect(output).toContain("Command Failed");
  });

  test("keeps unicode when explicit utf-8 locale is set", () => {
    expect(detectCliCharset({ LANG: "en_US.UTF-8" })).toBe("unicode");
  });

  test("does not force ascii when LANG has no explicit charset", () => {
    expect(detectCliCharset({ LANG: "en_US" })).toBe("unicode");
  });

  test("falls back to ascii when LC_ALL is C", () => {
    expect(detectCliCharset({ LC_ALL: "C" })).toBe("ascii");
  });

  test("falls back to ascii when LC_CTYPE is POSIX", () => {
    expect(detectCliCharset({ LC_CTYPE: "POSIX" })).toBe("ascii");
  });

  test("falls back to ascii for direct explicit non-utf8 charset tokens", () => {
    expect(detectCliCharset({ LANG: "ISO-8859-1" })).toBe("ascii");
    expect(detectCliCharset({ LANG: "US-ASCII" })).toBe("ascii");
    expect(detectCliCharset({ LANG: "latin1" })).toBe("ascii");
    expect(detectCliCharset({ LANG: "ANSI_X3.4-1968" })).toBe("ascii");
  });

  test("falls back to ascii for dotted explicit non-utf8 iso locales", () => {
    expect(detectCliCharset({ LANG: "de_DE.iso88591" })).toBe("ascii");
    expect(detectCliCharset({ LANG: "de_DE.iso885915@euro" })).toBe("ascii");
  });

  test("uses locale precedence with LC_ALL over lower-priority utf-8 locale", () => {
    expect(detectCliCharset({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe("ascii");
  });

  test("keeps unicode when highest-precedence effective locale is utf-8", () => {
    expect(detectCliCharset({ LC_CTYPE: "en_US.UTF-8", LANG: "C" })).toBe("unicode");
    expect(detectCliCharset({ LC_ALL: "en_US.utf8", LC_CTYPE: "POSIX" })).toBe("unicode");
  });

  test("strips ANSI sequences and normalizes tabs in rendered output", () => {
    const output = renderErrorPanel({
      title: "Error\tPanel",
      headline: "\u001B[31mManaged\u001B[0m startup failed",
      diagnostics: "line\tone\n\u001B[33mwarn\u001B[0m\titem",
      env: {},
    });

    expect(output).not.toContain("\u001B[31m");
    expect(output).not.toContain("\u001B[33m");
    expect(output).not.toContain("\t");
    expect(output).toContain("Error  Panel");
    expect(output).toContain("Managed startup failed");
    expect(output).toContain("line  one");
    expect(output).toContain("warn  item");
  });

  test("neutralizes carriage return and backspace control characters", () => {
    const output = renderErrorPanel({
      title: "Bad\rTitle\b",
      headline: "line\rreset",
      diagnostics: "value\bfix\nnext\rline",
      env: {},
    });
    const lines = output.split("\n");

    expect(output).not.toContain("\r");
    expect(output).not.toContain("\b");
    expect(lines).toContain("Bad");
    expect(lines).toContain("Title ");
    expect(lines).toContain("line");
    expect(lines).toContain("reset");
    expect(lines).toContain("value fix");
    expect(lines).toContain("next");
    expect(lines).toContain("line");
  });

  test("splits embedded newlines in headline into safe lines", () => {
    const output = renderErrorPanel({
      title: "CodeHelm Start Failed",
      headline: "first line\nsecond line",
      env: {},
    });

    const lines = output.split("\n");

    expect(lines).toContain("first line");
    expect(lines).toContain("second line");
  });

  test("splits embedded newlines in section content into safe lines", () => {
    const output = renderSuccessPanel({
      title: "CodeHelm running",
      sections: [
        {
          title: "Result\nDetails",
          lines: ["line one\nline two", "plain line"],
        },
      ],
      commandHints: ["code-helm status\ncode-helm stop"],
      env: {},
    });

    const lines = output.split("\n");

    expect(lines).toContain("Result");
    expect(lines).toContain("Details");
    expect(lines).toContain("line one");
    expect(lines).toContain("line two");
    expect(lines).toContain("$ code-helm status");
    expect(lines).toContain("code-helm stop");
    expectNoFrameCharacters(output);
  });
});
