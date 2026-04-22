import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type PackageMetadata = {
  name: string;
  version: string;
};

let cachedPackageMetadata: PackageMetadata | undefined;

export const readPackageMetadataFromFile = (packageJsonPath: string): PackageMetadata => {
  const rawPackageJson = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(rawPackageJson) as {
    name?: unknown;
    version?: unknown;
  };

  return {
    name: typeof parsed.name === "string" ? parsed.name : "code-helm",
    version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
  };
};

export const readPackageMetadata = (): PackageMetadata => {
  if (cachedPackageMetadata) {
    return cachedPackageMetadata;
  }

  cachedPackageMetadata = readPackageMetadataFromFile(
    fileURLToPath(new URL("../package.json", import.meta.url)),
  );

  return cachedPackageMetadata;
};
