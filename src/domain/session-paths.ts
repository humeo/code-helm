import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const normalizeWhitespace = (value: string) => {
  return value.replace(/\s+/g, " ").trim();
};

const isHiddenDirectoryName = (name: string) => {
  return name.startsWith(".") && name !== "." && name !== "..";
};

const pathContainsHiddenDirectory = (path: string) => {
  let currentPath = path;

  while (true) {
    const currentName = basename(currentPath);

    if (isHiddenDirectoryName(currentName)) {
      return true;
    }

    const parentPath = dirname(currentPath);

    if (parentPath === currentPath) {
      return false;
    }

    currentPath = parentPath;
  }
};

export const normalizeSessionPathInput = (
  value: string,
  homeDir: string = homedir(),
) => {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error("Session path must not be empty");
  }

  if (trimmed.startsWith("~")) {
    if (trimmed === "~") {
      const resolvedHomeDir = resolve(homeDir);

      if (pathContainsHiddenDirectory(resolvedHomeDir)) {
        throw new Error("Session path must not include hidden directories");
      }

      return resolvedHomeDir;
    }

    if (!trimmed.startsWith("~/")) {
      throw new Error("Session path must be absolute or start with ~/");
    }

    const resolvedPath = resolve(homeDir, trimmed.slice(2));

    if (pathContainsHiddenDirectory(resolvedPath)) {
      throw new Error("Session path must not include hidden directories");
    }

    return resolvedPath;
  }

  if (!isAbsolute(trimmed)) {
    throw new Error("Session path must be absolute or start with ~/");
  }

  const resolvedPath = resolve(trimmed);

  if (pathContainsHiddenDirectory(resolvedPath)) {
    throw new Error("Session path must not include hidden directories");
  }

  return resolvedPath;
};

export const formatSessionPathForDisplay = (
  value: string,
  homeDir: string = homedir(),
) => {
  const normalizedHomeDir = resolve(homeDir);
  const normalizedPath = resolve(value);
  const homeRelativePath = relative(normalizedHomeDir, normalizedPath);

  if (homeRelativePath === "") {
    return "~";
  }

  if (
    homeRelativePath.length > 0
    && !homeRelativePath.startsWith("..")
    && !isAbsolute(homeRelativePath)
  ) {
    return `~/${homeRelativePath}`;
  }

  return normalizedPath;
};

export const formatSessionPathForAutocompleteValue = (
  value: string,
  homeDir: string = homedir(),
  trailingSlash: boolean = false,
) => {
  const displayPath = formatSessionPathForDisplay(value, homeDir);

  if (!trailingSlash || displayPath === "~" || displayPath.endsWith("/")) {
    return displayPath;
  }

  return `${displayPath}/`;
};

export const normalizeBootstrapThreadTitle = (value: string) => {
  const normalized = normalizeWhitespace(value);

  return normalized.length > 0 ? normalized : null;
};
