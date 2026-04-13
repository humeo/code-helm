# Discord Text Formatting

This document records the current Discord-facing text and panel formatting used by CodeHelm.

It is a behavior baseline, not a design wishlist. If the rendering changes, update this file together with the code and tests.

## Scope

This file covers the current formatting for:

- transcript messages in managed session threads
- one-off system messages in managed session threads
- status-card text
- approval lifecycle messages
- slash-command reply text

Primary implementation sources:

- [src/discord/transcript.ts](/Users/koltenluca/code-github/code-helm/src/discord/transcript.ts)
- [src/discord/renderers.ts](/Users/koltenluca/code-github/code-helm/src/discord/renderers.ts)
- [src/index.ts](/Users/koltenluca/code-github/code-helm/src/index.ts)

## Global Layout Rules

### Plain text transcript messages

Plain text transcript messages are rendered as plain content with no artificial leading blank line.

Visible effect:

- no extra blank line inside the reply bubble
- the visible text starts on the first line of the message body

Current implementation:

```text
<visible text>
```

This currently applies to final assistant transcript text and any bot-rendered plain transcript text bubble.

### Embed-only panel messages

Embed-only panels are sent without a `content` field.

Visible effect:

- no synthetic blank line is inserted between the message header and the panel
- panel spacing comes only from Discord's native embed rendering

### Text + panel combined messages

CodeHelm no longer relies on a single Discord message that mixes normal text content and an embed panel for read-only notices.

Instead, it sends:

```text
message 1: <action sentence>
message 2: <panel>
```

Visible effect:

- the spacing between the action line and the panel is native Discord message spacing
- no manual `\n` spacing hack is needed between body text and panel layout

## Managed Thread Transcript Formatting

### Native Discord user message

Messages typed directly in the Discord thread are shown by Discord natively.

CodeHelm does not emit a duplicated bot transcript echo for the same Discord-originated user input.

### Remote Input

Remote input is used for user input observed from Codex activity that is not native Discord thread input and has been explicitly synchronized into Discord.

Current rendering:

- panel/embed
- title: `Remote Input`
- description: one fenced `text` block containing the exact input
- no footer
- no explanatory preface line above the panel

Example:

```text
Remote Input

\`\`\`text
replay only "ok9"
\`\`\`
```

Notes:

- automatic external-activity detection no longer auto-inserts remote input into Discord
- remote input appears only after explicit sync paths that intentionally import that transcript state

### Codex Process Panel

CodeHelm no longer renders a `Codex` process panel in managed session threads.

Current rule:

- no `Codex` embed/panel is emitted for commentary
- no `Codex` embed/panel is emitted for `RUN ...` command steps
- no footer-only running/waiting process panel is emitted
- in-progress activity is represented only by the fixed status card and Discord's native typing indicator when applicable

### Final Assistant Output

The final Codex reply is rendered as a plain text Discord message, not as a panel.

Current rule:

- conversational body text only
- no title
- no `Codex:` prefix
- visually separated by Discord's normal message flow, with no synthetic leading blank line

## Managed Thread System Messages

### Session Started

When a managed thread is created or attached, CodeHelm sends a system panel.

Current rendering:

- panel/embed
- title: `Session started`
- description:

```text
Session: `<workdirLabel>`

Codex thread: `<codexThreadId>`
```

- no footer
- no extra action text above the panel

### Read-Only Degradation

When Discord is degraded to read-only, CodeHelm sends two consecutive messages.

Current rendering shape:

1. one plain text action message
2. one read-only panel message

#### Snapshot mismatch

Action text:

```text
Run `/session-sync` to resync this thread and restore write access.
```

Panel:

- title: `Session is read-only`
- description:

```text
CodeHelm detected Codex activity that was not mirrored into this Discord thread.
```

#### Missing bound session

Action text:

```text
Create or import a new session to continue in Discord.
```

Panel:

- title: `Session is read-only`
- description:

```text
The bound Codex session no longer exists.
```

#### Plain-text read-only wording

When the same state is rendered as text instead of panel payload, the current copy is:

Snapshot mismatch:

```text
Session is read-only.

CodeHelm detected Codex activity that was not mirrored into this Discord thread.

Run `/session-sync` to resync this thread and restore write access.
```

Thread missing:

```text
Session is read-only.

The bound Codex session no longer exists.

Create or import a new session to continue in Discord.
```

### Status Card

The thread-level status card remains plain text and is edited in place.

Current text values:

- `CodeHelm status: Idle.`
- `CodeHelm status: Running.`
- `CodeHelm status: Waiting for approval.`

Current rules:

- commentary/activity text is not included
- command text is not included
- only the fixed status sentence is shown

## Approval Lifecycle Formatting

Approval lifecycle messages remain compact plain text messages with optional buttons while pending.

Current text:

- pending: `Approval \`<requestId>\`: pending.`
- resolved: `Approval \`<requestId>\`: <status>.`

Pending approval thread messages may include buttons. Resolved messages remove buttons and keep only the text.

## Slash Command Reply Formatting

Slash-command replies in the control channel remain plain text, not panels.

Current examples:

- `Created session <#123>.`
- `Imported session into <#123>.`
- `Archived session <#123>.`
- `Synced session <#123>. Session is writable.`
- `Resumed session <#123>. Session remains \`running\`.`

Validation and error replies are also plain text, typically one sentence with inline code formatting for ids and states.

## External Activity Sync Rule

Current display behavior for external Codex activity is:

- if automatic snapshot/recovery detects unsupported external activity, CodeHelm degrades Discord to read-only
- that automatic path does not immediately relay recovered remote-input transcript entries into Discord
- recovered remote input and related transcript items appear only after an explicit manual sync path that reconciles the session

This rule exists to keep the Discord thread readable and to avoid mixing a read-only warning with automatically injected external transcript panels.
