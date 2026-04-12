# CodeHelm Session Resume Picker Design

Date: 2026-04-12

## Summary

CodeHelm currently splits "attach Discord to an existing Codex session" across two commands:

- `session-import` imports an idle or not-loaded Codex session into a new Discord thread
- `session-resume` reopens an already managed archived Discord thread

That split is not the right user model. The real intent is simpler: pick a Codex session from a workdir and continue it from Discord.

This design removes `session-import` and turns `session-resume` into the single entry point for attaching Discord to an existing Codex session.

The new flow is:

1. choose a configured workdir
2. choose a Codex session from that workdir, with search and recent-first sorting
3. let CodeHelm either reopen the existing managed thread or create a new Discord thread around that same Codex session

## Approaches Considered

### 1. Keep separate `session-import` and `session-resume`

This preserves the current implementation split, but it forces the user to understand internal lifecycle distinctions before they can continue a session.

### 2. Replace both with one `session-resume` entry point

This makes the product model match user intent. The user picks a workdir and a Codex session, and CodeHelm decides whether that means reopening an archived thread, reattaching a deleted thread, or creating a new thread for a previously unmanaged session.

### 3. Build a custom Discord picker UI instead of slash autocomplete

This can look richer, but it adds interaction complexity and state management without changing the core product model.

Recommended approach: option 2.

## Goals

- make `session-resume` the only command for attaching Discord to an existing Codex session
- let users choose sessions by workdir first, then by searchable recent session list
- keep the session list aligned with Codex rather than with only CodeHelm-managed records
- preserve one Discord thread per attached Codex session at a time
- keep the thread transcript as the stable Discord container whenever a resumable thread already exists

## Non-Goals

- reproducing the full Codex native multi-column session picker inside Discord
- adding branch display before Codex exposes branch data in the thread list protocol
- supporting multiple simultaneously active Discord threads for one Codex session
- removing the single-controller Discord model in this change

## Product Model

### `session-resume` is the single attach command

`session-resume` means:

- select an existing Codex session from a workdir
- attach Discord to it
- continue using that same Codex session from Discord

`session-import` is removed. The product should not ask users to distinguish between "import" and "resume" before they can continue a session.

### Controller model

For user-facing language, CodeHelm should use `controller`, not `owner`.

Controller means the Discord user who most recently attached the session to Discord through a successful `session-resume`.

For brand-new sessions created by `session-new`, the initial controller is the user who created the session.

Controller permissions remain the current v1 Discord control model:

- only the controller can send thread messages that become Codex input
- only the controller can use session control actions such as close and sync
- only the controller gets actionable approval controls
- other viewers can read transcript, status, and approval state, but they cannot drive the session

This is not a multi-user session-control redesign. It is only a clearer controller assignment rule.

## Command UX

### `/session-resume`

`/session-resume` takes two required string options, both using autocomplete:

- `workdir`
- `session`

#### `workdir`

`workdir` is chosen first from configured workdirs only.

- use existing configured workdir ids and labels
- reject stale or hand-typed values that do not match current config

#### `session`

`session` is populated dynamically from Codex for the selected workdir.

- no workdir selected: return no real session choices
- workdir selected: call Codex `thread/list`
- filter by `cwd = selected workdir absolute path`
- pass current user input as `searchTerm`
- use recent-first ordering based on `updatedAt desc`
- use `createdAt desc` as the next tie-breaker
- use full thread id ascending as the final stable tie-breaker
- truncate to the top 25 matches after sorting, because Discord autocomplete cannot return more than 25 choices

Candidate source is Codex session data, not just managed CodeHelm rows. This keeps the picker aligned with the Codex view of the workdir.

### Candidate display

Discord autocomplete is single-line only. It cannot render the Codex native picker layout.

Each candidate should compress the important fields into one short label:

- last updated time
- status
- preview or name
- short thread id suffix

The selected option value remains the full Codex thread id.

Branch is intentionally omitted because the current Codex thread list protocol does not expose it.

## Attachment Semantics

After the user submits `/session-resume`, CodeHelm chooses one of four attachment paths for the selected Codex session.

### 1. Session already attached to an active Discord thread

This is a conflict and must be rejected.

Behavior:

- do not create a second Discord thread
- do not silently transfer control
- return the current Discord thread reference
- return the current controller

This protects the one-thread-per-session model and avoids invisible controller theft.

This conflict rule applies whenever CodeHelm can determine that the selected Codex session is already attached to an active Discord thread, regardless of whether that attachment came from a prior resume path or an earlier first-attach path.

### 2. Session attached to an archived Discord thread

This is the true "reopen" path.

Behavior:

- reuse the same Discord thread
- perform sync first
- reopen that same thread
- assign controller to the user who successfully ran `/session-resume`

### 3. Session attached to a deleted or unusable Discord thread

This is a reattach path.

Behavior:

- create a new Discord thread
- bind it to the same Codex session
- assign controller to the user who successfully ran `/session-resume`

The old thread remains historical only. It is not a resumable container.

The old mapping must be tombstoned as non-resumable before the new mapping becomes active, so future lookups have exactly one authoritative Discord attachment for the Codex session.

### 4. Session has never been managed by CodeHelm

This is the first-attach path.

Behavior:

- create a new Discord thread
- create the managed session mapping
- assign controller to the user who successfully ran `/session-resume`

## Runtime State After Attach

Attach should not preserve the old import-only rule that only `idle` and `notLoaded` sessions can enter Discord. `session-resume` should reflect the real current Codex state.

### Writable attach states

The attached Discord thread is writable when sync says the session is ready for the next input:

- `idle`
- `notLoaded`
- `interrupted` only when Codex has returned to input-ready state

### Busy attach states

The attached Discord thread is visible but should not accept a new Discord input when sync says the session is already occupied:

- `running`
- `waiting_approval`

### Read-only attach states

The attached Discord thread is visible but read-only when CodeHelm cannot safely hand control back to Discord:

- degraded session state
- snapshot mismatch or other unsupported external modification state
- Codex `systemError`

## Validation Rules

`session-resume` must validate:

- command is invoked in the configured control channel
- selected workdir still exists in daemon config
- selected session belongs to the selected workdir
- any already-active Discord attachment for the selected Codex session is rejected
- deleted or unusable prior mappings are treated as historical only and cannot remain the authoritative resumable container after reattach

Workdir matching should be based on Codex thread `cwd`, not only on any existing managed row.

## Command Surface Changes

### Removed command

Remove `/session-import`.

This includes:

- command registration
- README command docs
- baseline docs
- tests that assert import-specific behavior

### Updated command semantics

`/session-resume` no longer means only "reopen an archived managed thread."

It now means "attach Discord to the chosen Codex session," with reopen, reattach, and first-attach handled internally.

## Testing Requirements

Add or update tests for:

- `/session-resume` command registration includes `workdir` and `session`
- autocomplete returns configured workdirs
- session autocomplete depends on selected workdir
- session autocomplete uses recent-first ordering
- session autocomplete passes search text through to Codex `thread/list`
- active attached sessions reject a second attach and surface current thread plus controller
- archived sessions reopen the same thread after sync
- deleted or unusable thread mappings create a new thread
- previously unmanaged Codex sessions create a new managed thread
- busy sessions attach successfully but stay non-writable
- degraded or error sessions attach successfully but stay read-only
- thread control and approval control continue to be controller-only after attach

## Documentation Updates

Update the user-facing docs so the product model is consistent:

- `session-new` creates a brand-new Codex session
- `session-resume` attaches Discord to an existing Codex session
- there is no separate `session-import` concept
- controller language replaces owner language where the text is user-facing and this does not force unnecessary schema churn

## Migration and Compatibility Notes

This change does not require an immediate database schema rename.

It is acceptable to keep internal persistence fields such as `ownerDiscordUserId` unchanged for now, as long as:

- behavior follows the new controller assignment rule
- user-facing strings say `controller` rather than `owner`

This avoids low-value churn in the same change as the command redesign.
