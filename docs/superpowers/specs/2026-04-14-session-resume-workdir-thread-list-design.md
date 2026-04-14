# CodeHelm Session Resume By Workdir And Codex Thread List Design

Date: 2026-04-14

## Summary

CodeHelm should treat Codex App Server as the source of truth for session discovery.

`/session-resume` becomes the single attach command for choosing an existing Codex session from a workdir and connecting Discord to it.

The picker flow is:

1. choose a configured workdir
2. choose a Codex session from that workdir, sourced from the live Codex `thread/list`
3. let CodeHelm either reopen the existing Discord thread for that session or create a new Discord thread if no active attachment exists

This removes the need for separate `workdir-list`, `session-list`, and `session-import` discovery/attach commands in the user-facing surface.

## Approaches Considered

### 1. `workdir + session` autocomplete on `/session-resume`

This makes the command mirror the user model: pick a workdir, then pick one of the Codex sessions that actually exist under that workdir.

Recommended.

### 2. `session` only, with workdir inferred from the selected Codex thread

This is shorter for the user, but it hides an important scope boundary and makes the picker harder to reason about when workdirs overlap conceptually.

### 3. Keep separate discovery and attach commands

This preserves a discovery/execution split, but it duplicates the discovery surface and puts the user back into a multi-command flow.

## Goals

- make Codex `thread/list` the discovery source for sessions
- keep session discovery scoped by workdir
- preserve one Discord thread per Codex session attachment
- avoid separate `workdir-list`, `session-list`, and `session-import` commands in the normal product flow
- keep the local database as a binding and lifecycle store, not a session discovery source

## Non-Goals

- adding a richer visual picker than Discord autocomplete
- supporting multiple active Discord attachments for the same Codex session
- changing Codex App Server protocol shape
- changing `session-new` into a session picker

## Product Model

### `/session-new`

`/session-new` remains the way to create a brand-new Codex session.

It takes one required `workdir` option:

- the user chooses a configured workdir
- CodeHelm creates a new Codex session rooted at that workdir
- CodeHelm opens a managed Discord thread bound to the new session

`session-new` is not a discovery command. It is only for creating a fresh session in a chosen workdir.

### `/session-resume`

`/session-resume` means:

- choose a configured workdir
- choose a Codex session from that workdir
- attach Discord to that Codex session

The session chooser must reflect the Codex view of the workdir.

If CodeHelm created the session originally, that session still appears because it is part of Codex `thread/list`.

### No `workdir-list`, `session-list`, or `session-import`

There is no separate `workdir-list`, `session-list`, or `session-import` command in the user-facing product path.

Session discovery belongs inside `/session-resume`.
If the user wants to attach to a session, they should use the attach command directly.

## Data Source Rules

### Workdir

`workdir` comes from the daemon configuration.

- only configured workdirs are valid
- stale or hand-typed values are rejected

### Session

`session` comes from live Codex `thread/list`.

Rules:

- call Codex `thread/list` for the selected workdir
- filter by `cwd = selected workdir absolute path`
- use the current Discord autocomplete text as Codex `searchTerm`
- preserve Codex-derived ordering, then apply a deterministic top-25 cutoff
- treat the session value as the full Codex thread id

CodeHelm's SQLite session rows are not the discovery source.
They remain authoritative only for attachment history, controller assignment, lifecycle state, and degradation state.

## Close Semantics

`/session-close` remains a Discord-surface lifecycle operation, not a Codex-session deletion operation.

Behavior:

- archive the current managed Discord thread
- keep the underlying Codex session alive
- preserve transcript, controller, lifecycle history, and binding state

After close:

- Codex remote activity may continue on the same session
- Discord stops being the active control surface for that session until `/session-resume`
- the next `/session-resume` is responsible for syncing and restoring the Discord surface

## Attachment Semantics

After the user submits `/session-resume`, CodeHelm chooses one of three attach paths.

### 1. Selected Codex session is already bound to an active Discord thread

Behavior:

- reopen the existing active attachment
- do not create a second Discord thread
- route the user back to the existing Discord thread rather than duplicating it

This preserves the one-session-one-Discord-container rule.

### 2. Selected Codex session is already bound to an archived or otherwise resumable Discord thread

Behavior:

- sync first
- reopen the existing Discord thread
- preserve the same Codex session binding

### 3. Selected Codex session has no usable Discord attachment

This includes:

- never-managed Codex sessions
- previously managed sessions whose Discord thread was deleted or otherwise unusable

Behavior:

- create a new Discord thread
- bind it to the selected Codex session

## Runtime State After Attach

Attach does not override the session state reported by Codex.

### Writable

The attached Discord thread is writable when Codex says the session is ready for input.

- `idle`
- `notLoaded`
- `interrupted` when input-ready

### Busy

The attached Discord thread is visible but not writable when Codex is still working.

- `running`
- `waiting_approval`

### Read-only

The attached Discord thread is visible but read-only when CodeHelm cannot safely hand control back to Discord.

- `degraded`
- snapshot mismatch or other unsupported external modification
- Codex `systemError`

## Validation Rules

`/session-resume` must validate:

- command is invoked in the configured control channel
- selected workdir still exists in daemon config
- selected session belongs to the selected workdir
- attach conflicts for already-active Discord threads are rejected or resolved by reusing the existing attachment, never by duplicating it
- deleted or unusable attachments are replaced by a new Discord thread and then rebound

## Command Surface

### Kept

- `/session-new`
- `/session-resume`
- `/session-close`
- `/session-sync`

### Removed from the normal user surface

- `/workdir-list`
- `/session-list`
- `/session-import`

## Testing Requirements

Add or update tests for:

- `/session-new` still takes a configured `workdir` and creates a new session in that workdir
- `/session-resume` command registration includes `workdir` and `session`
- autocomplete returns configured workdirs
- session autocomplete depends on selected workdir
- session autocomplete sources Codex `thread/list`
- session autocomplete uses workdir-scoped Codex results
- active attachments are reopened rather than duplicated
- archived attachments resume the existing Discord thread after sync
- never-managed sessions create a new Discord thread
- deleted or unusable attachments create a new Discord thread
- writable, busy, and read-only attach states still follow Codex runtime state

## Documentation Updates

Update the user-facing docs so the product model stays consistent:

- `session-new` creates a brand-new Codex session
- `session-resume` attaches Discord to an existing Codex session discovered through Codex `thread/list`
- `session-close` archives the Discord surface without deleting the Codex session
- there is no normal `workdir-list`, `session-list`, or `session-import` command
- controller language should remain consistent with the current ownership model where visible to users

## Migration And Compatibility Notes

This change should not require a Codex protocol migration.

Local persistence can keep existing binding fields as long as:

- discovery comes from Codex `thread/list`
- local rows continue to store the active Discord attachment and history
- user-facing session discovery does not depend on SQLite session listing
