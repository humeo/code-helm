# CodeHelm v1 Design

Date: 2026-04-07

## Summary

CodeHelm v1 is a remote control system for local Codex sessions.

- `CodeHelm daemon` runs on the local machine and owns a `Codex App Server`
- `Discord` is the primary remote control surface
- one `Discord thread` maps to one `Codex App Server thread`
- one `Codex session` belongs to exactly one `workdir`
- one `workdir` can have many sessions

V1 supports two official clients attached to the same Codex session:

- a `Discord thread`
- a local `codex resume --remote ...` client on the daemon host machine

V1 does not support provider abstraction, workdir switching inside a session, multi-owner control, or importing active sessions.

## Product Definition

The product is not "chatting with a Discord bot."

The product is remote operation of a locally running coding agent. Users can:

- choose a workdir
- create a new session
- import an existing idle session
- continue the conversation inside a Discord thread
- watch live status and output
- approve risky actions
- keep transcript synchronized
- move between multiple workdirs and sessions

## Core Mapping

- one Discord bot connects to one local CodeHelm daemon
- one Discord server is one CodeHelm workspace container
- one control channel is the workspace control console
- one Discord thread equals one Codex session
- one session belongs to one workdir
- one workdir can have many sessions

Strictly:

- `thread = session`
- `session belongs to one workdir`

## Configuration and Persistence

CodeHelm v1 uses explicit local configuration and local persistent state.

- the workspace registry is populated by daemon configuration
- each workspace entry binds one Discord server to one local CodeHelm workspace
- the workdir registry is also explicitly configured by the operator
- workdirs are not auto-discovered in v1
- session bindings are persisted by the daemon as local state

The daemon must persist at least:

- Discord server identifier
- control channel identifier
- Discord thread identifier
- Codex App Server thread identifier
- owning Discord user identifier
- bound workdir identifier and path
- last known session state
- degradation flags such as externally modified or error

This keeps workdir choice stable and makes imported sessions and Discord threads recoverable across daemon restarts.

## Source of Truth

The only session truth in v1 is the `Codex App Server thread`.

The following are derived from that thread:

- transcript
- runtime state
- approval requests and resolutions
- tool execution output
- turn completion

Discord is a control and presentation surface. It does not maintain a separate authoritative session model.

## Official Clients

V1 officially supports two clients for the same session:

1. `Discord thread`
2. local `codex resume --remote <ws-url> <thread-id>`

The second client is intentionally narrow:

- it is only for the same operator on the daemon host machine
- it is only supported through `--remote`
- plain local `codex resume <thread-id>` is not part of the supported product path

This means V1 supports shared live transcript and status across Discord and the local remote CLI, but it does not attempt to turn arbitrary local Codex clients into first-class participants.

## Trust Boundary

CodeHelm v1 assumes one trusted local machine hosting:

- the CodeHelm daemon
- the Discord bot connection
- the Codex App Server
- the optional local `codex resume --remote` client

The intended trust model is:

- Codex App Server listens on loopback only
- `--remote` access is therefore limited to the daemon host machine
- Discord is the remote surface for the same operator identity, not a mechanism for exposing raw App Server control publicly
- the session owner in Discord is the only Discord user allowed to operate the session

This is an operator trust boundary, not a multi-tenant security model. V1 does not attempt to secure arbitrary third-party local clients beyond the fact that App Server access stays local to the host machine.

## Workdir Model

Each session is permanently bound to one workdir.

- workdir is chosen before session creation or import
- workdir cannot change after the session exists
- if a user wants a different workdir, they create a new session and therefore a new Discord thread

This keeps thread meaning stable and avoids transcript ambiguity.

## User Flows

### Create Session

1. User opens the control channel.
2. User selects a workdir.
3. User creates a new session.
4. CodeHelm creates a new Codex App Server thread.
5. CodeHelm creates a Discord thread bound to that session.
6. The user continues naturally inside the Discord thread.

### Import Session

1. User opens the control channel.
2. User selects a workdir.
3. User chooses an existing Codex session from the import list.
4. CodeHelm resumes that session through the App Server.
5. CodeHelm creates a Discord thread bound to that session.

Import is only allowed for idle sessions.

### Continue in Thread

Inside a session thread:

- the initiator's normal messages become the next Codex user message
- CodeHelm streams commentary, tool progress, approvals, and final answers back into Discord

### Continue in Local CLI

The initiator may also attach a local client with:

```bash
codex resume --remote <ws-url> <thread-id>
```

That client shares the same live thread, transcript, runtime state, and approval events.

## Permissions

Each session thread has one controller: the initiator.

Only the initiator can:

- send messages that advance the session
- approve or cancel approvals
- interrupt the running turn
- close or archive the session thread

Other Discord members can:

- view the thread
- read transcript
- watch session status
- see approval state

Other Discord members cannot:

- advance the session
- respond to approvals
- change workdir
- take control

## Approval Model

Approval behavior is constrained by the actual Codex protocol.

Validated protocol behavior:

- approval requests fan out to all subscribed JSON-RPC clients
- multiple clients can respond
- the first processed response wins
- later responses are ignored without a useful ownership error

Therefore CodeHelm v1 uses this product model:

- in Discord, only the initiating user sees actionable approval controls
- other Discord viewers only see state: `pending`, `approved`, `declined`, or `canceled`
- the local `codex --remote` client is supported as an official second client, but its approval behavior follows Codex native semantics
- if approval is answered in Discord, the Discord UI closes on `serverRequest/resolved`
- if a local Codex TUI leaves a stale approval screen open after resolution, that is treated as a native client limitation, not a CodeHelm backend error

CodeHelm does not attempt to impose a stronger protocol than Codex provides. V1 documents and surfaces the real `first-response-wins` behavior instead of pretending there is hard ownership at the transport layer.

## Session States

CodeHelm v1 keeps a thin product state model over Codex runtime behavior.

### `idle`

- no turn is running
- no approval is pending
- the session can accept the next message
- only this state can be imported into Discord

### `running`

- a turn is active
- Discord and local remote CLI show live status and output
- the initiator cannot send another message until the turn completes or is interrupted

### `waiting_approval`

- the current turn is blocked on approval
- Discord shows approval UI for the initiator
- other Discord users only see the pending state

### `interrupted`

- the current turn was canceled or interrupted
- the interrupted turn is shown as ended
- the session becomes usable again when Codex returns to idle

### `error`

- CodeHelm can no longer reliably synchronize session state
- the session thread becomes degraded and shows the last known state plus the error condition

### `archived`

- a Discord lifecycle state, not a Codex runtime state
- the thread is no longer treated as an active control surface

## Import Rules

Import is intentionally narrow.

- only idle sessions can be imported
- running sessions cannot be imported
- waiting-approval sessions cannot be imported
- if a session is not idle at import time, CodeHelm rejects the import with a clear error

This removes the hardest ownership and UI reconciliation problems from v1.

## External Modification

V1 distinguishes between supported and unsupported secondary control surfaces.

Supported:

- Discord thread
- local `codex resume --remote ...` attached to the same App Server thread

Unsupported:

- plain local `codex resume <thread-id>`
- any unknown control path not going through the supported App Server thread model
- any daemon-observed session advance that cannot be attributed to the supported clients

If unsupported external modification is detected, CodeHelm marks the session as externally modified and degrades the Discord thread to read-only.

Read-only degradation means:

- transcript and status continue to update if possible
- Discord can no longer send new messages
- Discord approval controls are disabled
- Discord interrupt is disabled
- a system banner explains that the session was modified outside CodeHelm

To bring that session back under normal CodeHelm management, the operator must wait for it to return to idle and import it again.

## Control Channel Responsibilities

The control channel is the workspace console. It is responsible for:

- listing configured workdirs
- selecting the target workdir
- creating sessions
- listing importable idle sessions
- importing a selected session
- listing active session threads

It is not used for ongoing conversation. Conversation happens in the session thread.

## Discord Thread Responsibilities

The session thread is the remote session surface. It is responsible for:

- carrying normal conversation
- showing live commentary
- showing tool execution output
- showing approvals
- showing final answers
- showing session state transitions

The thread identity is stable because workdir cannot change after creation.

## Non-Goals

The following are explicitly outside v1:

- support for providers other than Codex
- switching workdir inside an existing session
- importing running sessions
- importing waiting-approval sessions
- multi-owner control
- full conflict-free ownership between Discord and native local Codex UI
- forcing native Codex TUI approval screens to close remotely
- supporting plain local `codex resume <thread-id>` as a reliable shared client path
- seamless control handoff among arbitrary clients

## Rationale

This scope is intentionally strict.

It keeps the product aligned with validated Codex behavior:

- `Codex App Server thread` is the real live session boundary
- `--remote` clients can share the same live transcript and state stream
- approval is shared at the protocol level but not safely owner-enforced by Codex

So v1 chooses clear, reviewable product boundaries:

- Discord is the main product surface
- local remote CLI is supported, but only as a narrow same-operator second client
- workdir is immutable per session
- import is idle-only
- anything outside the supported control model is degraded instead of implicitly reconciled

## Implementation Impact

The implementation should be shaped around these primitives:

- workspace registry
- workdir registry
- session registry
- Discord thread binding
- Codex App Server event subscription
- approval request tracking by `requestId`
- read-only degradation when unsupported external modification is detected

The implementation should not be shaped around raw local session files as the primary source of truth.

## Open Questions Intentionally Deferred

The following are deferred, not forgotten:

- how to support additional providers
- whether to formalize local CLI as a stronger ownership-aware client
- whether to support explicit handoff between Discord and local remote CLI
- whether to support active session import in later versions

These are valid future expansions, but they are not required to plan and build v1.
