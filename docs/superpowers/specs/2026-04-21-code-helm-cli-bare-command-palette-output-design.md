# CodeHelm CLI Bare Command Palette Output Design

Date: 2026-04-21

## Summary

CodeHelm should replace its current box-framed CLI panel style with a modern, frame-free command-line presentation language.

The new style should feel closer to a polished developer tool homepage than a terminal status card:

- no full-width outer boxes
- no heavy line-drawing frame as the primary visual device
- strong hierarchy through title, spacing, short section labels, and alignment
- pure-text readability first
- ASCII-safe fallback without changing the overall information structure

This design covers the full CLI surface:

- `code-helm help`
- `code-helm --help`
- `code-helm version`
- `code-helm update`
- `code-helm onboard`
- `code-helm start`
- `code-helm start --daemon`
- `code-helm status`
- `code-helm stop`
- `code-helm autostart enable`
- `code-helm autostart disable`
- `code-helm uninstall`
- top-level CLI failures
- runtime startup warnings and startup failures

This design supersedes the framed output direction in:

- `docs/superpowers/specs/2026-04-20-code-helm-cli-panel-output-design.md`

## Problem

### 1. The current panel system feels too boxed-in

The current CLI renderer depends on full-frame borders as the main presentation pattern.

That made output more consistent than the earlier ad hoc strings, but it still reads like an internal status panel rather than an intentional modern CLI surface.

For commands like `help`, `version`, `status`, and `update`, the line box becomes the thing the user notices first instead of the information hierarchy.

### 2. Help output reads like a framed notice, not a command palette

`code-helm --help` is one of the most important product surfaces.

Today it presents:

- a framed title
- an overview paragraph
- a raw command list
- examples

The information is correct, but it does not feel like a modern tool's command overview. It feels more like a boxed README excerpt.

### 3. The panel language flattens different command intents

CodeHelm currently routes many different outcomes through the same broad visual treatment:

- discovery
- runtime inspection
- mutation confirmation
- warnings
- failures

That consistency helped implementation, but it also means every command starts to look like the same box with different text inside.

### 4. Pure-text friendliness should remain a first-class requirement

The user explicitly wants a more modern CLI style without depending on color or terminal graphics.

That means the redesign cannot assume:

- ANSI color
- rich terminal theming
- Unicode line art as the main structure

The output must still look deliberate in:

- plain terminal recordings
- CI logs
- `TERM=dumb`
- ASCII-only environments

### 5. Onboarding needs to join the same product language

The repository currently treats `onboard` somewhat separately because it is interactive and built on `@clack/prompts`.

The user asked for all commands to align with the new style, so onboarding should also feel like part of the same CLI product, even if its interaction model remains prompt-driven.

## Approaches Considered

### 1. Bare command palette across the full CLI surface

Recommended.

Replace framed panels with a frame-free layout built from:

- title
- short subtitle or result sentence
- typed sections
- aligned rows
- command lists
- short next-step lists

Benefits:

- matches the requested modern CLI tone
- keeps the interface readable in plain text
- gives `help` a much stronger first impression
- scales across informational, operational, and failure outputs

Tradeoff:

- changes almost every user-facing snapshot
- requires a more expressive layout model than the current `title + lines` frame renderer

### 2. Keep panels, but reduce them to lighter separators

This would remove the heavy border while still thinking in terms of mini-panels and framed groupings.

Benefits:

- smallest migration from the current renderer
- easy to keep existing helpers mostly unchanged

Drawbacks:

- risks feeling like a softened version of the current design instead of a real redesign
- does not fully deliver the command-palette feel the user selected

### 3. Lean on ANSI colors and emphasis while keeping plain text simple

Benefits:

- quick visual modernization
- easy to highlight status and commands

Drawbacks:

- conflicts with the stated requirement that pure text must stand on its own
- degrades in logs, screen recordings, and low-capability terminals
- encourages aesthetics that are not encoded in actual information structure

## Goals

- replace the boxed panel look with a modern, frame-free CLI language
- make `help` feel like a developer-tool command palette rather than a framed notice
- keep all commands under one recognizable visual system
- preserve scan efficiency for runtime and failure outputs
- keep output compact, textual, and terminal-friendly
- preserve ASCII fallback as a layout-compatible variant rather than a different product surface
- include `onboard` in the same product language where prompt constraints allow

## Non-Goals

- changing command names or semantics
- introducing ANSI color themes
- adding JSON or machine-readable output modes
- redesigning Discord runtime behavior
- replacing `@clack/prompts` with a different onboarding library in this phase
- rewriting command business logic that is unrelated to presentation

## Design

### Visual Language

The new CLI should adopt a bare command palette language with four stable ingredients:

1. a primary title
2. a short subtitle or outcome sentence
3. one or more compact sections
4. optional next-step commands

The interface should avoid full-width decorative containers.

Instead, hierarchy should come from:

- whitespace
- section ordering
- concise section titles
- aligned command descriptions
- aligned key/value rows when field scanning matters

The renderer should prefer short, direct English copy.

It should avoid:

- framing everything in a border
- long overview paragraphs when a grouped list is clearer
- repeating the same status line in multiple sections
- placing diagnostics before the interpreted result

### Command Families

To keep the whole CLI coherent without making every command look identical, the output should be organized into four display families.

#### 1. Discoverability

Used by:

- `help`
- `version`

Purpose:

- orient the user
- describe the available surface
- present common flows

#### 2. Runtime lifecycle

Used by:

- `start`
- `status`
- `stop`

Purpose:

- tell the user whether CodeHelm is running
- summarize process and connection state
- make the next operational step obvious

#### 3. Mutation confirmation

Used by:

- `update`
- `autostart enable`
- `autostart disable`
- `uninstall`

Purpose:

- confirm what changed
- preserve a compact audit trail
- guide the next verification step

#### 4. Failures and warnings

Used by:

- CLI argument failures
- startup delays
- startup failures
- update failures
- stop failures
- onboarding-blocked conditions

Purpose:

- lead with the conclusion
- give actionable next steps
- keep diagnostics available but secondary

### Layout Rules

Across all command families, the renderer should follow these layout rules.

#### Titles

The first line should be the screen identity, for example:

- `CodeHelm`
- `Runtime`
- `CodeHelm 0.1.0`
- `Update failed`

Titles should be short and product-facing.

#### Subtitle or result line

The second line should immediately tell the user what they are looking at.

Examples:

- `Control Codex from Discord`
- `CodeHelm is running in background mode`
- `The latest published package was installed`
- `The command arguments are invalid`

This line replaces much of what framed headlines currently try to communicate.

#### Sections

Section titles should be short and lower-friction than the current panel headings.

Preferred examples:

- `Get started`
- `Runtime`
- `Common flows`
- `Process`
- `Connections`
- `Changed`
- `Next steps`
- `Try next`
- `Diagnostics`

The renderer may use a light textual separator such as a blank line and a heading, but should not use a full surrounding box.

#### Lists

Two list layouts should be first-class:

- command list
- key/value rows

Command lists should look like:

```text
start                Start CodeHelm in foreground
start --daemon       Start CodeHelm in background
status               Show runtime state
```

Key/value rows should remain aligned, for example:

```text
Mode        foreground
PID         81234
Discord     connected to guild 123 channel 456
```

#### Next-step commands

Commands the user can run next should appear in a dedicated section.

They should never be buried inside prose.

The presentation should remain plain text, for example:

```text
Next steps
  code-helm status
  codex --remote ws://127.0.0.1:4321
```

### Command-Specific Mapping

### `help`

`help` and `--help` should become the clearest expression of the new style.

It should no longer render as a success panel.

Instead it should render as a command palette screen with:

- title: `CodeHelm`
- subtitle: a one-line product description
- grouped command sections
- common flows

Recommended sections:

1. `Get started`
2. `Runtime`
3. `Automation`
4. `Maintenance`
5. `Common flows`

Example command groupings:

- `Get started`
  - `onboard`
  - `help`
  - `version`
- `Runtime`
  - `start`
  - `start --daemon`
  - `status`
  - `stop`
- `Automation`
  - `autostart enable`
  - `autostart disable`
- `Maintenance`
  - `update`
  - `uninstall`

Each command should include a short description.

The existing `Overview` paragraph should be removed in favor of the subtitle plus command descriptions.

The old `Examples` section should become `Common flows`, using real operator sequences rather than a loose list.

### `version`

`version` should be extremely compact.

Recommended format:

- title line containing the product and version, for example `CodeHelm 0.1.0`
- one short metadata line if needed, such as package name

It should not render as a framed two-section screen.

It should remain configuration-free and runtime-free.

The version source of truth remains `package.json` and the shared metadata path already established in the prior design.

### `start`

`start` should render a runtime screen that feels like a live operator summary rather than a boxed status card.

Recommended shape:

1. title: `Runtime`
2. result line:
   - foreground success: `CodeHelm is running in foreground mode`
   - daemon success: `CodeHelm started in background mode`
   - already running: `A CodeHelm runtime is already active`
3. sections:
   - `Process`
   - `Connections`
   - `Configuration` when materially useful
   - `Next steps`

`Process` should include:

- mode
- pid
- started time

`Connections` should include:

- Discord status
- Codex App Server address and running state

`Configuration` should stay intentionally light and only include durable facts the user can act on.

`Next steps` should include:

- `code-helm status`
- `codex --remote ...`
- `code-helm stop` for background mode
- a foreground-specific stop hint when relevant

### `status`

`status` should reuse the same runtime screen shape as `start`.

The key distinction is the subtitle:

- when running: a factual current-state sentence
- when not running: `CodeHelm is not running`

The not-running view should still feel like the same family, but with a smaller number of sections:

- `Process`
- `Next steps`

It should not pretend that missing runtime data is equivalent to a fully populated status card with `n/a` everywhere unless that is genuinely the clearest presentation.

The preferred not-running output is shorter and more direct.

### `stop`

`stop` success should be short and confident.

Recommended shape:

- title: `Runtime stopped`
- subtitle: `The background CodeHelm process is no longer active`
- optional `Next steps`

If the runtime was foreground-owned and cannot be stopped from the current invocation, the output should move into the warning family instead of simulating a successful stop.

### `autostart enable`

Recommended shape:

- title: `Autostart enabled`
- subtitle: `CodeHelm will launch automatically for this user session`
- `Changed`
- `Next steps`

`Changed` should include the launch label and launch agent path when relevant.

If the underlying service response indicates a mismatch or partial state, the output should become a warning screen with the same family language.

### `autostart disable`

Recommended shape:

- title: `Autostart disabled`
- subtitle: `The launch agent is no longer active`
- `Changed`
- `Next steps`

The not-found case should be treated as a compact warning or no-op confirmation rather than a full error unless the underlying operation truly failed.

### `update`

`update` should read like a mutation confirmation, not a panelized shell transcript.

Success shape:

- title: `CodeHelm updated`
- subtitle: `The latest published package was installed`
- `Command run`
- `Next steps`

`Command run` should keep the actual npm invocation visible for auditability.

`Next steps` should include:

- `code-helm version`
- optionally `code-helm restart` is not valid today, so do not invent it
- if CodeHelm is already running, keep the current semantic note that the new package affects future invocations rather than the current process

Failure shape:

- title: `Update failed`
- subtitle: `The package update did not complete`
- `Try next`
- `Diagnostics`

### `uninstall`

`uninstall` should use the mutation confirmation family.

Success shape:

- title: `CodeHelm uninstalled`
- subtitle: `Local CodeHelm data was removed`
- `Removed`
- `Next steps`

`Removed` should list deleted files and directories in a compact path list.

If uninstall requires the runtime to be stopped first, that guidance should appear in `Try next` or `Blocked`, not as a raw thrown string.

### `onboard`

`onboard` is interactive, so it cannot fully share the same static screen layout as non-interactive commands.

However, it should still align with the same product language in three places:

1. intro and note copy
2. review summary formatting
3. completion and blocked messaging

#### Intro

The opening `@clack/prompts` intro should feel closer to:

- product title
- short purpose sentence

and less like a generic setup wizard heading.

#### Review summary

The review block should adopt the same alignment discipline used elsewhere in the CLI.

Instead of a loose list of colon-separated values, it should read like a compact setup summary with stable row ordering.

#### Completion

The completion outro should match the palette language:

- concise completion sentence
- one explicit next command

#### Already-running or blocked onboarding

Cases that escape the interactive flow and return through `runCliCommand(...)` should use the same warning or blocked-screen family as the rest of the CLI.

This includes:

- onboarding blocked because a runtime is already running
- onboarding cancellation messaging when surfaced at the command level

### Failures and Warnings

All warnings and errors should follow the same information order:

1. conclusion
2. actionable next steps
3. diagnostics

This order matters more in the new frame-free design because structure must come from information hierarchy rather than borders.

#### Invalid arguments

The argument error surface should render:

- title: `Invalid arguments`
- subtitle explaining what was wrong
- `Usage`

If there are multiple usage lines, the renderer should present only the relevant command-specific usage first, followed by the broader root usage if needed.

It should not feel like a raw parser exception dump.

#### Startup delayed

Recommended shape:

- title: `Startup delayed`
- subtitle: `Managed Codex App Server startup is taking longer than expected`
- `Try next`
- `Diagnostics` when available

#### Startup failed

Recommended shape:

- title: `Startup failed`
- subtitle explaining the interpreted failure class
- `Try next`
- `Diagnostics`

Certificate failures should keep their targeted trust guidance, but that guidance should live under `Try next` or `Fix this` rather than inside a framed "How To Fix" panel section.

#### Update failed

Use the shared failure family described above.

#### Stop failed

Differentiate:

- process signal failure
- shutdown wait timeout

The subtitle should tell the user which category occurred before diagnostics appear.

### Rendering Architecture

The implementation should preserve the existing broad separation:

- `src/cli/commands.ts` decides what to say
- `src/cli/output.ts` decides how it looks

However, the output layer should stop thinking in terms of framed panels.

#### Keep the current semantic entry points

To avoid unnecessary churn in the command layer, keep these top-level renderer functions:

- `renderRuntimePanel(...)`
- `renderSuccessPanel(...)`
- `renderWarningPanel(...)`
- `renderErrorPanel(...)`

Their names can remain for now even though the visual result is no longer a panel.

This lets the codebase migrate style without requiring every command path to adopt new calling conventions immediately.

#### Replace frame-based rendering with screen-based rendering

`src/cli/output.ts` should evolve from:

- `renderPanelFrame(...)`

to a frame-free screen renderer conceptually shaped like:

- `renderCliScreen(...)`
- `renderSection(...)`
- `renderCommandList(...)`
- `renderKeyValueRows(...)`
- `renderStepList(...)`
- `renderDiagnosticsBlock(...)`

The exact helper names may vary, but the renderer should become type-aware rather than treating everything as flat lines inside a box.

#### Typed sections

At minimum, the output layer should support these section types:

- text
- command list
- key/value rows
- step list
- path list
- diagnostics

This gives `help`, runtime output, and failures the structure they need without forcing them into one generic `lines: string[]` model.

The implementation may keep `lines: string[]` as a compatibility layer during migration, but the target state should be typed sections.

#### Charset handling

`detectCliCharset(...)` should remain.

Its job changes slightly:

- it no longer decides the outer frame characters
- it chooses lightweight separators or bullet tokens when needed

The important rule is that Unicode and ASCII variants must preserve the same hierarchy and ordering.

The user should see the same product, not two different layouts.

### Testing

The redesign should be locked with both command-level and renderer-level tests.

#### Renderer tests

Update `tests/cli/output.test.ts` so it verifies:

- output no longer depends on outer panel borders
- command lists align predictably
- key/value rows remain aligned
- diagnostics always appear after the conclusion and next-step guidance
- ASCII fallback preserves structure rather than collapsing sections
- `renderCliCaughtError(...)` normalizes raw failures into the new failure family

#### Command tests

Update `tests/cli/commands.test.ts` so it verifies:

- `help` includes grouped command categories and short descriptions
- `version` renders as a compact identity string rather than a multi-section panel
- `start` and `status` share the same runtime family
- `stop`, `update`, `autostart`, and `uninstall` use the mutation confirmation family
- warning and error flows expose `Try next` and `Diagnostics` in the expected order
- onboarding blocked flows align with the new warning language

The tests should stop overfitting to old section titles such as `Overview` when those titles are being intentionally replaced.

#### Verification commands

Before implementation is considered complete, run:

- `bun test`
- `bun run typecheck`

## Open Questions

- Whether the renderer should migrate fully to typed sections in one change set or use a compatibility bridge first
- Whether `version` should include the package name on a second line or remain a single-line identity screen
- Whether onboarding cancellation should stay minimal at the prompt layer or be wrapped in the same command-level failure family when surfaced from `runCliCommand(...)`

## Recommendation

Implement the redesign as a frame-free bare command palette across the entire CLI surface, with `help` as the clearest expression of the new style and the rest of the commands organized into runtime, mutation, and failure families.

Keep command semantics stable, preserve plain-text and ASCII compatibility, and concentrate most of the implementation in `src/cli/output.ts` plus targeted command-copy updates in `src/cli/commands.ts` and `src/cli/onboard.ts`.
