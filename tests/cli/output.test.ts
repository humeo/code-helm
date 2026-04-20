import { describe, expect, test } from "bun:test";
import {
  detectCliCharset,
  renderErrorPanel,
  renderKeyValueRows,
  renderSuccessPanel,
} from "../../src/cli/output";

const lineDisplayWidth = (value: string) => {
  let width = 0;

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (character === "\u200D") {
      continue;
    }

    if (/\p{Mark}/u.test(character)) {
      continue;
    }

    if (
      (codePoint >= 0x1100 && codePoint <= 0x115f)
      || codePoint === 0x2329
      || codePoint === 0x232a
      || (codePoint >= 0x2e80 && codePoint <= 0x303e)
      || (codePoint >= 0x3040 && codePoint <= 0xa4cf)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
      || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
      || (codePoint >= 0xff00 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
      || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    ) {
      width += 2;
      continue;
    }

    width += 1;
  }

  return width;
};

describe("cli output renderer", () => {
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

  test("falls back to ascii when LC_ALL is C", () => {
    expect(detectCliCharset({ LC_ALL: "C" })).toBe("ascii");
  });

  test("falls back to ascii when LC_CTYPE is POSIX", () => {
    expect(detectCliCharset({ LC_CTYPE: "POSIX" })).toBe("ascii");
  });

  test("keeps unicode on conflicting locale values if utf-8 is explicit", () => {
    expect(detectCliCharset({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe("unicode");
    expect(detectCliCharset({ LC_CTYPE: "POSIX", LANG: "en_US.utf8" })).toBe("unicode");
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
    const lines = output.split("\n");
    const widths = lines.map((line) => lineDisplayWidth(line));

    expect(new Set(widths).size).toBe(1);
  });
});
