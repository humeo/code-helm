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
  if (packageRoot.endsWith(`/.bun/install/global/node_modules/${PACKAGE_NAME}`)) {
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
      packageRoot.includes("/.nvm/versions/node/") ||
      packageRoot.startsWith("/opt/homebrew/lib/node_modules/") ||
      packageRoot.startsWith("/usr/local/lib/node_modules/")
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
  const marker = `/.bun/install/global/node_modules/${PACKAGE_NAME}`;
  const markerIndex = resolvedPath.indexOf(marker);

  if (markerIndex === -1) {
    return undefined;
  }

  return resolvedPath.slice(0, markerIndex + marker.length);
};

export const readInstalledPackageMetadataFromPath = (packageRoot: string) => {
  return readPackageMetadataFromFile(join(packageRoot, "package.json"));
};

export const resolveInstalledPackageManager = ({
  packageRoot,
  executablePath,
  resolveRealPath = realpathSync,
}: ResolveInstalledPackageManagerOptions): PackageManagerResolution => {
  if (packageRoot) {
    return resolvePackageManagerFromPackageRoot(packageRoot);
  }

  if (!executablePath) {
    return {
      kind: "unknown",
      command: undefined,
    };
  }

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
    updateAvailable: installedMetadata.version !== latestVersion,
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
