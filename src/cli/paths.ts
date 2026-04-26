import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG_PATH = "~/.config/code-helm/config.toml";
const DEFAULT_SECRETS_PATH = "~/.config/code-helm/secrets.toml";
const DEFAULT_DATABASE_PATH = "~/.local/share/code-helm/codehelm.sqlite";
const DEFAULT_STATE_DIR = "~/.local/state/code-helm/";
const DEFAULT_APP_SERVER_WORKDIR = "~/.codehelm/workdir";

export type CodeHelmPathEnv = Record<string, string | undefined>;

export type CodeHelmPaths = {
  configPath: string;
  secretsPath: string;
  databasePath: string;
  stateDir: string;
  logDir: string;
  appServerWorkdir: string;
};

export const expandHomePath = (value: string, homeDir = homedir()) => {
  if (value === "~") {
    return homeDir;
  }

  if (value.startsWith("~/")) {
    return join(homeDir, value.slice(2));
  }

  return value;
};

export const resolveCodeHelmPaths = (
  options: {
    env?: CodeHelmPathEnv;
    homeDir?: string;
  } = {},
): CodeHelmPaths => {
  const env = options.env ?? {};
  const homeDir = options.homeDir ?? homedir();

  const stateDir = expandHomePath(DEFAULT_STATE_DIR, homeDir);

  return {
    configPath: expandHomePath(env.CODE_HELM_CONFIG ?? DEFAULT_CONFIG_PATH, homeDir),
    secretsPath: expandHomePath(env.CODE_HELM_SECRETS ?? DEFAULT_SECRETS_PATH, homeDir),
    databasePath: expandHomePath(env.CODE_HELM_DATABASE_PATH ?? DEFAULT_DATABASE_PATH, homeDir),
    stateDir,
    logDir: expandHomePath(env.CODE_HELM_LOG_DIR ?? join(stateDir, "logs"), homeDir),
    appServerWorkdir: expandHomePath(DEFAULT_APP_SERVER_WORKDIR, homeDir),
  };
};
