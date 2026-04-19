# CodeHelm Managed App Server Startup Feedback Design

Date: 2026-04-19

## Summary

Startup feedback for the managed Codex App Server should stop surfacing a raw timeout error as the main user message.

Instead, CodeHelm should report startup using a user-facing status model:

- `starting`
- `ready`
- `warning: startup delayed`
- `failed`

The timeout case should usually be presented as a warning with clear next steps, not as a bare fatal-looking error sentence.

Human-facing timestamps should be shown in local display time with an explicit timezone label.
Raw UTC ISO timestamps remain appropriate for logs and stored state, but not as the primary CLI display format.

## Problem

The current startup timeout message:

- `Managed Codex App Server did not become ready before the startup timeout expired.`

has three problems.

### 1. It reads like a fatal crash

The wording sounds final even when the underlying process may still be alive and only slow to become ready.

### 2. It does not explain impact

The message does not tell the user what is still working and what is blocked.

For example:

- Discord may already be connected
- the daemon may still be running
- Codex requests may still be unavailable

### 3. Time display is easy to misread

Raw UTC ISO timestamps are correct for machines but confusing for people reading startup summaries in a local shell.

Example:

- `Started: 2026-04-17T08:22:19.208Z`

Users naturally interpret this as local time unless told otherwise.

## Approaches Considered

### 1. Copy-only tweak

- keep the same startup behavior
- replace the sentence with softer wording

Benefits:

- smallest change

Drawbacks:

- still lacks a state model
- still weak on impact and next steps

### 2. Status-oriented startup feedback

Recommended.

- separate startup state from final failure
- treat readiness timeout as a warning when the child is still alive
- show status, impact, and next-step guidance
- standardize local-time display

Benefits:

- fixes the misleading UX directly
- scales to both foreground and daemon startup summaries

Tradeoff:

- requires supervisor and CLI summary coordination

### 3. Verbose diagnostic dump in the CLI

- always show detailed process and readiness diagnostics on timeout

Benefits:

- strong debugging value

Drawbacks:

- too noisy for normal use
- hides the user-facing conclusion inside low-level detail

## Goals

- make startup feedback understandable at a glance
- distinguish delayed readiness from hard failure
- explain user impact when startup is degraded
- give one or two concrete next steps
- display human-facing startup time in local time with timezone
- keep raw diagnostics available without making them the headline

## Non-Goals

- redesigning all daemon/runtime output
- removing raw diagnostics from logs
- changing how readiness probing works internally
- changing Codex app-server startup timeout thresholds in this design

## Product Model

### Startup States

The managed Codex App Server should be described with one of these states:

- `starting`
- `ready`
- `delayed`
- `failed`

### Meaning

- `starting`: process launched, readiness still pending, within normal wait window
- `ready`: readiness probe succeeded
- `delayed`: readiness wait exceeded the startup timeout, but the child process is still alive or diagnostics do not yet prove a hard failure
- `failed`: process exited or reached a known unrecoverable startup error

### Why This Split Matters

`delayed` and `failed` are not the same user experience.

`delayed` means:

- the system might still recover
- the user should not assume the daemon is dead

`failed` means:

- startup did not complete successfully
- the user needs intervention

## CLI Copy Model

Human-facing startup feedback should follow this structure:

1. state conclusion
2. impact
3. next step

### Recommended Warning Copy

For delayed readiness:

- `Managed Codex App Server startup is taking longer than expected.`
- `Discord may already be connected, but Codex requests are not ready yet.`
- `You can keep waiting, inspect logs, or restart CodeHelm if the state does not recover.`

### Recommended Failure Copy

For hard failure:

- `Managed Codex App Server failed to start.`
- `Codex requests are unavailable until the server starts successfully.`
- `Inspect the diagnostics below and restart CodeHelm after fixing the issue.`

### Recommended Success Summary

The existing runtime summary should remain compact, but the Codex line should reflect the startup state more precisely.

Examples:

- `Codex App Server: starting ws://127.0.0.1:4200`
- `Codex App Server: running ws://127.0.0.1:4200`
- `Codex App Server: delayed ws://127.0.0.1:4200`
- `Codex App Server: failed ws://127.0.0.1:4200`

## Time Display Rules

### Human-Facing Output

Human-facing CLI output should display local time with timezone.

Recommended format:

- `Started: 2026-04-17 16:22:19 GMT+8`

Equivalent local timezone labels are acceptable as long as the zone is explicit.

### Machine-Facing Output

Stored state and logs may continue using raw ISO UTC timestamps.

That includes:

- persisted runtime state
- structured logs
- diagnostics payloads

### Reasoning

This keeps:

- human summaries readable
- machine formats stable

without forcing the user to mentally convert UTC during normal operation.

## Diagnostics Policy

### Headline First

User-facing output should lead with the interpreted state, not the raw exception text.

### Diagnostics Second

Detailed diagnostics should remain available after the headline when useful, for example:

- stderr excerpt
- exit code
- readiness URL
- timeout duration

These details support debugging, but should not replace the summary line.

## Foreground And Daemon Behavior

### Foreground Start

If startup is delayed but not proven failed:

- do not present the situation as an immediate fatal stop
- keep the runtime visible as delayed or starting
- give the user recovery guidance

### Daemon Summary

If the daemon is running but Codex readiness is delayed:

- runtime summary should show the daemon as running
- Codex App Server should show `delayed` instead of a binary running/stopped label

This avoids the current confusing mix where the overall process is up but the only visible message sounds terminal.

## Testing Strategy

Add or update tests that prove:

- readiness timeout copy uses the new warning framing
- hard failures still use failure framing
- local display time is shown in the runtime summary with timezone
- raw UTC ISO is not shown as the main `Started:` display line
- runtime summary can represent delayed Codex startup separately from stopped state

## Rollout Notes

Recommended implementation order:

1. introduce explicit startup state vocabulary for managed Codex readiness
2. change the timeout path to produce delayed-startup messaging when appropriate
3. align CLI summary lines with the new state model
4. keep detailed diagnostics behind the user-facing headline

## Why This Design

The main issue is not that the current timeout string is technically wrong.

The issue is that it communicates the wrong product state.

Users need to know:

- is it still coming up
- is it definitely broken
- what is affected
- what should I do next

This design answers those questions directly and makes the displayed time feel trustworthy in the user's local shell.
