# Transcript Display Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` when executing this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Convert Discord session threads from a mixed event log into a conversation-first transcript with role-aware rendering, one low-noise status surface, and snapshot reconciliation that no longer injects duplicate mid-turn transcript entries.

**Architecture:** Keep the current single-process Bun runtime and Codex App Server integration. This change stays inside the presentation and synchronization layer: transcript collection/rendering, runtime in-memory tracking, approval/status message handling, and snapshot scheduling.

**Tech Stack:** Bun, TypeScript, `discord.js`, `bun test`

---

## File Map

### Runtime / Orchestration

- Update: `src/index.ts`

### Discord Presentation

- Update: `src/discord/transcript.ts`
- Update: `src/discord/renderers.ts`

### Tests

- Update: `tests/discord/thread-handler.test.ts`
- Update: `tests/discord/transcript.test.ts`
- Update: `tests/index.test.ts`

### Docs

- Update: `README.md`

## Task 1: Lock Transcript Role Semantics and Rendering Rules

**Files:**
- Update: `src/discord/transcript.ts`
- Update: `tests/discord/transcript.test.ts`

- [ ] Define transcript entry types that match the spec:
  - Discord-originated user input is not rendered as a bot transcript echo
  - live-observed non-Discord user input can be labeled `Codex CLI`
  - assistant commentary and final-answer behavior are explicit
  - successful command execution is excluded from main transcript rendering
  - failed command execution becomes a compact system summary

- [ ] Add tests for:
  - Discord user echo suppression
  - best-effort `Codex CLI` labeling rules
  - commentary-only vs final assistant output behavior
  - failed command summary formatting
  - command success suppression

## Task 2: Replace Event Spam with a Single Editable Status Card

**Files:**
- Update: `src/index.ts`
- Update: `src/discord/renderers.ts`
- Update: `tests/index.test.ts`

- [ ] Introduce per-session runtime tracking for one editable status message
- [ ] Stop sending standalone thread messages for:
  - `turn/started`
  - `thread/status/changed`
  - `item/started`
  - successful command completion
- [ ] Update the status card in place for:
  - `Running`
  - short commentary activity
  - current command summary
  - `Waiting for approval`
  - `Idle`
- [ ] Keep degradation and session-start/import messages as explicit one-off `CodeHelm` system messages

## Task 3: Make Assistant and Approval Messages Single-Source and Non-Duplicated

**Files:**
- Update: `src/index.ts`
- Update: `src/discord/transcript.ts`
- Update: `tests/index.test.ts`

- [ ] Keep one streaming Discord message per assistant item and finalize it in place
- [ ] Ensure `item/completed` and `turn/completed` do not double-publish the same assistant reply
- [ ] Key approval thread messages by request id and edit the same message from pending to resolved
- [ ] Preserve DM controls for the owner, but reduce thread approval noise to a single compact lifecycle message per request

## Task 4: Re-scope Snapshot Reconciliation to Idle / Recovery Paths

**Files:**
- Update: `src/index.ts`
- Update: `tests/index.test.ts`

- [ ] Skip periodic `thread/read(includeTurns=true)` polling while a session is:
  - `running`
  - `waiting-approval`
- [ ] Keep snapshot reconciliation for:
  - daemon startup seeding
  - session import
  - turn completion
  - idle recovery
- [ ] Treat pre-materialization `includeTurns unavailable before first user message` as expected and non-warning
- [ ] Preserve best-effort external modification detection for idle sessions without reintroducing mid-turn duplicate transcript output

## Task 5: End-to-End Cleanup and Documentation

**Files:**
- Update: `README.md`
- Update: `tests/discord/thread-handler.test.ts`
- Update: `tests/discord/transcript.test.ts`
- Update: `tests/index.test.ts`

- [ ] Update tests to match the new conversation-first thread behavior
- [ ] Add or adjust integration tests for:
  - no duplicate bot echo for Discord-originated messages
  - compact approval lifecycle
  - status-card-only running updates
  - snapshot suppression during active turns
- [ ] Update README to describe:
  - conversation-first transcript model
  - supported `Codex CLI` shared-thread behavior
  - best-effort external modification detection and read-only downgrade

## Verification

- [ ] Run: `bun test`
- [ ] Run: `bun run typecheck`
- [ ] Run: `bun run migrate`
- [ ] Run a manual Discord smoke test against the existing local setup:
  - `/workdir-list`
  - `/session-new workdir:example`
  - send one Discord-originated prompt
  - verify one assistant reply, one status card, and no user echo duplication

