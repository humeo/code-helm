# Transcript Process Display Implementation Plan

Date: 2026-04-10

## Goal

Implement the revised Discord transcript model so each turn renders one preserved `Codex` process card, one plain final assistant reply, weak remote-input cards, no duplicated Discord user echo, and low-noise `CodeHelm` system/status output.

## Task 1: Lock the message model into renderer payload types

- add an explicit Discord payload abstraction for transcript output
- add explicit render targets for:
  - process card payload
  - final reply payload
  - weak remote-input payload
  - low-volume system message payload
- keep status-card rendering separate from transcript rendering

## Task 2: Rework per-turn live transcript state

- extend runtime tracking so each turn can own:
  - one editable process card message
  - one final reply identity
- track per-turn step history and dynamic footer state
- prevent duplicate final assistant emission when live completion and snapshot both see the same item

## Task 3: Normalize process steps

- map commentary, command execution, and edit-like events into compact step strings
- append only meaningful steps
- collapse consecutive duplicates
- keep `Working...` or `Waiting for approval` in the card footer while the turn is active

## Task 4: Tighten snapshot reconciliation

- snapshot recovery may backfill missing process/final messages
- snapshot recovery must not create second copies of already-rendered process or final messages
- keep active-turn polling suppressed as already designed

## Task 5: Adjust Discord thread/system output hierarchy

- remove duplicate `User: ...` transcript echo
- keep lifecycle messages under `CodeHelm`
- keep the thread-level status card small and non-conversational
- render final assistant replies as plain body text
- render remote input as a de-emphasized card instead of a body-prefixed role line

## Task 6: Test coverage

- add/adjust tests for:
  - single process card per turn
  - final reply de-duplication
  - external client input rendered as weak remote-input payload
  - dynamic footer transitions:
    - `Working...`
    - `Waiting for approval`
    - completion footer removal
  - plain final assistant reply payload without inline `Codex` prefix
  - snapshot backfill without duplicate process/final messages

## Task 7: Verification

- `bun test`
- `bun run typecheck`
- targeted Discord smoke on:
  - one normal turn
  - one approval turn
  - one archived-thread implicit resume turn
  - one shared-session remote-input turn
