# CodeHelm Transcript Process Display Design

Date: 2026-04-10

## Summary

CodeHelm now has the right session lifecycle semantics, but the Discord thread still reads too much like a protocol log. The remaining product problem is no longer only duplicate transcript items. It is now primarily message hierarchy and visual weight.

The thread needs to show:

- native Discord user input
- optional supported remote input from other Codex clients
- one low-noise `Codex` process card per turn
- one plain final assistant reply per turn
- low-volume `CodeHelm` lifecycle/system messages

This change keeps the thread conversational while still preserving visible execution history.

## Goals

- eliminate duplicate final assistant replies
- separate conversational replies, process history, remote input, and system output
- keep the main thread readable as a conversation
- preserve execution history without turning the thread into a line-by-line event log
- show running progress during a turn in a stable, compact way
- reduce repeated in-body role prefixes such as `Codex` / `Codex CLI`

## Non-Goals

- webhook-based author impersonation
- a separate logs UI
- transport-layer identity guarantees for external clients
- changing Codex protocol semantics

## Message Model

Each turn should produce at most:

1. one process message
2. one final reply

### Discord User

- Native Discord user messages remain the canonical display.
- CodeHelm must not emit duplicate `User: ...` transcript entries.

### Remote Input

- Live-observed user input on the shared remote thread that cannot be attributed to Discord should render as a weaker `Remote input` card.
- The body should show only the input text, visually de-emphasized compared with the final assistant reply.
- Snapshot-only recovered user items should not be retroactively rendered as remote input.

### Codex Process Card

Each active turn gets one editable process card rendered as `Codex`.

Rules:

- created once at turn start or on first meaningful process step
- edited in place as new steps occur
- preserved after completion as the process history for that turn
- never duplicated by snapshot reconciliation
- rendered as an embed/card, not a plain text transcript line

The process card body is:

```text
reading SKILL.md
running `bun test`
editing README.md
```

The dynamic state appears in the card footer:

- `Working...` while the turn is running
- `Waiting for approval` while blocked on approval
- removed when the turn completes successfully
- replaced by a short failure footer when the turn fails

### Codex Final Reply

Each turn may emit one final assistant reply rendered as plain message body text.

Rules:

- distinct from the process message
- shown only once
- live completion and snapshot reconciliation must converge on the same rendered message
- do not prefix the body with `Codex`
- this is the main conversational surface in the thread

### CodeHelm System Messages

`CodeHelm` remains reserved for lifecycle/system output only:

- session started/imported
- archived/resumed
- approval pending/resolved
- degraded/read-only
- daemon/session-level hard failures

## Visual Hierarchy

The thread should read in this order of importance:

1. native Discord user messages
2. plain final assistant replies
3. low-noise process cards
4. weak remote-input cards
5. explicit `CodeHelm` system messages

The practical implication is:

- the only plain conversational transcript bubble emitted by CodeHelm for Codex output is the final reply
- process history stays visible, but visually lighter than the reply
- remote input is preserved for debugging shared-session behavior, but should not compete with the main conversation

## Process Step Rules

Include in the process card:

- commentary distilled into short actions
- command execution summaries
- file edit summaries
- approval wait state

Do not include:

- raw protocol event names
- successful command stdout/stderr dumps
- repeated duplicate commentary
- low-level transport details

Process steps are appended in observed order and de-duplicated when the same step repeats consecutively.

## Status Card

Keep one low-noise `CodeHelm status` message per thread:

- `Running`
- `Waiting for approval`
- `Idle`

It is a thread-level state indicator, not the primary process history surface.

## De-Duplication Rules

- live events are authoritative for first render
- snapshot reconciliation only fills gaps
- snapshot reconciliation must not create:
  - a second process message for the same turn
  - a second final reply for the same assistant item

Stable per-turn/per-item message keys must back both the process message and final reply.

## Resulting Thread Shape

The desired thread shape is:

```text
Jack
reply exactly OK

[Codex process card]
reading SKILL.md
running `bun test`

OK
```

With approval:

```text
Jack
update README

[Codex process card]
reading README.md
running `touch /tmp/README.md`

CodeHelm
Approval resolved: approved

Done
```

With shared remote input:

```text
[Remote input card]
resume --remote

[Codex process card]
reading README.md
running `bun test`

done
```
