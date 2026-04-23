# CodeHelm Discord Managed Session Command Surface Design

Date: 2026-04-22

> Status note 2026-04-23: `/model` has been removed from the live Discord managed-session command surface and is no longer supported.
>
> Current supported managed-session commands are `/status` and `/interrupt`, and the implementation is the source of truth for what is live. Any `/model` references that remain below are historical design notes only and should not be read as current product behavior. Legacy `msm|...` components should degrade with an ephemeral removal notice.

## Summary

CodeHelm should add a Discord-native managed-session command surface that reproduces the most important `codex remote-cli` controls without pretending Discord is a terminal UI.

At the time this design was written, it proposed three guild slash commands for managed session threads:

- `/status`
- `/model` (historical only; later removed)
- `/interrupt`

It also changes how owner messages behave while a managed session is already running:

- owner messages in `running` sessions become `turn/steer`
- owner messages in `waiting-approval` sessions are rejected instead of being queued
- there is no dedicated `/followup` command

The target product feel is:

- Discord-native command entry
- remote-cli-like control semantics
- narrow, explicit scope

This design intentionally does not add a persistent control panel or plain-text slash command parsing inside thread messages.

## Problem

CodeHelm's current Discord managed-session flow is missing four important remote-cli-like controls.

### 1. Running owner messages are rejected instead of steering the active turn

Today, when the session owner sends a message while the managed session is `running`, CodeHelm responds as if the session were simply busy.

That blocks a core remote-cli behavior:

- continue talking to the active task without starting a second independent turn

The current behavior is especially awkward because the user's Discord message is already visible in the thread, but the system then says the session is already running instead of treating that message as guidance for the current turn.

### 2. There is no Discord equivalent of remote-cli interrupt

The user wants a Discord command that behaves like Ctrl+C in Codex CLI:

- stop the active turn
- do not silently continue the interrupted task
- do not keep previously queued follow-up input alive

CodeHelm currently has no managed-session thread command for this.

### 3. There is no thread-scoped status view comparable to `/status`

The existing managed thread surface has lightweight live transcript projection and approval cards, but it does not provide an explicit user-triggered status snapshot that feels comparable to remote-cli `/status`.

The user specifically wants a status output that is terminal-like rather than a generic Discord embed card.

### 4. Historical note: there was no thread-scoped model and effort picker

This section describes a historical design direction that is no longer supported in the live product.

This is not only a display problem.

It requires:

- an upstream model catalog request
- a thread-scoped persistence model
- a clear decision about whether changes apply globally or only to the current managed session

The user chose current-session-only scope.

## User-Approved Decisions

Note: the model-related bullets in this section are historical and no longer describe the live product surface.

This design locks in the decisions confirmed during brainstorming.

### Interaction Style

- use Discord-native slash commands and Discord-native selection UI
- do not parse plain thread messages such as `/status` as built-in commands
- do not add a persistent runtime control panel in the thread

### Managed Thread Message Semantics

- owner message in `idle` session: start a turn
- owner message in `running` session: steer the active turn
- owner message in `waiting-approval` session: reject the message
- owner message in `degraded` session: keep the session read-only
- non-owner thread messages do not control the session

### Follow-Up Input

- do not add a dedicated `/followup` slash command
- ordinary owner thread messages are the follow-up mechanism
- do not implement the second interaction mode of "interrupt and send immediately" in this phase

### Interrupt Semantics

- `/interrupt` should behave like Ctrl+C for the active managed-session turn
- when `/interrupt` is accepted, all queued steer input for that session is discarded
- discarded steer input is not automatically replayed as a new turn later

### Waiting Approval

- while the session is `waiting-approval`, ordinary owner thread messages are rejected
- those messages are not queued as steer input

### Historical Model Scope

- `/model` changes only the current managed session
- the selected model and reasoning effort apply to future turns in that session
- `/model` does not change global bot defaults
- `/model` is only available while the session is `idle`

### Historical Model Picker Scope

- `/model` must support both model and reasoning effort
- it should feel like CLI `Select Model and Effort`, adapted to Discord interaction constraints

## Approaches Considered

### 1. Minimal protocol bridge only

- add missing `turn/interrupt`, `turn/steer`, and `model/list` for the then-planned `/model` flow
- wire those into a few direct handlers
- keep the rest of the managed thread behavior mostly unchanged

Benefits:

- smallest implementation
- low migration risk

Drawbacks:

- easy to end up with a technically working but weak Discord UX
- `/status` would likely feel bolted on
- model selection flow would be underspecified

### 2. Discord-native managed-session command surface

Recommended.

- add explicit slash commands for status, interrupt, and model control
- keep ordinary owner thread messages as the natural follow-up path
- add protocol-backed steer and interrupt semantics
- add session-scoped model and effort overrides
- render `/status` as a compact monospace CLI-like snapshot

Benefits:

- matches the user's selected interaction model
- keeps Discord-native affordances where they help
- preserves remote-cli semantics where the user actually cares
- controlled implementation scope

Tradeoff:

- requires coordinated changes across protocol client, runtime state, Discord interaction handling, persistence, and tests

### 3. Full remote-cli runtime mirror inside Discord

- recreate a more complete terminal-style control plane in the thread
- attempt to mirror remote-cli running-state UI continuously

Benefits:

- highest visual similarity

Drawbacks:

- larger and riskier than the requested scope
- forces Discord to imitate TUI behavior too literally
- likely to add more state complexity than the current product needs

## Goals

- make running owner thread messages steer the active managed-session turn
- add a true managed-session interrupt command
- add a CLI-like `/status` snapshot for managed session threads
- historical at draft time: add a model and reasoning effort picker for the current managed session
- keep command semantics explicit and predictable
- preserve clear ownership and session safety boundaries
- keep the implementation narrow enough to ship without redesigning the entire Discord session surface

## Non-Goals

- building a persistent Discord runtime control panel
- parsing ordinary thread messages beginning with `/` as built-in commands
- implementing the "interrupt and send immediately" interaction mode
- adding a dedicated `/followup` command
- reproducing the Codex TUI pixel-for-pixel in Discord
- changing global model defaults for future sessions
- redesigning approval cards or the broader transcript projection model in this phase

## Command Surface

### Command Set

This design originally proposed three guild-only slash commands that would be valid only inside managed session threads:

- `/status`
- `/model` (historical only; not currently supported)
- `/interrupt`

These commands are guild-registered in the same broad style as the existing control-channel commands, but they are conceptually a separate command family:

- existing control-channel commands manage session creation and attachment
- new managed-thread commands control an already-bound session from inside the managed thread

### Thread Validation

Commands should be globally registered at the guild level but validated at runtime.

If a user invokes one of these commands outside a managed session thread, CodeHelm should respond with a short ephemeral explanation rather than attempting partial behavior.

The validation rules are:

- the interaction must come from a Discord thread channel
- the thread must map to a managed session
- the session lifecycle must still be actionable for that command

### Visibility Policy

- `/status` returns a normal thread-visible reply
- `/interrupt` returns a normal thread-visible reply when accepted or when it fails in a user-visible way
- historical `/model` flow: use ephemeral UI for selection flow, then emit one short thread-visible confirmation after a successful save

This preserves visible operational history in the thread without forcing every intermediate picker step into transcript history.

### Permission Rules

- `/status` is read-only and may be used by thread participants
- historical `/model` flow: owner-only
- `/interrupt` is owner-only

This keeps visibility broad for inspection while preserving tight control over state-changing commands.

## Managed Thread Message Semantics

### Idle Session

For `idle` managed sessions, owner messages keep the current behavior:

- ordinary owner thread message becomes `turn/start`

### Running Session

For `running` managed sessions, owner messages become `turn/steer`.

This is the most important behavioral change in the design.

The user already has a visible Discord message in the thread, so CodeHelm should treat that message as queued steering input for the active turn instead of replying that the session is already running.

There should be no extra success chatter for accepted steer input in the normal path.

The user's own message already serves as the visible queue item.

### Waiting Approval

For `waiting-approval` managed sessions, owner messages are rejected with a short explanation.

They are not:

- transformed into steer input
- queued for later submission
- silently ignored

This keeps approval state unambiguous and prevents Discord from accumulating invisible queued intent behind an unresolved approval gate.

### Read-Only Session

For `degraded` managed sessions, owner messages keep the current read-only behavior and recovery guidance.

### Non-Owner Messages

Non-owner thread messages continue not to control the session.

No new behavior is added for viewer-issued follow-up input in this phase.

## Runtime Bridge

### Protocol Client Additions

CodeHelm should expose three already-supported app-server capabilities through its local JSON-RPC client:

- `turn/steer`
- `turn/interrupt`
- `model/list`

This work belongs in:

- [src/codex/protocol-types.ts](/Users/koltenluca/code-github/code-helm/src/codex/protocol-types.ts)
- [src/codex/jsonrpc-client.ts](/Users/koltenluca/code-github/code-helm/src/codex/jsonrpc-client.ts)
- any small controller helpers needed in [src/codex/session-controller.ts](/Users/koltenluca/code-github/code-helm/src/codex/session-controller.ts)

### Pending Local Input Model

The current `pendingDiscordInputs` runtime tracking is sufficient for suppressing duplicate transcript replay for `turn/start`, but it is too weak to describe both start-turn and steer-turn local intent cleanly.

This design introduces a more explicit pending local input model for managed sessions.

Each pending local input should track:

- kind: `start` or `steer`
- source Discord message id
- text
- associated turn id when known

This enables three important behaviors:

- suppress replay of duplicate user transcript rows
- count and preview queued steer input for `/status`
- discard only the correct pending steer records on interrupt or failure

### Steer Submission Flow

When the session owner sends a normal thread message during `running`:

1. resolve the managed session
2. resolve the active turn id
3. record one pending local input of kind `steer`
4. submit `turn/steer(threadId, expectedTurnId, input)`
5. keep the pending record until transcript reconciliation confirms the steer input was consumed

If steer submission fails, CodeHelm must remove the pending local record and reply with a short error to the user.

### Interrupt Flow

When `/interrupt` is invoked:

1. verify that the caller owns the session
2. verify that the session is `running` or `waiting-approval`
3. resolve the current active turn id
4. submit `turn/interrupt(threadId, turnId)`
5. only after successful request submission, clear all pending local `steer` records for that session

Interrupt does not synthesize a new turn.

It only stops the current turn and discards queued steer input.

Because the original Discord messages remain in thread history, the thread-visible interrupt acknowledgement should explicitly mention the discard count when non-zero.

Recommended wording pattern:

- `Interrupted current turn.`
- `Interrupted current turn. Discarded 2 queued steer messages.`

### State Convergence

The managed-session persisted state should continue to converge based on real app-server events and explicit status probes.

The interrupt command should not immediately force a fake final state into the session row.

Instead:

- submit the interrupt request
- clear local steer queue
- wait for real upstream status and turn-completion signals to settle the thread state

## Historical Session-Scoped Model Override

### Historical Persistence Model

Model selection for Discord managed sessions should be durable per session.

This requires adding session-level persisted fields for:

- `model_override`
- `reasoning_effort_override`

The persisted override is used only for that managed session's future turns.

This belongs in:

- a new SQLite migration after [001_init.sql](/Users/koltenluca/code-github/code-helm/src/db/migrations/001_init.sql)
- [src/db/repos/sessions.ts](/Users/koltenluca/code-github/code-helm/src/db/repos/sessions.ts)
- any session type definitions that surface the stored values

### Historical Scope Rules

- overrides apply to future `turn/start` submissions from that managed session
- overrides do not rewrite global config
- overrides do not modify currently running turns
- `turn/steer` continues to operate inside the already-running turn and therefore does not use newly selected model settings

### Historical `/model` Interaction Flow

`/model` should be available only while the session is `idle`.

The command flow is:

1. validate session ownership and session state
2. fetch model catalog with `model/list`
3. show an ephemeral model picker
4. if the selected model supports multiple reasoning efforts, show a second ephemeral effort picker
5. persist the session override
6. emit one short visible thread confirmation

If the chosen model supports exactly one effort option, the second step is skipped.

### Historical Discord Component Constraints

Model selection components should use compact custom-id tokens rather than long descriptive identifiers.

This is intentionally consistent with the recent approval custom-id fix and avoids Discord's `custom_id` length limit becoming a new regression source.

## `/status` Output

### Product Shape

`/status` should render as a compact monospace text block in the managed session thread.

It should feel closer to a CLI status dump than to a Discord embed card.

Recommended structure:

- short title line
- aligned key/value rows
- optional small trailing sections for queued steer preview or pending approvals

### Freshness Policy

Because `/status` is an explicit user-triggered command, it should prefer live thread state instead of relying only on stored session state.

Recommended read order:

1. attempt a fresh thread snapshot from app-server
2. derive the best current runtime state from that snapshot
3. fall back to stored session state if the live read fails

This gives `/status` better remote-cli-like accuracy without turning it into a continuously refreshing card.

### Data Policy

`/status` should show only fields that are reliable in CodeHelm's current environment.

Examples of strong candidates:

- workdir
- Codex thread id
- Discord thread reference
- lifecycle state
- current runtime state
- queued steer count
- queued steer previews, capped to a small number
- pending approval count

Fields that are not currently reliable from CodeHelm's runtime should be omitted or rendered as explicitly unavailable.

CodeHelm should not fabricate remote-cli-only data such as token usage or account limits when those values are not actually available through the current Discord bot runtime.

### Queued Steer Preview

When pending local steer records exist, `/status` should show:

- total queued steer count
- up to three short preview lines

This gives the user a Discord-appropriate way to inspect what is currently queued without needing a persistent runtime control pane.

## `/interrupt` Output

### Eligibility

`/interrupt` is owner-only.

It is valid when the session is:

- `running`
- `waiting-approval`

It is not valid when the session is:

- `idle`
- `degraded`

### Success Semantics

Successful `/interrupt` does three things:

- submits `turn/interrupt`
- clears queued steer input for that session
- writes one short visible thread acknowledgement

It does not:

- start a replacement turn
- preserve queued steer input
- automatically replay discarded messages

### Failure Semantics

If interrupt submission fails, CodeHelm must not clear the queued steer state.

The failure reply should remain short and operationally clear.

## Error Handling

### Missing Active Turn Context

For `turn/steer` and `turn/interrupt`, the most fragile local dependency is the active turn id.

If the active turn id is missing locally, CodeHelm should:

1. perform one lightweight recovery probe from the upstream thread
2. retry with recovered active turn information if available
3. otherwise fail with a clear user-facing message

CodeHelm should not guess a turn id or silently degrade from steer into start-turn behavior.

### Not-Steerable Turns

If upstream rejects steering because the active turn is not steerable, CodeHelm should report that explicitly.

It should not:

- queue the steer forever
- convert the message into a new turn
- pretend the steer was accepted

### Waiting Approval Guard

When the session is `waiting-approval`, the user-facing message should clearly say that new follow-up input is blocked until the approval is resolved.

This prevents the user from assuming their message has already been queued.

### Historical Stale Model Picker

Because `/model` uses an ephemeral multi-step picker, the session may change state between step one and final selection.

Before saving the override, CodeHelm should revalidate:

- session still exists
- caller still owns the session
- session is still `idle`

If revalidation fails, the picker should end with a short ephemeral explanation instead of applying a stale write.

## Architecture Notes

This feature should avoid growing [src/index.ts](/Users/koltenluca/code-github/code-helm/src/index.ts) as one more large monolith.

The implementation should be split into focused pieces where practical:

- managed-thread slash command definitions and interaction routing
- session turn control semantics for `start`, `steer`, and `interrupt`
- historical session-scoped model override persistence and selection flow
- CLI-like status text renderer for Discord

The existing [src/discord/thread-handler.ts](/Users/koltenluca/code-github/code-helm/src/discord/thread-handler.ts) remains the right home for message-to-turn decision logic, but it should stop flattening `running` into a generic busy noop.

## Testing

### Discord Command Tests

Add coverage for command registration and interaction behavior in:

- [tests/discord/commands.test.ts](/Users/koltenluca/code-github/code-helm/tests/discord/commands.test.ts)

Key cases:

- `/status` and `/interrupt` command definitions
- historical coverage from the original draft also included `/model`
- command rejection outside managed session threads
- owner-only restrictions for `/interrupt`
- historical coverage from the original draft also included owner-only `/model`

### Thread Handler Tests

Expand:

- [tests/discord/thread-handler.test.ts](/Users/koltenluca/code-github/code-helm/tests/discord/thread-handler.test.ts)

Key cases:

- `idle` owner message starts a turn
- `running` owner message steers the active turn
- `waiting-approval` owner message is rejected
- non-owner message remains non-controlling
- degraded session remains read-only

### Runtime And Integration Tests

Expand:

- [tests/index.test.ts](/Users/koltenluca/code-github/code-helm/tests/index.test.ts)

Key cases:

- steer pending-record lifecycle
- successful steer consumption by transcript reconciliation
- steer failure rollback
- interrupt clears queued steer only after request submission succeeds
- interrupt failure preserves queued steer
- `/status` renders compact CLI-like output
- `/status` prefers live snapshot data when available
- historical draft coverage also included `/model` session override application to future turns only

### Session Repo And Migration Tests

Expand:

- [tests/db/session-repo.test.ts](/Users/koltenluca/code-github/code-helm/tests/db/session-repo.test.ts)

Key cases:

- migration adds session model and reasoning effort override columns
- legacy rows remain readable with null overrides
- override persistence updates and reads correctly

### Verification Commands

Before implementation work is considered complete, the expected verification remains:

- `bun test`
- `bun run typecheck`

## Open Implementation Constraints

Two practical constraints should guide implementation:

### 1. Keep thread noise low

The managed thread already contains transcript and approval traffic.

New control features should avoid adding noisy success chatter.

Recommended baseline:

- no extra success message for accepted steer input
- one short message for successful interrupt
- historical `/model` flow: one short message for successful model save
- one visible monospace block per `/status` call

### 2. Prefer evidence-backed state over local invention

Remote-cli-like feel matters, but correctness matters more.

Where Discord cannot faithfully mirror CLI internals, CodeHelm should choose:

- explicit omission
- explicit `not available`
- simple thread-appropriate wording

over a fake high-fidelity imitation.
