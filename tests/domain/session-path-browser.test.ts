import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { buildPathBrowserChoices } from "../../src/domain/session-path-browser";

const createTempHomeDir = () => {
  return mkdtempSync(join(tmpdir(), "codehelm-path-browser-"));
};

describe("buildPathBrowserChoices", () => {
  test("empty input starts at home and lists child directories only", () => {
    const homeDir = createTempHomeDir();

    try {
      mkdirSync(join(homeDir, "code-github"));
      mkdirSync(join(homeDir, "Downloads"));
      writeFileSync(join(homeDir, "notes.txt"), "hello");

      expect(buildPathBrowserChoices({ homeDir })).toEqual([
        { name: "Select ~", value: "~" },
        { name: "code-github/", value: "~/code-github/" },
        { name: "Downloads/", value: "~/Downloads/" },
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("choosing a child directory yields the child path, parent navigation, and child directories", () => {
    const homeDir = createTempHomeDir();

    try {
      mkdirSync(join(homeDir, "code-github", "code-helm"), { recursive: true });
      mkdirSync(join(homeDir, "code-github", "codex"), { recursive: true });
      writeFileSync(join(homeDir, "code-github", "README.md"), "ignore me");

      expect(buildPathBrowserChoices({
        inputPath: "~/code-github/",
        homeDir,
      })).toEqual([
        { name: "Select ~/code-github", value: "~/code-github" },
        { name: "../", value: "~" },
        { name: "code-helm/", value: "~/code-github/code-helm/" },
        { name: "codex/", value: "~/code-github/codex/" },
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("nonexistent paths fall back to the nearest valid parent", () => {
    const homeDir = createTempHomeDir();

    try {
      mkdirSync(join(homeDir, "code-github", "code-helm"), { recursive: true });
      mkdirSync(join(homeDir, "code-github", "codex"), { recursive: true });

      expect(buildPathBrowserChoices({
        inputPath: "~/code-github/missing/nested/",
        homeDir,
      })).toEqual([
        { name: "Select ~/code-github", value: "~/code-github" },
        { name: "../", value: "~" },
        { name: "code-helm/", value: "~/code-github/code-helm/" },
        { name: "codex/", value: "~/code-github/codex/" },
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("unreadable paths fall back to the nearest readable parent", () => {
    const homeDir = createTempHomeDir();
    const codeGithubDir = join(homeDir, "code-github");
    const privateDir = join(codeGithubDir, "private");

    try {
      mkdirSync(privateDir, { recursive: true });
      mkdirSync(join(codeGithubDir, "code-helm"));

      const choices = buildPathBrowserChoices({
        inputPath: "~/code-github/private/",
        homeDir,
        fs: {
          statSync(path) {
            return statSync(path);
          },
          readdirSync(path, options) {
            if (path === privateDir) {
              throw new Error("EACCES");
            }

            return readdirSync(path, options);
          },
        },
      });

      expect(choices).toEqual([
        { name: "Select ~/code-github", value: "~/code-github" },
        { name: "../", value: "~" },
        { name: "code-helm/", value: "~/code-github/code-helm/" },
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("home-rooted fallback does not escape above the home directory", () => {
    const homeDir = createTempHomeDir();

    try {
      expect(buildPathBrowserChoices({
        inputPath: "~/private/",
        homeDir,
        fs: {
          statSync(path) {
            return statSync(path);
          },
          readdirSync(path, options) {
            if (path === homeDir) {
              throw new Error("EACCES");
            }

            return readdirSync(path, options);
          },
        },
      })).toEqual([]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("results stay sorted and truncated to 25 choices", () => {
    const homeDir = createTempHomeDir();

    try {
      for (let index = 0; index < 30; index += 1) {
        mkdirSync(join(homeDir, `dir-${String(index).padStart(2, "0")}`));
      }
      writeFileSync(join(homeDir, "dir-30.txt"), "ignore me");

      const choices = buildPathBrowserChoices({ homeDir });

      expect(choices).toHaveLength(25);
      expect(choices[0]).toEqual({ name: "Select ~", value: "~" });
      expect(choices.at(-1)).toEqual({
        name: "dir-23/",
        value: "~/dir-23/",
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("hidden directories are excluded from browser choices", () => {
    const homeDir = createTempHomeDir();

    try {
      mkdirSync(join(homeDir, "code-github"));
      mkdirSync(join(homeDir, "Downloads"));

      for (let index = 0; index < 30; index += 1) {
        mkdirSync(join(homeDir, `.hidden-${String(index).padStart(2, "0")}`));
      }

      expect(buildPathBrowserChoices({
        homeDir,
        limit: 5,
      })).toEqual([
        { name: "Select ~", value: "~" },
        { name: "code-github/", value: "~/code-github/" },
        { name: "Downloads/", value: "~/Downloads/" },
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("hidden directory input falls back to the nearest visible parent", () => {
    const homeDir = createTempHomeDir();

    try {
      mkdirSync(join(homeDir, ".hidden", "nested"), { recursive: true });
      mkdirSync(join(homeDir, "code-github"));

      expect(buildPathBrowserChoices({
        inputPath: "~/.hidden/nested/",
        homeDir,
      })).toEqual([
        { name: "Select ~", value: "~" },
        { name: "code-github/", value: "~/code-github/" },
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("absolute hidden path input falls back to the nearest visible parent", () => {
    const homeDir = createTempHomeDir();

    try {
      const workspaceDir = join(homeDir, "workspace");

      mkdirSync(join(workspaceDir, ".hidden", "nested"), { recursive: true });
      mkdirSync(join(workspaceDir, "visible"));

      expect(buildPathBrowserChoices({
        inputPath: `${workspaceDir}/.hidden/nested/`,
        homeDir,
      })).toEqual([
        { name: "Select ~/workspace", value: "~/workspace" },
        { name: "../", value: "~" },
        { name: "visible/", value: "~/workspace/visible/" },
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
