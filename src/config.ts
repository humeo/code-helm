import { z } from "zod";
import { loadConfigStore } from "./cli/config-store";
import { expandHomePath } from "./cli/paths";

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
  const store = loadConfigStore({
    env,
    mode: "edit",
  });
  const resolvedBotToken = env.CODE_HELM_DISCORD_BOT_TOKEN
    ?? store.secrets?.discord.botToken
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
      ?? store.config?.discord.guildId
      ?? env.DISCORD_GUILD_ID,
    discordControlChannelId: env.CODE_HELM_DISCORD_CONTROL_CHANNEL_ID
      ?? store.config?.discord.controlChannelId
      ?? env.DISCORD_CONTROL_CHANNEL_ID,
    codexAppServerUrl: env.CODE_HELM_CODEX_APP_SERVER_URL
      ?? env.CODEX_APP_SERVER_URL
      ?? DEFAULT_CODEX_APP_SERVER_URL,
    databasePath: expandHomePath(
      env.CODE_HELM_DATABASE_PATH
        ?? store.config?.database.path
        ?? env.DATABASE_PATH
        ?? store.paths.databasePath,
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
