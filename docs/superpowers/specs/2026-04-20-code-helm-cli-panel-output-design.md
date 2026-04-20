# CodeHelm CLI Panel Output Design

Date: 2026-04-20

## Summary

CodeHelm should present its user-facing CLI output with one consistent terminal panel language instead of a mix of raw lines, plain errors, and ad hoc summaries.

This design covers:

- `code-helm start`
- `code-helm start --daemon`
- `code-helm status`
- `code-helm stop`
- `code-helm autostart enable`
- `code-helm autostart disable`
- `code-helm uninstall`
- CLI argument and usage errors
- startup warnings and startup failures

This design does not change `code-helm onboard`.

The visual direction is:

- English copy
- Unicode panel framing by default
- graceful ASCII fallback when the terminal cannot reliably render Unicode
- compact grouped output with clear next actions

## Problem

The current CLI output has become hard to scan as a product surface.

### 1. Command output is visually inconsistent

Some commands return a plain line:

- `CodeHelm stopped`

Some return a loose block:

- `CodeHelm running`
- `Mode: foreground`
- `PID: 77802`

Some failures surface raw error strings with minimal interpretation.

That inconsistency makes the CLI feel internal rather than intentional.

### 2. Startup output does not establish a reusable visual system

Recent startup feedback improvements made the copy better, but the output is still mostly string assembly.

There is no shared presentation model for:

- runtime summaries
- success confirmations
- warnings
- errors
- diagnostics
- next-step commands

### 3. Recoverable failures need clearer action guidance

Some startup failures are transient or environment-specific, such as certificate verification issues.

The CLI should explicitly tell the user when retrying is reasonable, instead of leaving them with only the low-level error sentence.

### 4. Argument errors do not match the product tone

Usage failures currently print plain error text and usage text. The information is correct, but it does not look like the rest of the CLI product.

## Approaches Considered

### 1. Shared formatter with command-by-command migration

Recommended.

Create a small internal CLI rendering layer and migrate existing commands onto it without changing command semantics.

Benefits:

- concentrated visual logic
- low migration risk
- keeps command execution logic stable
- easy to extend to more commands later

Tradeoff:

- output remains string-rendered rather than fully model-driven

### 2. Replace command outputs with a structured result model first

Each command would return a semantic object such as `success`, `warning`, `error`, `sections`, and `actions`, then a renderer would print it.

Benefits:

- strongest long-term architecture

Drawbacks:

- larger change set
- more interface churn
- slower path to the UX improvement requested now

### 3. Use a third-party terminal box library

Benefits:

- fast visual improvement

Drawbacks:

- weaker style control
- snapshot and compatibility risk
- unnecessary dependency for a small, repo-specific presentation layer

## Goals

- give all user-facing CLI output one consistent visual language
- make `start` and `status` feel like a polished runtime dashboard
- keep output compact and scannable
- make next actions obvious
- preserve diagnostics without making them the headline
- explicitly tell the user when retrying is a valid next step
- default to Unicode while remaining safe on terminals that need ASCII

## Non-Goals

- changing `code-helm onboard`
- redesigning runtime debug logging
- changing command semantics or command names
- adding colors or theme support in this design
- introducing JSON output or machine-readable CLI modes
- refactoring the entire CLI to return structured data objects

## Design

### Rendering Layer

A new rendering module should be added at:

- `src/cli/output.ts`

It should centralize all user-facing CLI presentation while keeping command logic in `src/cli/commands.ts`.

### Base Rendering Helpers

The rendering layer should provide:

- `detectCliCharset()` to choose Unicode or ASCII framing
- `wrapText()` for readable line wrapping
- `renderKeyValueRows()` for aligned key-value sections
- `renderListSection()` for compact lists such as removed paths or failure items
- `renderDiagnosticsSection()` for raw stderr or low-level details
- `renderCommandHint()` for next-step commands such as `codex --remote ...`
- `renderPanelFrame()` for the actual outer frame and titled sections

### Semantic Renderers

The rendering layer should expose a few stable entry points:

- `renderRuntimePanel(...)`
- `renderSuccessPanel(...)`
- `renderWarningPanel(...)`
- `renderErrorPanel(...)`

This keeps command files simple while making the visual style easy to adjust in one place.

### Panel Language

The panel language should be intentionally restrained.

It should use:

- one main title
- short section titles
- aligned key-value rows where helpful
- command hints in their own section
- diagnostics after the interpreted conclusion

It should avoid:

- excessive borders inside borders
- decorative noise
- large prose paragraphs when a short section is clearer

### Command Mapping

### `code-helm start`

Successful startup should render a main runtime panel titled:

- `CodeHelm Runtime`

It should include these sections:

1. `Status`
2. `Connections`
3. `Configuration`
4. `Quick Actions`

`Status` should contain:

- mode
- started time
- pid

`Connections` should contain:

- Discord connection summary
- Codex App Server address and state

`Configuration` should stay intentionally light.
It should include only stable, useful facts already available to the command surface, such as:

- foreground or background mode
- whether the Codex app server is managed or externally configured when that can be inferred clearly

`Quick Actions` should contain:

- `codex --remote ...`

If `start` discovers an already-running instance, it should reuse the same runtime panel and add a short note that the existing instance is already running.

### `code-helm status`

`status` should reuse the same runtime panel as `start`.

The goal is that a user learns one runtime summary format and sees it consistently.

### `code-helm stop`

Successful stop should render a compact success panel titled:

- `CodeHelm Stopped`

It should confirm that the runtime is no longer active.

If stopping fails, it should render an error panel that clearly distinguishes:

- signal failure
- timeout while waiting for shutdown

### `code-helm autostart enable`

Successful enable should render a success panel titled:

- `Autostart Enabled`

It should show:

- launch label
- launch agent path
- current state

### `code-helm autostart disable`

Successful disable should render a success panel titled:

- `Autostart Disabled`

It should show:

- launch label
- launch agent path
- whether a launch agent file was removed

### `code-helm uninstall`

Successful uninstall should render a success panel titled:

- `Uninstall Complete`

It should include:

- a `Removed` section listing removed paths when available
- a `Next Step` section showing `npm uninstall -g code-helm`

If uninstall completes with partial failures, the CLI should render an error panel instead of a bare joined string.

The error panel should lead with the summary conclusion and then list:

- removed items
- failed items

### CLI Argument and Usage Errors

Argument and usage failures should render through the same panel language.

Examples include:

- no command provided
- unknown command
- unknown arguments for a valid command
- invalid `autostart` usage

These should render as an error panel titled either:

- `Invalid Command`
- `Invalid Arguments`

The body should split into:

- `Problem`
- `Usage`

if the error contains usage guidance.

For other plain command errors, the body should split into:

- `Problem`
- `Details`

## Startup Warning and Failure Policy

The startup interpretation logic should continue to live in `formatStartupFailure(...)` inside `src/cli/commands.ts`, with rendering delegated to the new output layer.

### Delayed Startup

When startup is delayed but not proven dead, the CLI should render a warning panel.

It should clearly say:

- startup is taking longer than expected
- Codex requests are not ready yet
- retrying later is reasonable

Recommended next-step guidance:

- `You can retry the command in a moment if startup does not recover on its own.`

Diagnostics should still be displayed below the warning summary.

### General Startup Failure

Hard startup failures should render as an error panel titled:

- `Startup Failed`

The guidance should explicitly say both of these ideas:

- fix the issue shown in diagnostics
- retrying the command is reasonable if the failure looks transient

Recommended guidance:

- `Fix the issue shown below, then try running the command again.`

### Certificate Verification Failure

If startup failure text indicates TLS or certificate verification problems, the CLI should render a more specific error summary instead of surfacing only the raw message.

Matching may be heuristic and should look for terms such as:

- `certificate`
- `verification`
- `tls`
- `ssl`

The summary should explain that secure connection setup failed during startup.

It should suggest checking:

- proxy configuration
- corporate or custom certificate trust setup
- local network environment
- system trust chain

It should still end with an explicit retry action.

Recommended guidance:

- `Check your network or certificate trust setup, then try running the command again.`

Diagnostics must still include the original low-level message.

## Charset Fallback

Unicode should be the default panel style.

ASCII should be used when Unicode rendering is likely unreliable.

### Automatic Fallback Signals

The renderer should fall back to ASCII when any of these conditions apply:

- `TERM=dumb`
- locale values do not indicate UTF-8 support
- `CODE_HELM_CLI_ASCII=1`

This fallback should be automatic and silent.
The command semantics and content should not change, only the framing characters.

## Error Catching Boundary

Top-level CLI error formatting should be centralized in `src/cli.ts`.

The main entry point should stop printing raw `error.message` directly.
Instead, it should render the final message through the same CLI output layer so that:

- usage failures
- ordinary command errors
- startup failures

all share one visual system.

## Testing

### New Renderer Tests

Add focused renderer tests for:

- Unicode runtime panel output
- ASCII fallback output
- success panel structure
- warning panel structure
- error panel structure
- diagnostics section formatting

### Existing Command Tests

Update command-level tests to assert that:

- `start` and `status` render the runtime panel
- delayed managed startup renders warning copy with retry guidance
- startup failure renders error copy with retry guidance
- certificate verification failure gets the more specific startup guidance
- `stop`, `autostart`, and `uninstall` render panel-style success output
- usage and argument failures render panel-style errors

## Implementation Notes

The implementation should stay incremental.

Recommended order:

1. add the CLI output renderer and its tests
2. migrate runtime summary rendering
3. migrate startup warning and failure rendering
4. migrate `stop`, `autostart`, and `uninstall`
5. migrate top-level error output in `src/cli.ts`
6. update command tests

This preserves behavioral confidence while steadily moving the CLI onto one visual system.
