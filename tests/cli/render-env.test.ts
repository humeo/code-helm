import { describe, expect, test } from "bun:test";
import { createRenderEnv } from "../../src/cli/render-env";

describe("createRenderEnv", () => {
  test("marks the terminal interactive only when both stdin and stdout are tty", () => {
    expect(createRenderEnv({ stdinIsTTY: true, stdoutIsTTY: true })).toMatchObject({
      CODE_HELM_CLI_IS_TTY: "1",
    });
    expect(createRenderEnv({ stdinIsTTY: false, stdoutIsTTY: true })).toMatchObject({
      CODE_HELM_CLI_IS_TTY: "0",
    });
    expect(createRenderEnv({ stdinIsTTY: true, stdoutIsTTY: false })).toMatchObject({
      CODE_HELM_CLI_IS_TTY: "0",
    });
  });
});
