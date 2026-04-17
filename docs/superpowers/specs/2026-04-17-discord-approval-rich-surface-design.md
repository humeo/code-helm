# CodeHelm Discord Approval Rich Surface Design

Date: 2026-04-17

## Summary

Discord approval rendering should stop treating an approval as only:

- `requestId`
- `status`

That model is sufficient for protocol bookkeeping, but it is not sufficient for a human-facing approval surface.

CodeHelm should persist each approval as:

1. lifecycle state
2. display snapshot

The lifecycle state answers:

- is this approval pending
- was it approved
- was it declined
- was it canceled
- was it only externally resolved

The display snapshot answers:

- what action was being approved
- why approval was requested
- where it would run
- what kind of approval it was

Discord should render approval messages from this persisted snapshot, not from a transient in-memory event alone.

The target user experience is:

- pending approvals are readable and actionable
- terminal approvals remain readable as historical records
- request id remains visible only as secondary metadata
- the same Discord message updates through the approval lifecycle
- stale button presses return precise status-aware feedback

## Problem

The current approval model was designed around protocol identity, not presentation.

Today the main lifecycle message is rendered from `requestId` and `status`, which leads to surfaces such as:

- `Approval 0: pending`
- `Approval 0: approved`

This has three concrete problems:

1. the primary title is an internal transport identifier that is not meaningful to users
2. the approval card does not preserve the human-readable context visible in the terminal approval popup
3. once the live event is gone, Discord cannot reliably reconstruct what the approval was actually about

The result is especially weak in resume, reopen, and restart flows because those flows need a durable record of what was being approved, not just whether something once had status `pending`.

## Approaches Considered

### 1. Rendering-only patch

Keep the current persistence model and improve Discord text generation with best-effort runtime inference.

Benefits:

- smallest implementation
- lowest migration risk
- quick path to hide `Approval 0`

Drawbacks:

- does not fix the missing data model
- cannot reliably survive restart, resume, or reopen flows
- still depends on transient live-event memory for rich rendering
- makes terminal-parity UX opportunistic rather than durable

### 2. Approval state plus persisted display snapshot

Recommended.

Treat an approval as one record containing:

- mutable lifecycle state
- mostly immutable display snapshot

Benefits:

- Discord can render a stable, human-readable approval card from durable data
- pending and terminal approvals remain understandable after restart or resume
- request id can be demoted to secondary metadata
- stale interaction handling can be status-aware and contextual
- terminal and Discord approval surfaces become much closer semantically

Tradeoff:

- requires schema and repository changes
- requires compatibility handling for older approval rows

### 3. Runtime-only rich cache

Keep the database mostly unchanged and maintain a richer in-memory approval cache keyed by `approvalKey`.

Benefits:

- lighter schema change than approach 2
- richer than the current implementation during a single runtime

Drawbacks:

- still loses fidelity on restart
- weak fit for reopened or resumed sessions
- creates two sources of truth for approval rendering

## Goals

- make Discord approval cards human-readable without exposing transport ids as the main title
- keep request id available as secondary metadata for debugging and traceability
- preserve approval context across restart, reopen, and resume flows
- update the same Discord approval message from pending to terminal state
- keep pending controls visible only while the approval is still actionable
- give precise stale-interaction feedback based on actual terminal state
- stay compatible with existing approval rows that do not yet have snapshot fields

## Non-Goals

- reproducing the terminal UI pixel-for-pixel in Discord
- storing the full raw approval payload for every provider event
- rewriting Codex protocol request identifiers
- introducing a second approval history table
- changing who is allowed to approve or decline
- redesigning non-approval transcript rendering

## Product Model

### Approval As State Plus Snapshot

Every approval record should answer two different questions.

Lifecycle:

- what is the current approval status

Display snapshot:

- what was the user being asked to approve

These concerns must not be conflated.

The lifecycle is expected to change over time.
The display snapshot should be treated as a durable record of what the approval looked like when it was first surfaced.

### Pending Approval

A pending approval should render:

- a human-readable title based on the action or approval type
- command preview when available
- justification or reason when available
- cwd when available
- request kind when available
- request id as secondary metadata
- approve, decline, and cancel controls when the viewer can control the session

### Terminal Approval

An approved, declined, canceled, or externally resolved approval should render:

- the same human-readable snapshot content
- a terminal status label
- no controls

The approval should remain understandable as history even after it is no longer actionable.

## Data Model

### Approval Identity

`approvalKey` remains the stable logical identity for one approval across:

- thread lifecycle message
- DM control message
- database persistence
- interaction callbacks

`requestId` remains important for provider round-trips, but it is not the user-facing identity.

### Persisted Fields

The existing approval row should be extended with nullable display fields rather than creating a second snapshot table.

Recommended added columns:

- `display_title`
- `command_preview`
- `justification`
- `cwd`
- `request_kind`

Existing lifecycle fields continue to carry:

- `approval_key`
- `request_id`
- `codex_thread_id`
- `discord_thread_id`
- `status`
- resolution metadata
- timestamps

### Snapshot Mutability Rules

Lifecycle fields are mutable.
Display snapshot fields are write-on-create in the normal path.

Status transitions may update lifecycle fields, but should not rewrite the original snapshot content except for rare repair or backfill tooling.

That ensures a canceled approval still shows what was canceled.

## Rendering Model

### Primary Title

The primary visible title should describe the approval in human terms.

Preferred title sources, in order:

1. explicit `display_title`
2. command preview derived title
3. request kind fallback
4. generic approval fallback

Examples:

- `Command approval`
- `Allow command execution`
- `File change approval`

`Approval 0` must not be the primary title.

### Secondary Metadata

The following details may appear in smaller or secondary text:

- request id
- approval key when useful for debugging
- cwd
- request kind

This keeps operator traceability without making internal ids dominate the UI.

### Legacy Fallback

Older approval rows may not have snapshot fields.

For those rows, Discord should render a compatibility card that:

- uses a generic approval title
- includes request id as metadata
- omits fields that were never captured
- still shows the correct lifecycle status

The fallback should be clearly degraded but still coherent.

## Event Flow

### 1. Approval Request Arrival

When a live `requestApproval` event arrives, CodeHelm should:

1. resolve the target managed session
2. derive `approvalKey`
3. extract display snapshot fields from the live event
4. persist the approval row with:
   - `status = pending`
   - snapshot fields populated when available
5. upsert the thread lifecycle message for that `approvalKey`
6. optionally upsert the DM control message for the session owner

The important rule is that snapshot persistence happens before Discord rendering depends on it.

### 2. Pending Rendering

The thread lifecycle message and DM message should both be rendered from the persisted approval record for the same `approvalKey`.

This prevents rendering drift between:

- the live event path
- resume reconciliation
- recovered messages after restart

### 3. Local Interaction

When the owner clicks approve, decline, or cancel:

1. load the approval row by `approvalKey`
2. verify ownership and actionable state
3. send the provider reply using `requestId`
4. persist the terminal status locally
5. update the existing Discord message in place
6. remove controls

### 4. Provider Resolution

`serverRequest/resolved` remains a closure signal, but it is less specific than:

- `approved`
- `declined`
- `canceled`

Recommended status precedence:

1. `approved`, `declined`, `canceled`
2. `resolved`
3. `pending`

If a more specific terminal state is already known, a later `resolved` event must not overwrite it with a less informative status.

### 5. Resume And Recovery

When a waiting-approval session is resumed or reconciled:

1. read the pending approval row from storage
2. rebuild the approval surface from the stored snapshot
3. recover and edit the existing message when possible
4. only fall back to generic legacy rendering when snapshot fields are absent

This makes approval recovery deterministic rather than dependent on live in-memory context.

## Interaction Feedback

### Actionable Pending Approval

Pending approvals behave as they do today:

- owner can resolve
- non-owner cannot resolve
- controls are shown only when actionable

### Stale Interaction Feedback

The current generic message:

- `That approval is no longer pending.`

should be replaced with status-aware feedback.

Recommended behavior:

- approved approval: say it was already approved
- declined approval: say it was already declined
- canceled approval: say it was already canceled
- resolved approval: say it is already finishing or was resolved elsewhere

When possible, include a short command preview or display title so the user knows which approval the feedback refers to.

This is especially important when Discord still shows a cached button briefly after the message has already been updated.

## Persistence And Migration

### Schema Strategy

Prefer additive migration on `approvals`.

Add nullable columns for display snapshot fields.
Do not require backfilling guessed values for existing rows.

### Existing Rows

Older rows remain valid approvals.
They simply lack rich display data.

Migration rules:

- preserve all existing identities and lifecycle states
- allow new snapshot columns to remain `NULL`
- keep current foreign key and rebind behavior intact

### Storage Growth

The snapshot should store concise display-oriented data, not the full raw provider payload.

That keeps the table useful for diagnostics without turning it into an event log archive.

## Testing Strategy

### Domain Tests

Add or extend tests that prove:

- status precedence does not allow `resolved` to overwrite a more specific terminal state
- snapshotless approvals fall back to generic compatibility rendering
- pending approvals expose controls only while actionable

### Repository And Migration Tests

Add or extend tests that prove:

- snapshot fields persist on insert
- later status updates do not erase snapshot fields
- older schemas migrate cleanly with nullable snapshot columns
- rebound Discord thread references continue to work after the migration

### Integration Tests

Add or extend tests that prove:

- a live approval request stores snapshot fields before rendering
- the same Discord message is edited from pending to terminal state
- stale button presses return status-specific feedback
- resume reconciliation rebuilds a rich approval card when snapshot data exists
- legacy rows without snapshot data still render a coherent fallback card

## Why This Design

This design is recommended over a rendering-only patch because the current problem is not just wording.

The actual missing capability is durable human-readable approval context.
Without that context in storage, Discord can only guess or degrade once the live event is gone.

Persisting a small display snapshot gives CodeHelm the minimum durable data it needs to make approvals:

- readable
- recoverable
- request-scoped
- compatible with restart and resume flows

That is the most direct way to make Discord approval behave more like the terminal approval experience without overbuilding a separate approval subsystem.
