import { describe, expect, test } from "bun:test";
import {
  detectCliCharset,
  renderCliCaughtError,
  renderErrorPanel,
  renderKeyValueRows,
  renderSuccessPanel,
} from "../../src/cli/output";

describe("cli output renderer", () => {
  const expectPanelRowsToStayFramed = (output: string) => {
    const lines = output.split("\n");

    for (const line of lines.slice(1, -1)) {
      if (line.startsWith("├") || line.startsWith("+")) {
        continue;
      }

      expect(line.startsWith("│ ")).toBe(true);
      expect(line.endsWith(" │")).toBe(true);
    }
  };

  test("uses unicode panel framing by default", () => {
    const output = renderSuccessPanel({
      title: "CodeHelm Stopped",
      sections: [{ title: "Result", lines: ["The runtime is no longer active."] }],
      env: {},
    });

    expect(output).toContain("┌");
    expect(output).toContain("┐");
    expect(output).toContain("CodeHelm Stopped");
  });

  test("uses ASCII framing when TERM is dumb", () => {
    const output = renderSuccessPanel({
      title: "CodeHelm Stopped",
      sections: [{ title: "Result", lines: ["Done"] }],
      env: { TERM: "dumb" },
    });

    expect(output).toContain("+");
    expect(output).not.toContain("┌");
  });

  test("uses ASCII framing when CODE_HELM_CLI_ASCII is enabled", () => {
    const output = renderSuccessPanel({
      title: "CodeHelm Stopped",
      sections: [{ title: "Result", lines: ["Done"] }],
      env: { CODE_HELM_CLI_ASCII: "1" },
    });

    expect(output).toContain("+");
    expect(output).not.toContain("┌");
  });

  test("renders aligned key-value rows inside a titled panel", () => {
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
    expect(output).toContain("Mode    : background");
    expect(output).toContain("PID     : 1234");
    expect(output).toContain("Started : 2026-04-20 10:00:00 +08:00");
  });

  test("aligns key-value colons for mixed ascii and cjk keys", () => {
    const rows = renderKeyValueRows([
      { key: "模式", value: "后台" },
      { key: "PID", value: "1234" },
      { key: "状态", value: "运行中" },
    ]);

    expect(rows).toEqual(["模式 : 后台", "PID  : 1234", "状态 : 运行中"]);
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
    const innerLines = lines
      .filter((line) => line.startsWith("│ ") && line.endsWith(" │"))
      .map((line) => line.slice(2, -2));
    const line1Index = innerLines.findIndex((line) => line.trim() === "line 1");
    const line3Index = innerLines.findIndex((line) => line.trim() === "line 3");

    expect(line1Index).toBeGreaterThan(-1);
    expect(line3Index).toBeGreaterThan(line1Index);
    expect(innerLines.slice(line1Index + 1, line3Index).some((line) => line.trim() === "")).toBe(true);
  });

  test("renders command hints as a dedicated section", () => {
    const output = renderSuccessPanel({
      title: "CodeHelm Stopped",
      sections: [{ title: "Result", lines: ["The runtime is no longer active."] }],
      commandHints: ["code-helm start", "code-helm status"],
      env: {},
    });

    expect(output).toContain("Command Hints");
    expect(output).toContain("$ code-helm start");
    expect(output).toContain("$ code-helm status");
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

  test("keeps frame display width aligned for cjk lines", () => {
    const output = renderSuccessPanel({
      title: "状态面板",
      sections: [
        {
          title: "结果",
          lines: ["运行正常", "Codex 已连接"],
        },
      ],
      env: {},
    });

    expect(output).toBe([
      "┌──────────────┐",
      "│ 状态面板     │",
      "├──────────────┤",
      "│ 结果         │",
      "│ 运行正常     │",
      "│ Codex 已连接 │",
      "└──────────────┘",
    ].join("\n"));
  });

  test("strips ANSI sequences and normalizes tabs so borders stay aligned", () => {
    const output = renderErrorPanel({
      title: "Error\tPanel",
      headline: "\u001B[31mManaged\u001B[0m startup failed",
      diagnostics: "line\tone\n\u001B[33mwarn\u001B[0m\titem",
      env: {},
    });
    const lines = output.split("\n");

    expect(output).not.toContain("\u001B[31m");
    expect(output).not.toContain("\u001B[33m");
    expect(output).not.toContain("\t");
    expect(output).toContain("Error  Panel");
    expect(output).toContain("line  one");
    expect(output).toContain("warn  item");
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });

  test("neutralizes carriage return and backspace control characters", () => {
    const output = renderErrorPanel({
      title: "Bad\rTitle\b",
      headline: "line\rreset",
      diagnostics: "value\bfix\nnext\rline",
      env: {},
    });

    expect(output).not.toContain("\r");
    expect(output).not.toContain("\b");
    expect(output).toContain("│ Bad");
    expect(output).toContain("│ Title");
    expect(output).toContain("│ line");
    expect(output).toContain("│ reset");
    expect(output).toContain("│ value fix");
    expect(output).toContain("│ next");
    expect(output).toContain("│ line");
    expectPanelRowsToStayFramed(output);
  });

  test("splits embedded newlines in headline into safe framed lines", () => {
    const output = renderErrorPanel({
      title: "CodeHelm Start Failed",
      headline: "first line\nsecond line",
      env: {},
    });

    expect(output).toContain("│ first line            │");
    expect(output).toContain("│ second line           │");
    expectPanelRowsToStayFramed(output);
  });

  test("splits embedded newlines in section content into safe framed lines", () => {
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

    const innerLines = output
      .split("\n")
      .filter((line) => line.startsWith("│ ") && line.endsWith(" │"))
      .map((line) => line.slice(2, -2).trimRight());

    expect(innerLines).toContain("Result");
    expect(innerLines).toContain("Details");
    expect(innerLines).toContain("line one");
    expect(innerLines).toContain("line two");
    expect(innerLines).toContain("$ code-helm status");
    expect(innerLines).toContain("code-helm stop");
    expectPanelRowsToStayFramed(output);
  });
});
