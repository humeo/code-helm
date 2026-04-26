# CodeHelm Startup Lazy Reconcile Design

Date: 2026-04-26

## Summary

CodeHelm should stop treating daemon startup as the moment to recover every
mapped session's transcript state.

The daemon should become ready when the core runtime is ready:

- Codex App Server is initialized
- Discord bot is connected
- commands are registered
- `runtime.json` is published for CLI status and stop commands

Old managed sessions should be reconciled only when they matter to a Discord user
action. Live Codex remote events are handled by projection gating, not snapshot
reconciliation. There should be no idle-session background sweep.

The default reconciliation model is a recent-window sync, not a full transcript
audit. CodeHelm should check the latest 10 Codex turns by default. It should not
try to prove that the full Discord thread and full Codex thread are historically
identical during ordinary startup or ordinary session recovery.

If the current Codex App Server can only return full `thread/read` snapshots,
this design still treats the latest 10 turns as the CodeHelm processing and
rendering boundary. Fetching a full snapshot is acceptable only as a temporary
per-session fallback for explicit or lazy reconciliation. It is not acceptable
on daemon startup or broad background warmup.

## Problem

CodeHelm currently keeps important transcript de-duplication state in process
memory. When the daemon restarts, this memory is lost. The existing recovery
strategy compensates by reading Codex thread snapshots for mapped sessions and
seeding in-memory transcript state from historical turns.

That has two separate costs.

First, startup becomes shaped by the number of existing sessions. More mapped
sessions means more restore and snapshot work. This is the root cause behind
daemon startup taking longer than the parent process's readiness wait.

Second, a long-disconnected Discord thread can diverge from its Codex thread.
If CodeHelm blindly reads and replays old snapshot history when the user returns
to the Discord thread, it may:

- spend too long processing historical turns
- flood Discord with old transcript messages
- miss the product distinction between a safe continuation and a multi-writer
  history fork
- give users false confidence that the full history was audited

The fix is not simply to move full-session snapshot work into the background.
The fix is to make reconciliation explicit, bounded, and trust-gated.

## Goals

- keep daemon readiness close to O(1) with respect to historical session count
- avoid startup-time `thread/read(includeTurns=true)` across all mapped sessions
- preserve live continuity for sessions that are actively running or waiting for
  approval
- reconcile old session transcript state only when a Discord user action needs it
- project live Codex remote events to Discord only when the mapped Discord
  session is still active
- default to checking the latest 10 Codex turns, not the full history
- avoid automatic full-history Discord replay
- make out-of-sync sessions visible and safe instead of silently continuing from
  a forked history

## Non-Goals

- guarantee full historical equality between Discord and Codex in the default
  sync path
- replay all missing Codex history into Discord
- add a full transcript audit command in this change
- redesign the Codex App Server `thread/read` API
- persist a complete transcript store in SQLite
- remove all snapshot reconciliation behavior
- add idle background recovery for inactive sessions

## User-Approved Decisions

- Use a two-step direction: fix startup first, treat durable checkpointing as a
  later hardening option.
- Startup should not snapshot every mapped session.
- Default reconciliation should inspect only the latest 10 Codex turns.
- CodeHelm sync should be described as recent-window reconciliation, not a full
  transcript audit.
- Manual sync should not dump a long historical transcript into Discord.
- Idle sessions should not be periodically recovered by the daemon. Snapshot
  reconciliation is driven by Discord actions only.
- Codex remote events should be projected to Discord only when the mapped Discord
  session is active. Archived or deleted sessions should not receive projected
  remote transcript updates.

## Architecture

The runtime should split old-session handling into two event-driven
responsibilities.

### 1. Control Warmup

Control warmup restores the ability to receive live Codex events for sessions
that still need continuity.

This path may run after the daemon has published runtime readiness. It should:

- avoid reading full transcript turns
- use bounded per-session timeouts
- warn on expected recoverable failures
- degrade sessions only for authoritative missing-thread failures
- focus on sessions whose runtime state implies live continuity, especially
  `running` and `waiting-approval`

Control warmup is about keeping a live control connection healthy. It is not a
transcript recovery mechanism.

### 2. Transcript Reconciliation

Transcript reconciliation rebuilds or validates the in-memory transcript runtime
for one session.

This path should be lazy. It should run only when a session is about to be used
or explicitly inspected through Discord:

- user sends a message in a managed Discord thread
- `/status` requests fresh state
- `/session-sync` requests reconciliation

Transcript reconciliation may read Codex turns. It must be bounded by the latest
10 turns in the default path.

This is a CodeHelm behavior boundary even if the transport cannot yet fetch a
tail-only snapshot. CodeHelm must slice to the latest 10 turns before classifying
unknown input, marking items seen, or choosing transcript messages to render.

### 3. Codex Remote Projection

Codex remote input is the other event source.

When CodeHelm receives a live event from Codex App Server for a mapped session,
it should decide whether that event belongs on the Discord surface:

- active session: project eligible assistant/tool/status events into Discord
- archived session: do not project transcript events into Discord
- deleted session: do not project transcript events into Discord

This decision should require both of these gates:

- CodeHelm's persisted session lifecycle state is `active`
- the Discord thread can receive the message without being recreated or
  unarchived

If the Discord thread is unavailable, archived, deleted, or would require
unarchiving to send, CodeHelm should skip projection and log a session-level
warning. A Codex remote event should not cause CodeHelm to restore, recreate, or
unarchive a Discord thread by itself.

Codex remote projection is not a snapshot recovery path and does not trigger
recent-window reconciliation. It handles events that arrive live through the
control subscription.

## Snapshot Read Boundary

The preferred long-term Codex App Server operation is a bounded thread read:

- read latest N turns
- or read since a checkpoint
- or read a compact thread status plus tail window

This design does not require that upstream API to exist before Phase 1 can ship.
Until it exists, CodeHelm may call the existing full snapshot read for one
session at a time, but only under these safeguards:

- never before daemon readiness is published
- never as an all-session startup seed
- never from broad background warmup
- always timeout-bounded
- always processed as a latest-10-turn window
- never rendered as full historical replay

No background idle recovery may use full snapshots as a hidden route for
full-history scans.

## Startup Flow

Startup should follow this order:

1. create database client and apply migrations
2. initialize Codex App Server client
3. register Discord commands
4. connect the Discord bot
5. publish `runtime.json`
6. return readiness to the CLI parent process
7. start background control warmup

No default startup step should snapshot all active sessions for transcript seed.

The daemon may still load session rows from SQLite. Loading session metadata is
cheap and local. The expensive boundary is Codex snapshot reads.

## Lazy Reconciliation Flow

When a managed Discord thread receives user input, CodeHelm should gate the
write to Codex with recent-window reconciliation if the session's runtime state
is not trusted.

The flow is:

1. resolve the Discord thread to a mapped session
2. decide whether the in-memory transcript runtime is trusted
3. if trusted, continue with the existing input path
4. if untrusted, read a Codex snapshot for that session
5. inspect only the latest 10 turns
6. classify the result
7. either continue, prompt for manual action, or mark the session read-only

The trusted-runtime decision can be conservative. A session is a strong lazy
reconcile candidate when:

- the daemon has restarted and no transcript runtime exists for the thread
- a prior reconcile timed out or failed
- the persisted session state is stale compared with a fresh status snapshot
- the session is already degraded for snapshot mismatch

## Codex Remote Event Flow

When a Codex remote event arrives through a restored control subscription,
CodeHelm should treat it as live input from the remote side. This path gates
Discord projection only; it does not lazy-load transcript snapshots.

The flow is:

1. resolve the Codex thread id to a mapped session
2. read the session lifecycle state from CodeHelm persistence
3. if the persisted session is not active, do not project the event to Discord
4. inspect the Discord thread state required for sending
5. if the Discord thread is unavailable, archived, deleted, or would require
   unarchiving to send, skip projection
6. if both gates pass, use the existing live transcript/status projection rules
7. if projection fails because Discord state is unavailable, log a session-level
   warning without crashing the daemon

This path does not need to run recent-window snapshot reconciliation first,
because the event is already live. If later snapshot reconciliation observes a
fork or mismatch, the session can still move to an out-of-sync/read-only state.

## Origin Classification

Recent-window reconciliation needs a conservative origin model.

A Codex user item should be treated as Discord-origin when CodeHelm can match it
to one of these signals:

- a pending Discord input that has not yet been consumed
- an item id or comparable transcript id already marked seen by the runtime
- a completed-turn remap from a live event CodeHelm previously observed
- a trusted external turn id that was explicitly recorded by live observation

A Codex user item should be treated as external-origin when:

- it appears in the latest 10 turns and does not match any Discord-origin signal
- it has no stable metadata that lets CodeHelm prove it came from this Discord
  thread
- its origin is ambiguous

Ambiguous origin must be handled as external-origin in automated lazy
reconciliation. This biases toward pausing instead of silently merging a possible
multi-writer fork.

## Reconciliation Classification

Recent-window reconciliation should produce one of these outcomes.

### Safe Continuation

The latest 10 turns contain no unknown user input that would imply another
writer advanced the session outside Discord.

CodeHelm may:

- mark recent items as seen
- relay at most 3 missing assistant/tool messages if useful
- continue sending the user's new Discord input to Codex

This path should avoid historical replay. It is enough to restore the recent
dedupe context needed for safe continuation.

### Long History, Recent Window Safe

When CodeHelm can tell that the thread has more than 10 turns, but the latest 10
turns are safe, the result should be described as a recent-window sync.

Knowing that the thread has more than 10 turns is helpful but not required. If
the current API does not expose a cheap total-turn count and CodeHelm already has
only the tail window, it should still use the same recent-window wording and avoid
claiming full-history sync.

CodeHelm may continue, but any user-facing sync message must be precise:

- recent history was checked
- older history was not audited
- older missing content was not replayed

This is the normal outcome for long-lived sessions.

### Out Of Sync

The latest 10 turns contain unknown user input or other evidence that the Codex
thread advanced through a different surface.

CodeHelm must not silently append the new Discord input. It should mark the
session as out of sync or snapshot-mismatch read-only and ask the user to choose
an explicit next action.

Recommended actions:

- `/session-sync` to accept recent remote state and restore control if safe
- `/session-new` to start fresh from the current workdir
- `/session-archive` to retire the old Discord thread

Automated lazy reconciliation must not accept unknown recent user input on the
user's behalf. Manual `/session-sync` is the explicit accept-remote action for
the latest-10-turn window.

### Needs Manual Sync

The snapshot read fails, times out, or returns a shape CodeHelm cannot reconcile
safely.

CodeHelm should not treat this as daemon failure. It should keep the daemon
running, warn in logs, and surface a narrow session-level message that manual
sync is needed.

## Manual Sync UX

Manual sync means the user explicitly asks CodeHelm to reconcile the Discord
thread with the remote Codex session.

Default `/session-sync` should use the same latest-10-turn window. It should not
perform a full transcript audit and should not replay all missing history.

Unlike automated lazy reconciliation, manual `/session-sync` means the user is
accepting the recent remote Codex state as the source of truth. If the latest 10
turns contain external-origin user input, `/session-sync` may mark those recent
turns as trusted remote history and clear an out-of-sync/read-only state, provided
there is no unsent local Discord input waiting to be delivered.

If there is unsent local Discord input in the affected session, `/session-sync`
must not silently merge it with remote changes. It should keep the session
blocked and ask the user to send a new message after sync or start a new session.

A successful manual sync should produce a compact Discord message such as:

```text
Synced recent remote history.

Checked latest 10 Codex turns.
Older history was not replayed into Discord.
```

If useful, CodeHelm may also render a small number of recent missing transcript
messages. This cap is 3 rendered messages by default, separate from the 10-turn
inspection window, so Discord is not flooded.

Manual sync should render assistant and tool/result messages only. It should not
render historical user messages as bot-authored transcript entries. External
remote user input should be summarized in the sync notice instead.

If sync finds recent unknown user input, the message should be explicit:

```text
Synced recent remote history.

Accepted remote input from outside this Discord thread.
Checked latest 10 Codex turns.
Older history was not replayed into Discord.
```

The exact command names can follow the live managed-session command surface.
The important behavior is that CodeHelm does not silently merge ambiguous
multi-writer history during automated continuation. Manual sync is the explicit
remote-accept path for the recent window.

## Future Hardening: Persistent Checkpoints

Persistent transcript checkpoints are useful but not required to fix startup.

A later design may add a small SQLite-backed checkpoint per Codex thread, such as:

- last trusted turn id
- last trusted item id
- recent seen item id window
- active turn id
- updated timestamp

That would let CodeHelm rebuild much of `transcriptRuntimes` after daemon restart
without reading a Codex snapshot first.

This should be treated as optional hardening because it changes the persistence
model and must be validated against snapshot mismatch, Discord-origin input
dedupe, synthetic live ids, and completed-turn remapping.

## Error Handling

Expected session-level errors should stay session-level.

- `thread_missing`: degrade the mapped session to read-only with a clear reason
- pre-materialization snapshot failure: ignore or debug-log without warning spam
- timeout: warn once for the affected session and continue
- unknown snapshot shape: mark the session as needing manual sync
- Discord send failure during sync notice: log warning, do not crash daemon
- Codex remote event for archived or deleted session: ignore for Discord
  projection and keep the persisted lifecycle unchanged

Daemon startup should fail only when core runtime dependencies fail before
readiness, such as database migration, Codex initialization, command
registration, or Discord bot startup.

## Testing

Behavior-level coverage should include:

- startup publishes readiness without transcript snapshot seeding
- startup control warmup does not call `thread/read(includeTurns=true)`
- control warmup is limited to sessions that need live continuity
- first user input in an untrusted session triggers lazy reconciliation
- lazy reconciliation inspects only the latest 10 turns
- ambiguous user-item origin is treated as external-origin during automated lazy
  reconciliation
- safe recent-window reconciliation allows the user input to continue
- recent unknown user input prevents automatic continuation and marks the session
  out of sync or read-only
- `/session-sync` uses the latest-10-turn window by default
- `/session-sync` accepts recent remote state explicitly and can clear
  out-of-sync state when no local input is pending
- `/session-sync` does not replay long historical transcript content
- `/session-sync` renders at most 3 missing assistant/tool messages and does not
  render historical user messages as bot-authored transcript entries
- no idle periodic recovery runs after startup
- live Codex remote events project to active Discord sessions
- live Codex remote events do not project to archived or deleted Discord sessions
- lazy reconcile timeout remains session-local and does not affect daemon
  readiness

Existing transcript tests around snapshot mismatch, pending Discord inputs, and
synthetic live id remapping should remain part of the safety net.

## Acceptance Criteria

- no per-session Codex snapshot reads happen before `runtime.json` readiness is
  published
- ordinary startup performs no `thread/read(includeTurns=true)` across every
  mapped session
- test fixtures with many mapped sessions observe zero `thread/read(includeTurns=true)`
  calls before runtime readiness is published
- post-readiness control warmup is timeout-bounded and does not perform
  transcript snapshot seeding
- returning to an old Discord thread performs bounded recent-window
  reconciliation before continuing
- default sync checks the latest 10 turns and clearly avoids claiming full
  history audit
- default sync renders at most 3 recent assistant/tool messages
- no background idle recovery snapshots mapped sessions after daemon readiness
- Codex remote events are projected only for active mapped Discord sessions
- long-disconnected or forked sessions become explicit user decisions instead of
  silent merges
- full test suite and typecheck pass after implementation
