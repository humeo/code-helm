# CodeHelm

Control your Codex sessions from Discord.

CodeHelm turns Discord into the control surface for your Codex sessions. Start new sessions, resume existing ones, approve requests, and follow progress without leaving Discord. Each Discord thread stays attached to its Codex session so you can come back later and keep working without starting over.

- Control Codex from Discord
- Resume and continue existing Codex sessions
- Approve requests without leaving Discord
- Watch progress and final output in the same thread

## Demo Video

A public demo video and preview asset are not published yet.
Until they are, use [Demo Storyboard](docs/demo-storyboard.md) to record a short happy-path walkthrough without guessing.

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
- one text or announcement channel to use as the control channel
- public threads enabled in that control channel
- `Message Content Intent` enabled for the bot

Need help creating the app, inviting the bot, or choosing the right permissions? See [Discord Bot Setup](docs/discord-bot-setup.md).
If you still need to create the app, generate a bot token, or install the bot to a server, start with Discord's official guide: [Building your first Discord Bot](https://docs.discord.com/developers/docs/getting-started).

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

### 3. Connect Codex

Use the printed address with:

```bash
codex --remote <ws-url>
```

If you want the remote Codex session to start in the directory you are currently in, launch Codex with:

```bash
codex -C "$(pwd)" --remote <ws-url>
```

`-C "$(pwd)"` tells Codex to use your current shell directory as the session's starting workdir.

### 4. Control The Session From Discord

Use the configured control channel to point Codex at a workdir, create or resume a session, approve requests, and follow progress:

- `/workdir`
- `/session-new`
- `/session-resume`
- approve requests from Discord
- watch progress and final output in the session thread

Each Discord thread stays attached to its Codex session so you can come back later, resume, approve, and keep working without starting over.

## How It Works

- `code-helm start` runs a local daemon.
- The daemon manages a local Codex App Server and prints the `ws-url` that Codex connects to.
- CodeHelm binds Discord threads to Codex sessions so you can resume work instead of starting from scratch.
- Session state, approval state, and thread metadata are persisted locally.

### Runtime And Cleanup Commands

To inspect or stop the local daemon:

```bash
code-helm status
code-helm stop
```

On macOS, CodeHelm can install a LaunchAgent that starts the daemon at login:

```bash
code-helm autostart enable
```

To remove it:

```bash
code-helm autostart disable
```

On unsupported platforms, CodeHelm returns a clear unsupported result instead of pretending it worked.

To remove the local CodeHelm installation and state:

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
