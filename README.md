# CodeHelm

CodeHelm turns Codex into a local daemon you control from Discord.

GitHub: `https://github.com/humeo/code-helm`

It solves the awkward setup that usually comes with remote Codex sessions:

- no manual `.env` as the normal user path
- no separate Codex App Server process to start yourself
- one local daemon lifecycle with `onboard`, `start`, `status`, `stop`, `autostart`, and `uninstall`
- Discord stays the day-to-day session surface

## What It Does

- stores your CodeHelm config locally in TOML
- manages a local Codex App Server for you
- prints the remote address you use with `codex --remote <ws-url>`
- registers and serves the Discord control commands
- keeps Discord threads attached to Codex sessions

## Before You Install

You need these tools on the machine:

- `bun`
- `codex`
- a Discord bot application that is already invited to the target server

The bot needs:

- the bot token
- access to one target guild
- one text channel to act as the control channel
- `Message Content Intent` enabled

## Trust And Local State

CodeHelm does not install Codex for you.

Normal local state lives here:

- config: `~/.config/code-helm/config.toml`
- secrets: `~/.config/code-helm/secrets.toml`
- database: `~/.local/share/code-helm/codehelm.sqlite`
- runtime state: `~/.local/state/code-helm/`

What it touches:

- Discord API for bot login, command registration, and thread operations
- a local managed Codex App Server on loopback
- local config, secrets, database, and runtime-state files

What it does not try to do:

- it does not uninstall the global npm package for you
- it does not install Codex for you
- it does not require a hand-written `.env` for the normal flow

To stop it immediately:

```bash
code-helm stop
```

To remove local state:

```bash
code-helm uninstall
```

## Install

CodeHelm is published as an npm package, but it still runs on Bun at runtime. Install Bun first, then install CodeHelm globally:

```bash
npm install -g code-helm
```

Confirm what you installed:

```bash
code-helm version
code-helm help
```

## Quick Start

### 1. Onboard

```bash
code-helm onboard
```

The onboarding flow asks for only:

- your Discord bot token
- the guild to bind
- the control channel to bind

Everything else is defaulted and hidden.

### 2. Start CodeHelm

Foreground:

```bash
code-helm start
```

Background:

```bash
code-helm start --daemon
```

When startup succeeds, CodeHelm prints a concise status summary including the managed Codex App Server address.

### 3. Connect Codex Remote

Use the printed address with:

```bash
codex --remote <ws-url>
```

### 4. Use Discord

In the configured control channel, use:

- `/workdir`
- `/session-new`
- `/session-resume`
- `/session-close`
- `/session-sync`

## Day-To-Day Commands

```bash
code-helm help
code-helm version
code-helm status
code-helm stop
code-helm update
code-helm autostart enable
code-helm autostart disable
code-helm uninstall
```

`code-helm status` always includes the current Codex remote address and the matching:

```bash
codex --remote <ws-url>
```

## Update

To install the latest published npm release:

```bash
code-helm update
```

This command runs:

```bash
npm install -g code-helm@latest
```

What it updates:

- the global `code-helm` npm package for future invocations and restarts

What it does not update:

- Bun
- Codex
- an already-running CodeHelm process in the current session

## See It Work

```bash
$ code-helm onboard
$ code-helm start
CodeHelm running
Mode: foreground
PID: 12345
Discord: connected guild 123 channel 456
Codex App Server: running ws://127.0.0.1:4123
Connect: codex --remote ws://127.0.0.1:4123

$ codex --remote ws://127.0.0.1:4123
```

Then switch to Discord and open or resume a session from the configured control channel.

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

This removes CodeHelm-managed local resources:

```bash
code-helm uninstall
```

That command:

- stops the background daemon if one is running
- disables autostart when supported
- removes local config, secrets, database, and runtime-state files

It does not remove the global npm package. To do that too:

```bash
npm uninstall -g code-helm
```

## Development

For local repo development:

```bash
bun install
bun test
bun run typecheck
```

Useful dev commands:

```bash
bun run dev
bun run migrate
```

Release workflow:

- see [docs/release.md](./docs/release.md) for the npm and GitHub publishing steps
- CI/CD workflows live in `.github/workflows/ci.yml` and `.github/workflows/publish.yml`

## Advanced Overrides

Normal users should prefer `code-helm onboard`.

If you need to override paths or inject values in development, see [.env.example](./.env.example).

## Legacy Workspace Import

CodeHelm still preserves a compatibility bridge for older installs that used:

- `WORKSPACE_ROOT`
- `WORKDIRS_JSON`

That path is legacy-only and not part of the normal onboarding flow.
