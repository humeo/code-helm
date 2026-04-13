# CodeHelm Transcript Display Design

Date: 2026-04-08

## Summary

CodeHelm v1 currently delivers a functionally correct Discord transcript, but the message stream reads like a mixed event log instead of a conversation. The main issues are:

- Discord users already see their own native messages, but CodeHelm also emits `User: ...` transcript messages
- live Codex events and snapshot reconciliation both emit transcript entries, causing duplicates
- running state, tool progress, and transcript content all appear with the same visual weight
- Codex replies and CodeHelm system messages are both authored by the same `code-helm` bot identity
- command execution output is rendered directly into the chat transcript, making the thread noisy

This design changes the Discord thread into a conversation-first surface.

The thread should read like:

1. native Discord user messages
2. assistant replies from `Codex`
3. optional external client input from `Codex CLI`
4. low-volume system messages from `CodeHelm`

The product goal is not to expose every event. The product goal is to preserve transcript meaning while keeping the thread readable.

## Display Boundary for V1

This design distinguishes transcript roles semantically first, not necessarily through separate Discord author identities.

Current CodeHelm v1 bot permissions do not assume webhook management. Therefore the implementation target for this change is:

- distinct role-aware rendering and message types
- conversation-first ordering and de-duplication
- one low-noise system/status surface

True Discord-level author impersonation such as separate `Codex` and `Codex CLI` webhook identities is explicitly out of scope for this change. The role split is still meaningful because it governs:

- which messages are emitted at all
- which messages are status-only
- which transcript items are suppressed
- how external client input is labeled in the visible transcript

## Goals

- make session threads feel like conversations, not logs
- preserve the semantic difference between user input, assistant output, and system state
- eliminate avoidable duplicate transcript messages
- prevent snapshot reconciliation from injecting transcript messages during an active turn
- keep approval and degradation events visible without overwhelming the main chat flow

## Non-Goals

- redesign Discord itself or hide native user messages
- build a separate log viewer in this change
- change Codex protocol semantics
- solve multi-controller ownership at the transport layer
- remove all transcript backfill behavior for imported or restarted sessions

## Message Roles

The thread must distinguish four roles.

### 1. Discord User

This is the actual Discord message author in the thread.

- native Discord messages remain the canonical display for Discord-authored user input
- CodeHelm must not emit a second transcript message that repeats the same content as `User: ...`

### 2. Codex

This is the assistant role.

- assistant final answers should be rendered as authored by `Codex`
- assistant streaming output should be represented by a single editable in-progress message
- when the turn completes, that single streaming message should become the final visible assistant reply

### 3. Codex CLI

This is an external supported client role, specifically `codex resume --remote`.

- if a user message arrives on the shared Codex App Server thread and CodeHelm can prove it did not originate from the native Discord thread message path, Discord should still show it
- that message must not be displayed as `Codex`
- it must appear as a distinct role such as `Codex CLI`

This preserves transcript meaning. A local CLI input is user intent from another control surface, not assistant output.

V1 attribution rule:

- Codex protocol `userMessage` items do not carry a trustworthy source field
- therefore `Codex CLI` is a best-effort display label, not a transport-level identity guarantee
- the daemon may label a user transcript item as `Codex CLI` only when the item is observed on the live shared thread and does not match a currently pending Discord-originated input
- snapshot-only user items discovered later must not be retroactively labeled as `Codex CLI`; they should either remain hidden if already represented by a native Discord message or be treated as external drift evidence

### 4. CodeHelm

This is the system role.

CodeHelm should only emit product/system messages:

- session started
- session imported
- approval pending
- approval resolved
- degraded / read-only
- rare hard errors

CodeHelm should not narrate every protocol event into the main transcript.

## Display Model

### Conversation Body

The main thread body should show only conversation and key control-state events.

Keep:

- native Discord user messages
- `Codex CLI` user messages from supported remote clients
- final assistant replies from `Codex`
- approval pending / resolved
- degradation / read-only banners
- session started / imported

Do not emit as standalone chat messages:

- `Turn started`
- `Thread status changed`
- `Tool started`
- `Tool completed`
- raw command stdout for successful commands
- duplicated user transcript entries for Discord-authored messages

### Status Card

Each session thread should maintain at most one active editable status message authored by `CodeHelm`.

It represents ephemeral runtime state only:

- `Running`
- `Waiting for approval`
- `Idle`

The status card stays fixed to operational state only. Commentary and command detail belong on the process/progress surface instead.

The status card is operational, not conversational.

It should be edited in place instead of producing a new message for every status transition.

When the session returns to `idle`, the status card may either:

- remain as a final short status line, or
- be cleared/removed if the implementation can do so safely

V1 should prefer keeping a compact final `Idle` status rather than deleting messages.

## Transcript Rules

### Discord-Originated User Messages

When a message originates from the Discord thread owner:

- the original Discord message is the visible transcript entry
- CodeHelm forwards that content to Codex
- CodeHelm must not emit a second rendered transcript entry for the same user text

### Remote CLI-Originated User Messages

When a new user message appears on the shared Codex App Server thread and did not originate from Discord:

- CodeHelm should render it as `Codex CLI`
- the text should remain visible in the transcript

This keeps the shared-session transcript understandable to Discord viewers.

V1 only guarantees this label for live-observed shared-thread input. If the daemon learns about a user item only from later snapshot recovery, it should not guess the actor and should prefer drift handling over attribution.

### Assistant Messages

Assistant output has two phases:

1. streaming
2. finalized

Rules:

- only one streaming assistant message per active assistant item
- deltas edit the same Discord message
- completion finalizes that message instead of creating a second one
- snapshot reconciliation must not create another final assistant message for the same item after live completion has already rendered it

Assistant phase rules:

- `phase = commentary` is not a normal conversation reply by default
- commentary should feed the status card when it is useful as a short activity hint
- commentary must not create a durable transcript bubble unless the turn finishes without any non-commentary assistant reply
- if a turn contains multiple completed assistant items, preserve turn order but only completed non-commentary items become durable `Codex` transcript messages
- if a turn has no completed non-commentary assistant item, the last completed commentary item may be promoted to the final visible `Codex` reply so the turn is not left without assistant output

### Command Execution Messages

Command execution should not be rendered into the main transcript by default.

Rules:

- successful command execution updates the status card only
- failed command execution may create a short `CodeHelm` system summary
- raw command output should remain excluded from the main transcript body in this change

This applies even when Codex exposes command execution as transcript items.

Successful command display rules:

- the status card may show the current command while it is running
- successful command completion should not produce a standalone transcript message

Failed command display rules:

- emit at most one compact `CodeHelm` system message for the failed command
- include the command string and exit code when available
- include cwd only when it adds meaningful context
- include at most a short truncated stderr/stdout summary; never dump the full raw output into the main transcript

## Snapshot Reconciliation Rules

Snapshot reconciliation remains necessary, but it must stop acting like a concurrent second transcript source during active execution.

### Allowed Reconciliation Moments

Snapshot reconciliation should run only when:

- daemon startup seeds already-mapped sessions
- an idle session is imported into Discord
- a turn completes
- an idle session needs low-frequency recovery/backfill

### Disallowed Reconciliation Moments

Snapshot reconciliation should not emit transcript entries while session state is:

- `running`
- `waiting-approval`

For the periodic poll specifically:

- the daemon should skip `thread/read(includeTurns=true)` entirely while a session is `running` or `waiting-approval`
- active-session drift detection during these states relies on live events only
- periodic snapshot-based drift detection resumes after the thread returns to `idle`

This is an intentional tradeoff. V1 prefers conversation stability over mid-turn snapshot drift detection.

### Pre-Materialization Threads

A newly created session may have a valid thread id before Codex considers the thread materialized for `includeTurns=true`.

For these sessions:

- the daemon must treat `includeTurns unavailable before first user message` as expected pre-materialization state
- this must not produce repeated warning-level logs
- this must not degrade the session

## De-Duplication Model

De-duplication should happen by transcript item id and by origin.

### Item ID De-Duplication

If a transcript item id has already been rendered, snapshot reconciliation must not render it again.

### Discord-Origin De-Duplication

If a user message originated from Discord and the original native Discord message is already visible:

- the transcript entry should still be marked as seen internally
- but it must not be re-emitted as a rendered bot message

### Live-vs-Snapshot Priority

Live event rendering is the primary path.

Snapshot reconciliation is only a recovery path.

If live rendering already emitted a transcript item, snapshot reconciliation should only mark it as seen, not display it again.

## Approval Display

Approval remains a system concern, not a conversation role.

Display rules:

- `CodeHelm` posts a compact `Approval pending` message into the thread
- actionable controls continue to go to the owner via DM
- approval thread messages should be keyed by request id, so the same approval message can be updated in place from pending to resolved
- when resolved, `CodeHelm` updates that approval message to a compact form such as `Approval approved (request abc123)`
- remote CLI and Discord may both observe the same underlying approval, but the thread should only reflect state transitions once

## External Modification and Read-Only

When CodeHelm detects unsupported external modification, the session becomes read-only.

Display rules:

- emit a single `CodeHelm` degradation banner
- do not mix degradation information into assistant transcript items
- once degraded, no further Discord control actions should be accepted

This banner is intentionally system-level, not conversational.

## Recommended Discord Presentation

The intended thread appearance is:

```text
Jack
reply exactly OK

Codex
OK
```

Remote CLI example:

```text
Codex CLI
reply exactly OK

Codex
OK
```

Approval example:

```text
Jack
update README

CodeHelm
Approval approved (request abc123)

Codex
Done
```

## Implementation Consequences

The implementation should change behavior in four places:

1. transcript rendering policy
2. runtime status message handling
3. snapshot reconciliation scheduling
4. transcript de-duplication between live and snapshot paths

The implementation does not require a transport or database redesign. It is a presentation and synchronization-layer change over the current v1 architecture.
