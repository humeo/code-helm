# CodeHelm Discord Thread-Only Approval UX Design

Date: 2026-04-19

## Summary

Discord approval handling should become a single thread-only surface.

For managed sessions:

- approval panels appear only in the managed session thread
- owner DMs no longer receive approval cards
- pending approvals render as one actionable panel
- terminal approvals collapse in place into one short result line
- buttons must be rendered from the provider's actual decision set, not from a fixed local three-button model

This design is intentionally opinionated:

- one approval
- one thread message
- one resolution path

That is the cleanest way to fix the current problems together:

1. Discord and codex-remote approval wording drift
2. duplicated approval surfaces caused by thread plus DM projection
3. command execution approvals losing important decision semantics such as `acceptForSession` versus `cancel`

## Problem

The current approval implementation has three coupled issues.

### 1. Multiple surfaces compete

The same approval can be shown in:

- the managed Discord thread
- the owner's DM
- codex-remote

That creates duplicated notifications, unclear ownership of the approval action, and inconsistent cleanup when one surface resolves before another.

### 2. Approval semantics are flattened

CodeHelm currently reduces Discord actions to a local generic model:

- approve
- decline
- cancel

That is too lossy.

The upstream provider distinguishes decisions such as:

- `accept`
- `acceptForSession`
- `acceptWithExecpolicyAmendment`
- `applyNetworkPolicyAmendment`
- `decline`
- `cancel`

These are not interchangeable.

For example, in Codex UI the wording `No, and tell Codex what to do differently` maps to the abort/cancel path, not to a generic decline.

### 3. Terminal cleanup is noisy or ambiguous

Pending approvals and resolved approvals are treated as variations of the same card.

That keeps too much terminal-state UI in the thread and makes stale interactions harder to explain precisely.

## Approaches Considered

### 1. Minimal patch on top of the current design

- disable DM approval delivery
- keep the current fixed button set
- tweak wording and terminal rendering

Benefits:

- smallest code change
- low migration risk

Drawbacks:

- does not fix the semantic mismatch with provider decisions
- keeps command approvals artificially flattened
- likely to regress when new approval options appear

### 2. Thread-only approval surface with decision-driven rendering

Recommended.

- thread is the only actionable approval surface
- pending state is a single panel
- terminal state collapses to a short result line
- buttons are rendered from persisted provider decisions

Benefits:

- fixes the user-facing duplication problem
- aligns Discord behavior with codex-remote semantics
- gives one stable lifecycle to recover on resume or reopen

Tradeoff:

- requires approval model and persistence changes
- requires broader test updates than a copy-only patch

### 3. Unified system timeline redesign

- refactor approval, read-only, system status, and other thread events into one larger event framework

Benefits:

- strongest long-term consistency

Drawbacks:

- much larger than the current problem
- expands scope well beyond approval UX

## Goals

- make the managed Discord thread the only place where approvals are actioned
- stop sending approval cards to owner DMs
- make pending approvals readable, compact, and actionable
- collapse terminal approvals into one short result line in place
- preserve precise provider decision semantics in Discord
- align Discord wording with Codex approval meaning, especially for command execution
- keep stale interaction feedback precise and status-aware
- make resume, reopen, and replay flows reuse the same approval message instead of recreating new ones

## Non-Goals

- reproducing the Codex terminal UI pixel-for-pixel in Discord
- redesigning all system messages in the managed thread
- changing who is allowed to approve
- changing upstream Codex approval protocol semantics
- introducing DMs as a fallback approval control surface

## Product Model

### Single Approval Entry Point

For a managed session, approval actions happen only in the managed Discord thread.

DM behavior:

- no approval panel
- no duplicate approval result message

If an approval is resolved in codex-remote, the thread remains the historical record, but not the decision origin.

### Pending Approval

While pending, one approval owns one visible thread slot.

That slot is an actionable panel with:

- a question sentence tailored to the approval kind
- the approval payload summary
- the real provider-backed decision buttons

No extra explanatory preamble should be sent in the normal path.

### Terminal Approval

When the approval stops being actionable, the same thread message is edited in place into one short result line.

Examples of terminal outcomes:

- approved
- approved for session
- approved with saved exec rule
- declined
- canceled
- handled elsewhere and approved
- handled elsewhere and canceled

The terminal line should keep the result understandable without preserving the full panel body.

## Rendering Model

### Pending Panel Structure

The panel should lead with the human question, not a generic title.

Examples:

- `Would you like to run the following command?`
- `Would you like to apply these file changes?`
- `Would you like to grant these permissions?`

The body should include the best available human context:

- reason or justification
- command preview or change summary
- cwd
- request kind when helpful
- side effects of the decision when relevant, such as session-scoped allow or saved host rule

`requestId` remains debug metadata, not the main heading.

### Terminal Result Line

The terminal line is intentionally shorter than the pending panel.

Recommended pattern:

- result first
- item summary second
- origin third when handled elsewhere

Examples:

- `Approved: touch i.txt`
- `Declined and continuing without it: touch i.txt`
- `Canceled. The current turn was interrupted: touch i.txt`
- `Handled in codex-remote: approved touch i.txt`
- `Approved for this session: touch i.txt`

### Language Behavior

The wording should follow the existing thread language heuristic.

This applies to:

- pending question copy
- button labels
- terminal result lines
- stale interaction feedback

## Decision Model

### Preserve Provider Decisions

Discord must stop translating pending approval choices into a fixed local trio before rendering.

Instead, CodeHelm should persist and render the provider's actual decision catalog for that approval.

Examples:

- command execution uses command execution approval decisions
- file change uses file change approval decisions
- permissions use permissions-specific grant flow

### Why This Matters

Different negative outcomes mean different things.

For command execution:

- `decline` means do not run it, but continue the turn
- `cancel` means do not run it and interrupt the turn

Discord must not collapse those into one vague rejection action.

### Recommended Button Policy

Buttons should be rendered from the ordered persisted decision catalog.

That means Discord can show only the decisions that are actually valid for that approval.

This preserves:

- session-scope allow
- future exec-rule allow
- future host allow or deny
- decline versus cancel

## Data Model

Each approval should be treated as one durable record with four concerns.

### 1. Lifecycle Identity

- `approvalKey`
- `requestId`
- thread/session bindings

### 2. Display Snapshot

Human-facing approval snapshot captured at creation time.

Recommended fields:

- `questionText`
- `displayTitle`
- `commandPreview`
- `justification`
- `cwd`
- `requestKind`
- `effectSummary`

These are write-on-create in the normal path.

### 3. Decision Catalog

Persist the ordered list of provider decisions that were valid while pending.

Recommended storage shape:

- JSON field or equivalent structured persistence

Each decision entry should carry enough data to render the button:

- provider decision id
- display label
- optional consequence summary

### 4. Resolution Record

Persist the final outcome separately from the pending catalog.

Recommended fields:

- `resolvedProviderDecision`
- `resolvedStatus`
- `resolvedBySurface`
- `resolvedElsewhere`
- `resolvedAt`

`resolvedBySurface` should distinguish at least:

- `discord`
- `codex_remote`
- `system`

## Lifecycle State Machine

Recommended visible lifecycle:

1. `pending`
2. `submitting`
3. terminal result

### Pending

- panel is visible
- buttons are enabled
- approval is actionable

### Submitting

Entered immediately after a Discord button click is accepted locally.

Rules:

- keep the same panel
- disable buttons
- show lightweight submitting feedback
- reject duplicate clicks

### Terminal

After provider confirmation or external resolution:

- remove the panel body
- replace it with the result line
- keep the message id stable

### Resolved Elsewhere

If codex-remote resolves the approval first:

- treat the approval as terminal
- update the thread message in place
- include the external origin in the result line

No additional follow-up message should be created in the normal path.

## Recovery And Deduplication

### Resume/Reopen

Resume and reopen must recover the existing approval message whenever possible.

Rules:

- pending approvals recover as pending panels
- terminal approvals remain terminal
- a terminal approval must never be revived into a pending panel

### Replay Protection

If duplicate or replayed approval events arrive for the same approval:

- reuse the same `approvalKey`
- reuse the same Discord lifecycle message
- ignore stale pending replays once a terminal resolution exists

### DM Removal

The owner-DM approval path should be removed from normal runtime flow and recovery flow.

That includes:

- live delivery
- resolution edits
- resume reconciliation

## Interaction Feedback

### Success Path

When the owner clicks a valid Discord button:

- acknowledge immediately
- move the message into `submitting`
- finalize in place after the provider confirms

### Stale Interaction

If a user clicks a cached button after resolution, feedback should be specific.

Examples:

- `This approval was already approved in codex-remote: touch i.txt`
- `This approval was already canceled. The turn was interrupted: touch i.txt`
- `This approval was already declined and Codex continued without it: touch i.txt`

Avoid generic wording like:

- `That approval is no longer pending.`

unless no better context exists.

## Error Handling

### Delivery Failure

If the thread panel cannot be delivered:

- keep the upstream approval unresolved
- keep execution blocked
- emit one short error message in the thread when possible

The absence of a DM path is intentional; Discord should fail closed instead of silently rerouting approval elsewhere.

### Unsupported Decision Shapes

If a future provider decision arrives that CodeHelm does not yet know how to render:

- preserve the raw decision in storage
- degrade to a read-only approval explanation
- do not invent a misleading fallback button

## Testing Strategy

### Domain Tests

Add or update tests for:

- provider decision catalog preservation
- decline versus cancel semantic separation
- result line copy selection by resolution outcome

### Integration Tests

Add or update tests for:

- no owner DM approval delivery in the normal path
- command approvals rendering provider-accurate button sets
- Discord click moves pending panel to submitting and then to terminal result
- codex-remote resolution collapses the thread panel in place
- stale button clicks return precise status-aware feedback
- resume does not duplicate or revive resolved approvals

### Recovery Tests

Add or update tests for:

- approval-key-based message reuse
- duplicate approval replay deduplication
- terminal approvals staying terminal after reopen or recovery

## Rollout Notes

This is best implemented as an additive migration plus rendering transition.

Recommended order:

1. persist decision catalog and richer resolution data
2. stop DM approval delivery
3. switch pending rendering to decision-driven buttons
4. switch terminal rendering to collapsed result lines
5. tighten stale interaction feedback and replay recovery

## Why This Design

The current bug is not just a copy mismatch.

The real issue is that Discord approval is modeled as a generic local workflow while Codex approval is modeled as a provider-specific decision system.

The design above fixes the abstraction boundary:

- Codex stays the source of truth for decision semantics
- Discord becomes a focused projection of that truth into one clean thread-only surface
