# CodeHelm User-Scoped Workdir Session Entry Design

Date: 2026-04-16

## Summary

CodeHelm should stop asking `/session-resume` to resolve `path` and `session` inside the same slash command interaction.

Instead, Discord should adopt a small CLI-like flow:

1. run `/workdir` to set the current workdir
2. run `/session-new` to create a new Codex session in that workdir
3. run `/session-resume` to attach to an existing Codex session in that workdir

The current workdir should be stored per user, per guild, and per control channel.

This keeps the command surface small, preserves the "enter directory, then operate" mental model, and removes the unreliable dependency where `session` autocomplete has to trust the latest `path` value from the same Discord slash command.

## Problem

The current path-first model is directionally right, but the specific `/session-resume path + session` interaction is not reliable enough in real Discord usage.

Observed behavior:

- the user can visually select a final `path`
- when `session` autocomplete fires, Discord may still send an older `path` value
- CodeHelm then scopes `thread/list` to the wrong directory

This is not a Codex session discovery problem.
It is a Discord interaction-state problem.

As long as `session` autocomplete depends on another option from the same slash command payload, the flow can become stale or incorrect.

## Approaches Considered

### 1. Keep `path + session` and keep patching around stale autocomplete state

This preserves the current command shape, but it depends on behavior Discord does not reliably guarantee in practice.

Rejected.

### 2. Collapse to a single `session` search across all directories

This avoids the stale-path problem, but it gives up the preferred "choose directory first" experience.

Rejected.

### 3. Introduce a current workdir step, then scope `session-new` and `session-resume` to that workdir

This keeps the user's preferred CLI-like flow while removing cross-option autocomplete dependency.

Recommended.

## Goals

- preserve a native-feeling "enter directory, then operate" flow
- keep the command surface minimal
- make `/session-resume` session autocomplete strictly scoped to one stable workdir
- avoid any fallback that could show sessions from the wrong directory
- keep multi-user control-channel usage isolated and predictable
- show the active workdir in command results so users always know the current context

## Non-Goals

- supporting a shared channel-wide current directory
- inferring current workdir from previous command history
- preserving the old `/session-resume path + session` surface
- introducing extra status-management commands such as `/workdir-show` or `/workdir-clear`
- changing Codex App Server protocol shape

## Product Model

### Command Surface

The control-channel command set becomes:

- `/workdir path:<autocomplete>`
- `/session-new`
- `/session-resume session:<autocomplete>`
- `/session-close`
- `/session-sync`

`/session-close` and `/session-sync` keep their current meaning.
The change only affects how users choose the directory context before creating or resuming sessions.

### Mental Model

The intended user mental model is:

1. "enter" a directory with `/workdir`
2. run `new` or `resume` inside that directory

This should feel closer to:

- `cd ~/code-github/code-helm`
- `codex`
- or `codex resume`

than to filling out two dependent fields inside one Discord form.

## Current Workdir State

### Scope

Current workdir is stored per:

- `guild_id`
- `channel_id`
- `discord_user_id`

This means:

- different users in the same control channel do not affect each other
- the same user can have different current workdirs in different guilds or different control channels

### Persistence Model

Add a small persistence table dedicated to current workdir state.

Suggested columns:

- `guild_id`
- `channel_id`
- `discord_user_id`
- `cwd`
- `created_at`
- `updated_at`

Suggested primary key:

- `(guild_id, channel_id, discord_user_id)`

`cwd` should always be stored as the normalized absolute path.
When shown back to the user, CodeHelm should format it using `~/...` display when applicable.

### Update Rule

`/workdir` performs an upsert:

- if no current workdir exists for that user/channel context, create one
- if one already exists, overwrite it with the new normalized path

This is a "change current directory" action, not a history or bookmark feature.

## Command Behavior

### `/workdir`

`/workdir` sets the current workdir for the invoking user in the current control channel.

Input:

- required `path` string with autocomplete

Behavior:

- reuse the existing directory-browser-style path autocomplete
- normalize and validate the selected path
- require the path to exist and be a directory
- reject hidden directories using the same hidden-path rules already used for session path input
- persist the normalized path as current workdir

Success response:

- `Current workdir: ~/code-github/code-helm`

### `/session-new`

`/session-new` no longer accepts a `path` option.

Behavior:

- read current workdir at command start
- if missing, fail immediately
- if present, use it as `cwd` for Codex `thread/start`
- create and bind the managed Discord thread as usual

Success payloads should include:

- `Workdir: ~/...`

### `/session-resume`

`/session-resume` no longer accepts a `path` option.

Input:

- required `session` string with autocomplete

Behavior:

- read current workdir for the invoking user in the current control channel
- scope session autocomplete to that workdir only
- on submit, read current workdir again and use it as the authoritative directory context
- verify the selected Codex thread still belongs to that workdir before attaching Discord

This keeps session discovery aligned with Codex while avoiding any need to trust another option from the same slash command request.

## Autocomplete Rules

### `/workdir path`

Keep the current directory-browser interaction:

- start at `~/`
- allow entering child directories
- allow selecting the current directory
- show `.` and `..` navigation choices
- show directories only
- do not show hidden directories

The submitted value remains a real path string.

### `/session-resume session`

`session` autocomplete should no longer inspect a `path` command option.

Instead:

1. load the user's current workdir for this guild/channel context
2. if absent, return an empty list
3. if present, call Codex `thread/list` using that `cwd`
4. apply the same recent-first ordering and top-25 truncation already used by the current session picker

This means the user never sees a "best effort" fallback session list from another directory.

## Validation And Error Handling

### Missing Current Workdir

If the user has not run `/workdir` yet:

- `/session-new` must fail
- `/session-resume` submit must fail
- `/session-resume` autocomplete should return an empty list

Recommended message:

- `No current workdir. Run /workdir first.`

### Unavailable Current Workdir

Current workdir is stored as a path, so later command execution may find that the path is no longer usable.

Expected cases:

- the directory was deleted
- the directory was renamed or moved
- the directory is no longer readable
- the path now points to a non-directory target

Recommended message:

- `Current workdir is no longer available. Run /workdir again.`

### Resume Submit Mismatch

Even with scoped autocomplete, submit-time validation must remain strict.

If the selected session's actual `cwd` no longer matches the user's current workdir:

- reject the command
- do not attempt to attach Discord

Recommended shape:

- `Session \`019d...\` belongs to \`~/other/path\`, not current workdir \`~/code-github/code-helm\`.`

### No Sessions In Current Workdir

If the user's current workdir is valid but Codex reports no matching sessions:

- autocomplete returns no choices
- submit without a valid session cannot happen through normal command flow

Optional user-facing empty-state wording elsewhere should stay concise:

- `No sessions found in current workdir: ~/code-github/code-helm`

## Concurrency Rules

### User Isolation

Current workdir is isolated by user identity within the same control channel.

This avoids a class of problems where one user changes the directory context for another user mid-flow.

### Command Snapshot Rule

Each command should read current workdir once at command start and use that value for the rest of that command execution.

Implications:

- if the user changes `/workdir` while an earlier command is already executing, the earlier command keeps using its starting snapshot
- the newer workdir only affects later commands

This avoids surprising behavior where autocomplete or submission appears to switch directories mid-command.

## Migration

### User-Facing Migration

After this design ships:

- `/workdir` is the required first step before `new` or `resume`
- `/session-new` no longer accepts `path`
- `/session-resume` no longer accepts `path`

There should be no hidden auto-migration of prior path values into current workdir state.

Users start with no current workdir and establish it explicitly.

### Runtime Compatibility

Existing managed sessions remain valid.

Existing archived threads remain resumable.

The only behavioral change is that the user must first set current workdir to the session's directory before resuming it from Discord.

## User-Facing Copy

Recommended minimal copy:

`/workdir` success:

- `Current workdir: ~/code-github/code-helm`

`/session-new` or `/session-resume` without current workdir:

- `No current workdir. Run /workdir first.`

Unavailable current workdir:

- `Current workdir is no longer available. Run /workdir again.`

Success payloads should include the active workdir:

- `Workdir: ~/code-github/code-helm`

Internal explanations about Discord autocomplete quirks should not be shown in normal user-facing command replies.

## Testing Requirements

Add or update tests for:

- command registration exposes `/workdir`, `/session-new`, and `/session-resume` with the new option schema
- `/workdir path` uses path autocomplete
- `/session-new` has no `path` option
- `/session-resume` has only `session` autocomplete
- current workdir is stored per `guild + channel + user`
- repeated `/workdir` calls overwrite previous current workdir
- different users in the same channel do not share current workdir
- `/session-new` fails when current workdir is missing
- `/session-new` uses current workdir as `cwd`
- `/session-resume` autocomplete returns empty when current workdir is missing
- `/session-resume` autocomplete scopes Codex `thread/list` by current workdir
- `/session-resume` submit rejects sessions whose actual `cwd` differs from current workdir
- unavailable current workdir paths produce the expected command error
- success replies for `new` and `resume` include `Workdir: ...`

## Superseded Direction

This design supersedes the user-facing direction in earlier path-first specs that required `/session-resume` to collect both `path` and `session` in one command.

The forward product direction should be:

- explicit current workdir
- user-scoped directory context
- minimal command surface
- strict no-fallback session scoping
