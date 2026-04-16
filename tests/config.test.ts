import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveStoredConfig,
  saveStoredSecrets,
  type StoredConfig,
  type StoredSecrets,
} from "../src/cli/config-store";
import {
  DEFAULT_CODEX_APP_SERVER_URL,
  DEFAULT_DISCORD_APP_ID,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  assertOperationalConfigReady,
  loadAppConfig,
  parseConfig,
} from "../src/config";

const tempDirs: string[] = [];
const STORED_DISCORD_APP_ID = "123456789012345678";
const OVERRIDE_DISCORD_APP_ID = "987654321098765432";
const STORED_BOT_TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.stored.secret";
const OVERRIDE_BOT_TOKEN = "OTg3NjU0MzIxMDk4NzY1NDMy.override.secret";

const createTempDir = () => {
  const directory = mkdtempSync(join(tmpdir(), "codehelm-config-"));
  tempDirs.push(directory);
  return directory;
};

const createStoredConfig = (): StoredConfig => ({
  discord: {
    guildId: "stored-guild",
    controlChannelId: "stored-channel",
  },
  codex: {
    appServerMode: "managed",
  },
  database: {
    path: "/tmp/stored-codehelm.sqlite",
  },
});

const createStoredSecrets = (): StoredSecrets => ({
  discord: {
    botToken: STORED_BOT_TOKEN,
  },
});

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadAppConfig", () => {
  test("builds an AppConfig from stored config and stored secrets", () => {
    const directory = createTempDir();
    const configPath = join(directory, "config.toml");
    const secretsPath = join(directory, "secrets.toml");

    saveStoredConfig(createStoredConfig(), { configPath });
    saveStoredSecrets(createStoredSecrets(), { secretsPath });

    const config = loadAppConfig({
      CODE_HELM_CONFIG: configPath,
      CODE_HELM_SECRETS: secretsPath,
    });

    expect(config.discord.guildId).toBe("stored-guild");
    expect(config.discord.controlChannelId).toBe("stored-channel");
    expect(config.discord.botToken).toBe(STORED_BOT_TOKEN);
    expect(config.codex.appServerUrl).toBe(DEFAULT_CODEX_APP_SERVER_URL);
    expect(config.databasePath).toBe("/tmp/stored-codehelm.sqlite");
    expect(config.DISCORD_APP_ID).toBe(STORED_DISCORD_APP_ID);
    expect(config.discord.appId).toBe(STORED_DISCORD_APP_ID);
    expect(config.workspace).toEqual({
      id: DEFAULT_WORKSPACE_ID,
      name: DEFAULT_WORKSPACE_NAME,
    });
  });

  test("lets CODE_HELM overrides win over stored files", () => {
    const directory = createTempDir();
    const configPath = join(directory, "config.toml");
    const secretsPath = join(directory, "secrets.toml");

    saveStoredConfig(createStoredConfig(), { configPath });
    saveStoredSecrets(createStoredSecrets(), { secretsPath });

    const config = loadAppConfig({
      CODE_HELM_CONFIG: configPath,
      CODE_HELM_SECRETS: secretsPath,
      CODE_HELM_DISCORD_GUILD_ID: "override-guild",
      CODE_HELM_DISCORD_CONTROL_CHANNEL_ID: "override-channel",
      CODE_HELM_DISCORD_BOT_TOKEN: OVERRIDE_BOT_TOKEN,
      CODE_HELM_CODEX_APP_SERVER_URL: "wss://example.com/codex",
      CODE_HELM_DATABASE_PATH: "/tmp/override-codehelm.sqlite",
    });

    expect(config.discord.guildId).toBe("override-guild");
    expect(config.discord.controlChannelId).toBe("override-channel");
    expect(config.discord.botToken).toBe(OVERRIDE_BOT_TOKEN);
    expect(config.codex.appServerUrl).toBe("wss://example.com/codex");
    expect(config.databasePath).toBe("/tmp/override-codehelm.sqlite");
    expect(config.DISCORD_APP_ID).toBe(OVERRIDE_DISCORD_APP_ID);
  });

  test("keeps the daemon compatibility bridge values required by the runtime", () => {
    const directory = createTempDir();
    const configPath = join(directory, "config.toml");
    const secretsPath = join(directory, "secrets.toml");

    saveStoredConfig(createStoredConfig(), { configPath });
    saveStoredSecrets(createStoredSecrets(), { secretsPath });

    const config = parseConfig({
      CODE_HELM_CONFIG: configPath,
      CODE_HELM_SECRETS: secretsPath,
    });

    expect(config.discord.guildId).toBe("stored-guild");
    expect(config.discord.controlChannelId).toBe("stored-channel");
    expect(config.discord.botToken).toBe(STORED_BOT_TOKEN);
    expect(config.codex.appServerUrl).toBe(DEFAULT_CODEX_APP_SERVER_URL);
    expect(config.databasePath).toBe("/tmp/stored-codehelm.sqlite");
    expect(config.DISCORD_APP_ID).toBe(STORED_DISCORD_APP_ID);
    expect(config.discord.appId).toBe(STORED_DISCORD_APP_ID);
    expect(config.workspace).toEqual({
      id: DEFAULT_WORKSPACE_ID,
      name: DEFAULT_WORKSPACE_NAME,
    });
  });

  test("operational guard rejects placeholder Codex app server URLs", () => {
    const directory = createTempDir();
    const configPath = join(directory, "config.toml");
    const secretsPath = join(directory, "secrets.toml");

    saveStoredConfig(createStoredConfig(), { configPath });
    saveStoredSecrets(createStoredSecrets(), { secretsPath });

    const config = loadAppConfig({
      CODE_HELM_CONFIG: configPath,
      CODE_HELM_SECRETS: secretsPath,
    });

    expect(() => assertOperationalConfigReady(config)).toThrow(/CODEX_APP_SERVER_URL/);
  });

  test("operational guard rejects unresolved Discord app ids", () => {
    const directory = createTempDir();
    const configPath = join(directory, "config.toml");
    const secretsPath = join(directory, "secrets.toml");

    saveStoredConfig(createStoredConfig(), { configPath });
    saveStoredSecrets({
      discord: {
        botToken: "not-a-discord-token",
      },
    }, { secretsPath });

    const config = loadAppConfig({
      CODE_HELM_CONFIG: configPath,
      CODE_HELM_SECRETS: secretsPath,
      CODEX_APP_SERVER_URL: "ws://127.0.0.1:4090",
    });

    expect(config.DISCORD_APP_ID).toBe(DEFAULT_DISCORD_APP_ID);
    expect(() => assertOperationalConfigReady(config)).toThrow(/DISCORD_APP_ID/);
  });

  test("operational guard allows runtime-ready config", () => {
    const directory = createTempDir();
    const configPath = join(directory, "config.toml");
    const secretsPath = join(directory, "secrets.toml");

    saveStoredConfig(createStoredConfig(), { configPath });
    saveStoredSecrets(createStoredSecrets(), { secretsPath });

    const config = loadAppConfig({
      CODE_HELM_CONFIG: configPath,
      CODE_HELM_SECRETS: secretsPath,
      CODEX_APP_SERVER_URL: "ws://127.0.0.1:4090",
    });

    expect(() => assertOperationalConfigReady(config)).not.toThrow();
  });
});
