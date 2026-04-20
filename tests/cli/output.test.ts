import { describe, expect, test } from "bun:test";
import {
  renderErrorPanel,
  renderKeyValueRows,
  renderSuccessPanel,
} from "../../src/cli/output";

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
});
