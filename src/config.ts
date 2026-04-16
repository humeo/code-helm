import { z } from "zod";
import { loadStoredConfig, loadStoredSecrets } from "./cli/config-store";
import { expandHomePath, resolveCodeHelmPaths } from "./cli/paths";

const CodexAppServerUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  }, "CODEX_APP_SERVER_URL must use ws:// or wss://");

const ResolvedConfigSchema = z.object({
  discordBotToken: z.string().min(1),
  discordAppId: z.string().min(1),
  discordGuildId: z.string().min(1),
  discordControlChannelId: z.string().min(1),
  codexAppServerUrl: CodexAppServerUrlSchema,
  databasePath: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
});

export const DEFAULT_WORKSPACE_ID = "default-workspace";
export const DEFAULT_WORKSPACE_NAME = "CodeHelm";
export const DEFAULT_DISCORD_APP_ID = "code-helm-pending-app-id";
export const DEFAULT_CODEX_APP_SERVER_URL = "ws://127.0.0.1:0/code-helm-placeholder";

export type AppConfig = {
  DISCORD_APP_ID: string;
  discord: {
    botToken: string;
    appId: string;
    guildId: string;
    controlChannelId: string;
  };
  codex: {
    appServerUrl: string;
  };
  databasePath: string;
  workspace: {
    id: string;
    name: string;
  };
};

const decodeBase64Segment = (value: string) => {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
};

export const deriveDiscordAppIdFromBotToken = (token: string): string | undefined => {
  const [idSegment] = token.split(".", 1);

  if (!idSegment) {
    return undefined;
  }

  const decoded = decodeBase64Segment(idSegment)?.trim();

  if (!decoded || !/^\d+$/.test(decoded)) {
    return undefined;
  }

  return decoded;
};

const resolveAppConfigInput = (env: Record<string, string | undefined>) => {
  const paths = resolveCodeHelmPaths({ env });
  const storedConfig = loadStoredConfig({ configPath: paths.configPath });
  const storedSecrets = loadStoredSecrets({ secretsPath: paths.secretsPath });
  const resolvedBotToken = env.CODE_HELM_DISCORD_BOT_TOKEN
    ?? storedSecrets?.discord.botToken
    ?? env.DISCORD_BOT_TOKEN;
  const derivedDiscordAppId = resolvedBotToken
    ? deriveDiscordAppIdFromBotToken(resolvedBotToken)
    : undefined;

  return ResolvedConfigSchema.parse({
    discordBotToken: resolvedBotToken,
    discordAppId: env.DISCORD_APP_ID
      ?? derivedDiscordAppId
      ?? DEFAULT_DISCORD_APP_ID,
    discordGuildId: env.CODE_HELM_DISCORD_GUILD_ID
      ?? storedConfig?.discord.guildId
      ?? env.DISCORD_GUILD_ID,
    discordControlChannelId: env.CODE_HELM_DISCORD_CONTROL_CHANNEL_ID
      ?? storedConfig?.discord.controlChannelId
      ?? env.DISCORD_CONTROL_CHANNEL_ID,
    codexAppServerUrl: env.CODE_HELM_CODEX_APP_SERVER_URL
      ?? env.CODEX_APP_SERVER_URL
      ?? DEFAULT_CODEX_APP_SERVER_URL,
    databasePath: expandHomePath(
      env.CODE_HELM_DATABASE_PATH
        ?? storedConfig?.database.path
        ?? env.DATABASE_PATH
        ?? paths.databasePath,
    ),
    workspaceId: env.WORKSPACE_ID ?? DEFAULT_WORKSPACE_ID,
    workspaceName: env.WORKSPACE_NAME ?? DEFAULT_WORKSPACE_NAME,
  });
};

export const loadAppConfig = (env: Record<string, string | undefined>): AppConfig => {
  const resolved = resolveAppConfigInput(env);

  return {
    DISCORD_APP_ID: resolved.discordAppId,
    discord: {
      botToken: resolved.discordBotToken,
      appId: resolved.discordAppId,
      guildId: resolved.discordGuildId,
      controlChannelId: resolved.discordControlChannelId,
    },
    codex: {
      appServerUrl: resolved.codexAppServerUrl,
    },
    databasePath: resolved.databasePath,
    workspace: {
      id: resolved.workspaceId,
      name: resolved.workspaceName,
    },
  };
};

export const parseConfig = (env: Record<string, string | undefined>): AppConfig => {
  return loadAppConfig(env);
};

export const assertOperationalConfigReady = (config: AppConfig) => {
  const issues: string[] = [];

  if (config.DISCORD_APP_ID === DEFAULT_DISCORD_APP_ID) {
    issues.push("DISCORD_APP_ID is unresolved");
  }

  if (config.codex.appServerUrl === DEFAULT_CODEX_APP_SERVER_URL) {
    issues.push("CODEX_APP_SERVER_URL is unresolved");
  }

  if (issues.length > 0) {
    throw new Error(`CodeHelm configuration is not ready for daemon startup: ${issues.join("; ")}`);
  }
};
