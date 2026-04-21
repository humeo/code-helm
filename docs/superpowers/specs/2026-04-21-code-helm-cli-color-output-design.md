# CodeHelm CLI Color Output Design

Date: 2026-04-21

## Summary

Restore the previously approved "A" direction for the CLI by layering ANSI color onto the new bare command palette renderer.

Color should enhance the modern command-line look in interactive terminals, but the renderer must still degrade cleanly to the existing plain-text output in logs and low-capability environments.

## Goals

- keep the new frame-free command palette layout
- restore a modern colored terminal presentation by default in interactive terminals
- preserve the current plain-text hierarchy when color is disabled
- automatically disable color for `NO_COLOR`, `TERM=dumb`, ASCII-only mode, and non-TTY output
- avoid changing command semantics or output ordering

## Non-Goals

- redesigning command copy again
- depending on color for meaning
- adding theme configuration in this phase

## Approach

Use semantic ANSI styling in the renderer:

- titles: cool accent emphasis
- headlines: subtle bright text
- success screens: green title accent
- warning screens: yellow title accent
- error screens: red title accent
- section titles: muted accent
- commands and command hints: cool accent emphasis

Color enablement should be decided centrally from render environment:

- enabled by default for interactive TTY output
- disabled when `NO_COLOR` is present
- disabled when `CODE_HELM_CLI_ASCII=1`
- disabled when `TERM=dumb`
- disabled when the relevant output stream is not a TTY
- `FORCE_COLOR` may explicitly enable color

## Testing

Add renderer tests that verify:

- interactive output includes ANSI escapes
- success/warning/error families use distinct title styling
- command lists and command hints highlight commands
- `NO_COLOR`, `TERM=dumb`, ASCII mode, and non-TTY output all render without ANSI escapes
- caught-error output follows the same enable/disable rules
