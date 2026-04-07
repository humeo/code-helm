import type { Database } from "bun:sqlite";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  type Message,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Client,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { JsonRpcClient } from "./codex/jsonrpc-client";
import type {
  ApprovalRequestEvent,
  CodexThread,
  CodexThreadStatus,
  RoutedEventMap,
} from "./codex/protocol-types";
import { type AppConfig, parseConfig, type WorkdirConfig } from "./config";
import { createDatabaseClient } from "./db/client";
import { applyMigrations } from "./db/migrate";
import { createApprovalRepo } from "./db/repos/approvals";
import { createSessionRepo } from "./db/repos/sessions";
import { createWorkdirRepo } from "./db/repos/workdirs";
import { createWorkspaceRepo } from "./db/repos/workspaces";
import type { ApprovalStatus } from "./domain/approval-service";
import { applyApprovalResolutionSignal, renderApprovalUi } from "./discord/approval-ui";
import { createDiscordBot } from "./discord/bot";
import type { DiscordCommandResult, DiscordCommandServices } from "./discord/commands";
import {
  renderDegradationBannerText,
  renderFinalAnswerText,
  renderRunningStatusText,
  renderSessionStartedText,
  renderToolProgressText,
} from "./discord/renderers";
import { decideThreadTurn } from "./discord/thread-handler";
import { logger } from "./logger";

const approvalButtonPrefix = "approval";

type SessionRuntimeState = "idle" | "running" | "waiting-approval" | "degraded";
type ApprovalAction = "approve" | "decline" | "cancel";
type ApprovalButtonMessage = Message<boolean>;
type SendableChannel = {
  send(payload: { content: string; components?: unknown[] }): Promise<Message<boolean>>;
};
type ThreadStarterMessage = Message<boolean> & {
  startThread(options: {
    name: string;
    autoArchiveDuration: ThreadAutoArchiveDuration;
    reason?: string;
  }): Promise<{ id: string; send(payload: { content: string }): Promise<unknown> }>;
};

const toRecord = (value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
};

const readString = (value: unknown, key: string) => {
  const record = toRecord(value);
  const candidate = record[key];

  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
};

const readNestedString = (value: unknown, keys: string[]) => {
  let cursor: unknown = value;

  for (const key of keys) {
    cursor = toRecord(cursor)[key];
  }

  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
};

const coerceActiveFlags = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [] as Array<"waitingOnApproval" | "waitingOnUserInput">;
  }

  return value.filter(
    (entry): entry is "waitingOnApproval" | "waitingOnUserInput" =>
      entry === "waitingOnApproval" || entry === "waitingOnUserInput",
  );
};

const coerceCodexThreadStatus = (value: unknown): CodexThreadStatus | undefined => {
  if (typeof value === "string") {
    if (value === "idle") {
      return { type: "idle" };
    }

    if (value === "notLoaded") {
      return { type: "notLoaded" };
    }

    if (value === "systemError") {
      return { type: "systemError" };
    }

    if (value === "waitingOnApproval") {
      return { type: "active", activeFlags: ["waitingOnApproval"] };
    }

    if (value === "active" || value === "running") {
      return { type: "active", activeFlags: [] };
    }

    return undefined;
  }

  const type = readString(value, "type");

  if (!type) {
    return undefined;
  }

  if (type === "active") {
    return {
      type: "active",
      activeFlags: coerceActiveFlags(toRecord(value).activeFlags),
    };
  }

  if (type === "idle" || type === "notLoaded" || type === "systemError") {
    return { type };
  }

  return undefined;
};

export const isImportableThreadStatus = (status: CodexThreadStatus) => {
  return status.type === "idle" || status.type === "notLoaded";
};

export const inferSessionStateFromThreadStatus = (
  status: CodexThreadStatus,
): SessionRuntimeState => {
  if (status.type === "systemError") {
    return "degraded";
  }

  if (status.type === "active") {
    return status.activeFlags.includes("waitingOnApproval")
      ? "waiting-approval"
      : "running";
  }

  return "idle";
};

export const describeCodexThreadStatus = (status: CodexThreadStatus) => {
  if (status.type !== "active") {
    return status.type;
  }

  if (status.activeFlags.length === 0) {
    return "active";
  }

  return `active(${status.activeFlags.join(", ")})`;
};

const readThreadIdFromEvent = (params: unknown) => {
  return readString(params, "threadId") ?? readNestedString(params, ["thread", "id"]);
};

const readTurnIdFromEvent = (params: unknown) => {
  return readString(params, "turnId") ?? readNestedString(params, ["turn", "id"]);
};

const readItemIdFromEvent = (params: unknown) => {
  return readString(params, "itemId") ?? readNestedString(params, ["item", "id"]);
};

const readFinalAnswerFromEvent = (params: unknown) => {
  return (
    readString(params, "text")
    ?? readNestedString(params, ["turn", "result", "text"])
    ?? readNestedString(params, ["turn", "result", "outputText"])
  );
};

const isSendableChannel = (value: unknown): value is SendableChannel => {
  return (
    !!value &&
    typeof value === "object" &&
    "send" in value &&
    typeof (value as { send?: unknown }).send === "function"
  );
};

const buildApprovalCustomId = (requestId: string, action: ApprovalAction) => {
  return `${approvalButtonPrefix}|${encodeURIComponent(requestId)}|${action}`;
};

const parseApprovalCustomId = (customId: string) => {
  const [prefix, encodedRequestId, action] = customId.split("|");

  if (
    prefix !== approvalButtonPrefix ||
    !encodedRequestId ||
    (action !== "approve" && action !== "decline" && action !== "cancel")
  ) {
    return null;
  }

  return {
    requestId: decodeURIComponent(encodedRequestId),
    action,
  } as const;
};

const approvalDecision = (action: ApprovalAction): {
  providerDecision: "accept" | "decline" | "cancel";
  status: ApprovalStatus;
} => {
  if (action === "approve") {
    return {
      providerDecision: "accept",
      status: "approved",
    };
  }

  if (action === "decline") {
    return {
      providerDecision: "decline",
      status: "declined",
    };
  }

  return {
    providerDecision: "cancel",
    status: "canceled",
  };
};

const formatWorkdirList = (workdirs: WorkdirConfig[]) => {
  return workdirs
    .map((workdir) => `- \`${workdir.id}\`: ${workdir.label} (${workdir.absolutePath})`)
    .join("\n");
};

const formatThreadList = (threads: CodexThread[], workdirs: WorkdirConfig[]) => {
  const workdirByPath = new Map(workdirs.map((workdir) => [workdir.absolutePath, workdir]));

  if (threads.length === 0) {
    return "No Codex sessions found for configured workdirs.";
  }

  return threads
    .map((thread) => {
      const workdir = workdirByPath.get(thread.cwd);
      const workdirLabel = workdir ? `${workdir.label} (${workdir.id})` : thread.cwd;

      return `- \`${thread.id}\` [${describeCodexThreadStatus(thread.status)}] ${workdirLabel}`;
    })
    .join("\n");
};

const ensureWorkspaceSeeded = (
  db: Database,
  config: AppConfig,
) => {
  const workspaceRepo = createWorkspaceRepo(db);
  const workdirRepo = createWorkdirRepo(db);

  if (!workspaceRepo.getById(config.workspace.id)) {
    workspaceRepo.insert({
      id: config.workspace.id,
      name: config.workspace.name,
      rootPath: config.workspace.rootPath,
    });
  }

  for (const workdir of config.workdirs) {
    if (!workdirRepo.getById(workdir.id)) {
      workdirRepo.insert({
        id: workdir.id,
        workspaceId: config.workspace.id,
        label: workdir.label,
        absolutePath: workdir.absolutePath,
      });
    }
  }
};

const requireConfiguredControlChannel = (
  config: AppConfig,
  guildId: string,
  channelId: string,
): DiscordCommandResult | null => {
  if (guildId !== config.discord.guildId) {
    return {
      reply: {
        content: `This daemon is bound to guild \`${config.discord.guildId}\`.`,
        ephemeral: true,
      },
    };
  }

  if (channelId !== config.discord.controlChannelId) {
    return {
      reply: {
        content: `Use this command in <#${config.discord.controlChannelId}>.`,
        ephemeral: true,
      },
    };
  }

  return null;
};

const findConfiguredWorkdir = (config: AppConfig, workdirId: string) => {
  return config.workdirs.find((workdir) => workdir.id === workdirId);
};

const registerGuildCommands = async (
  config: AppConfig,
  commands: RESTPostAPIChatInputApplicationCommandsJSONBody[],
) => {
  const rest = new REST({ version: "10" }).setToken(config.discord.botToken);

  await rest.put(
    Routes.applicationGuildCommands(
      config.discord.appId,
      config.discord.guildId,
    ),
    {
      body: commands,
    },
  );
};

const requireDiscordClient = (client: Client | undefined) => {
  if (!client) {
    throw new Error("Discord client is not ready");
  }

  return client;
};

const createVisibleSessionThread = async ({
  client,
  controlChannelId,
  title,
  starterText,
}: {
  client: Client;
  controlChannelId: string;
  title: string;
  starterText: string;
}) => {
  const controlChannel = await client.channels.fetch(controlChannelId);

  if (!isSendableChannel(controlChannel)) {
    throw new Error("Configured control channel does not support sending messages");
  }

  const starter = await controlChannel.send({ content: starterText });

  if (!("startThread" in starter) || typeof starter.startThread !== "function") {
    throw new Error("Configured control channel does not support public threads");
  }

  return (starter as ThreadStarterMessage).startThread({
    name: title,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: starterText,
  });
};

const sendTextToChannel = async (
  client: Client,
  channelId: string,
  content: string,
) => {
  const channel = await client.channels.fetch(channelId);

  if (!isSendableChannel(channel)) {
    return;
  }

  await channel.send({ content });
};

const buildApprovalComponents = (requestId: string) => {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildApprovalCustomId(requestId, "approve"))
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(buildApprovalCustomId(requestId, "decline"))
        .setLabel("Decline")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(buildApprovalCustomId(requestId, "cancel"))
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
};

const maybeSendApprovalDm = async ({
  client,
  request,
  ownerId,
  threadId,
}: {
  client: Client;
  request: ApprovalRequestEvent;
  ownerId: string;
  threadId: string;
}) => {
  const approval = {
    requestId: String(request.requestId),
    status: "pending" as const,
  };
  const ui = renderApprovalUi({
    approval,
    viewerId: ownerId,
    ownerId,
  });

  if (ui.kind !== "controls") {
    return undefined;
  }

  const owner = await client.users.fetch(ownerId);

  return owner.send({
    content: `Approval pending for session <#${threadId}>.\nRequest: \`${approval.requestId}\`.`,
    components: buildApprovalComponents(approval.requestId),
  });
};

const handleApprovalInteraction = async ({
  interaction,
  client,
  sessionRepo,
  approvalRepo,
  codexClient,
}: {
  interaction: ButtonInteraction;
  client: JsonRpcClient;
  sessionRepo: ReturnType<typeof createSessionRepo>;
  approvalRepo: ReturnType<typeof createApprovalRepo>;
  codexClient: Client;
}) => {
  const parsed = parseApprovalCustomId(interaction.customId);

  if (!parsed) {
    return false;
  }

  const approvalRecord = approvalRepo.getByRequestId(parsed.requestId);

  if (!approvalRecord) {
    await interaction.reply({
      content: "That approval is no longer available.",
      ephemeral: true,
    });
    return true;
  }

  const session = sessionRepo.getByDiscordThreadId(approvalRecord.discordThreadId);

  if (!session || session.ownerDiscordUserId !== interaction.user.id) {
    await interaction.reply({
      content: "Only the session owner can resolve this approval.",
      ephemeral: true,
    });
    return true;
  }

  const nextDecision = approvalDecision(parsed.action);

  await interaction.deferUpdate();
  approvalRepo.insert({
    requestId: parsed.requestId,
    discordThreadId: approvalRecord.discordThreadId,
    status: nextDecision.status,
    resolvedByDiscordUserId: interaction.user.id,
    resolution: nextDecision.status,
  });
  await client.replyToServerRequest({
    requestId: parsed.requestId,
    decision: nextDecision.providerDecision,
  });

  await sendTextToChannel(
    codexClient,
    approvalRecord.discordThreadId,
    `Approval ${nextDecision.status} by <@${interaction.user.id}>.`,
  );

  return true;
};

export const startCodeHelm = async (
  env: Record<string, string | undefined> = Bun.env,
) => {
  const config = parseConfig(env);
  const db = createDatabaseClient(config.databasePath);

  applyMigrations(db);
  ensureWorkspaceSeeded(db, config);

  const sessionRepo = createSessionRepo(db);
  const approvalRepo = createApprovalRepo(db);
  const codexClient = new JsonRpcClient(config.codex.appServerUrl);
  const approvalDmMessages = new Map<string, ApprovalButtonMessage>();
  let discordClient: Client | undefined;
  let shuttingDown = false;

  const services: DiscordCommandServices = {
    async listWorkdirs({ guildId, channelId }) {
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return contextError;
      }

      return {
        reply: {
          content: formatWorkdirList(config.workdirs),
        },
      };
    },
    async createSession({ actorId, guildId, channelId, workdirId }) {
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return contextError;
      }

      const workdir = findConfiguredWorkdir(config, workdirId);

      if (!workdir) {
        return {
          reply: {
            content: `Unknown workdir \`${workdirId}\`.`,
            ephemeral: true,
          },
        };
      }

      const discord = requireDiscordClient(discordClient);
      const started = await codexClient.startThread({
        cwd: workdir.absolutePath,
      });
      const codexThreadId = started.thread.id;
      const thread = await createVisibleSessionThread({
        client: discord,
        controlChannelId: config.discord.controlChannelId,
        title: `${workdir.label}-session`,
        starterText: `Opening session for \`${workdir.label}\`.`,
      });

      sessionRepo.insert({
        discordThreadId: thread.id,
        codexThreadId,
        ownerDiscordUserId: actorId,
        workdirId: workdir.id,
        state: "idle",
      });
      await thread.send({
        content: renderSessionStartedText({
          type: "session.started",
          params: {
            workdirLabel: workdir.label,
            codexThreadId,
          },
        }),
      });

      return {
        reply: {
          content: `Created session <#${thread.id}> for \`${workdir.label}\`.`,
        },
      };
    },
    async importSession({ actorId, guildId, channelId, workdirId, sessionId }) {
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return contextError;
      }

      const existingSession = sessionRepo.getByCodexThreadId(sessionId);

      if (existingSession) {
        return {
          reply: {
            content: `Codex session \`${sessionId}\` is already mapped to <#${existingSession.discordThreadId}>.`,
            ephemeral: true,
          },
        };
      }

      const workdir = findConfiguredWorkdir(config, workdirId);

      if (!workdir) {
        return {
          reply: {
            content: `Unknown workdir \`${workdirId}\`.`,
            ephemeral: true,
          },
        };
      }

      const readResult = await codexClient.readThread({
        threadId: sessionId,
        includeTurns: false,
      });

      if (!isImportableThreadStatus(readResult.thread.status)) {
        return {
          reply: {
            content: `Session \`${sessionId}\` is not importable because its status is \`${describeCodexThreadStatus(readResult.thread.status)}\`.`,
            ephemeral: true,
          },
        };
      }

      await codexClient.resumeThread({ threadId: sessionId });

      const discord = requireDiscordClient(discordClient);
      const thread = await createVisibleSessionThread({
        client: discord,
        controlChannelId: config.discord.controlChannelId,
        title: `${workdir.label}-import`,
        starterText: `Importing Codex session \`${sessionId}\` for \`${workdir.label}\`.`,
      });

      sessionRepo.insert({
        discordThreadId: thread.id,
        codexThreadId: sessionId,
        ownerDiscordUserId: actorId,
        workdirId: workdir.id,
        state: inferSessionStateFromThreadStatus(readResult.thread.status),
      });
      await thread.send({
        content: renderSessionStartedText({
          type: "session.started",
          params: {
            workdirLabel: workdir.label,
            codexThreadId: sessionId,
          },
        }),
      });

      return {
        reply: {
          content: `Imported session into <#${thread.id}>.`,
        },
      };
    },
    async listSessions({ guildId, channelId }) {
      const contextError = requireConfiguredControlChannel(config, guildId, channelId);

      if (contextError) {
        return contextError;
      }

      const workdirPaths = new Set(config.workdirs.map((workdir) => workdir.absolutePath));
      const listed = await codexClient.listThreads({ limit: 50 });
      const supportedThreads = listed.data.filter((thread) =>
        workdirPaths.has(thread.cwd),
      );

      return {
        reply: {
          content: formatThreadList(supportedThreads, config.workdirs),
        },
      };
    },
  };

  const bot = createDiscordBot({
    token: config.discord.botToken,
    services,
    logger,
  });
  discordClient = bot.client;

  bot.client.on(Events.MessageCreate, (message) => {
    void (async () => {
      if (message.author.bot) {
        return;
      }

      const session = sessionRepo.getByDiscordThreadId(message.channelId);

      if (!session) {
        return;
      }

      const sessionState =
        session.state === "running"
          || session.state === "waiting-approval"
          || session.state === "degraded"
          ? (session.state as SessionRuntimeState)
          : "idle";
      const decision = decideThreadTurn({
        authorId: message.author.id,
        ownerId: session.ownerDiscordUserId,
        content: message.content,
        sessionState,
        codexThreadId: session.codexThreadId,
      });

      if (decision.kind === "noop") {
        if (decision.reason === "session-busy") {
          await message.reply("Session is already running.");
        }
        return;
      }

      if (decision.kind === "read-only") {
        await message.reply(
          renderDegradationBannerText({
            type: "session.degraded",
            params: {
              reason: session.degradationReason,
            },
          }),
        );
        return;
      }

      await codexClient.startTurn(decision.request);
      sessionRepo.updateState(session.discordThreadId, "running");
    })().catch((error) => {
      logger.error("Failed to handle Discord thread message", error);
    });
  });

  bot.client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton()) {
      return;
    }

    void handleApprovalInteraction({
      interaction,
      client: codexClient,
      sessionRepo,
      approvalRepo,
      codexClient: bot.client,
    }).catch((error) => {
      logger.error("Approval interaction failed", error);
    });
  });

  codexClient.on("turn/started", (params) => {
    void (async () => {
      const codexThreadId = readThreadIdFromEvent(params);

      if (!codexThreadId) {
        return;
      }

      const session = sessionRepo.getByCodexThreadId(codexThreadId);

      if (!session) {
        return;
      }

      sessionRepo.updateState(session.discordThreadId, "running");
      await sendTextToChannel(
        bot.client,
        session.discordThreadId,
        renderRunningStatusText({
          method: "turn/started",
          params: {
            turnId: readTurnIdFromEvent(params),
          },
        }),
      );
    })().catch((error) => {
      logger.error("Failed to process turn/started event", error);
    });
  });

  codexClient.on("thread/status/changed", (params) => {
    void (async () => {
      const codexThreadId = readThreadIdFromEvent(params);

      if (!codexThreadId) {
        return;
      }

      const session = sessionRepo.getByCodexThreadId(codexThreadId);

      if (!session) {
        return;
      }

      const status = coerceCodexThreadStatus(toRecord(params).status);

      if (status) {
        sessionRepo.updateState(
          session.discordThreadId,
          inferSessionStateFromThreadStatus(status),
        );
      }

      await sendTextToChannel(
        bot.client,
        session.discordThreadId,
        renderRunningStatusText({
          method: "thread/status/changed",
          params: {
            status: status ? describeCodexThreadStatus(status) : readString(params, "status"),
          },
        }),
      );
    })().catch((error) => {
      logger.error("Failed to process thread/status/changed event", error);
    });
  });

  codexClient.on("item/started", (params) => {
    void (async () => {
      const codexThreadId = readThreadIdFromEvent(params);

      if (!codexThreadId) {
        return;
      }

      const session = sessionRepo.getByCodexThreadId(codexThreadId);

      if (!session) {
        return;
      }

      await sendTextToChannel(
        bot.client,
        session.discordThreadId,
        renderToolProgressText({
          method: "item/started",
          params: {
            itemId: readItemIdFromEvent(params),
          },
        }),
      );
    })().catch((error) => {
      logger.error("Failed to process item/started event", error);
    });
  });

  codexClient.on("item/completed", (params) => {
    void (async () => {
      const codexThreadId = readThreadIdFromEvent(params);

      if (!codexThreadId) {
        return;
      }

      const session = sessionRepo.getByCodexThreadId(codexThreadId);

      if (!session) {
        return;
      }

      await sendTextToChannel(
        bot.client,
        session.discordThreadId,
        renderToolProgressText({
          method: "item/completed",
          params: {
            itemId: readItemIdFromEvent(params),
          },
        }),
      );
    })().catch((error) => {
      logger.error("Failed to process item/completed event", error);
    });
  });

  codexClient.on("turn/completed", (params) => {
    void (async () => {
      const codexThreadId = readThreadIdFromEvent(params);

      if (!codexThreadId) {
        return;
      }

      const session = sessionRepo.getByCodexThreadId(codexThreadId);

      if (!session) {
        return;
      }

      sessionRepo.updateState(session.discordThreadId, "idle");
      await sendTextToChannel(
        bot.client,
        session.discordThreadId,
        renderFinalAnswerText({
          method: "turn/completed",
          params: {
            text: readFinalAnswerFromEvent(params),
          },
        }),
      );
    })().catch((error) => {
      logger.error("Failed to process turn/completed event", error);
    });
  });

  codexClient.on("item/commandExecution/requestApproval", (event) => {
    void (async () => {
      const session = sessionRepo.getByCodexThreadId(event.threadId);

      if (!session) {
        return;
      }

      sessionRepo.updateState(session.discordThreadId, "waiting-approval");
      approvalRepo.insert({
        requestId: event.requestId,
        discordThreadId: session.discordThreadId,
        status: "pending",
      });
      await sendTextToChannel(
        bot.client,
        session.discordThreadId,
        `Approval pending for request \`${event.requestId}\`. Actionable controls are sent to the owner by DM.`,
      );

      try {
        const dmMessage = await maybeSendApprovalDm({
          client: bot.client,
          request: event,
          ownerId: session.ownerDiscordUserId,
          threadId: session.discordThreadId,
        });

        if (dmMessage) {
          approvalDmMessages.set(String(event.requestId), dmMessage);
        }
      } catch (error) {
        logger.warn(
          `Could not DM approval controls to ${session.ownerDiscordUserId}; local codex --remote remains the fallback path.`,
          error,
        );
      }
    })().catch((error) => {
      logger.error("Failed to process approval request event", error);
    });
  });

  codexClient.on("serverRequest/resolved", (event) => {
    void (async () => {
      const requestId = String(event.requestId);
      const approvalRecord = approvalRepo.getByRequestId(requestId);

      if (!approvalRecord) {
        return;
      }

      const outcome = applyApprovalResolutionSignal(
        {
          requestId: approvalRecord.requestId,
          status: approvalRecord.status,
        },
        {
          type: "serverRequest/resolved",
          requestId,
        },
      );

      approvalRepo.insert({
        requestId,
        discordThreadId: approvalRecord.discordThreadId,
        status: outcome.approval.status,
      });

      if (outcome.closeActiveUi) {
        const dmMessage = approvalDmMessages.get(requestId);

        if (dmMessage) {
          await dmMessage.edit({
            content: `Approval resolved: \`${outcome.approval.status}\`.`,
            components: [],
          });
          approvalDmMessages.delete(requestId);
        }
      }

      await sendTextToChannel(
        bot.client,
        approvalRecord.discordThreadId,
        `Approval resolved: \`${outcome.approval.status}\`.`,
      );
    })().catch((error) => {
      logger.error("Failed to process serverRequest/resolved event", error);
    });
  });

  await codexClient.initialize();
  await registerGuildCommands(config, bot.commands);
  await bot.start();

  const stop = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await bot.stop();
    codexClient.close();
    db.close();
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stop().catch((error) => {
        logger.error(`Failed to stop cleanly on ${signal}`, error);
      });
    });
  }

  return {
    config,
    db,
    bot,
    codexClient,
    stop,
  };
};

if (import.meta.main) {
  void startCodeHelm(process.env as Record<string, string | undefined>)
    .then(({ config }) => {
      logger.info(`CodeHelm started for Discord app ${config.discord.appId}`);
    })
    .catch((error) => {
      logger.error("CodeHelm failed to start", error);
      process.exitCode = 1;
    });
}
