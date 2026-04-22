import { afterEach, describe, expect, test } from "bun:test";
import type { PasswordOptions } from "@clack/prompts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadStoredConfig,
  loadStoredSecrets,
  type StoredConfig,
} from "../../src/cli/config-store";
import {
  createOnboardingUi,
  formatReviewSummary,
  runOnboarding,
  type DiscoveryServices,
  type OnboardingUi,
  type OnboardingUiTokenResponse,
} from "../../src/cli/onboard";

const tempDirs: string[] = [];

const createTempDir = () => {
  const directory = mkdtempSync(join(tmpdir(), "codehelm-onboard-"));
  tempDirs.push(directory);
  return directory;
};

class OnboardingUiStub implements OnboardingUi {
  promptTokenCalls = 0;
  guildSelectionCalls = 0;
  channelSelectionCalls = 0;
  tokenErrors: string[] = [];
  blockedErrors: string[] = [];
  completionCount = 0;
  lastGuildSelectionInput:
    | { guilds: Array<{ id: string; name: string }>; currentGuildId?: string }
    | undefined;
  lastChannelSelectionInput:
    | { channels: Array<{ id: string; name: string }>; currentChannelId?: string }
    | undefined;
  lastReviewInput:
    | {
      botIdentity: { botUser: { id: string; username: string }; application: { id: string; name: string } };
      botToken: string;
      guild: { id: string; name: string };
      controlChannel: { id: string; name: string };
      configPath: string;
      secretsPath: string;
      databasePath: string;
      existingConfig?: StoredConfig;
    }
    | undefined;

  constructor(
    private readonly options: {
      tokens?: OnboardingUiTokenResponse[];
      guildSelections?: string[];
      channelSelections?: string[];
    } = {},
  ) {}

  async showWelcome() {}

  async promptBotToken() {
    const next = this.options.tokens?.[this.promptTokenCalls];
    this.promptTokenCalls += 1;
    return next ?? { kind: "submit", token: "token-1" };
  }

  async showTokenValidationError(message: string) {
    this.tokenErrors.push(message);
  }

  async selectGuild(input: { guilds: Array<{ id: string; name: string }>; currentGuildId?: string }) {
    this.lastGuildSelectionInput = input;
    const next = this.options.guildSelections?.[this.guildSelectionCalls];
    this.guildSelectionCalls += 1;
    return next ?? input.currentGuildId ?? input.guilds[0]?.id ?? "";
  }

  async selectControlChannel(
    input: { channels: Array<{ id: string; name: string }>; currentChannelId?: string },
  ) {
    this.lastChannelSelectionInput = input;
    const next = this.options.channelSelections?.[this.channelSelectionCalls];
    this.channelSelectionCalls += 1;
    return next ?? input.currentChannelId ?? input.channels[0]?.id ?? "";
  }

  async reviewSelection(input: Parameters<OnboardingUi["reviewSelection"]>[0]) {
    this.lastReviewInput = input;
    return true;
  }

  async showBlockedError(message: string) {
    this.blockedErrors.push(message);
  }

  async showCompleted() {
    this.completionCount += 1;
  }
}

const createDiscoveryServices = (
  overrides: Partial<DiscoveryServices> = {},
): DiscoveryServices => {
  return {
    async validateBotToken(token) {
      return {
        botUser: {
          id: "bot-1",
          username: token,
        },
        application: {
          id: "123456789012345678",
          name: "CodeHelm Bot",
        },
      };
    },
    async listSelectableGuilds() {
      return [
        { id: "guild-1", name: "Guild One" },
        { id: "guild-2", name: "Guild Two" },
      ];
    },
    async listSelectableControlChannels() {
      return [
        { id: "channel-1", name: "control-room" },
        { id: "channel-2", name: "ops" },
      ];
    },
    ...overrides,
  };
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runOnboarding", () => {
  test("review summary uses stable aligned rows and masks the bot token", () => {
    const review = formatReviewSummary({
      botIdentity: {
        botUser: {
          id: "bot-1",
          username: "code-helm",
        },
        application: {
          id: "123456789012345678",
          name: "CodeHelm Bot",
        },
      },
      botToken: "abcd1234",
      guild: { id: "guild-1", name: "Guild One" },
      controlChannel: { id: "channel-1", name: "control-room" },
      configPath: "/tmp/config.toml",
      secretsPath: "/tmp/secrets.toml",
      databasePath: "/tmp/codehelm.sqlite",
    });

    const lines = review.split("\n");

    expect(lines).toHaveLength(10);
    expect(lines[0]).toMatch(/^Bot\s+code-helm \(CodeHelm Bot\)$/);
    expect(lines[1]).toMatch(/^Discord bot token\s+abcd\*{4}$/);
    expect(lines[2]).toMatch(/^Guild\s+Guild One$/);
    expect(lines[3]).toMatch(/^Control channel\s+#control-room$/);
    expect(lines[4]).toMatch(/^Codex App Server\s+managed \(loopback, port assigned on start\)$/);
    expect(lines[5]).toMatch(/^Codex address\s+ws:\/\/127\.0\.0\.1:<auto>$/);
    expect(lines[6]).toMatch(/^Codex connect\s+codex --remote ws:\/\/127\.0\.0\.1:<auto> -C "\$\(pwd\)"$/);
    expect(lines[7]).toMatch(/^Config path\s+\/tmp\/config\.toml$/);
    expect(lines[8]).toMatch(/^Secrets path\s+\/tmp\/secrets\.toml$/);
    expect(lines[9]).toMatch(/^Database path\s+\/tmp\/codehelm\.sqlite$/);
  });

  test("createOnboardingUi uses an asterisk mask for bot token entry", async () => {
    let capturedMask: string | undefined;
    const ui = createOnboardingUi({
      password: async (options: PasswordOptions) => {
        capturedMask = options.mask;
        return "token-1";
      },
    });

    const response = await ui.promptBotToken();

    expect(response).toEqual({ kind: "submit", token: "token-1" });
    expect(capturedMask).toBe("*");
  });

  test("createOnboardingUi welcomes with a product title and concise note", async () => {
    let introMessage: string | undefined;
    let noteMessage: string | undefined;
    let noteLabel: string | undefined;
    const ui = createOnboardingUi({
      intro(message) {
        introMessage = message;
      },
      note(message, label) {
        noteMessage = message;
        noteLabel = label;
      },
    });

    await ui.showWelcome();

    expect(introMessage).toBe("CodeHelm");
    expect(noteLabel).toBe("Onboarding");
    expect(noteMessage).toBe("Connect Discord and save local runtime settings.");
  });

  test("createOnboardingUi completion copy ends with one explicit next command", async () => {
    let outroMessage: string | undefined;
    const ui = createOnboardingUi({
      outro(message) {
        outroMessage = message;
      },
    });

    await ui.showCompleted();

    expect(outroMessage).toBe("Onboarding complete. Run `code-helm start`.");
  });

  test("first-run onboarding saves config and secrets", async () => {
    const homeDir = createTempDir();
    const ui = new OnboardingUiStub({
      tokens: [{ kind: "submit", token: "token-1" }],
      guildSelections: ["guild-2"],
      channelSelections: ["channel-2"],
    });

    const result = await runOnboarding({
      env: {},
      homeDir,
      ui,
      discovery: createDiscoveryServices(),
      readRuntimeSummary: () => undefined,
      isPidAlive: () => false,
    });

    expect(result.kind).toBe("completed");
    expect(
      loadStoredConfig({
        configPath: join(homeDir, ".config", "code-helm", "config.toml"),
      }),
    ).toEqual<StoredConfig>({
      discord: {
        guildId: "guild-2",
        controlChannelId: "channel-2",
      },
      codex: {
        appServerMode: "managed",
      },
      database: {
        path: join(homeDir, ".local", "share", "code-helm", "codehelm.sqlite"),
      },
    });
    expect(
      loadStoredSecrets({
        secretsPath: join(homeDir, ".config", "code-helm", "secrets.toml"),
      }),
    ).toEqual({
      discord: {
        botToken: "token-1",
      },
    });
    expect(ui.completionCount).toBe(1);
    expect(ui.lastReviewInput?.botToken).toBe("token-1");
  });

  test("token validation failure keeps the flow on the token step", async () => {
    const homeDir = createTempDir();
    const ui = new OnboardingUiStub({
      tokens: [
        { kind: "submit", token: "bad-token" },
        { kind: "submit", token: "good-token" },
      ],
    });

    await runOnboarding({
      env: {},
      homeDir,
      ui,
      discovery: createDiscoveryServices({
        async validateBotToken(token) {
          if (token === "bad-token") {
            throw new Error("Invalid bot token");
          }

          return {
            botUser: {
              id: "bot-1",
              username: token,
            },
            application: {
              id: "123456789012345678",
              name: "CodeHelm Bot",
            },
          };
        },
      }),
      readRuntimeSummary: () => undefined,
      isPidAlive: () => false,
    });

    expect(ui.promptTokenCalls).toBe(2);
    expect(ui.tokenErrors[0]).toMatch(/invalid bot token/i);
  });

  test("stale existing tokens return the flow to the token step", async () => {
    const homeDir = createTempDir();
    const firstUi = new OnboardingUiStub({
      tokens: [{ kind: "submit", token: "stale-token" }],
    });

    await runOnboarding({
      env: {},
      homeDir,
      ui: firstUi,
      discovery: createDiscoveryServices(),
      readRuntimeSummary: () => undefined,
      isPidAlive: () => false,
    });

    const editUi = new OnboardingUiStub({
      tokens: [
        { kind: "use-existing" },
        { kind: "submit", token: "fresh-token" },
      ],
    });

    await runOnboarding({
      env: {},
      homeDir,
      ui: editUi,
      discovery: createDiscoveryServices({
        async validateBotToken(token) {
          if (token === "stale-token") {
            throw new Error("Invalid bot token");
          }

          return {
            botUser: {
              id: "bot-1",
              username: token,
            },
            application: {
              id: "123456789012345678",
              name: "CodeHelm Bot",
            },
          };
        },
      }),
      readRuntimeSummary: () => undefined,
      isPidAlive: () => false,
    });

    expect(editUi.promptTokenCalls).toBe(2);
    expect(editUi.tokenErrors[0]).toMatch(/invalid bot token/i);
  });

  test("no guilds returns a helpful blocking error", async () => {
    const homeDir = createTempDir();
    const ui = new OnboardingUiStub();

    await expect(
      runOnboarding({
        env: {},
        homeDir,
        ui,
        discovery: createDiscoveryServices({
          async listSelectableGuilds() {
            return [];
          },
        }),
        readRuntimeSummary: () => undefined,
        isPidAlive: () => false,
      }),
    ).rejects.toThrow(/no guild/i);
    expect(ui.blockedErrors[0]).toMatch(/no guild/i);
  });

  test("no valid text channels returns a helpful blocking error", async () => {
    const homeDir = createTempDir();
    const ui = new OnboardingUiStub();

    await expect(
      runOnboarding({
        env: {},
        homeDir,
        ui,
        discovery: createDiscoveryServices({
          async listSelectableControlChannels() {
            return [];
          },
        }),
        readRuntimeSummary: () => undefined,
        isPidAlive: () => false,
      }),
    ).rejects.toThrow(/no valid control channel/i);
    expect(ui.blockedErrors[0]).toMatch(/no valid control channel/i);
  });

  test("existing config enters edit mode with existing values preloaded", async () => {
    const homeDir = createTempDir();
    const firstUi = new OnboardingUiStub({
      tokens: [{ kind: "submit", token: "token-1" }],
      guildSelections: ["guild-2"],
      channelSelections: ["channel-2"],
    });

    await runOnboarding({
      env: {},
      homeDir,
      ui: firstUi,
      discovery: createDiscoveryServices(),
      readRuntimeSummary: () => undefined,
      isPidAlive: () => false,
    });

    const editUi = new OnboardingUiStub({
      tokens: [{ kind: "use-existing" }],
    });

    await runOnboarding({
      env: {},
      homeDir,
      ui: editUi,
      discovery: createDiscoveryServices(),
      readRuntimeSummary: () => undefined,
      isPidAlive: () => false,
    });

    expect(editUi.guildSelectionCalls).toBe(1);
    expect(editUi.channelSelectionCalls).toBe(1);
    expect(editUi.promptTokenCalls).toBe(1);
    expect(editUi.lastGuildSelectionInput?.currentGuildId).toBe("guild-2");
    expect(editUi.lastChannelSelectionInput?.currentChannelId).toBe("channel-2");
  });

  test("invalid guild selections are rejected instead of silently falling back", async () => {
    const homeDir = createTempDir();
    const ui = new OnboardingUiStub({
      guildSelections: ["guild-missing"],
    });

    await expect(
      runOnboarding({
        env: {},
        homeDir,
        ui,
        discovery: createDiscoveryServices(),
        readRuntimeSummary: () => undefined,
        isPidAlive: () => false,
      }),
    ).rejects.toThrow(/selected guild/i);
  });

  test("invalid control-channel selections are rejected instead of silently falling back", async () => {
    const homeDir = createTempDir();
    const ui = new OnboardingUiStub({
      channelSelections: ["channel-missing"],
    });

    await expect(
      runOnboarding({
        env: {},
        homeDir,
        ui,
        discovery: createDiscoveryServices(),
        readRuntimeSummary: () => undefined,
        isPidAlive: () => false,
      }),
    ).rejects.toThrow(/selected control channel/i);
  });

  test("already-running short-circuits before the tui opens", async () => {
    const homeDir = createTempDir();
    const ui = new OnboardingUiStub();

    const result = await runOnboarding({
      env: {},
      homeDir,
      ui,
      discovery: createDiscoveryServices(),
      readRuntimeSummary: () => ({
        pid: 1234,
        mode: "background",
        discord: { guildId: "guild-1" },
        codex: { appServerAddress: "ws://127.0.0.1:4500" },
      }),
      isPidAlive: () => true,
    });

    expect(result.kind).toBe("already-running");
    expect(ui.promptTokenCalls).toBe(0);
    expect(ui.guildSelectionCalls).toBe(0);
    expect(ui.channelSelectionCalls).toBe(0);
  });
});
