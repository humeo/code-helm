import { z } from "zod";

const ConfigSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  CODEX_APP_SERVER_URL: z.string().url(),
  DATABASE_PATH: z.string().min(1),
});

export const parseConfig = (env: Record<string, string | undefined>) => {
  const result = ConfigSchema.safeParse(env);

  if (result.success) {
    return result.data;
  }

  const issue = result.error.issues[0];
  const field = issue?.path[0];
  throw new Error(`${String(field ?? "CONFIG")}: ${issue?.message ?? "Invalid config"}`);
};
