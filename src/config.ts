import { z } from "zod";

const ConfigSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_CONTROL_CHANNEL_ID: z.string().min(1),
  CODEX_APP_SERVER_URL: z
    .string()
    .url()
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "ws:" || protocol === "wss:";
    }, "CODEX_APP_SERVER_URL must use ws:// or wss://"),
  DATABASE_PATH: z.string().min(1),
  WORKSPACE_ID: z.string().min(1),
  WORKSPACE_NAME: z.string().min(1),
});

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

export const parseConfig = (env: Record<string, string | undefined>): AppConfig => {
  const parsed = ConfigSchema.parse(env);

  return {
    DISCORD_APP_ID: parsed.DISCORD_APP_ID,
    discord: {
      botToken: parsed.DISCORD_BOT_TOKEN,
      appId: parsed.DISCORD_APP_ID,
      guildId: parsed.DISCORD_GUILD_ID,
      controlChannelId: parsed.DISCORD_CONTROL_CHANNEL_ID,
    },
    codex: {
      appServerUrl: parsed.CODEX_APP_SERVER_URL,
    },
    databasePath: parsed.DATABASE_PATH,
    workspace: {
      id: parsed.WORKSPACE_ID,
      name: parsed.WORKSPACE_NAME,
    },
  };
};
