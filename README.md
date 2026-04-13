# CodeHelm v1

CodeHelm v1 is a local daemon that bridges a Discord control surface to Codex App Server sessions. The product model is strict:

- one Discord bot connects to one local CodeHelm daemon
- one Discord server maps to one workspace container
- one Discord thread maps to one Codex session
- one session belongs to one workdir for its entire lifetime

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
WORKSPACE_ROOT=
WORKDIRS_JSON=
```

`WORKDIRS_JSON` must be valid JSON and each entry must look like:

```json
{"id":"main","label":"Main","absolutePath":"/absolute/path/to/workspace"}
```

Rules enforced by the config parser:

- `WORKSPACE_ROOT` must be absolute
- every workdir path must be absolute
- every workdir path must live under `WORKSPACE_ROOT`
- workdir ids must be unique
- workdir paths must be unique

## Workspace Model

CodeHelm v1 uses one workspace per daemon. The daemon does not auto-discover workdirs.

- `WORKSPACE_ID` identifies the workspace container
- `WORKSPACE_NAME` is the display name for that workspace
- `WORKSPACE_ROOT` is the absolute root that contains all configured workdirs
- `WORKDIRS_JSON` is the explicit registry of allowed workdirs

If you need a different workspace root, run a different daemon instance.

## Run It

Apply the database migrations first:

```bash
bun run migrate
```

Then start the daemon:

```bash
bun run dev
```

`bun run dev` starts the full CodeHelm daemon entrypoint in `src/index.ts`. That path parses config, applies migrations, seeds the configured workspace/workdirs, initializes the Codex App Server client, registers guild commands, starts the Discord bot, subscribes to Codex events, and installs shutdown hooks.

## Regression Baseline

The current product baseline and executable end-to-end regression checklist live in [`docs/baselines/e2e-baseline.md`](/Users/koltenluca/code-github/code-helm/docs/baselines/e2e-baseline.md).

## Session Flow

Use the control channel for session management, not for normal conversation.

- `workdir-list` shows the configured workdirs
- `session-new --workdir <id>` creates a new Codex session in that workdir
- `session-import --workdir <id> --session <thread-id>` attaches Discord to an existing idle session
- `session-close` archives the current managed Discord thread without destroying the Codex session
- `session-resume --session <thread-id>` syncs and reopens an archived managed session on the same Discord thread
- `session-list` shows known sessions

Session creation creates a new Codex App Server thread first, then binds it to a new Discord thread. Import reuses an existing Codex thread, resumes it first, then creates the Discord thread around it and backfills the durable conversation-first subset into Discord.

Import is intentionally narrow:

- only `idle` and `notLoaded` Codex thread states are importable
- `running` sessions cannot be imported
- `waiting-approval` sessions cannot be imported

Close and resume keep `thread = session` intact:

- `session-close` archives the same Discord thread and marks the managed session `archived`
- `session-resume` always syncs the Codex session first, then reopens that same thread
- a resumed thread only accepts new Discord input after sync says the session is `idle`
- if resume sync finds `running` or `waiting-approval`, the thread reopens but the original message is not forwarded
- if resume sync finds a degraded session, the thread reopens in read-only mode
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
- once downgraded, the thread stays read-only in Discord until the session is recreated or re-imported

## What Has Been Verified Here

Verified in the current repo state:

- config parsing requires the documented env vars and validates `WORKDIRS_JSON`
- `WORKDIRS_JSON` paths must be absolute and under `WORKSPACE_ROOT`
- Discord control commands are guild-only and DM-disabled
- import eligibility is limited to idle / notLoaded thread states
- import also rejects Codex threads whose cwd does not match the selected workdir
- imported sessions backfill the durable conversation-first subset into the new Discord thread
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
