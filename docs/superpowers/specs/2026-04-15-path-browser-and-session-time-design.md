# CodeHelm Path Browser And Session Time Design

Date: 2026-04-15

## Summary

CodeHelm should improve the new path-first session flow in two places:

1. fix incorrect session picker relative times such as `20537 days ago`
2. replace raw path-string autocomplete with a directory-browser-style path picker that feels closer to navigating directories before starting or resuming a Codex session

The resulting user experience becomes:

1. open `/session-new` or `/session-resume`
2. browse directories starting from `~/`
3. choose the current directory explicitly when ready
4. create a new session there or list existing sessions for that same directory
5. see session choices with correct relative timestamps

This preserves the path-first product model while making Discord feel less like a brittle text field and more like navigating into a directory before running Codex.

This design extends the earlier path-first session UX design and intentionally supersedes one earlier non-goal: CodeHelm now should provide a lightweight directory-browser experience inside Discord autocomplete for the `path` field.

## Problem

The current path-first implementation is directionally right, but two rough edges remain.

### 1. Session picker time is clearly wrong

Observed symptom:

- resume choices can render impossible values such as `20537 days ago`

Current implementation detail:

- `formatResumeThreadUpdatedAt(...)` assumes `updatedAt` and `createdAt` are already millisecond timestamps

That assumption is apparently not stable enough for real provider data. Even if the protocol type is `number`, the unit is not trustworthy enough to skip normalization.

### 2. Path entry still behaves like a plain text box

The command model is now path-first, but the interaction still expects the user to type a full path manually.

That misses the intended mental model:

- start in home
- browse down into directories
- select the current directory when it looks right

The requested experience is closer to navigating folders than to filtering a list of pre-registered workdirs.

## Approaches Considered

### 1. Keep plain path text entry and only patch the time bug

This is the smallest change, but it leaves the main usability complaint untouched.

Rejected.

### 2. Replace slash commands with a fully custom browser-style flow

This could model directory navigation very explicitly, but it would fight Discord's native slash-command UX and add unnecessary interaction complexity.

Rejected.

### 3. Keep slash commands, but make `path` autocomplete behave like a directory browser

This keeps the current command surface while upgrading the experience from free-form text filtering to guided directory navigation.

Recommended.

## Goals

- fix incorrect session picker relative time display
- use the same normalized time for both picker sorting and picker display
- make `path` autocomplete behave like directory browsing, not raw string filtering
- start browsing from `~/`
- support the same browsing behavior in both `/session-new` and `/session-resume`
- allow selecting the current directory at any level
- show only directories, not files
- keep hand-typed absolute or `~/...` paths working for power users

## Non-Goals

- building a separate visual file manager UI outside Discord slash commands
- supporting relative paths
- showing files in the path picker
- changing Codex App Server protocol shape
- changing the path-first session model back to configured workdirs

## Product Model

### Commands

Both commands use the same path browsing model:

- `/session-new`
- `/session-resume`

The path picker is still a slash-command `path` option, but autocomplete becomes a directory navigation surface.

### Default Browser Root

When the user first focuses `path` with no value entered:

- treat `~/` as the current browsing root
- list only directories directly under `~/`
- also offer selecting `~/` itself

The browser does not start from `/` by default.

### Navigation Model

At any current directory, autocomplete should offer:

- `Select <current-directory>`
- `../`
- direct child directories, each shown with a trailing `/`

Examples at `~/code-github/`:

- `Select ~/code-github`
- `../`
- `code-helm/`
- `codex/`

Rules:

- choosing a child directory means "enter this directory"
- choosing `../` means "go to parent"
- choosing `Select ...` means "use this directory as the command path"
- only directories appear in the browse list
- ordinary files never appear

### Final Selection Model

The path value submitted to the command should always remain a real path string.

There should be no special internal token such as:

- `select::...`
- `enter::...`

Instead:

- entered child directories use their real path values
- `../` resolves to the real parent path value
- `Select ...` also resolves to the current real path value

This keeps command execution simple and preserves compatibility with hand-entered paths.

### `/session-resume`

`/session-resume` continues to use path-scoped session discovery.

Behavior:

- while `path` is still being browsed, Discord shows path autocomplete choices
- once the chosen `path` resolves to a valid directory, `session` autocomplete uses that directory as `cwd`
- if the chosen `path` is invalid or not yet resolvable, `session` autocomplete returns no choices

This keeps the command mental model clean:

1. pick a directory
2. then pick a session from that directory

## Time Normalization

### Problem Statement

The current picker formats relative time directly from provider numbers. That is too trusting.

The design should treat provider timestamps as unit-ambiguous numeric values that must be normalized before use.

### Normalization Rules

Introduce a small helper that turns raw provider numbers into epoch milliseconds.

Behavior:

- `undefined` stays unknown
- values in a plausible epoch-second range are converted to milliseconds
- values already in a plausible epoch-millisecond range are used directly
- values in plausible microsecond or nanosecond ranges are scaled down to milliseconds
- anything still implausible after normalization becomes unknown

The exact thresholds should be implementation-level constants, but the intent is:

- prefer a correct-enough recent timestamp
- fail closed to `unknown time`
- never emit absurd relative times

### Sorting Rule

Resume picker sorting should use the normalized timestamp, not the raw provider number.

Ordering stays:

1. normalized `updatedAt`
2. normalized `createdAt`
3. thread id

This avoids a state where display uses one interpretation and sorting uses another.

### Display Rule

The picker should continue to display relative time only, for example:

- `3 minutes ago`
- `2 hours ago`
- `1 day ago`
- `unknown time`

Absolute timestamps are not part of the picker label.

## Command-Surface Design

### Shared Path Browser Helper

Introduce a focused helper layer responsible for:

- resolving the current browsing directory from the current `path` value
- listing child directories
- formatting Discord autocomplete choices
- producing parent-navigation choices
- producing the explicit `Select current directory` choice

This helper should be reused by both `/session-new` and `/session-resume`.

### Runtime Validation Still Happens At Submit Time

Autocomplete browsing is guidance, not final authority.

When the command is submitted:

- existing path normalization and validation still run
- the directory must still exist
- the directory must still be a directory

This preserves correctness when the filesystem changes between autocomplete and submit.

## Error Handling

### Path Browser

If the current path cannot be read cleanly:

- prefer returning a small, safe fallback set of choices
- avoid breaking the entire autocomplete interaction
- do not emit placeholder choices whose submitted values are not real paths

Expected cases:

- nonexistent path: fall back to the nearest valid parent when possible
- unreadable directory: return an empty list or a safe parent-level fallback
- too many entries: sort deterministically and truncate to Discord's limit

The important behavior is graceful degradation, not hard failure.

### Session Picker

If the chosen `path` is not yet a valid directory:

- return no `session` choices

This avoids mixing path recovery errors into the session picker itself.

## Testing Plan

### Time Tests

Add focused tests for:

- second-based provider times
- millisecond-based provider times
- oversized provider times that need scaling down
- missing times
- sorting and display using the same normalized interpretation

### Path Browser Tests

Add focused tests for:

- empty input starting from `~/`
- child-directory navigation
- parent-directory navigation via `../`
- explicit `Select current directory`
- directories only, no files
- deterministic ordering and Discord 25-choice truncation

### Command Tests

Lock that:

- `/session-new` uses the shared browser helper for `path`
- `/session-resume` uses the same path browser
- `/session-resume` only queries sessions after `path` resolves to a valid directory
- manually typed valid paths still execute without browsing

## Implementation Notes

The main code risk is letting the path browser become an implicit state machine hidden inside command handlers.

To keep it maintainable:

- keep the path-browser logic in a narrow helper module
- keep time normalization in a separate helper
- let `src/discord/commands.ts` and `src/index.ts` only wire those helpers into command and runtime services

This keeps directory browsing, time normalization, and session runtime behavior independently testable.

## Success Criteria

This design is successful when:

- impossible relative times such as `20537 days ago` disappear
- users can browse from `~/` downward without typing full paths
- users can select the current directory at any level
- `/session-new` and `/session-resume` feel consistent
- the session picker only appears after a real directory is selected
- hand-entered valid paths still work
