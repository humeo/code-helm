import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfigStore,
  loadStoredConfig,
  loadStoredSecrets,
  saveStoredConfig,
  saveStoredSecrets,
  type StoredConfig,
  type StoredSecrets,
} from "../../src/cli/config-store";
import { resolveCodeHelmPaths } from "../../src/cli/paths";

const tempDirs: string[] = [];

const createTempDir = () => {
  const directory = mkdtempSync(join(tmpdir(), "codehelm-store-"));
  tempDirs.push(directory);
  return directory;
};

const createStoredConfig = (): StoredConfig => ({
  discord: {
    guildId: "guild-1",
    controlChannelId: "channel-1",
  },
  codex: {
    appServerMode: "managed",
  },
  database: {
    path: "/tmp/codehelm.sqlite",
  },
});

const createStoredSecrets = (): StoredSecrets => ({
  discord: {
    botToken: "bot-token-1",
  },
});

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveCodeHelmPaths", () => {
  test("expands the default config, secrets, database, and state paths under the home directory", () => {
    const homeDir = createTempDir();

    expect(resolveCodeHelmPaths({ homeDir })).toEqual({
      configPath: join(homeDir, ".config", "code-helm", "config.toml"),
      secretsPath: join(homeDir, ".config", "code-helm", "secrets.toml"),
      databasePath: join(homeDir, ".local", "share", "code-helm", "codehelm.sqlite"),
      stateDir: `${join(homeDir, ".local", "state", "code-helm")}/`,
    });
  });

  test("honors CODE_HELM_DATABASE_PATH overrides", () => {
    const homeDir = createTempDir();

    expect(resolveCodeHelmPaths({
      env: {
        CODE_HELM_DATABASE_PATH: "~/custom/codehelm.sqlite",
      },
      homeDir,
    }).databasePath).toBe(join(homeDir, "custom", "codehelm.sqlite"));
  });
});

describe("config-store", () => {
  test("saves and loads config.toml", () => {
    const directory = createTempDir();
    const configPath = join(directory, "config.toml");
    const storedConfig = createStoredConfig();

    saveStoredConfig(storedConfig, { configPath });

    expect(existsSync(configPath)).toBe(true);
    expect(loadStoredConfig({ configPath })).toEqual(storedConfig);
    const rawConfig = readFileSync(configPath, "utf8");
    expect(rawConfig).toContain('appServerMode = "managed"');
    expect(rawConfig).toContain('path = "/tmp/codehelm.sqlite"');
    expect(rawConfig).not.toContain("[internal]");
  });

  test("saves and loads secrets.toml", () => {
    const directory = createTempDir();
    const secretsPath = join(directory, "secrets.toml");
    const storedSecrets = createStoredSecrets();

    saveStoredSecrets(storedSecrets, { secretsPath });

    expect(existsSync(secretsPath)).toBe(true);
    expect(loadStoredSecrets({ secretsPath })).toEqual(storedSecrets);
    if (process.platform !== "win32") {
      expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
    }
  });

  test("uses CODE_HELM_CONFIG and CODE_HELM_SECRETS for edit-mode path resolution", () => {
    const directory = createTempDir();
    const configPath = join(directory, "override-config.toml");
    const secretsPath = join(directory, "override-secrets.toml");

    saveStoredConfig(createStoredConfig(), { configPath });
    saveStoredSecrets(createStoredSecrets(), { secretsPath });

    const store = loadConfigStore({
      env: {
        CODE_HELM_CONFIG: configPath,
        CODE_HELM_SECRETS: secretsPath,
      },
      mode: "edit",
    });

    expect(store.paths.configPath).toBe(configPath);
    expect(store.paths.secretsPath).toBe(secretsPath);
    expect(store.config?.discord.guildId).toBe("guild-1");
    expect(store.secrets).toEqual(createStoredSecrets());
  });

  test("reads existing config and secrets in edit mode", () => {
    const directory = createTempDir();
    const configPath = join(directory, "config.toml");
    const secretsPath = join(directory, "secrets.toml");
    const storedConfig = createStoredConfig();
    const storedSecrets = createStoredSecrets();

    saveStoredConfig(storedConfig, { configPath });
    saveStoredSecrets(storedSecrets, { secretsPath });

    const store = loadConfigStore({
      env: {
        CODE_HELM_CONFIG: configPath,
        CODE_HELM_SECRETS: secretsPath,
      },
      mode: "edit",
    });

    expect(store.config).toEqual(storedConfig);
    expect(store.secrets).toEqual(storedSecrets);
  });

  test("ignores daemon compatibility fields when reading existing config.toml", () => {
    const directory = createTempDir();
    const configPath = join(directory, "config.toml");

    const rawConfig = `
[discord]
guildId = "guild-1"
controlChannelId = "channel-1"

[codex]
appServerMode = "managed"

[database]
path = "/tmp/codehelm.sqlite"

[internal]
discordAppId = "app-1"
codexAppServerUrl = "ws://127.0.0.1:4090"
`;

    writeFileSync(configPath, rawConfig, "utf8");

    expect(loadStoredConfig({ configPath })).toEqual(createStoredConfig());
  });

  test("create mode resolves paths without reading existing files", () => {
    const directory = createTempDir();
    const configPath = join(directory, "config.toml");
    const secretsPath = join(directory, "secrets.toml");

    saveStoredConfig(createStoredConfig(), { configPath });
    saveStoredSecrets(createStoredSecrets(), { secretsPath });

    const store = loadConfigStore({
      env: {
        CODE_HELM_CONFIG: configPath,
        CODE_HELM_SECRETS: secretsPath,
      },
      mode: "create",
    });

    expect(store.paths.configPath).toBe(configPath);
    expect(store.paths.secretsPath).toBe(secretsPath);
    expect(store.config).toBeUndefined();
    expect(store.secrets).toBeUndefined();
  });
});
