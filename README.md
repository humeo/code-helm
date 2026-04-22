# CodeHelm

Control your Codex sessions from Discord.

CodeHelm turns Discord into the control surface for your Codex sessions. Start new sessions, resume existing ones, approve requests, and follow progress without leaving Discord. Each Discord thread stays attached to its Codex session so you can come back later and keep working without starting over.

- Control Codex from Discord
- Resume and continue existing Codex sessions
- Approve requests without leaving Discord
- Watch progress and final output in the same thread

## Demo Video

- [TODO: add demo video link]
- [TODO: add demo thumbnail or GIF]
- [TODO: define what the demo should show]

The demo should show:

- starting CodeHelm
- connecting Codex with the printed `ws-url`
- creating or resuming a session from Discord
- approving a request from Discord
- watching progress and final output in the session thread

## Prerequisites

Before you install CodeHelm, make sure you already have:

- Bun installed on the machine
- Codex installed on the machine
- a Discord bot token
- the bot invited to the target Discord server
- one text channel to use as the control channel
- `Message Content Intent` enabled for the bot
- [TODO: add Discord bot setup guide/link]

## Install

Choose one install method:

```bash
npm install -g code-helm
```

```bash
bun add -g code-helm
```

Bun is still required at runtime no matter which install command you choose. CodeHelm keeps its config, secrets, database, and runtime state locally; see `Operational Notes` below for the exact paths and cleanup commands.

## Quick Start

### 1. Onboard

```bash
code-helm onboard
```

The guided setup asks for your Discord bot token, target server, and control channel.

### 2. Start CodeHelm

Foreground:

```bash
code-helm start
```

Background:

```bash
code-helm start --daemon
```

- [TODO: add sample startup output with ws-url]

### 3. Connect Codex

Use the printed address with:

```bash
codex --remote <ws-url>
```

### 4. Control The Session From Discord

Use the configured control channel to point Codex at a workdir, create or resume a session, approve requests, and follow progress:

- `/workdir`
- `/session-new`
- `/session-resume`
- approve requests from Discord
- watch progress and final output in the session thread
- [TODO: add Discord thread screenshot or transcript snippet]
- [TODO: add approval screenshot or transcript snippet]

Each Discord thread stays attached to its Codex session so you can come back later, resume, approve, and keep working without starting over.

## Why CodeHelm

If you already use `codex --remote`, the model is familiar. CodeHelm packages that flow into one local daemon and a Discord-first control surface so you do not need to babysit a separate app-server process or rebuild session context every time.

CodeHelm is not just a Discord bot wrapper. It is a remote control layer for Codex sessions, with thread-to-session continuity, approval handling, and progress visibility built into the day-to-day workflow.

## How It Works

- `code-helm start` runs a local daemon.
- The daemon manages a local Codex App Server and prints the `ws-url` that Codex connects to.
- CodeHelm binds Discord threads to Codex sessions so you can resume work instead of starting from scratch.
- Session state, approval state, and thread metadata are persisted locally.

## Operational Notes

Normal local state lives here:

- config: `~/.config/code-helm/config.toml`
- secrets: `~/.config/code-helm/secrets.toml`
- database: `~/.local/share/code-helm/codehelm.sqlite`
- runtime state: `~/.local/state/code-helm/`

CodeHelm touches:

- Discord API for bot login, command registration, and thread operations
- a local managed Codex App Server on loopback
- local config, secrets, database, and runtime-state files

CodeHelm does not install for you:

- Bun
- Codex
- a hand-written `.env` file for the normal onboarding flow

To inspect or stop the local daemon:

```bash
code-helm status
code-helm stop
```

## Check And Update

CodeHelm can check the published package version without changing your installation:

```bash
code-helm check
```

To check and immediately continue into the same update flow:

```bash
code-helm check --yes
```

To update directly:

```bash
code-helm update
```

Update behavior:

- `check` shows the installed version, latest published version, detected package manager, and the update command it would use.
- `check --yes` skips the confirmation step and runs the same update path as `code-helm update`.
- `update` auto-detects whether this global install is managed by `npm` or `bun` and uses the matching global update command.
- If CodeHelm is running in the foreground, the package can still update, but that already-running foreground process stays on the old version until you stop it and start CodeHelm again.
- If CodeHelm is running as a background daemon, `update` stops it before installing and restarts it automatically when possible.
- If the daemon does not come back automatically after update, CodeHelm tells you to recover with `code-helm start --daemon`.

## Autostart

On macOS, CodeHelm can install a LaunchAgent that starts the daemon at login:

```bash
code-helm autostart enable
```

To remove it:

```bash
code-helm autostart disable
```

On unsupported platforms, CodeHelm returns a clear unsupported result instead of pretending it worked.

## Uninstall

```bash
code-helm uninstall
```

That command stops the background daemon if one is running, disables autostart when supported, and removes local config, secrets, database, and runtime-state files.

To remove the global package too, use the same package manager you used to install it:

```bash
npm uninstall -g code-helm
bun remove -g code-helm
```

## Development

For local repository development:

```bash
bun install
bun test
bun run typecheck
```

Useful development commands:

```bash
bun run dev
bun run migrate
```

Release workflow and publishing notes live in [docs/release.md](./docs/release.md).
