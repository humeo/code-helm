# README Rewrite Design

Date: 2026-04-21

## Summary

Rewrite the repository README so it reads like a public product page first and an operator guide second.

The new README should immediately communicate that CodeHelm lets users control Codex from Discord, continue existing Codex sessions, approve requests from Discord, and watch progress and final output in the same thread.

## Goals

- Make the first screen understandable without explaining Codex remote internals.
- Lead with user value, not implementation details.
- Keep installation and quick start short and happy-path oriented.
- Treat `npm install -g code-helm` and `bun add -g code-helm` as two official install options.
- Make Discord bot prerequisites explicit before installation.
- Preserve useful operational and contributor information, but move it below the product-facing sections.
- Add explicit placeholders for missing assets and setup guides instead of silently omitting them.

## Non-Goals

- Do not turn the README into a full Discord bot setup tutorial.
- Do not explain the full `codex --remote` model in the opening sections.
- Do not keep advanced override details in the main README structure.
- Do not keep legacy workspace import details in the main README structure.
- Do not mix release-process detail into the primary user onboarding flow.

## Reader Assumptions

The README should assume the reader wants to understand what CodeHelm does and how to start using it, but it should not assume they already understand Codex remote concepts.

The README should explain usage differences clearly enough for a new reader to follow the happy path, while leaving deeper implementation and setup details to linked docs or explicit placeholders.

## Messaging Priorities

The opening must emphasize these points in this order:

1. CodeHelm lets you control Codex sessions from Discord.
2. You can resume and continue existing Codex sessions.
3. You can approve requests from Discord.
4. You can watch progress and final output in the same thread.

Secondary messaging:

- CodeHelm runs where Codex already lives.
- Discord becomes the control surface.
- Each Discord thread remains attached to a Codex session.

## Recommended Opening Copy Direction

### Title

`# CodeHelm`

### One-line summary

Recommended:

`Control your Codex sessions from Discord.`

### Intro paragraph direction

Recommended direction:

`CodeHelm turns Discord into the control surface for your Codex sessions. Start new sessions, resume existing ones, approve requests, and follow progress without leaving Discord. Keep each Discord thread attached to its Codex session so you can come back and continue where you left off.`

### Top-value bullets

Use these four bullets near the top:

- `Control Codex from Discord`
- `Resume and continue existing Codex sessions`
- `Approve requests without leaving Discord`
- `Watch progress and final output in the same thread`

## Final README Structure

The README should use this order:

1. `# CodeHelm`
2. one-line summary
3. intro paragraph
4. value bullets
5. `Demo Video`
6. `Prerequisites`
7. `Install`
8. `Quick Start`
9. `Why CodeHelm`
10. `How It Works`
11. `Operational Notes`
12. `Autostart`
13. `Uninstall`
14. `Development`

## Section Requirements

### Demo Video

Purpose:

- give fast visual proof of the product

Until assets exist, keep explicit placeholders:

- `[TODO: add demo video link]`
- `[TODO: add demo thumbnail or GIF]`
- `[TODO: define what the demo should show]`

The placeholder checklist should name these demo moments:

- starting CodeHelm
- connecting Codex
- creating or resuming a session from Discord
- approving a request from Discord
- watching progress and final output in the session thread

### Prerequisites

Purpose:

- make pre-install requirements explicit before the user chooses an install method

Required content:

- Bun installed on the machine
- Codex installed on the machine
- a Discord bot token
- the bot already invited to the target Discord server
- one text channel to use as the control channel
- `Message Content Intent` enabled for the bot

Required placeholder:

- `[TODO: add Discord bot setup guide/link]`

### Install

Purpose:

- present two official install methods
- avoid confusion about Bun still being required at runtime

Required commands:

```bash
npm install -g code-helm
```

```bash
bun add -g code-helm
```

Required clarification:

- Bun is still required at runtime, regardless of install method.

### Quick Start

Purpose:

- provide a happy-path onboarding flow only

Required steps:

1. run `code-helm onboard`
2. run `code-helm start` or `code-helm start --daemon`
3. connect with `codex --remote <ws-url>`
4. operate the session from Discord

Required Discord actions to mention:

- `/workdir`
- `/session-new`
- `/session-resume`
- approving requests from Discord
- watching progress and final output in the session thread

Required supporting placeholders:

- `[TODO: add sample startup output with ws-url]`
- `[TODO: add Discord thread screenshot or transcript snippet]`
- `[TODO: add approval screenshot or transcript snippet]`

Required emphasis sentence:

- each Discord thread stays attached to its Codex session so the user can come back, resume, approve, and keep working without starting over

### Why CodeHelm

Purpose:

- explain the product value after the user already knows the basic flow

Required positioning:

- CodeHelm is not just a Discord bot wrapper.
- It is a remote control layer for Codex sessions.

This section should reinforce outcomes, not protocol details.

### How It Works

Purpose:

- give a brief technical model for technically curious readers

Keep this section short. It should explain:

- CodeHelm runs as a local daemon
- it manages a local Codex App Server
- it binds Discord threads to Codex sessions
- it persists session and approval state

Do not expand into full protocol or storage design detail here.

### Operational Notes

Purpose:

- preserve important practical boundaries without interrupting onboarding

Required content:

- local state paths
- what CodeHelm touches
- what CodeHelm does not install for the user
- how to stop CodeHelm

This section may mention trust and local-state boundaries, but only in a compact, readable form.

### Autostart

Purpose:

- keep macOS LaunchAgent support documented

Required content:

- `code-helm autostart enable`
- `code-helm autostart disable`
- unsupported platforms return a clear unsupported result

### Uninstall

Purpose:

- explain what gets removed and what does not

Required content:

- `code-helm uninstall`
- local config, secrets, database, and runtime-state cleanup
- background daemon stop behavior
- autostart cleanup when supported
- global package removal command for npm
- global package removal command for Bun

### Development

Purpose:

- provide a concise contributor entry point

Required commands:

```bash
bun install
bun test
bun run typecheck
```

Keep useful development commands and the release guide link in this section.

## Content To Remove From The Main README Structure

These topics should not remain as primary sections in the new README:

- `Advanced Overrides`
- `Legacy Workspace Import`

If they still need documentation, move them to separate docs or reference them from more specific documentation later.

## Style Requirements

- Write like a product page first, an onboarding guide second, and operator notes last.
- Prefer short paragraphs and short bullet lists.
- Avoid leading with daemon, App Server, WebSocket, or JSON-RPC terminology.
- Use concrete user-facing verbs such as `control`, `resume`, `approve`, `watch`, and `continue`.
- Keep the quick start on the happy path.
- Use explicit placeholders anywhere important content is still missing.

## Acceptance Criteria

The README rewrite is successful when:

- a new reader can understand the product value from the first screen
- prerequisites appear before install
- install offers both npm and Bun global install commands
- quick start clearly includes onboarding, start, `codex --remote`, and Discord control
- the top of the README explicitly mentions continuing sessions, approvals, and progress
- advanced overrides and legacy workspace import are removed from the main README structure
- missing video, screenshot, and guide assets are represented by explicit placeholders
