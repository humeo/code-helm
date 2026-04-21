# CodeHelm Runtime Panel Copy Cleanup Design

Date: 2026-04-21

## Summary

Tighten the shared CodeHelm runtime panel so it shows only high-value, non-redundant information in both `status` and `start` flows.

This design is a narrow follow-up to the broader CLI panel work. It changes four display details across the shared runtime panel used by:

- `code-helm status`
- successful `code-helm start`
- `code-helm start` when a runtime is already active

- remove `Time Zone` from the `Configuration` section
- rename `Runtime State` to `State Source`
- show the actual runtime state file path for `State Source`
- rename `Next steps` to `Quick actions`

This design also removes the redundant `code-helm status` action from the `status` screen while preserving it in `start` output where it remains a useful follow-up command.

## Problem

The current runtime panel contains a few labels that are technically correct but product-wise awkward.

### 1. `Time Zone` adds low value in the runtime panel

The panel already renders `Started` in a readable local format. Repeating `Time Zone` in `Configuration` adds extra visual weight without helping the user take action.

### 2. `Runtime State` sounds like an execution status, not a storage location

The current value is the fixed phrase `local state file`, which is not actionable and can be misread as a state enum rather than the source of the displayed runtime summary.

### 3. `Next steps` is broader than what the panel actually offers

For an already-rendered runtime summary, the action list behaves more like a small command palette than a sequential workflow.

### 4. `code-helm status` is redundant on the status screen but useful after `start`

Showing the same command that the user just ran does not help them move forward on the `status` screen, but it remains a useful follow-up command after `start`.

## Goals

- make runtime panels more self-explanatory
- reduce low-signal configuration noise
- make the state source actionable by showing a real path
- use action language that matches the panel behavior
- keep the change narrow and low risk

## Non-Goals

- changing runtime state storage behavior
- changing startup or failure messaging outside the status runtime panel
- redesigning other command panels in this pass
- changing command semantics or introducing new commands

## Approaches Considered

### 1. Shared runtime-panel cleanup

Recommended.

Update the shared runtime panel copy and value selection so `status` and `start` stay visually aligned.

Benefits:

- smallest possible change set
- directly addresses the confusing labels the user noticed
- preserves consistency between `start` and `status`
- low regression risk

Tradeoff:

- other non-runtime panels may still use older section titles until a future pass

### 2. Broader runtime-panel consistency pass

Apply the same wording changes to every runtime-oriented panel and related warning or success surface.

Benefits:

- strongest consistency

Drawbacks:

- larger test churn
- broader scope than requested

## Design

### Scope

The change should stay inside the shared runtime panel rendering path in `src/cli/commands.ts`, with test updates in the existing CLI output tests.

The shared panel changes should apply to:

- `code-helm status`
- successful `code-helm start`
- `code-helm start` when it returns the currently active runtime instead of launching a second instance

This design does not broaden into startup failure panels or other non-runtime surfaces.

### Configuration Section

The `Configuration` section for a running runtime should become:

- `State Source` -> absolute path to the runtime state file

`Time Zone` should be removed from the shared runtime panel.

`State Source` should point at the same file used by the runtime-state reader and writer:

- `<stateDir>/runtime.json`

This keeps the display aligned with the current runtime state implementation rather than inventing a second source label.

### Action Section Naming

For the shared runtime panel, rename the action section title from:

- `Next steps`

to:

- `Quick actions`

This better matches the meaning of the listed commands. They are optional follow-up commands, not an ordered recovery flow.

### Action List Contents

Action contents should continue to follow the command context.

When rendering `code-helm status`, remove:

- `code-helm status`

The remaining actions should still depend on runtime mode:

- running foreground: `codex --remote ...` and the foreground stop guidance
- running background: `codex --remote ...` and `code-helm stop`
- not running: `code-helm start` and `code-helm onboard`

When rendering successful `code-helm start` output, keep:

- `code-helm status`

This command is not redundant there because it is a useful follow-up for checking runtime state later.

The only intentional action removal in this design is the self-referential `code-helm status` action from the `status` screen itself.

## Implementation Notes

- derive the runtime state file path from the existing resolved `stateDir`
- keep the shared renderer and add only the minimal caller context needed to decide whether `code-helm status` should be shown
- avoid duplicating runtime-state path logic in multiple places where possible
- keep the broader renderer section model intact; this is a copy-and-values refinement, not a renderer rewrite

## Testing

Update CLI tests to verify:

- the `status` runtime panel no longer shows `Time Zone`
- the `status` runtime panel shows `State Source`
- the `status` runtime panel contains the expected `runtime.json` path
- the `status` runtime panel uses `Quick actions`
- the `status` runtime panel no longer includes `code-helm status`
- the successful `start` runtime panel no longer shows `Time Zone`
- the successful `start` runtime panel shows `State Source`
- the successful `start` runtime panel contains the expected `runtime.json` path
- the successful `start` runtime panel uses `Quick actions`
- the successful `start` runtime panel still includes `code-helm status`

No new behavioral tests are needed outside the existing CLI panel coverage because runtime lifecycle semantics are unchanged.
