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
- [src/discord/approval-ui.ts](/Users/koltenluca/code-github/code-helm/src/discord/approval-ui.ts)
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

Approval lifecycle messages remain compact plain text messages that are rendered only in the managed thread.

Current rules:

- pending approvals are delivered only in the bound managed thread
- owner DMs do not carry approval controls
- pending approvals use a question-led body plus Discord buttons
- button labels come from the provider-offered decision catalog, not from a fixed local trio
- terminal approvals edit the same thread message in place into a short result line
- terminal approvals always keep `Request ID` as secondary metadata

### Pending approval thread messages

Pending approval thread messages are plain text bodies with Discord buttons attached to the same message.

Current command-approval example:

```text
**Would you like to run the following command?**

\`\`\`sh
touch c.txt
\`\`\`

要允许我在项目根目录创建 c.txt 吗？

CWD: `/tmp/ws1/app`
Kind: `command_execution`
Request ID: `req-7`
```

Current file-change example:

```text
**Would you like to apply these file changes?**

Allow updating tracked files?

CWD: `/tmp/ws1/app`
Kind: `file_change`
Request ID: `req-8`
```

Current permissions example:

```text
**Would you like to grant these permissions?**

Allow elevated permissions for this step?

CWD: `/tmp/ws1/app`
Kind: `permissions`
Request ID: `req-9`
```

### Terminal approval result lines

When an approval resolves, CodeHelm edits the same thread message in place, removes the buttons, and collapses the content into one short result line plus `Request ID` metadata.

Current examples:

```text
Approved: touch c.txt
Request ID: `req-7`
```

```text
Approved for this session: touch i.txt
Request ID: `0`
```

```text
Declined and continuing without it: touch i.txt
Request ID: `0`
```

```text
Canceled. The current turn was interrupted: touch i.txt
Request ID: `0`
```

```text
Handled in codex-remote: approved touch i.txt
Request ID: `0`
```

### Stale approval interaction replies

When someone clicks a stale approval button, CodeHelm replies ephemerally with status-aware text instead of reopening the approval.

Current examples:

```text
This approval was already approved: touch c.txt
```

```text
This approval was already approved in codex-remote: touch c.txt
```

```text
This approval was already declined and Codex continued without it: touch c.txt
```

```text
This approval was already canceled. The turn was interrupted: That approval
```

```text
This approval was already resolved in codex-remote: touch c.txt
```

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

- if CodeHelm observes an external turn live through the routed event stream, it mirrors that remote input and result into Discord without forcing manual sync
- if automatic snapshot/recovery detects external activity that was not observed live, CodeHelm degrades Discord to read-only
- transcript items from that unobserved/offline path appear only after an explicit manual sync path that reconciles the session

This split keeps live remote control usable while still failing closed for offline or otherwise untrusted transcript divergence.
