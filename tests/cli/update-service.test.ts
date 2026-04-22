import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readPackageMetadata } from "../../src/package-metadata";
import {
  checkForUpdates,
  readInstalledPackageMetadataFromPath,
  readLatestPublishedVersion,
  resolveInstalledPackageManager,
} from "../../src/cli/update-service";

const tempDirs: string[] = [];

const createTempDir = () => {
  const directory = mkdtempSync(join(tmpdir(), "codehelm-update-service-"));
  tempDirs.push(directory);
  return directory;
};

const writeJson = (targetPath: string, value: unknown) => {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(value, null, 2));
};

const createInstalledPackage = (root: string, version: string) => {
  const packageRoot = join(root, "node_modules", "code-helm");
  writeJson(join(packageRoot, "package.json"), {
    name: "code-helm",
    version,
  });
  return packageRoot;
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    Bun.spawnSync(["rm", "-rf", directory]);
  }
});

describe("readInstalledPackageMetadataFromPath", () => {
  test("reads installed version from an arbitrary package directory on disk instead of process metadata cache", () => {
    const processPackageMetadata = readPackageMetadata();
    const tempRoot = createTempDir();
    const packageRoot = createInstalledPackage(tempRoot, "0.2.0");

    const result = readInstalledPackageMetadataFromPath(packageRoot);

    expect(processPackageMetadata.version).not.toBe("0.2.0");
    expect(result).toEqual({
      name: "code-helm",
      version: "0.2.0",
    });
  });
});

describe("resolveInstalledPackageManager", () => {
  test("detects npm installs from canonical nvm global package paths", () => {
    const packageRoot =
      "/Users/example/.nvm/versions/node/v22.17.0/lib/node_modules/code-helm";

    const result = resolveInstalledPackageManager({ packageRoot });

    expect(result).toEqual({
      kind: "npm",
      command: ["npm", "install", "-g", "code-helm@latest"],
      executableName: "npm",
      packageRoot,
    });
  });

  test("returns unknown for near-miss nvm-shaped paths that are not canonical global installs", () => {
    const packageRoot =
      "/tmp/not-global/.nvm/versions/node/v22.17.0/lib/node_modules/code-helm";

    const result = resolveInstalledPackageManager({ packageRoot });

    expect(result).toEqual({
      kind: "unknown",
      command: undefined,
      packageRoot,
    });
  });

  test("detects npm installs from canonical homebrew global package paths", () => {
    const packageRoot = "/opt/homebrew/lib/node_modules/code-helm";

    const result = resolveInstalledPackageManager({ packageRoot });

    expect(result).toEqual({
      kind: "npm",
      command: ["npm", "install", "-g", "code-helm@latest"],
      executableName: "npm",
      packageRoot,
    });
  });

  test("returns unknown for nested homebrew near-miss paths", () => {
    const packageRoot =
      "/opt/homebrew/lib/node_modules/foo/node_modules/code-helm";

    const result = resolveInstalledPackageManager({ packageRoot });

    expect(result).toEqual({
      kind: "unknown",
      command: undefined,
      packageRoot,
    });
  });

  test("detects bun installs from canonical global package paths", () => {
    const packageRoot =
      "/Users/example/.bun/install/global/node_modules/code-helm";

    const result = resolveInstalledPackageManager({ packageRoot });

    expect(result).toEqual({
      kind: "bun",
      command: ["bun", "add", "-g", "code-helm@latest"],
      executableName: "bun",
      packageRoot,
    });
  });

  test("returns unknown for bun-shaped near-miss package roots", () => {
    const packageRoot =
      "/tmp/not-global/.bun/install/global/node_modules/code-helm";

    const result = resolveInstalledPackageManager({ packageRoot });

    expect(result).toEqual({
      kind: "unknown",
      command: undefined,
      packageRoot,
    });
  });

  test("detects bun installs from the global bun executable path when the resolved realpath is canonical", () => {
    const executablePath = "/Users/example/.bun/bin/code-helm";
    const resolvedPackageRoot =
      "/Users/example/.bun/install/global/node_modules/code-helm";
    const resolvedExecutablePath = `${resolvedPackageRoot}/bin/code-helm`;

    const result = resolveInstalledPackageManager({
      executablePath,
      resolveRealPath: () => resolvedExecutablePath,
    });

    expect(result).toEqual({
      kind: "bun",
      command: ["bun", "add", "-g", "code-helm@latest"],
      executableName: "bun",
      executablePath,
      packageRoot: resolvedPackageRoot,
    });
  });

  test("prefers canonical executable-path resolution over a non-canonical package root", () => {
    const packageRoot = "/srv/custom/code-helm";
    const executablePath = "/Users/example/.bun/bin/code-helm";
    const resolvedPackageRoot =
      "/Users/example/.bun/install/global/node_modules/code-helm";
    const resolvedExecutablePath = `${resolvedPackageRoot}/bin/code-helm`;

    const result = resolveInstalledPackageManager({
      packageRoot,
      executablePath,
      resolveRealPath: () => resolvedExecutablePath,
    });

    expect(result).toEqual({
      kind: "bun",
      command: ["bun", "add", "-g", "code-helm@latest"],
      executableName: "bun",
      executablePath,
      packageRoot: resolvedPackageRoot,
    });
  });

  test("detects npm installs from canonical executable realpaths before falling back to packageRoot", () => {
    const packageRoot = "/srv/custom/code-helm";
    const executablePath = "/Users/example/.nvm/versions/node/v22.17.0/bin/code-helm";
    const resolvedPackageRoot =
      "/Users/example/.nvm/versions/node/v22.17.0/lib/node_modules/code-helm";
    const resolvedExecutablePath = `${resolvedPackageRoot}/bin/code-helm`;

    const result = resolveInstalledPackageManager({
      packageRoot,
      executablePath,
      resolveRealPath: () => resolvedExecutablePath,
    });

    expect(result).toEqual({
      kind: "npm",
      command: ["npm", "install", "-g", "code-helm@latest"],
      executableName: "npm",
      executablePath,
      packageRoot: resolvedPackageRoot,
    });
  });

  test("returns unknown when the installed path does not match npm or bun conventions", () => {
    const packageRoot = "/srv/custom/code-helm";

    const result = resolveInstalledPackageManager({ packageRoot });

    expect(result).toEqual({
      kind: "unknown",
      command: undefined,
      packageRoot,
    });
  });
});

describe("readLatestPublishedVersion", () => {
  test("reads the latest version from npm registry metadata", async () => {
    const result = await readLatestPublishedVersion({
      fetch: async () =>
        new Response(
          JSON.stringify({
            "dist-tags": {
              latest: "0.2.1",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    expect(result).toBe("0.2.1");
  });

  test("throws a targeted error when the registry response is invalid", async () => {
    await expect(
      readLatestPublishedVersion({
        fetch: async () =>
          new Response(JSON.stringify({ "dist-tags": {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow(
      "Could not determine the latest published version for code-helm from the npm registry response.",
    );
  });
});

describe("checkForUpdates", () => {
  test("builds an npm update check result with install command preview", async () => {
    const tempRoot = createTempDir();
    const packageRoot = createInstalledPackage(tempRoot, "0.2.0");

    const result = await checkForUpdates({
      packageRoot,
      fetch: async () =>
        new Response(
          JSON.stringify({
            "dist-tags": {
              latest: "0.2.1",
            },
          }),
        ),
    });

    expect(result).toEqual({
      installedVersion: "0.2.0",
      latestVersion: "0.2.1",
      packageManager: {
        kind: "unknown",
        command: undefined,
        packageRoot,
      },
      updateAvailable: true,
    });
  });

  test("builds an npm command preview when the package root matches npm conventions", async () => {
    const packageRoot =
      "/Users/example/.nvm/versions/node/v22.17.0/lib/node_modules/code-helm";

    const result = await checkForUpdates({
      packageRoot,
      fetch: async () =>
        new Response(
          JSON.stringify({
            "dist-tags": {
              latest: "0.2.1",
            },
          }),
        ),
      readPackageMetadataFromPath: () => ({
        name: "code-helm",
        version: "0.2.0",
      }),
    });

    expect(result).toEqual({
      installedVersion: "0.2.0",
      latestVersion: "0.2.1",
      packageManager: {
        kind: "npm",
        command: ["npm", "install", "-g", "code-helm@latest"],
        executableName: "npm",
        packageRoot,
      },
      updateAvailable: true,
    });
  });

  test("builds a bun command preview when the package root matches bun conventions", async () => {
    const packageRoot =
      "/Users/example/.bun/install/global/node_modules/code-helm";

    const result = await checkForUpdates({
      packageRoot,
      fetch: async () =>
        new Response(
          JSON.stringify({
            "dist-tags": {
              latest: "0.2.1",
            },
          }),
        ),
      readPackageMetadataFromPath: () => ({
        name: "code-helm",
        version: "0.2.0",
      }),
    });

    expect(result).toEqual({
      installedVersion: "0.2.0",
      latestVersion: "0.2.1",
      packageManager: {
        kind: "bun",
        command: ["bun", "add", "-g", "code-helm@latest"],
        executableName: "bun",
        packageRoot,
      },
      updateAvailable: true,
    });
  });

  test("reads installed metadata from the resolved canonical install root when provenance is more authoritative", async () => {
    const packageRoot = "/srv/custom/code-helm";
    const executablePath = "/Users/example/.bun/bin/code-helm";
    const resolvedPackageRoot =
      "/Users/example/.bun/install/global/node_modules/code-helm";
    const readCalls: string[] = [];

    const result = await checkForUpdates({
      packageRoot,
      executablePath,
      fetch: async () =>
        new Response(
          JSON.stringify({
            "dist-tags": {
              latest: "0.2.1",
            },
          }),
        ),
      readPackageMetadataFromPath: (targetPath) => {
        readCalls.push(targetPath);
        return {
          name: "code-helm",
          version: "0.2.0",
        };
      },
      resolveRealPath: () => `${resolvedPackageRoot}/bin/code-helm`,
    });

    expect(readCalls).toEqual([resolvedPackageRoot]);
    expect(result).toEqual({
      installedVersion: "0.2.0",
      latestVersion: "0.2.1",
      packageManager: {
        kind: "bun",
        command: ["bun", "add", "-g", "code-helm@latest"],
        executableName: "bun",
        executablePath,
        packageRoot: resolvedPackageRoot,
      },
      updateAvailable: true,
    });
  });

  test("does not mark an update available when installed is newer than latest", async () => {
    const packageRoot =
      "/Users/example/.bun/install/global/node_modules/code-helm";

    const result = await checkForUpdates({
      packageRoot,
      fetch: async () =>
        new Response(
          JSON.stringify({
            "dist-tags": {
              latest: "0.2.1",
            },
          }),
        ),
      readPackageMetadataFromPath: () => ({
        name: "code-helm",
        version: "0.2.2",
      }),
    });

    expect(result).toEqual({
      installedVersion: "0.2.2",
      latestVersion: "0.2.1",
      packageManager: {
        kind: "bun",
        command: ["bun", "add", "-g", "code-helm@latest"],
        executableName: "bun",
        packageRoot,
      },
      updateAvailable: false,
    });
  });

  test("treats prerelease versions as older than the matching stable release", async () => {
    const packageRoot =
      "/Users/example/.bun/install/global/node_modules/code-helm";

    const result = await checkForUpdates({
      packageRoot,
      fetch: async () =>
        new Response(
          JSON.stringify({
            "dist-tags": {
              latest: "1.2.3",
            },
          }),
        ),
      readPackageMetadataFromPath: () => ({
        name: "code-helm",
        version: "1.2.3-beta.1",
      }),
    });

    expect(result).toEqual({
      installedVersion: "1.2.3-beta.1",
      latestVersion: "1.2.3",
      packageManager: {
        kind: "bun",
        command: ["bun", "add", "-g", "code-helm@latest"],
        executableName: "bun",
        packageRoot,
      },
      updateAvailable: true,
    });
  });

  test("rejects when the installed version is not valid semver", async () => {
    const packageRoot =
      "/Users/example/.bun/install/global/node_modules/code-helm";

    await expect(
      checkForUpdates({
        packageRoot,
        fetch: async () =>
          new Response(
            JSON.stringify({
              "dist-tags": {
                latest: "1.2.3",
              },
            }),
          ),
        readPackageMetadataFromPath: () => ({
          name: "code-helm",
          version: "wat",
        }),
      }),
    ).rejects.toThrow("Invalid semantic version: wat");
  });

  test("rejects when the latest registry version is not valid semver", async () => {
    const packageRoot =
      "/Users/example/.bun/install/global/node_modules/code-helm";

    await expect(
      checkForUpdates({
        packageRoot,
        fetch: async () =>
          new Response(
            JSON.stringify({
              "dist-tags": {
                latest: "nope",
              },
            }),
          ),
        readPackageMetadataFromPath: () => ({
          name: "code-helm",
          version: "1.2.3",
        }),
      }),
    ).rejects.toThrow("Invalid semantic version: nope");
  });

  test("accepts build metadata and ignores it for precedence", async () => {
    const packageRoot =
      "/Users/example/.bun/install/global/node_modules/code-helm";

    const result = await checkForUpdates({
      packageRoot,
      fetch: async () =>
        new Response(
          JSON.stringify({
            "dist-tags": {
              latest: "1.2.3",
            },
          }),
        ),
      readPackageMetadataFromPath: () => ({
        name: "code-helm",
        version: "1.2.3+build.1",
      }),
    });

    expect(result).toEqual({
      installedVersion: "1.2.3+build.1",
      latestVersion: "1.2.3",
      packageManager: {
        kind: "bun",
        command: ["bun", "add", "-g", "code-helm@latest"],
        executableName: "bun",
        packageRoot,
      },
      updateAvailable: false,
    });
  });
});
