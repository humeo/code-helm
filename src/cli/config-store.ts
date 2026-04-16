import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { resolveCodeHelmPaths, type CodeHelmPathEnv, type CodeHelmPaths } from "./paths";

type StringifiableToml = Parameters<typeof stringifyToml>[0];

const StoredConfigSchema = z.object({
  discord: z.object({
    guildId: z.string().min(1),
    controlChannelId: z.string().min(1),
  }),
  codex: z.object({
    appServerMode: z.literal("managed"),
  }),
  database: z.object({
    path: z.string().min(1),
  }),
  internal: z.object({
    discordAppId: z.string().min(1).optional(),
    codexAppServerUrl: z.string().min(1).optional(),
  }).optional(),
});

const StoredSecretsSchema = z.object({
  discord: z.object({
    botToken: z.string().min(1),
  }),
});

export type StoredConfig = z.infer<typeof StoredConfigSchema>;
export type StoredSecrets = z.infer<typeof StoredSecretsSchema>;
export type ConfigStoreMode = "create" | "edit";

export type LoadedConfigStore = {
  config?: StoredConfig;
  secrets?: StoredSecrets;
  paths: CodeHelmPaths;
};

const readTomlFile = <T>(path: string, schema: z.ZodType<T>) => {
  if (!existsSync(path)) {
    return undefined;
  }

  const content = readFileSync(path, "utf8");
  return schema.parse(parseToml(content));
};

const writeTomlFile = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyToml(value as StringifiableToml), "utf8");
};

export const loadStoredConfig = (
  options: {
    configPath: string;
  },
) => {
  return readTomlFile(options.configPath, StoredConfigSchema);
};

export const saveStoredConfig = (
  config: StoredConfig,
  options: {
    configPath: string;
  },
) => {
  writeTomlFile(options.configPath, StoredConfigSchema.parse(config));
};

export const loadStoredSecrets = (
  options: {
    secretsPath: string;
  },
) => {
  return readTomlFile(options.secretsPath, StoredSecretsSchema);
};

export const saveStoredSecrets = (
  secrets: StoredSecrets,
  options: {
    secretsPath: string;
  },
) => {
  writeTomlFile(options.secretsPath, StoredSecretsSchema.parse(secrets));
};

export const loadConfigStore = (
  options: {
    env?: CodeHelmPathEnv;
    homeDir?: string;
    mode?: ConfigStoreMode;
  } = {},
): LoadedConfigStore => {
  const env = options.env ?? {};
  const paths = resolveCodeHelmPaths({
    env,
    homeDir: options.homeDir,
  });

  const config = loadStoredConfig({ configPath: paths.configPath });
  const storedSecrets = loadStoredSecrets({ secretsPath: paths.secretsPath });
  const secrets = env.CODE_HELM_DISCORD_BOT_TOKEN
    ? StoredSecretsSchema.parse({
        ...storedSecrets,
        discord: {
          ...storedSecrets?.discord,
          botToken: env.CODE_HELM_DISCORD_BOT_TOKEN,
        },
      })
    : storedSecrets;

  return {
    config,
    secrets,
    paths,
  };
};
