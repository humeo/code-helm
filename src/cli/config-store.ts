import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const writeTomlFile = (
  path: string,
  value: unknown,
  options: {
    mode?: number;
  } = {},
) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyToml(value as StringifiableToml), {
    encoding: "utf8",
    mode: options.mode,
  });

  if (options.mode !== undefined) {
    chmodSync(path, options.mode);
  }
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
  writeTomlFile(
    options.secretsPath,
    StoredSecretsSchema.parse(secrets),
    { mode: 0o600 },
  );
};

export const loadConfigStore = (
  options: {
    env?: CodeHelmPathEnv;
    homeDir?: string;
    mode?: ConfigStoreMode;
  } = {},
): LoadedConfigStore => {
  const env = options.env ?? {};
  const mode = options.mode ?? "edit";
  const paths = resolveCodeHelmPaths({
    env,
    homeDir: options.homeDir,
  });

  if (mode === "create") {
    return {
      paths,
    };
  }

  return {
    config: loadStoredConfig({ configPath: paths.configPath }),
    secrets: loadStoredSecrets({ secretsPath: paths.secretsPath }),
    paths,
  };
};
