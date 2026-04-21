# CodeHelm Status Panel Copy Cleanup Design

Date: 2026-04-21

## Summary

Tighten the `code-helm status` runtime panel so it shows only high-value, non-redundant information.

This design is a narrow follow-up to the broader CLI panel work. It changes only four details in the status runtime panel:

- remove `Time Zone` from the `Configuration` section
- rename `Runtime State` to `State Source`
- show the actual runtime state file path for `State Source`
- rename `Next steps` to `Quick actions` and remove the redundant `code-helm status` action from the status screen

## Problem

The current status runtime panel contains a few labels that are technically correct but product-wise awkward.

### 1. `Time Zone` adds low value in the status panel

The status panel already renders `Started` in a readable local format. Repeating `Time Zone` in `Configuration` adds extra visual weight without helping the user take action.

### 2. `Runtime State` sounds like an execution status, not a storage location

The current value is the fixed phrase `local state file`, which is not actionable and can be misread as a state enum rather than the source of the displayed runtime summary.

### 3. `Next steps` is broader than what the panel actually offers

For an already-rendered runtime summary, the action list behaves more like a small command palette than a sequential workflow.

### 4. `code-helm status` is redundant on the status screen

Showing the same command that the user just ran does not help them move forward.

## Goals

- make the `status` panel more self-explanatory
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

### 1. Minimal status-panel-only cleanup

Recommended.

Update only the runtime panel copy and value selection used by `code-helm status`.

Benefits:

- smallest possible change set
- directly addresses the confusing labels the user noticed
- low regression risk

Tradeoff:

- other commands may still use older section titles until a future pass

### 2. Broader runtime-panel consistency pass

Apply the same wording changes to every runtime-oriented panel.

Benefits:

- strongest consistency

Drawbacks:

- larger test churn
- broader scope than requested

## Design

### Scope

The change should stay inside the status runtime panel rendering path in `src/cli/commands.ts`, with test updates in the existing CLI output tests.

### Configuration Section

The `Configuration` section for a running runtime should become:

- `State Source` -> absolute path to the runtime state file

`Time Zone` should be removed from the status runtime panel.

`State Source` should point at the same file used by the runtime-state reader and writer:

- `<stateDir>/runtime.json`

This keeps the display aligned with the current runtime state implementation rather than inventing a second source label.

### Action Section Naming

For the status runtime panel, rename the action section title from:

- `Next steps`

to:

- `Quick actions`

This better matches the meaning of the listed commands. They are optional follow-up commands, not an ordered recovery flow.

### Action List Contents

When rendering `code-helm status`, remove:

- `code-helm status`

The remaining actions should still depend on runtime mode:

- running foreground: `codex --remote ...` and the foreground stop guidance
- running background: `codex --remote ...` and `code-helm stop`
- not running: `code-helm start` and `code-helm onboard`

The only intentional removal in this design is the self-referential `code-helm status` action.

## Implementation Notes

- derive the runtime state file path from the existing resolved `stateDir`
- avoid duplicating runtime-state path logic in multiple places where possible
- keep the broader renderer section model intact; this is a copy-and-values refinement, not a renderer rewrite

## Testing

Update CLI tests to verify:

- the status runtime panel no longer shows `Time Zone`
- the status runtime panel shows `State Source`
- `State Source` contains the expected `runtime.json` path
- the status runtime panel uses `Quick actions`
- the status runtime panel no longer includes `code-helm status`

No new behavioral tests are needed outside the existing CLI panel coverage because runtime lifecycle semantics are unchanged.
