import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  formatSessionPathForDisplay,
  normalizeBootstrapThreadTitle,
  normalizeSessionPathInput,
} from "../../src/domain/session-paths";

describe("normalizeSessionPathInput", () => {
  test("accepts absolute paths and normalizes path segments", () => {
    expect(
      normalizeSessionPathInput("/tmp/code-helm/../code-helm/workspace"),
    ).toBe("/tmp/code-helm/workspace");
  });

  test("expands home-relative paths", () => {
    const homeDir = join("/Users", "koltenluca");

    expect(normalizeSessionPathInput("~/code-helm", homeDir)).toBe(
      "/Users/koltenluca/code-helm",
    );
  });

  test("rejects hidden directories in home-relative paths", () => {
    const homeDir = join("/Users", "koltenluca");

    expect(() => normalizeSessionPathInput("~/.codex", homeDir)).toThrow(
      /hidden directories/i,
    );
  });

  test("rejects descendants inside hidden directories", () => {
    const homeDir = join("/Users", "koltenluca");

    expect(() => normalizeSessionPathInput("~/.codex/work", homeDir)).toThrow(
      /hidden directories/i,
    );
  });

  test("rejects relative paths", () => {
    expect(() => normalizeSessionPathInput("code-helm")).toThrow(
      /absolute|~\//i,
    );
  });
});

describe("formatSessionPathForDisplay", () => {
  test("renders paths inside the home directory with a tilde prefix", () => {
    const homeDir = join("/Users", "koltenluca");
    const path = "/Users/koltenluca/code-github/code-helm";

    expect(formatSessionPathForDisplay(path, homeDir)).toBe(
      "~/code-github/code-helm",
    );
  });

  test("renders paths outside the home directory as absolute paths", () => {
    const homeDir = join("/Users", "koltenluca");

    expect(formatSessionPathForDisplay("/srv/agents/project-x", homeDir)).toBe(
      "/srv/agents/project-x",
    );
  });
});

describe("normalizeBootstrapThreadTitle", () => {
  test("collapses whitespace and trims the title", () => {
    expect(normalizeBootstrapThreadTitle("  hello\n\nworld  ")).toBe(
      "hello world",
    );
  });

  test("returns null for empty titles", () => {
    expect(normalizeBootstrapThreadTitle("   \n\t  ")).toBeNull();
  });
});
