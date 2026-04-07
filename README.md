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

## Session Flow

Use the control channel for session management, not for normal conversation.

- `workdir-list` shows the configured workdirs
- `session-new --workdir <id>` creates a new Codex session in that workdir
- `session-import --workdir <id> --session <thread-id>` attaches Discord to an existing idle session
- `session-list` shows known sessions

Session creation creates a new Codex App Server thread and binds it to a new Discord thread. Import reuses an existing Codex thread and creates the Discord thread around it.

Import is intentionally narrow:

- only `idle` and `notLoaded` Codex thread states are importable
- `running` sessions cannot be imported
- `waiting-approval` sessions cannot be imported

## Ownership And Approval

Each Discord thread has one controller: the initiating user.

- only the owner can advance the session, approve or cancel approvals, interrupt, or close/archive the thread
- other guild members can view the thread, read transcript, and see session status
- other guild members only see approval state; they do not get actionable approval controls

Approval handling follows Codex protocol behavior, not a stronger ownership model.

- approval events fan out to subscribed clients
- the first processed response wins
- if Discord answers an approval, the Discord UI closes when Codex emits `serverRequest/resolved`
- if a local Codex client leaves a stale approval screen open after resolution, that is a native-client limitation

## Local Remote CLI

The local supported second client is:

```bash
codex resume --remote <ws-url> <thread-id>
```

That local `codex --remote` path attaches to the same live Codex App Server thread as Discord, sharing transcript, runtime state, and approval events. The concrete CLI invocation is `codex resume --remote ...`, and it is only supported on the daemon host through `--remote`.

## Read-Only Degradation

CodeHelm treats unsupported external modification as a read-only condition.

- supported control surfaces are Discord and `codex resume --remote`
- plain local `codex resume <thread-id>` is unsupported
- if CodeHelm detects an unsupported advance, the Discord thread is degraded to read-only
- read-only mode keeps transcript and status visible, but disables new Discord messages, approvals, and interrupt controls

## What Has Been Verified Here

Verified in the current repo state:

- config parsing requires the documented env vars and validates `WORKDIRS_JSON`
- `WORKDIRS_JSON` paths must be absolute and under `WORKSPACE_ROOT`
- Discord control commands are guild-only and DM-disabled
- import eligibility is limited to idle / notLoaded thread states
- owner-only control checks are implemented for Discord thread control
- approval UI behavior is split between owner controls and status-only viewers
- unsupported external modification degrades the Discord thread to read-only

Not verified here:

- end-to-end Discord bot login against a live guild
- live Codex App Server connectivity
- `codex resume --remote` against a running daemon host
- database migrations against a real database file
- the full daemon loop beyond the current `src/index.ts` startup entrypoint
