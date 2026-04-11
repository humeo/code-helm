# CodeHelm Session Close and Resume Design

Date: 2026-04-09

## Summary

CodeHelm v1 already maps one Discord thread to one Codex App Server thread. What is missing is a lifecycle operation for temporarily closing a session thread without deleting the underlying Codex session, and a matching way to resume that same thread later.

This design adds two product operations:

- `session-close`: archive the existing Discord thread for a managed session
- `session-resume`: unarchive the same Discord thread after first synchronizing the underlying Codex session

The design keeps `thread = session` intact. Closing a session does not create a second Discord thread and does not destroy the Codex thread.

## Approaches Considered

### 1. Close = archive same thread, resume = unarchive same thread

This keeps the existing Discord thread as the stable UI container for the session. It preserves transcript continuity and avoids duplicate Discord threads pointing at the same Codex session.

### 2. Close = end thread, resume = create a new thread for the same session

This makes implementation simpler at the Discord API level, but it breaks the current product rule that a thread is the session container. It also complicates session listing and transcript continuity.

### 3. Close = interrupt or terminate the Codex session itself

This is too destructive for v1. The user intent behind close is to hide or pause the Discord control surface, not to kill the underlying coding session.

Recommended approach: option 1.

## Goals

- let the owner hide an inactive session thread without losing its Discord transcript
- allow the same thread to be resumed later
- ensure resume always starts with a fresh Codex session sync
- preserve `thread = session` and `session belongs to one workdir`

## Non-Goals

- deleting Codex sessions
- supporting resume for deleted Discord threads
- adding multi-owner coordination
- auto-reopening archived Discord threads just because a remote CLI client produced new activity

## Session Lifecycle Semantics

This feature keeps three state dimensions distinct:

- Discord lifecycle state: `active` or `archived`
- Codex runtime state: `idle`, `running`, `waiting_approval`, `interrupted`, or `error`
- access mode: `writable` or `read-only`

`session-close` only changes Discord lifecycle state. It does not overwrite the underlying Codex runtime state.

Read-only mode remains the existing CodeHelm policy outcome for degraded or externally modified sessions. It is not the same thing as `error`.

### Close

`session-close` is a Discord lifecycle operation, not a Codex runtime operation.

Effects:

- archive the same Discord thread
- persist an archived marker in CodeHelm state
- stop treating that thread as an active Discord control surface
- keep the Codex thread mapping, workdir binding, owner, transcript state, and approval history

Constraints:

- only the owner can close
- closing does not delete the Codex thread
- closing does not interrupt or cancel the Codex thread automatically

Close is allowed from any managed runtime state:

- `idle`
- `running`
- `waiting_approval`
- `interrupted`
- `error`

If the session is active when close happens, CodeHelm archives the Discord surface immediately and lets the underlying Codex session continue. Any later resume must reconcile whatever happened while the thread was archived.

### Resume

`session-resume` restores the same Discord thread, not a replacement thread.

Resume sequence:

1. find the existing managed session by Discord thread id or session selection
2. read the underlying Codex thread state
3. reconcile transcript and current runtime state before accepting new input
4. unarchive the same Discord thread
5. update the session status card and approval state

Resume must be sync-first. It is invalid to accept a new user message before CodeHelm has reconciled the Codex session.

## Input Handling After Close

### Discord message sent to an archived session thread

This is an implicit resume attempt.

Handling:

Only the owner can trigger implicit resume. Messages from non-owners do not reopen the thread and must be ignored or answered with a no-permission notice.

Handling for owner messages:

1. unarchive intent is accepted
2. CodeHelm first performs resume-time session sync
3. if the synced state is `idle`, the original message is forwarded as the next turn
4. if the synced state is `running` or `waiting_approval`, the message is not forwarded and the thread shows the current state instead
5. if the session is degraded, the thread remains read-only

### Remote `codex resume --remote` activity after close

This does not automatically reopen the Discord thread.

Handling:

- Codex may continue producing events on the shared session
- CodeHelm may continue tracking transcript/runtime state internally
- the archived Discord thread stays archived until the user explicitly resumes it from Discord
- the next explicit resume backfills anything that happened while the thread was closed

This preserves the meaning of close: it closes the Discord surface, not the Codex session.

## Delete Semantics

Discord thread deletion is not part of the normal CodeHelm session lifecycle.

If a managed Discord thread is deleted externally:

- CodeHelm should treat the Discord container as destroyed
- the Codex session should not be deleted automatically
- the mapping should move to a detached/deleted state for audit and possible later re-import

CodeHelm should not expose delete as the normal alternative to close in v1.

## Commands

### `/session-close`

- valid only in a managed session thread
- owner-only
- archives that same thread

### `/session-resume`

- valid from the control channel for a managed archived session
- owner-only
- takes a managed session identifier, using the existing Codex thread id
- resumes the same Discord thread after sync
- does not create a new thread

### `/session-list`

`/session-list` becomes the discovery surface for managed sessions in all lifecycle states, including archived sessions.

For each session it should show at least:

- Discord thread reference when available
- Codex thread id
- workdir id
- lifecycle state, such as `active` or `archived`
- runtime state, such as `idle`, `running`, `waiting_approval`, `interrupted`, or `error`
- access mode, such as `writable` or `read-only`

This gives `/session-resume` a stable control-channel selection path without inventing a second session identifier.

## Resume Failure and Read-Only Branches

Resume is not always a full return to writable control.

- if sync succeeds and the session is `idle`, resume restores normal writable behavior
- if sync succeeds and the session is `running` or `waiting_approval`, resume restores the thread but does not accept a new message yet
- if sync succeeds and the session is `interrupted`, resume restores the thread and treats it as ready for the next message once Codex has returned to idle-equivalent state
- if sync succeeds but the session is already marked externally modified or otherwise degraded, resume restores the thread in read-only mode
- if sync succeeds and the runtime state is `error`, resume restores the thread only as an error surface; it does not return to writable control
- if sync cannot establish a trustworthy session view at all, `/session-resume` fails and the Discord thread stays archived

## Testing Requirements

- close archives the same thread and marks the session archived
- resume unarchives the same thread and performs sync before accepting input
- Discord message after close behaves like implicit resume
- remote CLI activity while archived does not auto-unarchive the thread
- deleted threads are not treated as resumable same-thread sessions
