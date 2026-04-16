import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  password,
  select,
} from "@clack/prompts";
import { loadConfigStore, saveStoredConfig, saveStoredSecrets, type StoredConfig } from "./config-store";
import type { RuntimeSummary } from "./runtime-state";
import {
  createDiscordDiscoveryServices,
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

const ONBOARDING_CANCELLED_MESSAGE = "Onboarding cancelled.";

const unwrapPromptValue = <T>(value: T | symbol): T => {
  if (isCancel(value)) {
    cancel(ONBOARDING_CANCELLED_MESSAGE);
    throw new Error(ONBOARDING_CANCELLED_MESSAGE);
  }

  return value;
};

const formatReviewSummary = (input: {
  botIdentity: DiscordBotIdentity;
  guild: SelectableGuild;
  controlChannel: SelectableControlChannel;
  configPath: string;
  secretsPath: string;
  databasePath: string;
}) => {
  return [
    `Bot: ${input.botIdentity.botUser.username} (${input.botIdentity.application.name})`,
    `Guild: ${input.guild.name}`,
    `Control channel: #${input.controlChannel.name}`,
    "Codex App Server: managed",
    `Config: ${input.configPath}`,
    `Secrets: ${input.secretsPath}`,
    `Database: ${input.databasePath}`,
  ].join("\n");
};

export const createOnboardingUi = (): OnboardingUi => {
  return {
    async showWelcome() {
      intro("CodeHelm onboarding");
      note(
        "CodeHelm will configure one local daemon, one Discord guild, and one Discord control channel.",
        "Welcome",
      );
    },
    async promptBotToken(input = {}) {
      if (input.hasExistingToken) {
        const tokenAction = unwrapPromptValue(await select({
          message: "Discord bot token",
          options: [
            { value: "use-existing", label: "Use existing token" },
            { value: "replace", label: "Replace token" },
          ],
        }));

        if (tokenAction === "use-existing") {
          return { kind: "use-existing" };
        }
      }

      const token = unwrapPromptValue(await password({
        message: "Discord bot token",
        validate(value) {
          return value.trim().length === 0
            ? "Discord bot token is required."
            : undefined;
        },
      }));

      return { kind: "submit", token };
    },
    async showTokenValidationError(message) {
      note(message, "Token error");
    },
    async selectGuild(input) {
      return unwrapPromptValue(await select({
        message: "Discord guild",
        options: input.guilds.map((guild) => ({
          value: guild.id,
          label: guild.name,
        })),
        initialValue: input.currentGuildId,
      }));
    },
    async selectControlChannel(input) {
      return unwrapPromptValue(await select({
        message: "Control channel",
        options: input.channels.map((channel) => ({
          value: channel.id,
          label: `#${channel.name}`,
        })),
        initialValue: input.currentChannelId,
      }));
    },
    async reviewSelection(input) {
      note(formatReviewSummary(input), "Review");
      return unwrapPromptValue(await confirm({
        message: "Save this configuration?",
        active: "save",
        inactive: "cancel",
        initialValue: true,
      }));
    },
    async showBlockedError(message) {
      note(message, "Blocked");
    },
    async showCompleted() {
      outro("Onboarding complete. Run `code-helm start`.");
    },
  };
};

export const createDefaultDiscoveryServices = (): DiscoveryServices => {
  return createDiscordDiscoveryServices();
};

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

const resolveSelectedGuild = (
  guilds: SelectableGuild[],
  selectedGuildId: string,
) => {
  const selectedGuild = guilds.find((entry) => entry.id === selectedGuildId);

  if (!selectedGuild) {
    throw new Error("Selected guild is no longer available. Please retry onboarding.");
  }

  return selectedGuild;
};

const resolveSelectedControlChannel = (
  channels: SelectableControlChannel[],
  selectedChannelId: string,
) => {
  const selectedChannel = channels.find((entry) => entry.id === selectedChannelId);

  if (!selectedChannel) {
    throw new Error("Selected control channel is no longer available. Please retry onboarding.");
  }

  return selectedChannel;
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

    const nextToken = tokenResponse.kind === "use-existing"
      ? existingToken
      : tokenResponse.token;

    if (!nextToken) {
      await options.ui.showTokenValidationError("No existing bot token is available.");
      continue;
    }

    try {
      botIdentity = await options.discovery.validateBotToken(nextToken);
      botToken = nextToken;
    } catch (error) {
      await options.ui.showTokenValidationError(normalizeValidationError(error));
    }
  }

  if (!botIdentity) {
    throw new Error("Bot token validation did not complete.");
  }

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
  const guild = resolveSelectedGuild(guilds, selectedGuildId);

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
  const controlChannel = resolveSelectedControlChannel(channels, selectedChannelId);

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
