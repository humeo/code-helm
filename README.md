# CodeHelm v1

CodeHelm v1 is a local daemon that bridges a Discord control surface to Codex App Server sessions. The product model is strict:

- one Discord bot connects to one local CodeHelm daemon
- one Discord server maps to one workspace container
- one Discord thread maps to one Codex session
- one session belongs to one `cwd` for its entire lifetime

Discord is the remote UI. The Codex App Server thread is the session source of truth.

## Required Setup

### Discord App Settings

In the Discord Developer Portal, create or configure the bot application for the target guild.

- add the bot token to `DISCORD_BOT_TOKEN`
- copy the application id into `DISCORD_APP_ID`
- install the bot into the target guild and set `DISCORD_GUILD_ID`
- choose one control channel in that guild and set `DISCORD_CONTROL_CHANNEL_ID`
- enable the `Message Content Intent` privileged intent

CodeHelm registers guild slash commands and disables DM usage for the control commands.

### Local Codex App Server Settings

CodeHelm connects to the local Codex App Server over WebSocket.

- set `CODEX_APP_SERVER_URL` to a `ws://` or `wss://` URL
- in v1, keep that server on the daemon host machine
- the supported local `codex --remote` attachment path is `codex resume --remote <ws-url> <thread-id>`; plain local `codex resume <thread-id>` is not

### Environment Variables

The daemon requires these env vars:

```bash
DISCORD_BOT_TOKEN=
DISCORD_APP_ID=
DISCORD_GUILD_ID=
DISCORD_CONTROL_CHANNEL_ID=
CODEX_APP_SERVER_URL=
DATABASE_PATH=
WORKSPACE_ID=
WORKSPACE_NAME=
```

Optional legacy bootstrap env vars still exist for importing old configured-workdir data on first boot:

```bash
WORKSPACE_ROOT=
WORKDIRS_JSON=
```

They are not required for the normal user flow.

## Workspace Model

CodeHelm v1 still uses one workspace container per daemon:

- `WORKSPACE_ID` identifies the workspace container
- `WORKSPACE_NAME` is the display name for that workspace

Normal session entry is path-first:

- `/session-new` takes a `path`
- `/session-resume` takes `path` and a path-scoped `session` choice
- users can enter absolute paths or `~/...`
- there is no configured workdir picker in the normal user flow

## Run It

Apply the database migrations first:

```bash
bun run migrate
```

Then start the daemon:

```bash
bun run dev
```

`bun run dev` starts the full CodeHelm daemon entrypoint in `src/index.ts`. That path parses config, applies migrations, optionally seeds legacy workspace/workdir rows for older installs, initializes the Codex App Server client, registers guild commands, starts the Discord bot, subscribes to Codex events, and installs shutdown hooks.

## Regression Baseline

The current product baseline and executable end-to-end regression checklist live in [`docs/baselines/e2e-baseline.md`](/Users/koltenluca/code-github/code-helm/docs/baselines/e2e-baseline.md).

## Session Flow

Use the control channel for session management, not for normal conversation.

- `session-new --path <absolute-or-tilde-path>` creates a fresh Codex session in that directory
- `session-resume --path <absolute-or-tilde-path> --session <thread-id>` attaches Discord to an existing Codex session chosen from the selected path's live Codex thread list
- `session-close` archives the current managed Discord thread without destroying the Codex session
- `session-sync` is the manual recovery path for degraded managed session threads

Session discovery lives inside `/session-resume`, not in separate list/import commands.

Session creation creates a new Codex App Server thread first, then binds it to a new Discord thread.

New managed-thread naming is bootstrap-based:

- thread creation starts with `session-id`
- the first completed reply renames the thread to the first user message

`/session-resume` is the only attach path for existing Codex sessions:

- the selected Codex thread must belong to the selected path
- if the session already has an active usable Discord thread, CodeHelm reuses that thread
- if the session has an archived Discord thread, CodeHelm syncs first and reopens that same thread
- if the session has no Discord attachment yet, CodeHelm creates a new Discord thread and binds it
- if the old Discord thread was deleted or is no longer usable, CodeHelm creates a replacement thread and rebinds the managed attachment
- if attach finds `running` or `waiting-approval`, Discord reflects that busy state without pretending the session is writable
- if attach finds `waiting-approval`, CodeHelm uses resume semantics so approval UI and DM controls can be rehydrated on the attached Discord surface

Managed attachment keeps the Codex session identity stable even when the Discord container changes:

- `session-close` archives the same Discord thread and marks the managed session `archived`
- `session-resume` reuses, reopens, creates, or replaces the Discord thread attachment around the same Codex session
- `session-sync` only reevaluates a degraded active managed thread; it does not create or replace attachments
- deleting the Discord thread is treated as detaching the Discord container, not as deleting the Codex session

## Conversation-First Transcript

CodeHelm renders one shared conversation, not separate Discord and Codex logs.

- Discord-originated user messages are recorded once and are not echoed back as a second `User:` line
- live non-Discord input observed on the daemon host is labeled `Codex CLI`
- assistant commentary stays in the process card instead of becoming durable transcript noise
- active turns use a status-only recovery probe; periodic `includeTurns=true` snapshot polling is idle-only and resumes after recovery

This keeps the thread readable as a conversation while still preserving the durable items that matter.

## Ownership And Approval

Each Discord thread has one controller: the initiating user.

- in the current runtime, only the owner can advance the session and resolve approvals
- other guild members can view the thread, read transcript, and see session status
- other guild members only see approval state; they do not get actionable approval controls

Explicit interrupt and close/archive controls are part of the v1 product model but are not yet wired into this repository snapshot.
Approval handling follows Codex protocol behavior, not a stronger ownership model.

- approval events fan out to subscribed clients
- the first processed response wins
- if Discord answers an approval, the Discord UI closes when Codex emits `serverRequest/resolved`
- if a local Codex client leaves a stale approval screen open after resolution, that is a native-client limitation
- if an approval is raised while the Discord thread is archived, CodeHelm persists it and recreates the owner DM controls on resume
- if an approval resolves while the thread is archived, CodeHelm still tears down the DM controls and updates any existing approval lifecycle message without reopening the thread

## Local Remote CLI

The local supported second client is:

```bash
codex resume --remote <ws-url> <thread-id>
```

That `codex resume --remote` path is the supported shared-thread mode. It attaches to the same live Codex App Server thread as Discord and shares transcript state, runtime state, live commentary deltas, command output summaries, and approval events. The plain local `codex resume <thread-id>` path is not supported here.

If a managed Discord thread has been closed, remote CLI activity does not auto-reopen it. CodeHelm keeps tracking the shared Codex session internally and backfills transcript/state on the next explicit or implicit Discord resume.

## Read-Only Degradation

CodeHelm treats unsupported external modification as a read-only condition in the product model.

- supported control surfaces are Discord and `codex resume --remote`
- plain local `codex resume <thread-id>` is unsupported
- the current runtime preserves already-degraded sessions as read-only
- the current runtime seeds a transcript snapshot for mapped sessions and periodically reconciles `thread/read(includeTurns=true)`
- if new snapshot items appear without having been observed on the live app-server stream, Discord marks the session read-only with reason `snapshot_mismatch`
- this is a best-effort detector for unsupported/offline modification, not a precise control-surface identifier
- once downgraded, the thread stays read-only in Discord until a trustworthy sync clears the degradation or the session is recreated

## What Has Been Verified Here

Verified in the current repo state:

- config parsing requires the documented env vars for Discord, Codex, database, and workspace identity
- Discord control commands are guild-only and DM-disabled
- the user-facing command surface is `session-new`, `session-resume`, `session-close`, and `session-sync`
- `/session-new` takes `path`
- `/session-resume` uses required `path + session` autocomplete instead of separate list/import commands
- `/session-resume` rejects Codex threads whose cwd does not match the selected path
- there is no configured workdir picker in the normal user flow
- managed thread creation starts with `session-id`
- the first completed reply renames the thread to the first user message
- `/session-resume` can attach unmanaged Codex sessions, reuse active Discord attachments, reopen archived ones, and replace deleted or unusable Discord thread containers
- waiting-approval attaches use resume semantics so approval state can be restored on the attached Discord surface
- live app-server transcript sync relays Discord-originated user messages once, labels live non-Discord user input as `Codex CLI`, keeps commentary durable only when no final reply exists, and omits successful command executions from the main transcript
- owner-only control checks are implemented for Discord thread control
- approval UI behavior is split between owner controls and status-only viewers
- the current runtime preserves already-degraded sessions as read-only

Not verified here:

- end-to-end Discord bot login against a live guild
- live Codex App Server connectivity
- `codex resume --remote` against a running daemon host
- database migrations against a real database file
- unsupported external modification detection against a real plain local `codex resume <thread-id>` session
