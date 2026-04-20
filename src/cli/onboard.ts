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
import { renderKeyValueRows } from "./output";

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
    botToken: string;
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
const MANAGED_CODEX_APP_SERVER_ADDRESS = "ws://127.0.0.1:<auto>";
const MANAGED_CODEX_CONNECT_COMMAND = `codex --remote ${MANAGED_CODEX_APP_SERVER_ADDRESS}`;

const unwrapPromptValue = <T>(value: T | symbol): T => {
  if (isCancel(value)) {
    cancel(ONBOARDING_CANCELLED_MESSAGE);
    throw new Error(ONBOARDING_CANCELLED_MESSAGE);
  }

  return value;
};

type OnboardingPrompts = {
  confirm: typeof confirm;
  intro: typeof intro;
  note: typeof note;
  outro: typeof outro;
  password: typeof password;
  select: typeof select;
};

const defaultOnboardingPrompts: OnboardingPrompts = {
  confirm,
  intro,
  note,
  outro,
  password,
  select,
};

const maskBotTokenForDisplay = (token: string) => {
  if (token.length <= 4) {
    return token;
  }

  return `${token.slice(0, 4)}${"*".repeat(token.length - 4)}`;
};

export const formatReviewSummary = (input: {
  botIdentity: DiscordBotIdentity;
  botToken: string;
  guild: SelectableGuild;
  controlChannel: SelectableControlChannel;
  configPath: string;
  secretsPath: string;
  databasePath: string;
}) => {
  return renderKeyValueRows([
    {
      key: "Bot",
      value: `${input.botIdentity.botUser.username} (${input.botIdentity.application.name})`,
    },
    { key: "Discord bot token", value: maskBotTokenForDisplay(input.botToken) },
    { key: "Guild", value: input.guild.name },
    { key: "Control channel", value: `#${input.controlChannel.name}` },
    { key: "Codex App Server", value: "managed (loopback, port assigned on start)" },
    { key: "Codex address", value: MANAGED_CODEX_APP_SERVER_ADDRESS },
    { key: "Codex connect", value: MANAGED_CODEX_CONNECT_COMMAND },
    { key: "Config path", value: input.configPath },
    { key: "Secrets path", value: input.secretsPath },
    { key: "Database path", value: input.databasePath },
  ]).join("\n");
};

export const createOnboardingUi = (
  promptOverrides: Partial<OnboardingPrompts> = {},
): OnboardingUi => {
  const prompts = {
    ...defaultOnboardingPrompts,
    ...promptOverrides,
  };

  return {
    async showWelcome() {
      prompts.intro("CodeHelm");
      prompts.note(
        "Connect Discord and save local runtime settings.",
        "Onboarding",
      );
    },
    async promptBotToken(input = {}) {
      if (input.hasExistingToken) {
        const tokenAction = unwrapPromptValue(await prompts.select({
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

      const token = unwrapPromptValue(await prompts.password({
        message: "Discord bot token",
        mask: "*",
        validate(value) {
          return value.trim().length === 0
            ? "Discord bot token is required."
            : undefined;
        },
      }));

      return { kind: "submit", token };
    },
    async showTokenValidationError(message) {
      prompts.note(message, "Token error");
    },
    async selectGuild(input) {
      return unwrapPromptValue(await prompts.select({
        message: "Discord guild",
        options: input.guilds.map((guild) => ({
          value: guild.id,
          label: guild.name,
        })),
        initialValue: input.currentGuildId,
      }));
    },
    async selectControlChannel(input) {
      return unwrapPromptValue(await prompts.select({
        message: "Control channel",
        options: input.channels.map((channel) => ({
          value: channel.id,
          label: `#${channel.name}`,
        })),
        initialValue: input.currentChannelId,
      }));
    },
    async reviewSelection(input) {
      prompts.note(formatReviewSummary(input), "Review");
      return unwrapPromptValue(await prompts.confirm({
        message: "Save this configuration?",
        active: "save",
        inactive: "cancel",
        initialValue: true,
      }));
    },
    async showBlockedError(message) {
      prompts.note(message, "Blocked");
    },
    async showCompleted() {
      prompts.outro("Onboarding complete. Run `code-helm start`.");
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
    botToken,
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
