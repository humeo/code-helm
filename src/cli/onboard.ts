import { loadConfigStore, saveStoredConfig, saveStoredSecrets, type StoredConfig } from "./config-store";
import type { RuntimeSummary } from "./runtime-state";
import {
  listSelectableControlChannels,
  listSelectableGuilds,
  validateBotToken,
  type DiscordBotIdentity,
  type SelectableControlChannel,
  type SelectableGuild,
} from "./discord-discovery";

export type OnboardingUiTokenResponse =
  | { kind: "submit"; token: string }
  | { kind: "use-existing" };

export type OnboardingUi = {
  showWelcome(): Promise<void>;
  promptBotToken(input?: { hasExistingToken?: boolean }): Promise<OnboardingUiTokenResponse>;
  showTokenValidationError(message: string): Promise<void>;
  selectGuild(input: {
    guilds: SelectableGuild[];
    currentGuildId?: string;
  }): Promise<string>;
  selectControlChannel(input: {
    channels: SelectableControlChannel[];
    currentChannelId?: string;
  }): Promise<string>;
  reviewSelection(input: {
    botIdentity: DiscordBotIdentity;
    guild: SelectableGuild;
    controlChannel: SelectableControlChannel;
    configPath: string;
    secretsPath: string;
    databasePath: string;
    existingConfig?: StoredConfig;
  }): Promise<boolean>;
  showBlockedError(message: string): Promise<void>;
  showCompleted(): Promise<void>;
};

export type DiscoveryServices = {
  validateBotToken(token: string): Promise<DiscordBotIdentity>;
  listSelectableGuilds(token: string): Promise<SelectableGuild[]>;
  listSelectableControlChannels(token: string, guildId: string): Promise<SelectableControlChannel[]>;
};

export type OnboardingResult =
  | { kind: "completed" }
  | { kind: "already-running" }
  | { kind: "cancelled" };

const loadOnboardingStore = (options: { env: Record<string, string | undefined>; homeDir?: string }) => {
  return loadConfigStore({
    env: options.env,
    homeDir: options.homeDir,
    mode: "edit",
  });
};

const normalizeValidationError = (error: unknown) => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Invalid bot token";
};

const saveOnboardingConfig = (
  options: {
    configPath: string;
    secretsPath: string;
    databasePath: string;
    guildId: string;
    controlChannelId: string;
    botToken: string;
  },
) => {
  const config: StoredConfig = {
    discord: {
      guildId: options.guildId,
      controlChannelId: options.controlChannelId,
    },
    codex: {
      appServerMode: "managed",
    },
    database: {
      path: options.databasePath,
    },
  };

  saveStoredConfig(config, { configPath: options.configPath });
  saveStoredSecrets(
    {
      discord: {
        botToken: options.botToken,
      },
    },
    { secretsPath: options.secretsPath },
  );
};

const getExistingToken = (store: ReturnType<typeof loadOnboardingStore>) => {
  return store.secrets?.discord.botToken;
};

const resolveRuntimeState = (
  options: {
    env: Record<string, string | undefined>;
    homeDir?: string;
    readRuntimeSummary: (input: { stateDir: string; isPidAlive: (pid: number) => boolean }) => RuntimeSummary | undefined;
    isPidAlive: (pid: number) => boolean;
  },
) => {
  const store = loadOnboardingStore({
    env: options.env,
    homeDir: options.homeDir,
  });

  return {
    store,
    runtime: options.readRuntimeSummary({
      stateDir: store.paths.stateDir,
      isPidAlive: options.isPidAlive,
    }),
  };
};

export const runOnboarding = async (
  options: {
    env: Record<string, string | undefined>;
    homeDir?: string;
    ui: OnboardingUi;
    discovery: DiscoveryServices;
    readRuntimeSummary: (input: { stateDir: string; isPidAlive: (pid: number) => boolean }) => RuntimeSummary | undefined;
    isPidAlive: (pid: number) => boolean;
  },
): Promise<OnboardingResult> => {
  const { store, runtime } = resolveRuntimeState(options);

  if (runtime) {
    return { kind: "already-running" };
  }

  await options.ui.showWelcome();

  const existingToken = getExistingToken(store);
  let botToken: string | undefined;
  let botIdentity: DiscordBotIdentity | undefined;

  while (!botToken) {
    const tokenResponse = await options.ui.promptBotToken({
      hasExistingToken: Boolean(existingToken),
    });

    if (tokenResponse.kind === "use-existing") {
      if (!existingToken) {
        await options.ui.showTokenValidationError("No existing bot token is available.");
        continue;
      }

      botToken = existingToken;
      break;
    }

    try {
      botIdentity = await options.discovery.validateBotToken(tokenResponse.token);
      botToken = tokenResponse.token;
    } catch (error) {
      await options.ui.showTokenValidationError(normalizeValidationError(error));
    }
  }

  botIdentity ??= await options.discovery.validateBotToken(botToken);
  const guilds = await options.discovery.listSelectableGuilds(botToken);

  if (guilds.length === 0) {
    const message = "No guilds are available for this bot token. Invite the bot to a guild first.";
    await options.ui.showBlockedError(message);
    throw new Error(message);
  }

  const currentGuildId = store.config?.discord.guildId;
  const selectedGuildId = await options.ui.selectGuild({
    guilds,
    currentGuildId,
  });
  const guild = guilds.find((entry) => entry.id === selectedGuildId) ?? guilds[0];

  const channels = await options.discovery.listSelectableControlChannels(botToken, guild.id);

  if (channels.length === 0) {
    const message = "No valid control channel is available in the selected guild.";
    await options.ui.showBlockedError(message);
    throw new Error(message);
  }

  const selectedChannelId = await options.ui.selectControlChannel({
    channels,
    currentChannelId: store.config?.discord.controlChannelId,
  });
  const controlChannel = channels.find((entry) => entry.id === selectedChannelId) ?? channels[0];

  const accepted = await options.ui.reviewSelection({
    botIdentity,
    guild,
    controlChannel,
    configPath: store.paths.configPath,
    secretsPath: store.paths.secretsPath,
    databasePath: store.paths.databasePath,
    existingConfig: store.config,
  });

  if (!accepted) {
    return { kind: "cancelled" };
  }

  saveOnboardingConfig({
    configPath: store.paths.configPath,
    secretsPath: store.paths.secretsPath,
    databasePath: store.paths.databasePath,
    guildId: guild.id,
    controlChannelId: controlChannel.id,
    botToken,
  });

  await options.ui.showCompleted();

  return { kind: "completed" };
};
