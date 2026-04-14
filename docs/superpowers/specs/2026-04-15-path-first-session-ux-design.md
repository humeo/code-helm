# CodeHelm Path-First Session UX Design

Date: 2026-04-15

## Summary

CodeHelm should stop modeling session entry around configured `workdir` ids and move to a path-first `cwd` model that feels like launching Codex from a terminal.

The user experience becomes:

1. enter a target path
2. create a new session there or list existing Codex sessions for that same path
3. attach Discord to the selected Codex session without introducing a second discovery model

This makes Discord feel closer to `cd /path && codex`, and it keeps Discord session discovery aligned with codex-remote because both are driven by Codex App Server session data rather than a separate CodeHelm workdir registry.

## Problem

The current product model still reflects a daemon-managed workspace registry:

- `/session-new` requires a configured `workdir`
- `/session-resume` first scopes by configured `workdir`
- the UI surfaces `workdir` labels as if they were the user's primary mental model

That does not match how users think about Codex sessions in practice.

Users think in terms of:

- "open this directory"
- "resume the session that already exists in this directory"
- "see the same sessions that codex-remote sees"

The current design adds a second abstraction layer that feels non-native and creates presentation mismatches between Discord and codex-remote.

## Approaches Considered

### 1. Keep configured `workdir` ids and only polish the labels

This is the smallest code change, but it preserves the wrong mental model.

Rejected.

### 2. Keep an internal registry but expose paths in the UI

This improves presentation, but it still forces users through hidden registry constraints and does not actually make Discord behave like native CLI session entry.

Rejected.

### 3. Move to a path-first `cwd` model for session entry

This makes command inputs match the real Codex concept, removes unnecessary indirection, and keeps Discord session discovery aligned with codex-remote.

Recommended.

## Goals

- make `path` or `cwd` the primary user-facing concept
- make `session-new` feel like starting Codex in a directory
- make `session-resume` show the same path-scoped session set that codex-remote has
- remove `WORKSPACE_ROOT` and `WORKDIRS_JSON` from the user-facing operating model
- unify path and session display style across creation, resume, and thread starter UI
- keep one Discord thread bound to one Codex session at a time

## Non-Goals

- building a directory browser UI inside Discord
- supporting relative paths with Discord-specific pseudo-current-directory behavior
- attaching multiple Discord threads to the same Codex session
- changing Codex App Server protocol shape

## Product Model

### Core Model

CodeHelm should treat a Codex session as belonging to one normalized `cwd` path.

The user-facing model is:

- choose a path
- create a new session at that path, or
- attach to an existing Codex session already rooted at that path

The path is the scope boundary.
It replaces `workdir` as the primary concept in command input, autocomplete, and presentation.

### `/session-new`

`/session-new` creates a brand-new Codex session at a user-supplied path.

Inputs:

- required `path` string

Behavior:

- expand `~/...` to the caller's home directory
- reject relative paths
- validate that the target exists and is a directory
- normalize the path to one stable absolute form before creating the session
- call Codex `thread/start` with that normalized `cwd`
- create a managed Discord thread bound to the new Codex session

`/session-new` is not a discovery command.
It always creates a new Codex session for the supplied path.

### `/session-resume`

`/session-resume` attaches Discord to an existing Codex session for a user-supplied path.

Inputs:

- required `path` string
- required `session` string

Behavior:

- normalize the supplied path using the same rules as `/session-new`
- populate `session` choices from live Codex `thread/list` using that normalized path as `cwd`
- after submit, verify that the selected Codex session still belongs to that normalized path
- either reuse, reopen, or create the Discord thread attachment for that Codex session

This keeps Discord and codex-remote aligned because the session list comes from the same Codex source of truth.

### `/session-close`

`/session-close` remains a Discord-surface lifecycle action.

Behavior:

- archive the managed Discord thread
- keep the underlying Codex session alive
- preserve the Codex session binding, path binding, transcript state, and approval history

### `/session-sync`

`/session-sync` remains the recovery path when Discord has degraded to read-only.

The move from `workdir` to `path` does not change sync semantics.

## Path Rules

### Accepted Input

`path` should accept:

- absolute paths such as `/Users/koltenluca/code-github/code-helm`
- home-relative paths such as `~/code-github/code-helm`

`path` should reject:

- relative paths such as `code-helm` or `../code-helm`
- empty values
- non-directory filesystem targets

### Why Relative Paths Are Rejected

Discord slash commands do not have a trustworthy current working directory.

Supporting relative paths would force CodeHelm to invent a fake current directory, which would make the experience less native, not more native.

Absolute path plus `~/...` gives a terminal-like experience without hidden ambiguity.

### Display Form

When CodeHelm displays a path back to the user:

- show `~/...` when the path is inside the home directory
- otherwise show the absolute path

Examples:

- `~/code-github/code-helm`
- `/srv/agents/project-x`

CodeHelm should not display operator-defined labels such as `example` or `Code Agent Helm Example` as the primary path identity.

## Session Discovery Rules

`session` choices for `/session-resume` come from live Codex `thread/list`, not from the local SQLite session table.

Rules:

- use the normalized `path` as the `cwd` filter
- pass the user's current session query text through as Codex `searchTerm`
- preserve deterministic recent-first ordering
- truncate to Discord's top 25 autocomplete limit after sorting
- use the full Codex thread id as the submitted `session` value

The local database remains the source of truth only for:

- Discord thread binding
- lifecycle state
- read-only degradation state
- approval bookkeeping
- controller ownership

## Session Picker Format

`/session-resume` should format each session choice as:

- `updated-time · conversation · session-id`

Examples:

- `3 minutes ago · fix approval projection · 019d8bbd-8bb5-73b1-b6d7-aec5b95c5c1e`
- `2 hours ago · hi · 019d8e05-3a03-7da2-8af6-b7fb52dc4929`

Rules:

- do not show status in the main picker label
- do not repeat the selected path in each session choice
- prefer the Codex conversation title or preview text for the middle segment
- fall back to session id when conversation text is unavailable

This keeps the Discord picker visually closer to native Codex resume flow while staying within Discord autocomplete constraints.

## Thread Naming Lifecycle

### New Session Threads

When `/session-new` creates a Discord thread:

- the initial thread name should be the Codex `session-id`
- do not synthesize names such as `<workdir>-session`

### Rename After First Reply

After the first user message receives its completed assistant reply:

- rename the Discord thread to the first user message text

Rules:

- use the first user message even when it is short, such as `hi`, `1`, or `继续`
- do not rename before the first reply completes
- only apply this bootstrap rename once per thread

This keeps thread creation stable and deterministic, while still giving the thread a human-recognizable title once the conversation actually starts.

## Starter And Status Presentation

Starter and session summary UI should reflect the path-first model.

Examples of the intended direction:

- `Session started`
- `Path: ~/code-github/code-helm`
- `Codex thread: 019d8bbd-8bb5-73b1-b6d7-aec5b95c5c1e`

CodeHelm should stop presenting configured workdir labels as the primary identity for a session.

## Data Model Direction

The persistence model should evolve from `workdir` binding toward direct path binding.

Desired direction:

- persist a normalized `cwd` or equivalent path field on managed session rows
- stop requiring a preconfigured workdir registry to validate session creation or resume
- keep existing Discord-thread-to-Codex-thread binding guarantees

The implementation may use an incremental migration path, but the product model should not expose legacy `workdir` concepts once the new flow ships.

## Migration And Compatibility

### User-Facing Compatibility

Once this design ships:

- `/workdir-list` should remain absent
- `/session-new` should use `path`, not `workdir`
- `/session-resume` should use `path` and `session`, not `workdir` and `session`

### Runtime Compatibility

The implementation may temporarily preserve legacy tables or fields while migrating, but:

- existing managed sessions must remain resumable
- existing archived threads must still reopen correctly
- existing Codex sessions visible in codex-remote must remain discoverable in Discord when the same normalized path is entered

## Validation Rules

CodeHelm must validate:

- the command is invoked in the configured control channel
- the supplied `path` normalizes successfully
- the normalized path exists and is a directory
- the selected Codex session still belongs to that normalized path
- active Discord attachments are reused rather than duplicated
- deleted or unusable Discord attachments are replaced and rebound

## Testing Requirements

Add or update tests for:

- `/session-new` command registration exposes `path`
- `/session-resume` command registration exposes `path` and `session`
- path normalization accepts absolute paths and `~/...`
- relative paths are rejected
- nonexistent and non-directory paths are rejected
- `/session-resume` session autocomplete calls Codex `thread/list` with normalized `cwd`
- resume picker labels use `updated-time · conversation · session-id`
- resume picker labels do not include status
- thread creation uses `session-id` as the initial Discord thread name
- the first completed reply renames the thread to the first user message text
- managed active attachments are reused rather than duplicated
- archived attachments reopen correctly
- deleted Discord thread containers are replaced correctly

## Documentation Updates

Update user-facing docs so they describe:

- path-first session entry
- codex-remote-aligned session discovery
- `session-id` bootstrap naming
- first-reply thread rename behavior
- removal of configured workdir labels from the normal session UX

## Superseded Design Direction

This design supersedes the user-facing direction in prior specs that treated configured `workdir` ids as the primary session entry model.

Those earlier specs can remain as implementation history, but the forward product direction should be:

- path-first
- Codex-thread-list-driven
- visually closer to native Codex CLI and codex-remote
