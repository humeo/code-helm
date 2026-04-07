import { parseConfig } from "./config";
import { logger } from "./logger";

if (import.meta.main) {
  const config = parseConfig(process.env as Record<string, string | undefined>);
  logger.info(`CodeHelm starting for Discord app ${config.DISCORD_APP_ID}`);
}
