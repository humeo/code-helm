# CodeHelm Session Resume Workdir Hint Picker Design

Date: 2026-04-21

## Summary

CodeHelm should make the current workdir explicit inside `/session-resume` autocomplete.

When the user opens the `session` picker, the first visible row should be a workdir-context hint:

- `Current workdir: ~/... · Use /workdir to switch directories`

This row is not a real Codex session.
It exists to answer two questions before the user chooses a session:

1. "Which directory am I currently operating in?"
2. "How do I switch if this is the wrong directory?"

Because Discord autocomplete does not support a non-selectable header row, CodeHelm should implement this as a sentinel choice that is always listed first and is explicitly rejected on submit with a targeted user hint.

## Problem

The current `/session-resume` flow scopes session discovery to the stored current workdir, but the picker does not show that scope directly.

As a result:

- users can see recent session titles and ids
- users cannot immediately confirm which current workdir produced that list
- users do not get an in-context reminder that `/workdir` is how to switch directories

This is especially confusing when:

- the same user works across multiple repositories
- the same control channel is reused for different tasks over time
- the current workdir was set earlier and is no longer top of mind

The underlying scope is already correct.
The missing piece is visible context at the point where the user chooses a session.

## Approaches Considered

### 1. Show nothing in the picker and rely on `/workdir` replies plus error text

This keeps autocomplete fully session-only and avoids any sentinel handling.

Rejected.
It does not solve the actual UX problem at the moment of session selection.

### 2. Repeat the current workdir on every session row

This keeps every row selectable and avoids a fake header choice.

Rejected.
It makes each choice denser, burns label space on repeated context, and weakens the visibility of the actual session title and id.

### 3. Insert one top-of-picker workdir hint row and intercept it on submit

This most closely matches the desired experience: the picker opens with one clear current-directory hint before the session list.

Recommended.

## Goals

- show the current workdir directly inside `/session-resume` autocomplete
- remind the user that `/workdir` is how to switch directories
- keep real session rows compact and unchanged in meaning
- preserve the existing session sorting and attach semantics
- fail safely if the user selects the hint row

## Non-Goals

- changing `/session-new`
- changing slash-command schema
- changing persistence shape or adding a migration
- changing how Codex sessions are sorted or discovered
- introducing a true disabled autocomplete header, which Discord does not provide

## Product Model

### Picker Shape

When `/session-resume` autocomplete has a valid current workdir, CodeHelm should return:

1. one synthetic workdir-hint choice
2. up to 24 real session choices

This preserves Discord's 25-choice limit while keeping the workdir context visible.

The synthetic hint row should render like:

- `Current workdir: ~/code-github/…/code-agent-helm-example · Use /workdir to switch directories`

The exact displayed path should reuse the existing `~/...` formatting conventions and then truncate as needed to fit Discord's 100-character label limit.

### Sentinel Choice

The workdir-hint row should use a reserved internal `value` that cannot collide with a real Codex thread id.

Requirements:

- it must never be produced by Codex
- it must be easy for `resumeSession(...)` to recognize before any thread lookup
- it must not be persisted as a session identifier anywhere

This row is a UI affordance, not data.

## Command Behavior

### `/session-resume` autocomplete

If current workdir is available:

- prepend the synthetic workdir-hint choice
- fetch, sort, and format real session choices exactly as today
- return at most 24 real sessions after the hint row

If current workdir is missing or unavailable:

- preserve the current behavior and return `[]`

If there are no real sessions in the current workdir:

- still return the single synthetic workdir-hint row

This gives the user context even when the scoped directory is empty.

### `/session-resume` submit

If the submitted `session` value is the sentinel hint value:

- do not attempt to read the Codex thread
- do not attempt to attach, resume, sync, or rebind anything
- return an ephemeral corrective message

Corrective message text:

- `Current workdir: \`~/...\`. This row is only a hint and does not select a session. Run /workdir to switch directories, then choose a session below.`

This message should use the actual current workdir display path for the invoking user and channel context.

If the submitted `session` value is a real thread id:

- preserve current behavior exactly

## Error Handling

### Hint-row submission

Hint-row submission is not an attach failure.
It is intentional invalid selection recovery.

The response should therefore:

- be ephemeral
- avoid implying that Codex or Discord is broken
- explain what the row is
- explain what to do next

### Current workdir missing or unavailable

No special hint-row behavior should be added in these cases.
Existing messages remain the source of truth:

- `No current workdir. Run /workdir first.`
- `Current workdir is no longer available. Run /workdir again.`

## Copy Rules

### Top hint row

The top hint row should follow this structure:

- `Current workdir: <display-path> · Use /workdir to switch directories`

Copy goals:

- identify the active directory first
- keep `/workdir` in the same row so the remedy is immediately visible
- remain short enough for Discord autocomplete labels

### Submission intercept message

The intercept reply should follow this structure:

- `Current workdir: \`<display-path>\`. This row is only a hint and does not select a session. Run /workdir to switch directories, then choose a session below.`

This longer copy belongs in the command reply, not in the picker row.

## Technical Boundaries

This design should stay narrowly scoped.

Expected implementation surface:

- `buildResumeSessionAutocompleteChoices(...)`
- helper(s) for formatting the synthetic workdir hint row
- `resumeSession(...)` sentinel interception before thread read

This design should not require changes to:

- slash-command registration in `src/discord/commands.ts`
- session persistence schema
- Codex JSON-RPC protocol types
- existing attach path selection logic for real session ids

## Testing

Add or update behavior-level coverage in `tests/index.test.ts`.

Required cases:

- autocomplete prepends the synthetic workdir-hint row when current workdir is valid
- the hint row uses the expected combined copy with current workdir and `/workdir`
- autocomplete still returns at most 25 total choices
- autocomplete returns one hint row plus at most 24 real sessions
- long workdir display text is truncated to Discord-safe length
- selecting the sentinel value in `/session-resume` returns the targeted ephemeral corrective message
- selecting the sentinel value does not trigger thread read or attach behavior
- existing no-current-workdir and unavailable-current-workdir behavior remains unchanged

## Acceptance Criteria

- opening `/session-resume` shows the active current workdir before real session results
- the top row reminds the user to use `/workdir` to switch directories
- choosing the top row does not attach any session
- choosing the top row returns a clear corrective message that includes the current workdir
- choosing a real session continues to behave exactly as before
