import { isAbsolute, relative } from "node:path";
import { z } from "zod";

const WorkdirSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  absolutePath: z.string().min(1),
});

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
  WORKSPACE_ROOT: z.string().min(1),
  WORKDIRS_JSON: z.string().min(1),
});

export type WorkdirConfig = {
  id: string;
  label: string;
  absolutePath: string;
};

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
    rootPath: string;
  };
  workdirs: WorkdirConfig[];
};

const parseWorkdirs = (serializedWorkdirs: string) => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(serializedWorkdirs);
  } catch {
    throw new Error("WORKDIRS_JSON must be valid JSON");
  }

  const workdirs = z.array(WorkdirSchema).min(1).parse(parsed);
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const workdir of workdirs) {
    if (!isAbsolute(workdir.absolutePath)) {
      throw new Error("WORKDIRS_JSON paths must be absolute");
    }

    if (seenIds.has(workdir.id)) {
      throw new Error(`WORKDIRS_JSON contains duplicate workdir id: ${workdir.id}`);
    }

    if (seenPaths.has(workdir.absolutePath)) {
      throw new Error(
        `WORKDIRS_JSON contains duplicate workdir path: ${workdir.absolutePath}`,
      );
    }

    seenIds.add(workdir.id);
    seenPaths.add(workdir.absolutePath);
  }

  return workdirs;
};

const isWithinWorkspaceRoot = (workspaceRoot: string, workdirPath: string) => {
  const resolved = relative(workspaceRoot, workdirPath);

  return resolved === "" || (!resolved.startsWith("..") && !isAbsolute(resolved));
};

export const parseConfig = (env: Record<string, string | undefined>): AppConfig => {
  const parsed = ConfigSchema.parse(env);
  const workdirs = parseWorkdirs(parsed.WORKDIRS_JSON);

  if (!isAbsolute(parsed.WORKSPACE_ROOT)) {
    throw new Error("WORKSPACE_ROOT must be an absolute path");
  }

  for (const workdir of workdirs) {
    if (!isWithinWorkspaceRoot(parsed.WORKSPACE_ROOT, workdir.absolutePath)) {
      throw new Error(
        `WORKDIRS_JSON contains a workdir outside WORKSPACE_ROOT: ${workdir.absolutePath}`,
      );
    }
  }

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
      rootPath: parsed.WORKSPACE_ROOT,
    },
    workdirs,
  };
};
