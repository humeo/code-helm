import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
  readPackageMetadataFromFile,
  type PackageMetadata,
} from "../package-metadata";

const PACKAGE_NAME = "code-helm";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;

export type InstallSourceKind = "npm" | "bun" | "unknown";

export type PackageManagerResolution = {
  kind: InstallSourceKind;
  command: string[] | undefined;
  executableName?: "npm" | "bun";
  packageRoot?: string;
  executablePath?: string;
};

export type UpdateCheckResult = {
  installedVersion: string;
  latestVersion: string;
  packageManager: PackageManagerResolution;
  updateAvailable: boolean;
};

export type PackageUpdateExecutionResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ReadLatestPublishedVersionOptions = {
  fetch?: FetchLike;
};

type ResolveInstalledPackageManagerOptions = {
  packageRoot?: string;
  executablePath?: string;
  resolveRealPath?: (targetPath: string) => string;
};

type CheckForUpdatesOptions = {
  packageRoot: string;
  executablePath?: string;
  fetch?: FetchLike;
  readPackageMetadataFromPath?: (packageRoot: string) => PackageMetadata;
};

const buildInstallCommand = (
  kind: Exclude<InstallSourceKind, "unknown">,
) => {
  if (kind === "bun") {
    return ["bun", "add", "-g", `${PACKAGE_NAME}@latest`];
  }

  return ["npm", "install", "-g", `${PACKAGE_NAME}@latest`];
};

const resolvePackageManagerFromPackageRoot = (
  packageRoot: string,
): PackageManagerResolution => {
  const canonicalBunGlobalPackagePathPattern =
    /^\/Users\/[^/]+\/\.bun\/install\/global\/node_modules\/code-helm$/u;
  const isCanonicalNvmGlobalPackagePath =
    /^\/Users\/[^/]+\/\.nvm\/versions\/node\/[^/]+\/lib\/node_modules\/code-helm$/u
      .test(packageRoot);
  const isCanonicalBunGlobalPackagePath =
    canonicalBunGlobalPackagePathPattern.test(packageRoot);
  const isCanonicalHomebrewGlobalPackagePath =
    packageRoot === `/opt/homebrew/lib/node_modules/${PACKAGE_NAME}`;
  const isCanonicalUsrLocalGlobalPackagePath =
    packageRoot === `/usr/local/lib/node_modules/${PACKAGE_NAME}`;

  if (isCanonicalBunGlobalPackagePath) {
    return {
      kind: "bun",
      command: buildInstallCommand("bun"),
      executableName: "bun",
      packageRoot,
    };
  }

  if (
    packageRoot.endsWith(`/node_modules/${PACKAGE_NAME}`) &&
    (
      isCanonicalNvmGlobalPackagePath ||
      isCanonicalHomebrewGlobalPackagePath ||
      isCanonicalUsrLocalGlobalPackagePath
    )
  ) {
    return {
      kind: "npm",
      command: buildInstallCommand("npm"),
      executableName: "npm",
      packageRoot,
    };
  }

  return {
    kind: "unknown",
    command: undefined,
    packageRoot,
  };
};

const resolveBunPackageRootFromExecutablePath = (resolvedPath: string) => {
  const match =
    resolvedPath.match(
      /^((?:\/Users\/[^/]+\/\.bun\/install\/global\/node_modules\/code-helm))(?:\/.*)?$/u,
    );

  return match?.[1];
};

type ParsedSemanticVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const parseSemanticVersion = (value: string): ParsedSemanticVersion => {
  const match =
    value.match(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9A-Za-z-][0-9A-Za-z-]*))*))?$/u,
    );

  if (!match) {
    throw new Error(`Invalid semantic version: ${value}`);
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4]?.split(".") ?? [],
  };
};

const comparePrereleaseIdentifiers = (left: string, right: string) => {
  const numericPattern = /^(0|[1-9]\d*)$/u;
  const leftIsNumeric = numericPattern.test(left);
  const rightIsNumeric = numericPattern.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }

  if (leftIsNumeric) {
    return -1;
  }

  if (rightIsNumeric) {
    return 1;
  }

  return left.localeCompare(right);
};

const compareSemanticVersions = (left: string, right: string) => {
  const leftVersion = parseSemanticVersion(left);
  const rightVersion = parseSemanticVersion(right);

  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major - rightVersion.major;
  }

  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor - rightVersion.minor;
  }

  if (leftVersion.patch !== rightVersion.patch) {
    return leftVersion.patch - rightVersion.patch;
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) {
    return 0;
  }

  if (leftVersion.prerelease.length === 0) {
    return 1;
  }

  if (rightVersion.prerelease.length === 0) {
    return -1;
  }

  const maxLength = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length,
  );

  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];

    if (leftIdentifier === undefined) {
      return -1;
    }

    if (rightIdentifier === undefined) {
      return 1;
    }

    const comparison = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier);

    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
};

export const readInstalledPackageMetadataFromPath = (packageRoot: string) => {
  return readPackageMetadataFromFile(join(packageRoot, "package.json"));
};

export const resolveInstalledPackageManager = ({
  packageRoot,
  executablePath,
  resolveRealPath = realpathSync,
}: ResolveInstalledPackageManagerOptions): PackageManagerResolution => {
  if (executablePath) {
    let resolvedExecutablePath = executablePath;

    try {
      resolvedExecutablePath = resolveRealPath(executablePath);
    } catch {
      resolvedExecutablePath = executablePath;
    }

    const bunPackageRoot = resolveBunPackageRootFromExecutablePath(resolvedExecutablePath);

    if (bunPackageRoot) {
      return {
        kind: "bun",
        command: buildInstallCommand("bun"),
        executableName: "bun",
        executablePath,
        packageRoot: bunPackageRoot,
      };
    }
  }

  if (packageRoot) {
    return resolvePackageManagerFromPackageRoot(packageRoot);
  }

  return {
    kind: "unknown",
    command: undefined,
    executablePath,
  };
};

export const readLatestPublishedVersion = async ({
  fetch: fetchImpl = fetch,
}: ReadLatestPublishedVersionOptions = {}) => {
  let response: Response;

  try {
    response = await fetchImpl(REGISTRY_URL, {
      headers: {
        accept: "application/json",
      },
    });
  } catch (error) {
    throw new Error(
      `Could not determine the latest published version for ${PACKAGE_NAME} from the npm registry response.`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new Error(
      `Could not determine the latest published version for ${PACKAGE_NAME} from the npm registry response.`,
    );
  }

  const payload = await response.json().catch((error: unknown) => {
    throw new Error(
      `Could not determine the latest published version for ${PACKAGE_NAME} from the npm registry response.`,
      { cause: error },
    );
  });
  const parsedPayload = payload as {
    "dist-tags"?: {
      latest?: unknown;
    };
  };
  const latestVersion = parsedPayload["dist-tags"]?.latest;

  if (typeof latestVersion !== "string" || latestVersion.length === 0) {
    throw new Error(
      `Could not determine the latest published version for ${PACKAGE_NAME} from the npm registry response.`,
    );
  }

  return latestVersion;
};

export const checkForUpdates = async ({
  packageRoot,
  executablePath,
  fetch: fetchImpl,
  readPackageMetadataFromPath = readInstalledPackageMetadataFromPath,
}: CheckForUpdatesOptions): Promise<UpdateCheckResult> => {
  const installedMetadata = readPackageMetadataFromPath(packageRoot);
  const latestVersion = await readLatestPublishedVersion({ fetch: fetchImpl });
  const packageManager = resolveInstalledPackageManager({
    packageRoot,
    executablePath,
  });

  return {
    installedVersion: installedMetadata.version,
    latestVersion,
    packageManager,
    updateAvailable: compareSemanticVersions(installedMetadata.version, latestVersion) < 0,
  };
};

export const performPackageUpdate = (
  commandParts: string[],
  env: Record<string, string | undefined>,
): PackageUpdateExecutionResult => {
  const [command, ...args] = commandParts;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: env as Record<string, string>,
  });

  return {
    command: commandParts.join(" "),
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
};
