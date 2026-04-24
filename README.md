# CodeHelm

Control local Codex sessions from Discord.

CodeHelm runs a local daemon, manages a local Codex App Server, and turns a Discord channel into a control surface for your sessions. You can set a workdir, start or resume a session, approve requests, and follow progress in one Discord thread instead of bouncing between tools.

## Demo

- [Watch the demo video](docs/demo/04-23-code-helm.mp4)
- [See the demo storyboard](docs/demo-storyboard.md)

The demo shows the happy path end to end:

- start CodeHelm locally
- connect Codex to the printed remote address
- create or resume a session from Discord
- approve a request from Discord
- watch progress and the final answer stay in the same thread

## Why This Exists

Codex sessions are useful, but the control surface is still tied to a terminal. CodeHelm gives you a lightweight coordination layer in Discord so the session, approvals, and thread history stay attached to the same place your team is already watching.

If you have used bots that forward chat into an agent before, the idea is familiar. The difference here is that CodeHelm keeps the Discord thread bound to a real Codex session you can resume later instead of treating every exchange like a fresh stateless prompt.

## Install

Choose one install method:

```bash
npm install -g code-helm
```

```bash
bun add -g code-helm
```

> [!IMPORTANT]
> CodeHelm stores its state locally and does not require a hosted control plane.
> It writes local files under:
> `~/.config/code-helm/config.toml`,
> `~/.config/code-helm/secrets.toml`,
> `~/.local/share/code-helm/codehelm.sqlite`,
> `~/.local/state/code-helm/`,
> and `~/.codehelm/workdir`.
> To inspect the daemon, use `code-helm status`.
> To stop it, use `code-helm stop`.
> To remove local state, use `code-helm uninstall`.

Bun is still required at runtime even if you install the package with `npm`.

## Prerequisites

Before you run CodeHelm, make sure you already have:

- Bun installed on the machine
- Codex installed on the machine
- a Discord bot token
- the bot invited to the target Discord server
- one text or announcement channel to use as the control channel
- public threads enabled in that control channel
- `Message Content Intent` enabled for the bot

Setup details live in [docs/discord-bot-setup.md](docs/discord-bot-setup.md).

## Quick Start

### 1. Onboard

```bash
code-helm onboard
```

The guided setup asks for:

- your Discord bot token
- the target guild
- the control channel

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

Use the address printed by `code-helm start`:

```bash
codex --remote <ws-url>
```

If you want Codex to start in your current shell directory:

```bash
codex -C "$(pwd)" --remote <ws-url>
```

### 4. Control The Session From Discord

From the configured control channel:

- run `/workdir` to set the current workdir
- run `/session-new` to start a fresh Codex session
- run `/session-resume` to reattach an existing Codex session

Inside the managed Discord thread:

- send follow-up messages as normal thread messages
- approve requests from Discord
- watch progress updates and the final answer in the same thread

## What The Discord Flow Looks Like

1. Start the daemon locally.
2. Connect Codex to the printed remote address.
3. Open the configured control channel in Discord.
4. Pick a workdir with `/workdir`.
5. Create or resume a session.
6. Continue working in the managed session thread.

Each managed Discord thread stays attached to one Codex session, so you can leave and come back later without starting from scratch.

## Operational Commands

Use these commands to inspect, stop, or maintain the local daemon:

```bash
code-helm status
code-helm stop
code-helm check
code-helm update
```

<details>
<summary><b>More Operations</b></summary>

### Autostart

On macOS, CodeHelm can install a LaunchAgent that starts the daemon at login:

```bash
code-helm autostart enable
```

To remove it:

```bash
code-helm autostart disable
```

### Uninstall

To remove the local CodeHelm installation state:

```bash
code-helm uninstall
```

That command stops the background daemon if one is running, disables autostart when supported, and removes the local config, secrets, database, and runtime-state files.

To remove the global package too, use the same package manager you used to install it:

```bash
npm uninstall -g code-helm
bun remove -g code-helm
```

</details>

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
