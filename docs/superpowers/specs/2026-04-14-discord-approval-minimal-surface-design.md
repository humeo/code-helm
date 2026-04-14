# CodeHelm Discord Minimal Surface And Blocking Approval Design

Date: 2026-04-14

## Summary

Discord should no longer act like a verbose projection of Codex protocol activity.

For managed session threads, the desired Discord surface is minimal:

1. `Remote Input` cards for non-Discord input observed on the shared Codex thread
2. request-scoped approval cards
3. final assistant replies

Everything else should be hidden from the thread by default:

- no `Codex` process cards
- no commentary/progress messages
- no approval preamble text such as "I am sending an approval request now"
- no thread-level status card used as routine transcript output

Approval is the one required interrupt surface. If an approval must happen, Discord must show it and the underlying execution must remain blocked until the approval is resolved.

## Approaches Considered

### 1. Minimal visible surface with explicit approval cards

Project only:

- remote input
- approval cards
- final assistant output
- exceptional system error text when approval delivery itself fails

Recommended.

This best matches the target product model:

- almost the same practical user experience as `codex-remote`
- no noisy process transcript
- approval remains visible and authoritative
- strong safety property: if Discord did not successfully surface approval, execution does not continue

### 2. Keep a reduced process surface alongside approval

Show approval and final output, but still keep one compact process message or status card per turn.

This is easier to evolve from the current implementation, but it keeps visual noise the user explicitly does not want.

### 3. Full remote mirroring with selective hiding

Attempt a near-complete projection of remote events and then hide commentary/process categories in the renderer.

This preserves maximum information, but it increases complexity and risks more subtle mismatches between what Discord shows and what remote actually required.

## Goals

- keep the managed Discord thread almost identical to the practical `codex-remote` experience
- show approval requests in Discord whenever approval is required
- make approval genuinely blocking
- ensure execution cannot pass an unseen approval
- remove commentary/process noise from the Discord thread
- preserve final assistant output as the main conversational surface
- keep approval cards request-scoped and update them in place after resolution
- localize exceptional approval-delivery error text to the thread language

## Non-Goals

- reproducing every remote protocol event in Discord
- preserving a visual execution log in the main thread
- adding a second approval explanation message in the normal path
- replacing Discord buttons with a separate approval UI
- changing Codex app-server approval semantics

## Product Model

### Normal Turn With No Approval

Visible in Discord:

1. the native Discord user message, or a `Remote Input` card for non-Discord input
2. the final assistant reply

Hidden:

- commentary
- process steps
- command start messages
- command output
- file-change progress
- turn status chatter

### Turn With Approval

Visible in Discord:

1. the native Discord user message, or a `Remote Input` card for non-Discord input
2. the approval card
3. the final assistant reply after execution completes

Not visible in Discord:

- commentary about preparing or sending approval
- process/progress cards
- explanatory approval preamble text

Approval is the only visible wait state.

### Approval Resolution

Each approval card is request-scoped.

When the user clicks a button:

- the original approval card is updated in place
- the buttons are removed
- the card becomes terminal with one of:
  - approved
  - declined
  - canceled
  - resolved externally when applicable

No additional "approval resolved" message is sent in the normal path.

## Protocol Scope

Discord approval handling must cover all current app-server approval request methods:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`

These are server requests, not notifications.

The corresponding cleanup/closure signal remains:

- `serverRequest/resolved`

## Projection Rules

### Allowed Thread Output

The managed Discord thread may emit only these routine transcript surfaces:

- native Discord user messages
- `Remote Input` cards
- approval cards
- final assistant replies

### Disallowed Thread Output

The managed Discord thread must not emit these routine transcript surfaces:

- `Codex` process cards
- commentary-only transcript entries
- command execution start or running messages
- command output deltas
- file-change progress text
- approval preamble text
- routine thread-level status messages

### Exceptional Error Output

If approval delivery itself fails, Discord may emit one short error text message in the thread.

That message exists only to explain the failure state and the continued block. It is not part of the normal approval UX.

## Typing Behavior

Typing remains allowed, but only as a transient execution hint.

Rules:

1. after user input is accepted, Discord may briefly show typing while the turn is running
2. when an approval card is successfully emitted, typing must stop immediately
3. while approval is pending, typing must remain off
4. after the user resolves approval, typing may resume if the turn continues running
5. typing stops again when the final assistant reply is emitted or the turn otherwise finishes

Typing must not stay active during the approval wait state.

## Blocking Approval Semantics

This is the core safety rule:

If Discord did not successfully surface the approval card, execution must not continue.

Required behavior:

1. receive approval request from app-server
2. create the Discord approval card
3. only after the card is successfully sent and interactive should the request be considered surfaced to the user
4. until the user resolves the approval, do not allow the underlying work to proceed

The system must fail closed.

### Explicit Safety Property

The following state must be impossible:

- the underlying action executes
- but Discord never showed the approval card

## Approval Failure Handling

### Normal Path

In the normal path:

- show only the approval card
- do not send any explanatory approval text

### Approval Card Delivery Failure

If the approval card cannot be delivered to the managed Discord thread:

- keep the app-server request unresolved
- keep execution blocked
- stop typing
- emit one short error text message in the thread
- do not emit a normal approval explanation message

Recommended meaning of the error text:

- approval delivery failed
- execution remains blocked

### Interaction Failure

If the card exists but the button-handling path fails:

- do not send a provider response
- do not mark the request terminal locally
- keep the approval card pending when possible
- allow the user to retry

### Provider Resolution Before Local Interaction Completes

If `serverRequest/resolved` arrives before or during local reconciliation:

- update the existing card in place
- remove buttons
- reflect terminal state as best as possible
- do not send a second explanatory thread message

## Language Behavior

Approval-delivery error text should follow the thread language.

Recommended policy:

- infer from the most recent owner-authored user input in the thread
- if the thread language is ambiguous, fall back to English

This language rule applies only to exceptional system error text in the thread.

Approval cards themselves should follow the existing localized Discord surface conventions used by CodeHelm.

## State Model

The Discord-facing runtime only needs to expose these meaningful states:

- `idle`
- `running`
- `waiting-approval`
- terminal completion/failure states as reflected through final output or explicit error handling

`waiting-approval` is special:

- typing is off
- execution is blocked
- the approval card is the only normal visible wait surface

## Snapshot, Sync, And Resume Rules

Snapshot and sync behavior must preserve user-visible semantics, not raw protocol completeness.

Rules:

- do not replay process/commentary messages into Discord
- do not retroactively inject a missed approval as if it were still actionable
- preserve meaningful terminal approval state when recoverable
- preserve final assistant output

An approval that was never shown at the time it mattered must not be treated as successfully surfaced just because a later snapshot can see the underlying item history.

## Implementation Strategy

### 1. Add A Discord Projection Policy Layer

Introduce an explicit projection policy that whitelists what may appear in managed Discord threads.

The policy should allow:

- remote input
- approval surfaces
- final assistant output
- exceptional approval-delivery error text

The policy should reject:

- process/commentary/progress transcript output

### 2. Decouple Approval Handling From Transcript Projection

Approval should not depend on the generic transcript relay path.

Instead:

- route all approval request methods through one approval handler
- surface approval through a dedicated Discord approval-card path
- gate provider progression on successful approval-card delivery

### 3. Keep Approval Cards Request-Scoped

Approval UI state should remain keyed by provider request id so:

- multiple approvals in one thread remain distinct
- terminal updates edit the correct existing card
- retries and recovery remain precise

### 4. Preserve Typing As A Separate Concern

Typing should be controlled by runtime state transitions, not transcript visibility.

That keeps it possible to hide all process messages while still showing short-lived activity before approval or final output.

## Testing Requirements

Add or update tests for all of the following:

- normal turns emit only remote input or native user message plus final assistant reply
- commentary/process items never project into managed Discord threads
- all three approval request methods are handled
- approval card appears before execution can continue
- approval pending stops typing
- approval resolution can resume typing if work continues
- approval card updates in place after button click
- no extra approval explanation message is sent in the normal path
- approval card delivery failure emits exactly one error text message and remains blocked
- delivery failure does not silently fall back to remote-only approval
- snapshot/sync/resume do not replay process messages
- snapshot/sync/resume do not invent actionable historical approvals after the fact

## Rollout Notes

This change intentionally narrows the Discord surface.

The biggest user-visible differences are:

- disappearance of `Codex` process cards
- approval becoming the only visible wait surface
- stronger fail-closed behavior when approval delivery breaks

The rollout should verify real Discord behavior, not only unit tests, because approval safety depends on the actual ordering of:

1. app-server approval request arrival
2. Discord card send success
3. user interaction
4. provider resolution

## Open Questions

No open product questions remain for this version.

The approved behavior is:

- minimal thread surface
- no routine approval explanation text
- approval genuinely blocks execution
- approval card updates in place
- typing stops while approval is pending
