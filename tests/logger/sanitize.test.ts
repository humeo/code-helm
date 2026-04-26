import { describe, expect, test } from "bun:test";
import {
  normalizeLogArguments,
  sanitizeLogValue,
  serializeLogError,
} from "../../src/logger/sanitize";

describe("logger sanitization", () => {
  test("redacts token, secret, password, credential, and api key fields", () => {
    expect(sanitizeLogValue({
      botToken: "token-value",
      clientSecret: "secret-value",
      password: "password-value",
      credential: "credential-value",
      nested: {
        apiKey: "api-key-value",
      },
    })).toEqual({
      botToken: "[REDACTED]",
      clientSecret: "[REDACTED]",
      password: "[REDACTED]",
      credential: "[REDACTED]",
      nested: {
        apiKey: "[REDACTED]",
      },
    });
  });

  test("summarizes user content fields instead of logging full text", () => {
    const sanitized = sanitizeLogValue({
      content: "please create the private file",
      prompt: "full prompt body",
      input: "raw user input",
      text: "discord text",
    }) as Record<string, { redacted: boolean; length: number; sha256: string }>;

    expect(sanitized.content).toEqual({
      redacted: true,
      length: 30,
      sha256: expect.stringMatching(/^[a-f0-9]{12}$/),
    });
    expect(sanitized.prompt.length).toBe(16);
    expect(sanitized.input.length).toBe(14);
    expect(sanitized.text.length).toBe(12);
    expect(JSON.stringify(sanitized)).not.toContain("private file");
    expect(JSON.stringify(sanitized)).not.toContain("full prompt body");
  });

  test("truncates command previews instead of fully redacting them", () => {
    const command = `echo ${"x".repeat(700)}`;
    const sanitized = sanitizeLogValue({
      commandPreview: command,
    }) as { commandPreview: string };

    expect(sanitized.commandPreview.startsWith("echo ")).toBe(true);
    expect(sanitized.commandPreview.length).toBeLessThan(command.length);
    expect(sanitized.commandPreview.endsWith("...")).toBe(true);
  });

  test("serializes errors with debugging details", () => {
    const cause = new Error("root cause");
    const error = new Error("outer failure", { cause }) as Error & { code?: string };
    error.name = "CodeHelmError";
    error.code = "E_CODEHELM";

    const serialized = serializeLogError(error);

    expect(serialized.name).toBe("CodeHelmError");
    expect(serialized.message).toBe("outer failure");
    expect(serialized.code).toBe("E_CODEHELM");
    expect(serialized.stack).toContain("CodeHelmError");
    expect(serialized.cause).toEqual({
      name: "Error",
      message: "root cause",
      stack: expect.any(String),
    });
  });

  test("normalizes console-style message and error arguments", () => {
    const error = new Error("transport closed");
    const normalized = normalizeLogArguments(["JSON-RPC failed", error]);

    expect(normalized.msg).toBe("JSON-RPC failed");
    expect(normalized.meta.err).toMatchObject({
      name: "Error",
      message: "transport closed",
    });
  });

  test("normalizes object-first Pino-style arguments", () => {
    const normalized = normalizeLogArguments([
      {
        component: "codex",
        botToken: "secret",
        error: new Error("boom"),
      },
      "Codex request failed",
    ]);

    expect(normalized.msg).toBe("Codex request failed");
    expect(normalized.meta).toMatchObject({
      component: "codex",
      botToken: "[REDACTED]",
      error: {
        name: "Error",
        message: "boom",
      },
    });
  });
});
