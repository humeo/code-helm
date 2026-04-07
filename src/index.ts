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
  type AnyThreadChannel,
  type Client,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { JsonRpcClient } from "./codex/jsonrpc-client";
import type {
  CodexAgentMessageItem,
  CodexCommandExecutionItem,
  ApprovalRequestEvent,
  CodexThread,
  CodexThreadStatus,
  CodexTurn,
  CodexTurnItem,
  CodexUserMessageItem,
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
import { shouldDegradeDiscordToReadOnly } from "./domain/external-modification";
import { applyApprovalResolutionSignal, renderApprovalUi } from "./discord/approval-ui";
import { createDiscordBot } from "./discord/bot";
import type { DiscordCommandResult, DiscordCommandServices } from "./discord/commands";
import {
  renderDegradationBannerText,
  renderRunningStatusText,
  renderSessionStartedText,
  renderToolProgressText,
} from "./discord/renderers";
import {
  collectTranscriptEntries,
  collectTranscriptItemIds,
  renderTranscriptEntry,
} from "./discord/transcript";
import { decideThreadTurn } from "./discord/thread-handler";
import { logger } from "./logger";

const approvalButtonPrefix = "approval";

type SessionRuntimeState = "idle" | "running" | "waiting-approval" | "degraded";
type ApprovalAction = "approve" | "decline" | "cancel";
type ApprovalButtonMessage = Message<boolean>;
type StreamingTranscriptMessage = Message<boolean>;
type SendableChannel = {
  send(payload: { content: string; components?: unknown[] }): Promise<Message<boolean>>;
};
type ThreadStarterMessage = Message<boolean> & {
  startThread(options: {
    name: string;
    autoArchiveDuration: ThreadAutoArchiveDuration;
    reason?: string;
  }): Promise<AnyThreadChannel>;
};
type TranscriptRuntime = {
  seenItemIds: Set<string>;
  pendingDiscordInputs: string[];
  streamingAgentMessages: Map<
    string,
    {
      phase?: string | null;
      text: string;
      message?: StreamingTranscriptMessage;
    }
  >;
};

const sessionSnapshotPollIntervalMs = 15_000;

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

export const canImportThreadIntoWorkdir = (
  thread: Pick<CodexThread, "cwd" | "status">,
  workdirPath: string,
) => {
  return thread.cwd === workdirPath && isImportableThreadStatus(thread.status);
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

const readEventItem = (params: unknown) => {
  const candidate = toRecord(params).item;

  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as CodexTurnItem)
    : undefined;
};

const hasItemId = (item: CodexTurnItem | undefined): item is CodexTurnItem & {
  id: string;
} => {
  return !!item && typeof item.id === "string" && item.id.length > 0;
};

const isUserMessageItem = (item: CodexTurnItem | undefined): item is CodexUserMessageItem => {
  return hasItemId(item) && item.type === "userMessage";
};

const isAgentMessageItem = (item: CodexTurnItem | undefined): item is CodexAgentMessageItem => {
  return hasItemId(item) && item.type === "agentMessage" && typeof item.text === "string";
};

const isCommandExecutionItem = (
  item: CodexTurnItem | undefined,
): item is CodexCommandExecutionItem => {
  return hasItemId(item) && item.type === "commandExecution" && typeof item.command === "string";
};

const buildTranscriptRuntime = (): TranscriptRuntime => {
  return {
    seenItemIds: new Set<string>(),
    pendingDiscordInputs: [],
    streamingAgentMessages: new Map(),
  };
};

const relayTranscriptEntries = async ({
  client,
  channelId,
  runtime,
  turns,
}: {
  client: Client;
  channelId: string;
  runtime: TranscriptRuntime;
  turns: CodexTurn[] | undefined;
}) => {
  for (const entry of collectTranscriptEntries(turns)) {
    if (runtime.seenItemIds.has(entry.itemId)) {
      continue;
    }

    if (
      entry.kind === "user"
      && runtime.pendingDiscordInputs.length > 0
      && runtime.pendingDiscordInputs[0] === entry.text
    ) {
      runtime.pendingDiscordInputs.shift();
      runtime.seenItemIds.add(entry.itemId);
      continue;
    }

    const rendered = renderTranscriptEntry(entry);

    if (rendered.length > 0) {
      await sendTextToChannel(client, channelId, rendered);
    }

    runtime.seenItemIds.add(entry.itemId);
  }

  for (const itemId of collectTranscriptItemIds(turns)) {
    runtime.seenItemIds.add(itemId);
  }
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

const listSupportedThreads = async (
  client: JsonRpcClient,
  workdirs: WorkdirConfig[],
) => {
  const workdirPaths = new Set(workdirs.map((workdir) => workdir.absolutePath));
  const threads: CodexThread[] = [];
  let cursor: string | null = null;

  do {
    const page = await client.listThreads({
      limit: 50,
      cursor,
    });

    threads.push(...page.data.filter((thread) => workdirPaths.has(thread.cwd)));
    cursor = page.nextCursor;
  } while (cursor);

  return threads;
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
    return undefined;
  }

  return channel.send({ content });
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

  if (session.state === "degraded") {
    await interaction.reply({
      content: "This session is read-only because it was modified outside the supported flow.",
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
  const transcriptRuntimes = new Map<string, TranscriptRuntime>();
  let discordClient: Client | undefined;
  let shuttingDown = false;

  const ensureTranscriptRuntime = (codexThreadId: string) => {
    const existing = transcriptRuntimes.get(codexThreadId);

    if (existing) {
      return existing;
    }

    const runtime = buildTranscriptRuntime();
    transcriptRuntimes.set(codexThreadId, runtime);
    return runtime;
  };

  const updateSessionStateIfWritable = (
    session: ReturnType<typeof sessionRepo.getByCodexThreadId>,
    nextState: SessionRuntimeState,
  ) => {
    if (!session || session.state === "degraded") {
      return;
    }

    sessionRepo.updateState(session.discordThreadId, nextState);
  };

  const degradeSessionToReadOnly = async ({
    discord,
    session,
    reason,
  }: {
    discord: Client;
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    reason: string;
  }) => {
    if (session.state === "degraded") {
      return;
    }

    sessionRepo.markExternallyModified(session.discordThreadId, reason);
    await sendTextToChannel(
      discord,
      session.discordThreadId,
      renderDegradationBannerText({
        type: "session.degraded",
        params: { reason },
      }),
    );
  };

  const syncTranscriptSnapshot = async ({
    discord,
    session,
    degradeOnUnexpectedItems,
  }: {
    discord: Client;
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    degradeOnUnexpectedItems: boolean;
  }) => {
    const runtime = ensureTranscriptRuntime(session.codexThreadId);
    const snapshot = await codexClient.readThread({
      threadId: session.codexThreadId,
      includeTurns: true,
    });
    const turns = snapshot.thread.turns;
    const unseenItemIds = collectTranscriptItemIds(turns).filter(
      (itemId) => !runtime.seenItemIds.has(itemId),
    );

    if (
      degradeOnUnexpectedItems
      && unseenItemIds.length > 0
      && shouldDegradeDiscordToReadOnly({ controlSurface: "unknown" })
    ) {
      await degradeSessionToReadOnly({
        discord,
        session,
        reason: "snapshot_mismatch",
      });
    }

    await relayTranscriptEntries({
      client: discord,
      channelId: session.discordThreadId,
      runtime,
      turns,
    });
  };

  const seedTranscriptRuntimeFromSnapshot = async (session: {
    codexThreadId: string;
  }) => {
    const runtime = ensureTranscriptRuntime(session.codexThreadId);
    const snapshot = await codexClient.readThread({
      threadId: session.codexThreadId,
      includeTurns: true,
    });

    for (const itemId of collectTranscriptItemIds(snapshot.thread.turns)) {
      runtime.seenItemIds.add(itemId);
    }
  };

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

      const started = await codexClient.startThread({
        cwd: workdir.absolutePath,
      });
      const codexThreadId = started.thread.id;
      const discord = requireDiscordClient(discordClient);
      let thread: AnyThreadChannel | undefined;

      try {
        thread = await createVisibleSessionThread({
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
        ensureTranscriptRuntime(codexThreadId);
        await thread.send({
          content: renderSessionStartedText({
            type: "session.started",
            params: {
              workdirLabel: workdir.label,
              codexThreadId,
            },
          }),
        });
      } catch (error) {
        if (thread) {
          try {
            await thread.delete("CodeHelm failed to bind the new session");
          } catch (deleteError) {
            logger.warn("Failed to clean up orphan Discord thread after session creation", deleteError);
          }
        }
        throw error;
      }

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
        includeTurns: true,
      });

      if (!canImportThreadIntoWorkdir(readResult.thread, workdir.absolutePath)) {
        return {
          reply: {
            content:
              readResult.thread.cwd !== workdir.absolutePath
                ? `Session \`${sessionId}\` belongs to \`${readResult.thread.cwd}\`, not workdir \`${workdir.id}\`.`
                : `Session \`${sessionId}\` is not importable because its status is \`${describeCodexThreadStatus(readResult.thread.status)}\`.`,
            ephemeral: true,
          },
        };
      }

      await codexClient.resumeThread({ threadId: sessionId });

      const discord = requireDiscordClient(discordClient);
      let thread: AnyThreadChannel | undefined;

      try {
        thread = await createVisibleSessionThread({
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
        await syncTranscriptSnapshot({
          discord,
          session: sessionRepo.getByDiscordThreadId(thread.id)!,
          degradeOnUnexpectedItems: false,
        });
      } catch (error) {
        if (thread) {
          try {
            await thread.delete("CodeHelm failed to bind the imported session");
          } catch (deleteError) {
            logger.warn("Failed to clean up orphan Discord thread after session import", deleteError);
          }
        }
        throw error;
      }

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

      const supportedThreads = await listSupportedThreads(
        codexClient,
        config.workdirs,
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

  const renderStreamingAgentMessage = (phase: string | null | undefined, text: string) => {
    return renderTranscriptEntry({
      itemId: "stream",
      kind: "assistant",
      text,
      phase,
    });
  };

  const publishAgentDelta = async ({
    discord,
    session,
    itemId,
    delta,
  }: {
    discord: Client;
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    itemId: string;
    delta: string;
  }) => {
    if (session.state === "degraded") {
      return;
    }

    const runtime = ensureTranscriptRuntime(session.codexThreadId);
    const current = runtime.streamingAgentMessages.get(itemId) ?? {
      phase: undefined,
      text: "",
      message: undefined,
    };

    current.text += delta;
    runtime.streamingAgentMessages.set(itemId, current);

    const content = renderStreamingAgentMessage(current.phase, current.text);

    if (current.message) {
      await current.message.edit({ content });
      return;
    }

    const message = await sendTextToChannel(discord, session.discordThreadId, content);

    if (message) {
      current.message = message;
    }
  };

  const finalizeAgentTranscriptMessage = async ({
    discord,
    session,
    item,
  }: {
    discord: Client;
    session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>;
    item: CodexAgentMessageItem;
  }) => {
    const runtime = ensureTranscriptRuntime(session.codexThreadId);
    const current = runtime.streamingAgentMessages.get(item.id);
    const rendered = renderTranscriptEntry({
      itemId: item.id,
      kind: "assistant",
      text: item.text,
      phase: item.phase,
    });

    if (current?.message) {
      await current.message.edit({ content: rendered });
    } else {
      await sendTextToChannel(discord, session.discordThreadId, rendered);
    }

    runtime.seenItemIds.add(item.id);
    runtime.streamingAgentMessages.delete(item.id);
  };

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

      const runtime = ensureTranscriptRuntime(session.codexThreadId);

      runtime.pendingDiscordInputs.push(message.content);

      try {
        await codexClient.startTurn(decision.request);
        updateSessionStateIfWritable(session, "running");
      } catch (error) {
        if (runtime.pendingDiscordInputs.at(-1) === message.content) {
          runtime.pendingDiscordInputs.pop();
        }
        throw error;
      }
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

      updateSessionStateIfWritable(session, "running");
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
        updateSessionStateIfWritable(
          session,
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

      const item = readEventItem(params);

      if (isAgentMessageItem(item)) {
        const runtime = ensureTranscriptRuntime(session.codexThreadId);
        runtime.streamingAgentMessages.set(item.id, {
          phase: item.phase,
          text: item.text,
          message: undefined,
        });
        return;
      }

      if (!isCommandExecutionItem(item)) {
        return;
      }

      await sendTextToChannel(
        bot.client,
        session.discordThreadId,
        renderToolProgressText({
          method: "item/started",
          params: {
            itemId: item.id,
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

      const item = readEventItem(params);
      const runtime = ensureTranscriptRuntime(session.codexThreadId);

      if (!item) {
        return;
      }

      if (isAgentMessageItem(item)) {
        if (session.state === "degraded") {
          runtime.seenItemIds.add(item.id);
          runtime.streamingAgentMessages.delete(item.id);
          return;
        }

        await finalizeAgentTranscriptMessage({
          discord: bot.client,
          session,
          item,
        });
        return;
      }

      if (session.state === "degraded") {
        if (hasItemId(item)) {
          runtime.seenItemIds.add(item.id);
        }
        return;
      }

      await relayTranscriptEntries({
        client: bot.client,
        channelId: session.discordThreadId,
        runtime,
        turns: [
          {
            id: readTurnIdFromEvent(params) ?? "live",
            items: [item],
          },
        ],
      });
    })().catch((error) => {
      logger.error("Failed to process item/completed event", error);
    });
  });

  codexClient.on("item/agentMessage/delta", (params) => {
    void (async () => {
      const codexThreadId = readThreadIdFromEvent(params);
      const itemId = readString(params, "itemId");
      const delta = readString(params, "delta");

      if (!codexThreadId || !itemId || !delta) {
        return;
      }

      const session = sessionRepo.getByCodexThreadId(codexThreadId);

      if (!session) {
        return;
      }

      await publishAgentDelta({
        discord: bot.client,
        session,
        itemId,
        delta,
      });
    })().catch((error) => {
      logger.error("Failed to process item/agentMessage/delta event", error);
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

      updateSessionStateIfWritable(session, "idle");
      await syncTranscriptSnapshot({
        discord: bot.client,
        session,
        degradeOnUnexpectedItems: false,
      });
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

      if (session.state === "degraded") {
        await sendTextToChannel(
          bot.client,
          session.discordThreadId,
          `Approval pending for request \`${event.requestId}\`, but this session is already read-only in Discord.`,
        );
        return;
      }

      updateSessionStateIfWritable(session, "waiting-approval");
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
          `Could not DM approval controls to ${session.ownerDiscordUserId}; local codex resume --remote remains the fallback path.`,
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

  for (const session of sessionRepo.listAll()) {
    try {
      await seedTranscriptRuntimeFromSnapshot(session);
    } catch (error) {
      logger.warn(
        `Failed to seed transcript runtime for mapped session ${session.codexThreadId}`,
        error,
      );
    }
  }

  const snapshotPoll = setInterval(() => {
    void (async () => {
      for (const session of sessionRepo.listAll()) {
        if (session.state === "degraded") {
          continue;
        }

        try {
          await syncTranscriptSnapshot({
            discord: bot.client,
            session,
            degradeOnUnexpectedItems: true,
          });
        } catch (error) {
          logger.warn(
            `Failed to reconcile transcript snapshot for ${session.codexThreadId}`,
            error,
          );
        }
      }
    })().catch((error) => {
      logger.error("Snapshot reconciliation loop failed", error);
    });
  }, sessionSnapshotPollIntervalMs);

  const stop = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    clearInterval(snapshotPoll);
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
