<div align="center">

<img src="docs/assets/codehelm-product-banner.png" alt="CodeHelm" width="760" />

<h2>Run Codex locally. Control it from Discord.</h2>

<p><strong>Approve, resume, interrupt, and monitor AI coding work from your phone.</strong></p>

<p>
CodeHelm lets you start, resume, approve, interrupt, and monitor local Codex
sessions from a Discord thread.
</p>

[![npm](https://img.shields.io/npm/v/code-helm?style=flat-square&color=111827)](https://www.npmjs.com/package/code-helm)
[![Bun](https://img.shields.io/badge/runtime-Bun-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Discord](https://img.shields.io/badge/Discord-control%20surface-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.com/developers/docs/intro)

<br />

[English](README.md) · [中文](README.zh-CN.md)

<br />

[Demo](#demo) · [Quick Start](#quick-start) · [Workflow](#workflow) · [Discord Setup](docs/discord-bot-setup.md) · [Development](#development)

</div>

## ⚡ Overview

CodeHelm runs a local daemon, manages a local Codex App Server, and turns a
Discord channel into a control surface for Codex sessions. You can set a
workdir, start or resume a session, approve requests, interrupt a running turn,
and follow progress in one Discord thread instead of bouncing between tools.

Perfect for:

- approving Codex actions while away from your terminal
- keeping AI coding sessions visible to your team
- resuming long-running sessions without losing context

> You only need to: start CodeHelm locally, connect Codex to the printed remote
> address, and use the configured Discord channel.
>
> CodeHelm will return: a managed Discord thread attached to a real Codex
> session, with transcript updates, approval controls, and final output in one
> place.

## Demo

<img src="docs/demo/04-23-code-helm.gif" alt="CodeHelm Discord remote-control demo" width="100%" />

## Workflow

1. **Start the local daemon**: CodeHelm connects to Discord and starts a managed
   Codex App Server on loopback.
2. **Connect Codex**: run `codex --remote <ws-url>` with the address printed by
   `code-helm start`.
3. **Choose a workdir**: use `/workdir` in the configured Discord control
   channel.
4. **Create or resume a session**: use `/session-new` or `/session-resume`.
5. **Work inside the managed thread**: send follow-up messages, approve
   requests, inspect status, interrupt turns, and read the final answer.

Each managed Discord thread stays attached to one Codex session, so you can
leave and come back later without starting from scratch.

## Quick Start

### Install

#### Prerequisites

| Tool or setup   | Requirement                                      | Check                                            |
| --------------- | ------------------------------------------------ | ------------------------------------------------ |
| Bun             | Installed on the machine running CodeHelm        | `bun --version`                                  |
| Codex           | Installed on the same machine                    | `codex --version`                                |
| Discord bot     | Bot token, target server, control channel        | [Discord setup guide](docs/discord-bot-setup.md) |
| Discord channel | Text or announcement channel with public threads | Check channel permissions                        |
| Bot intent      | `Message Content Intent` enabled                 | Discord Developer Portal                         |

#### 1. Install CodeHelm

Choose one install method:

```bash
npm install -g code-helm
```

```bash
bun add -g code-helm
```

Bun is still required at runtime even if you install the package with `npm`.

#### 2. Onboard Discord

```bash
code-helm onboard
```

The guided setup asks for:

- your Discord bot token
- the target guild
- the control channel

#### 3. Start CodeHelm

Foreground:

```bash
code-helm start
```

Background:

```bash
code-helm start --daemon
```

#### 4. Connect Codex

Use the address printed by `code-helm start`:

```bash
codex --remote <ws-url>
```

If you want Codex to start in your current shell directory:

```bash
codex -C "$(pwd)" --remote <ws-url>
```

#### 5. Control Sessions From Discord

Control-channel commands:

| Command           | Purpose                                   |
| ----------------- | ----------------------------------------- |
| `/workdir`        | Set the current local workdir             |
| `/session-new`    | Start a fresh Codex session               |
| `/session-resume` | Reattach an existing Codex session        |
| `/session-close`  | Close the current managed session thread  |
| `/session-sync`   | Recover a degraded managed session thread |

Managed-thread commands and actions:

| Command or action            | Purpose                                 |
| ---------------------------- | --------------------------------------- |
| Send a normal thread message | Continue the Codex conversation         |
| Approval buttons             | Approve or decline Codex requests       |
| `/status`                    | Show the current managed session status |
| `/interrupt`                 | Interrupt the current Codex turn        |

## Commands

| Command                         | Purpose                                      |
| ------------------------------- | -------------------------------------------- |
| `code-helm onboard`             | Configure the Discord bot and control channel |
| `code-helm start`               | Run CodeHelm in the foreground               |
| `code-helm start --daemon`      | Run CodeHelm in the background               |
| `code-helm status`              | Show daemon state and the Codex remote URL   |
| `code-helm stop`                | Stop the background daemon                   |
| `code-helm check`               | Check whether a newer package is available   |
| `code-helm update`              | Update the installed package                 |
| `code-helm autostart enable`    | Start the daemon at login on macOS           |
| `code-helm autostart disable`   | Remove the login-startup entry on macOS      |
| `code-helm uninstall`           | Remove local CodeHelm config, state, and db  |
| `code-helm version`             | Print the installed version                  |

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
