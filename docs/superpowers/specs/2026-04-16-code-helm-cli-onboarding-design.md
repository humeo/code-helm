# CodeHelm CLI Onboarding Design

Date: 2026-04-16

## Summary

CodeHelm should move from an environment-variable-first daemon to a small local CLI product with a guided onboarding flow.

The first-run path should be:

1. install `code-helm`
2. run `code-helm onboard`
3. enter Discord bot token
4. choose one Discord guild
5. choose one Discord control channel
6. run `code-helm start`
7. connect Codex using the printed remote address
8. use Discord for day-to-day session work

The product model for the first version is intentionally narrow:

- one machine
- one CodeHelm instance
- one managed Codex App Server process
- one bound Discord guild
- one bound Discord control channel

CodeHelm does not install Codex.
The user is expected to already have Codex installed locally.

## Problem

The current startup model is built for a developer who already understands the repository internals:

- prepare a `.env`
- set multiple Discord and workspace variables
- separately start a Codex App Server
- then run CodeHelm

That is too heavy for a user who installs CodeHelm as a CLI tool and expects a normal product workflow.

The main issues are:

- too many startup concepts exposed too early
- environment variables act as the primary user interface
- Codex App Server lifecycle is detached from CodeHelm
- there is no explicit onboarding flow
- there is no clear local command surface for status, stop, uninstall, or autostart

The result is a tool that works for repo insiders but asks too much from first-time users.

## Approaches Considered

### 1. Keep environment variables as the primary setup path

Users would continue to prepare a `.env` or shell variables before startup.

Rejected.
This preserves the current implementation shape but does not create a user-friendly CLI product.

### 2. Build a power-user onboarding flow with many visible options

Users would choose app-server mode, file paths, secrets locations, and other advanced settings during onboarding.

Rejected for v1.
This is flexible, but it makes the first run feel like configuring an internal tool instead of starting a product.

### 3. Build a minimal managed onboarding flow

Recommended.

Users only provide the inputs that cannot be inferred automatically:

- Discord bot token
- Discord guild
- Discord control channel

Everything else is defaulted:

- managed Codex App Server lifecycle
- config file location
- secrets file location
- database location
- single-instance behavior

This keeps the first-run flow short and gives CodeHelm a clear product boundary.

## Goals

- make `code-helm` feel like a normal installable CLI product
- remove `.env` from the normal user path
- provide one explicit onboarding command
- default to a managed Codex App Server lifecycle
- keep the first-run form minimal
- provide local commands for run-state management
- keep Discord as the primary session control surface
- expose the Codex remote address clearly so users can launch Codex against the managed server

## Non-Goals

- installing Codex for the user
- multi-instance support on one machine
- exposing external app-server mode in the first-run onboarding flow
- hot-reloading runtime config while CodeHelm is already running
- replacing Discord as the primary session UI
- cleaning up legacy workspace metadata as part of this design

## Product Model

### Single Local Instance

The first version is single-instance only.

At any time, one machine may run at most one CodeHelm instance.

That instance owns:

- one config
- one secrets store
- one database
- one managed Codex App Server child process
- one bound Discord guild
- one bound Discord control channel

If a user attempts to start another instance, CodeHelm should not launch a second process.
It should report that an instance is already running and print the current status summary.

### Managed Codex App Server

CodeHelm should treat the Codex App Server as a managed child process in the normal user flow.

The user is responsible for installing Codex locally.
CodeHelm is responsible for:

- detecting that Codex is available
- starting the managed app server
- tracking its address
- shutting it down when CodeHelm exits

The managed app server is not a separate long-lived product surface in v1.
It lives and dies with CodeHelm.

### Discord As The Session Surface

The local CLI handles installation, onboarding, start/stop/status, and system lifecycle.

Discord remains the place where users actually work with sessions:

- `/workdir`
- `/session-new`
- `/session-resume`
- `/session-close`
- `/session-sync`

This preserves the current product direction:

- CLI for local daemon operations
- Discord for session operations

## Command Surface

The v1 local command surface should be:

- `code-helm onboard`
- `code-helm start`
- `code-helm start --daemon`
- `code-helm status`
- `code-helm stop`
- `code-helm autostart enable`
- `code-helm autostart disable`
- `code-helm uninstall`

Commands that are explicitly out of scope for v1:

- `restart`
- interactive uninstall confirmation variants
- multi-instance naming or profile switching

### `code-helm onboard`

Purpose:

- create or update the local CodeHelm configuration

Rules:

- if an instance is already running, do not enter the onboarding TUI
- instead, print the current status summary and tell the user to stop the instance first
- if no instance is running but config already exists, enter edit mode with existing values preselected

### `code-helm start`

Purpose:

- start CodeHelm in foreground mode by default

Rules:

- if config does not exist, automatically enter onboarding first
- after successful onboarding, continue into startup
- if an instance is already running, print the current status and exit successfully

### `code-helm start --daemon`

Purpose:

- start CodeHelm in background mode

Rules:

- same config and single-instance checks as foreground mode

### `code-helm status`

Purpose:

- show a concise operational summary

It must include:

- CodeHelm running or stopped
- foreground or background mode
- pid
- uptime
- Discord connected or disconnected
- guild
- control channel
- Codex App Server running or stopped
- Codex App Server address
- a launch hint for Codex:
  - `codex --remote <ws-url>`

The app-server address is required even in the concise view because users need it for remote Codex startup.

### `code-helm stop`

Purpose:

- stop the background CodeHelm instance

Rules:

- if no background instance exists, print `not running`
- if a background instance exists, request graceful shutdown
- foreground instances are not controlled by this command; the user stops them in the owning terminal

### `code-helm autostart enable|disable`

Purpose:

- manage login-time autostart outside onboarding

Rules:

- do not offer this in the first-run onboarding flow
- keep it as an explicit follow-up command

### `code-helm uninstall`

Purpose:

- remove CodeHelm-managed local resources

Rules:

- execute immediately without a confirmation prompt
- stop any background instance first
- disable autostart if enabled
- delete local config, secrets, database, and runtime state
- do not uninstall the global npm package itself
- print a final reminder that package removal remains:
  - `npm uninstall -g code-helm`

## Onboarding Flow

### Enter Conditions

Before the TUI starts, CodeHelm should check whether an instance is already running.

If an instance is running:

- do not open the TUI
- print the current concise status
- instruct the user to run:
  - `code-helm stop`
  - then `code-helm onboard`

If no instance is running:

- continue into onboarding

If configuration already exists:

- enter edit mode
- preload the current selections

### TUI Inputs

The first-run onboarding flow should ask for only three user-controlled values:

1. Discord bot token
2. Discord guild
3. Discord control channel

Everything else is defaulted and hidden.

### TUI Pages

#### 1. Welcome

Explain that CodeHelm will configure:

- one local daemon
- one Discord guild
- one Discord control channel

Do not expose advanced settings here.

#### 2. Bot Token

Collect the Discord bot token and validate it immediately.

Validation behavior:

- non-empty check
- Discord API validation
- fetch bot/application identity if validation succeeds

Do not ask the user for `DISCORD_APP_ID`.

#### 3. Guild Selection

Use the validated token to list guilds the bot is already in.

If the bot is not in any guild:

- stop onboarding
- instruct the user to invite the bot into the target server first

#### 4. Control Channel Selection

List usable text channels in the chosen guild.

If no suitable control channel exists:

- stop onboarding
- tell the user to create or choose a valid text channel

#### 5. Review

Show a final summary:

- bot identity
- selected guild
- selected control channel
- managed app-server mode
- config path
- secrets path
- database path

These non-user inputs are visible for transparency but not editable in the TUI.

#### 6. Finish

Save the configuration and exit.

Do not automatically start CodeHelm.
Do not offer an inline start action in v1.

The final instruction should be:

- `Run code-helm start`

## Configuration Model

### Config File

Location:

- `~/.config/code-helm/config.toml`

Contents:

- non-sensitive settings only

Suggested shape:

```toml
[discord]
guild_id = "..."
control_channel_id = "..."

[codex]
app_server_mode = "managed"

[database]
path = "~/.local/share/code-helm/codehelm.sqlite"
```

### Secrets File

Location:

- `~/.config/code-helm/secrets.toml`

Contents:

- sensitive values only

Suggested shape:

```toml
[discord]
bot_token = "..."
```

File permissions should be restricted as tightly as the platform allows.

### Database

Location:

- `~/.local/share/code-helm/codehelm.sqlite`

The database path is not user-facing in onboarding.
It should be defaulted automatically.

### Runtime State

Location:

- `~/.local/state/code-helm/`

First version should use only two runtime-state objects:

- `instance.lock`
- `runtime.json`

`instance.lock` exists to enforce single-instance startup.

`runtime.json` stores the latest known runtime summary for:

- `status`
- already-running output
- background stop and cleanup flows

Suggested contents:

- CodeHelm pid
- foreground/background mode
- start time
- Discord connection state
- selected guild
- selected control channel
- managed app-server pid
- managed app-server address
- managed app-server running state

### Environment Overrides

Environment variables are no longer the primary user path.

They remain only as advanced overrides for development, CI, or emergency recovery.

All overrides must use the `CODE_HELM_` prefix.

Minimum retained overrides:

- `CODE_HELM_CONFIG`
- `CODE_HELM_SECRETS`
- `CODE_HELM_DISCORD_BOT_TOKEN`

If more advanced overrides are added later, they must keep the same prefix.

### Configuration Priority

Recommended load order:

1. built-in defaults
2. `config.toml`
3. `secrets.toml`
4. `CODE_HELM_*` overrides

## Start, Status, Stop, And Shutdown Semantics

### Startup

`code-helm start` should perform these steps:

1. check single-instance lock
2. if unconfigured, run onboarding
3. validate Codex availability on the machine
4. load config and secrets
5. start managed Codex App Server
6. connect CodeHelm to that app server
7. start the Discord bot
8. write runtime state
9. print concise startup output

Startup output must include:

- CodeHelm running state
- pid
- mode
- Discord binding
- managed app-server address
- `codex --remote <ws-url>`

### Already Running

If `start` or `onboard` sees an already-running instance:

- do not start a second instance
- do not modify config
- print the concise status summary

### Stopping

When CodeHelm stops, it should also stop the managed Codex App Server child process.

This applies to:

- normal foreground shutdown
- daemon stop
- uninstall-driven shutdown

The managed app server is not reused across separate CodeHelm runs in v1.

## Failure Handling

### Onboarding Failure Rules

If onboarding fails:

- do not save partial config
- keep the user on the failing step when possible
- show the failing reason clearly

Important failure cases:

- invalid token
- bot not present in any guild
- no valid control channel available
- config directory creation failure
- config or secrets write failure

### Startup Failure Rules

If startup fails after partially progressing:

- stop the managed app server if this run started it
- clear the new runtime state
- do not leave behind a false running instance

Important failure cases:

- Codex binary missing
- managed app-server startup failure
- app-server connection failure
- Discord bot login failure

### Status Failure Rules

`status` should be the most reliable diagnostic command.

If runtime-state files are stale or corrupted:

- do not crash
- perform best-effort cleanup of stale state
- report `stopped` or `unknown` with a short explanation

### Stop Failure Rules

If `stop` finds stale runtime state:

- clean it up
- report `not running`

If graceful shutdown fails:

- report the failure clearly
- do not silently escalate to force-kill behavior in v1

### Uninstall Failure Rules

`uninstall` should use best-effort cleanup, but it must print what succeeded and what failed.

Examples:

- config removed
- secrets removed
- database delete failed

Do not silently swallow partial uninstall failures.

## Legacy Workspace Metadata

Legacy workspace configuration is explicitly out of this onboarding design.

The following concepts should not appear in the new user flow:

- `WORKSPACE_ID`
- `WORKSPACE_NAME`
- `WORKSPACE_ROOT`
- `WORKDIRS_JSON`

They remain a separate cleanup item and are documented in:

- `docs/workspace-legacy-cleanup.md`

## Testing And Verification Expectations

Implementation should verify at least:

- onboarding success and validation failure paths
- single-instance lock behavior
- `start` foreground and daemon modes
- already-running start behavior
- onboarding edit mode
- status output with app-server address
- stop behavior for daemon mode
- uninstall cleanup behavior
- managed app-server shutdown on CodeHelm exit

## Recommended Next Step

After this design is approved, the implementation plan should break the work into these slices:

1. CLI entrypoint and command parsing
2. config/secrets/runtime-state loading model
3. onboarding TUI
4. managed app-server supervisor
5. foreground/daemon lifecycle handling
6. status/stop/uninstall/autostart commands
7. migration of existing env-first startup into the new config-first flow
