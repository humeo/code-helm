import { z } from "zod";

const ConfigSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  CODEX_APP_SERVER_URL: z.string().url(),
  DATABASE_PATH: z.string().min(1),
});

export const parseConfig = (env: Record<string, string | undefined>) => {
  return ConfigSchema.parse(env);
};
