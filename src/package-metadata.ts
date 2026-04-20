import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type PackageMetadata = {
  name: string;
  version: string;
};

let cachedPackageMetadata: PackageMetadata | undefined;

export const readPackageMetadata = (): PackageMetadata => {
  if (cachedPackageMetadata) {
    return cachedPackageMetadata;
  }

  const rawPackageJson = readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8",
  );
  const parsed = JSON.parse(rawPackageJson) as {
    name?: unknown;
    version?: unknown;
  };

  cachedPackageMetadata = {
    name: typeof parsed.name === "string" ? parsed.name : "code-helm",
    version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
  };

  return cachedPackageMetadata;
};
