import { readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import {
  formatSessionPathForAutocompleteValue,
  formatSessionPathForDisplay,
  isHiddenDirectoryName,
  normalizeSessionPathInput,
  pathContainsHiddenDirectory,
} from "./session-paths";

export type PathBrowserChoice = {
  name: string;
  value: string;
};

type PathBrowserFs = {
  readdirSync(
    path: string,
    options: {
      withFileTypes: true;
    },
  ): Array<Pick<Dirent, "name" | "isDirectory">>;
  statSync(path: string): {
    isDirectory(): boolean;
  };
};

type ResolvePathBrowserStateInput = {
  inputPath?: string;
  homeDir?: string;
  fs?: PathBrowserFs;
};

type ListPathBrowserDirectoryChoicesInput = {
  currentPath: string;
  homeDir?: string;
  fs?: PathBrowserFs;
  limit?: number;
};

type BuildPathBrowserChoicesInput = {
  inputPath?: string;
  homeDir?: string;
  fs?: PathBrowserFs;
  limit?: number;
};

type PathBrowserState = {
  currentPath: string;
  currentLabel: string;
  currentValue: string;
  parentValue: string | null;
};

const defaultPathBrowserFs: PathBrowserFs = {
  readdirSync,
  statSync,
};

const defaultPathBrowserChoiceLimit = 25;
const directorySortCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
const currentDirectoryChoiceName = ".";
const parentDirectoryChoiceName = "..";

const isReadableDirectory = (path: string, fs: PathBrowserFs) => {
  try {
    if (!fs.statSync(path).isDirectory()) {
      return false;
    }

    fs.readdirSync(path, { withFileTypes: true });
    return true;
  } catch {
    return false;
  }
};

const normalizeRequestedBrowserPath = ({
  inputPath,
  homeDir,
}: {
  inputPath?: string;
  homeDir: string;
}) => {
  if (!inputPath || inputPath.trim().length === 0) {
    return normalizeSessionPathInput("~", homeDir);
  }

  try {
    return normalizeSessionPathInput(inputPath, homeDir);
  } catch {
    return normalizeSessionPathInput("~", homeDir);
  }
};

const isPathWithinHome = (path: string, homeDir: string) => {
  const homeRelativePath = relative(homeDir, path);

  return (
    homeRelativePath === ""
    || (
      homeRelativePath.length > 0
      && !homeRelativePath.startsWith("..")
      && !isAbsolute(homeRelativePath)
    )
  );
};

export const resolvePathBrowserState = ({
  inputPath,
  homeDir = homedir(),
  fs = defaultPathBrowserFs,
}: ResolvePathBrowserStateInput): PathBrowserState | null => {
  const normalizedHomeDir = normalizeSessionPathInput("~", homeDir);
  const requestedPath = normalizeRequestedBrowserPath({
    inputPath,
    homeDir: normalizedHomeDir,
  });
  const shouldStayWithinHome = isPathWithinHome(requestedPath, normalizedHomeDir);
  let candidatePath = requestedPath;

  while (
    !isReadableDirectory(candidatePath, fs)
    || (
      candidatePath !== normalizedHomeDir
      && pathContainsHiddenDirectory(candidatePath)
    )
  ) {
    if (shouldStayWithinHome && candidatePath === normalizedHomeDir) {
      return null;
    }

    const parentPath = dirname(candidatePath);

    if (parentPath === candidatePath) {
      return null;
    }

    candidatePath = parentPath;
  }

  const currentLabel = formatSessionPathForDisplay(candidatePath, normalizedHomeDir);
  const currentValue = formatSessionPathForAutocompleteValue(
    candidatePath,
    normalizedHomeDir,
  );
  const parentPath = dirname(candidatePath);
  const parentValue =
    currentLabel === "~" || parentPath === candidatePath
      ? null
      : formatSessionPathForAutocompleteValue(parentPath, normalizedHomeDir, true);

  return {
    currentPath: candidatePath,
    currentLabel,
    currentValue,
    parentValue,
  };
};

export const listPathBrowserDirectoryChoices = ({
  currentPath,
  homeDir = homedir(),
  fs = defaultPathBrowserFs,
  limit = defaultPathBrowserChoiceLimit,
}: ListPathBrowserDirectoryChoicesInput): PathBrowserChoice[] => {
  const state = resolvePathBrowserState({
    inputPath: currentPath,
    homeDir,
    fs,
  });

  if (!state || limit <= 0) {
    return [];
  }

  const choices: PathBrowserChoice[] = [
    {
      name: currentDirectoryChoiceName,
      value: state.currentValue,
    },
  ];

  if (state.parentValue) {
    choices.push({
      name: parentDirectoryChoiceName,
      value: state.parentValue,
    });
  }

  if (choices.length >= limit) {
    return choices.slice(0, limit);
  }

  let entries: Array<Pick<Dirent, "name" | "isDirectory">>;

  try {
    entries = fs.readdirSync(state.currentPath, { withFileTypes: true });
  } catch {
    return choices;
  }

  const childChoices = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !isHiddenDirectoryName(entry.name))
    .sort((left, right) => directorySortCollator.compare(left.name, right.name))
    .map((entry) => ({
      entry,
      childPath: join(state.currentPath, entry.name),
    }))
    .filter(({ childPath }) => isReadableDirectory(childPath, fs))
    .map(({ entry, childPath }) => ({
      name: `${entry.name}/`,
      value: formatSessionPathForAutocompleteValue(childPath, homeDir, true),
    }));

  return choices.concat(childChoices).slice(0, limit);
};

export const buildPathBrowserChoices = ({
  inputPath,
  homeDir = homedir(),
  fs = defaultPathBrowserFs,
  limit = defaultPathBrowserChoiceLimit,
}: BuildPathBrowserChoicesInput): PathBrowserChoice[] => {
  const state = resolvePathBrowserState({
    inputPath,
    homeDir,
    fs,
  });

  if (!state) {
    return [];
  }

  return listPathBrowserDirectoryChoices({
    currentPath: state.currentPath,
    homeDir,
    fs,
    limit,
  });
};
