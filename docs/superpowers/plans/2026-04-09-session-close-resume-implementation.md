# Session Close and Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` when executing this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `session-close` and `session-resume` so CodeHelm can archive and later restore the same Discord thread for a managed Codex session, with sync-first resume semantics.

**Architecture:** Keep the existing single-process Bun runtime. Add explicit Discord lifecycle state to persisted sessions, expose new control commands, and route archived-thread behavior through one resume path that always reconciles Codex state before allowing new input.

**Tech Stack:** Bun, TypeScript, `discord.js`, SQLite, `bun:test`

---

## File Map

### Persistence

- Update: `src/db/migrate.ts`
- Update: `src/db/migrations/001_init.sql`
- Update: `src/db/repos/sessions.ts`
- Update: `tests/db/session-repo.test.ts`

### Discord Command Surface

- Update: `src/discord/commands.ts`
- Update: `tests/discord/commands.test.ts`

### Runtime / Lifecycle Orchestration

- Update: `src/index.ts`
- Update: `src/discord/thread-handler.ts`
- Update: `src/domain/session-service.ts`
- Update: `src/domain/types.ts`
- Update: `tests/index.test.ts`
- Update: `tests/discord/thread-handler.test.ts`
- Update: `tests/domain/session-service.test.ts`

### Docs

- Update: `README.md`

## Task 1: Persist Discord Lifecycle State Separately from Runtime State

**Files:**
- Update: `src/db/migrate.ts`
- Update: `src/db/migrations/001_init.sql`
- Update: `src/db/repos/sessions.ts`
- Update: `tests/db/session-repo.test.ts`

- [ ] Add explicit session lifecycle storage for Discord thread state, using `active` / `archived`, without overloading the existing runtime `state` column.
- [ ] Keep `001_init.sql` as the bootstrap schema for fresh databases, but add an explicit upgrade path in `src/db/migrate.ts` for existing databases that need the new lifecycle columns/state.
- [ ] Expand the session repo API to:
  - read/write lifecycle state
  - mark sessions detached/deleted when the Discord thread container is removed
  - list archived sessions distinctly
  - represent runtime state, lifecycle state, and read-only degradation together
- [ ] Add repo tests for insert defaults, archive/unarchive transitions, and list output that preserves both runtime and lifecycle semantics.

## Task 2: Add Control-Channel Commands for Close and Resume

**Files:**
- Update: `src/discord/commands.ts`
- Update: `tests/discord/commands.test.ts`
- Update: `src/index.ts`

- [ ] Add `/session-close` and `/session-resume` command definitions.
- [ ] Keep `/session-close` thread-scoped and owner-only.
- [ ] Make `/session-resume` control-channel-only, owner-only, and require a managed Codex thread id argument.
- [ ] Update `/session-list` implementation in `src/index.ts` so it lists managed sessions from persistence instead of only live Codex threads, and include:
  - Discord thread reference when available
  - Codex thread id
  - workdir id
  - lifecycle state
  - runtime state
  - access mode
- [ ] Add command tests for option parsing, defer behavior, and service delegation.

## Task 3: Implement Archive and Sync-First Resume in the Runtime

**Files:**
- Update: `src/index.ts`
- Update: `src/domain/types.ts`
- Update: `src/domain/session-service.ts`
- Update: `tests/index.test.ts`
- Update: `tests/domain/session-service.test.ts`

- [ ] Add service handlers for `closeSession` and `resumeSession`.
- [ ] Expand the shared state model so lifecycle state, runtime state, and access mode are represented distinctly in code, not only in spec prose.
- [ ] Implement close as:
  - validating ownership
  - archiving the same Discord thread
  - persisting lifecycle state as archived
  - keeping the Codex thread mapping and runtime state intact
- [ ] Implement resume as:
  - locating the existing managed session
  - reading current Codex thread state
  - reconciling transcript/status/approval before reopening
  - unarchiving the same Discord thread
  - restoring writable vs read-only behavior based on synced state
  - treating `interrupted` as a resumable idle-equivalent branch once Codex has returned to next-input-ready state
- [ ] Add tests for:
  - archive state transitions
  - resume behavior for `idle`
  - resume behavior for `running` / `waiting_approval`
  - resume behavior for `interrupted`
  - read-only resume for degraded sessions
  - error-surface resume behavior for `error`
  - failure behavior when sync cannot establish a trustworthy view

## Task 4: Route Archived Thread Messages Through Implicit Resume

**Files:**
- Update: `src/index.ts`
- Update: `src/discord/thread-handler.ts`
- Update: `tests/index.test.ts`
- Update: `tests/discord/thread-handler.test.ts`

- [ ] Detect owner messages sent into archived managed threads.
- [ ] Treat those messages as implicit resume attempts, not as direct turn-start requests.
- [ ] Ensure the archived-thread path:
  - runs resume sync first
  - only forwards the original message if the synced runtime state is `idle`
  - rejects forwarding for `running` / `waiting_approval`
  - stays read-only for degraded sessions
- [ ] Ignore or reject non-owner archived-thread messages without reopening the thread.
- [ ] Preserve the spec rule that remote `codex resume --remote` activity does not auto-unarchive the Discord thread.

## Task 5: Handle External Discord Thread Deletion as Detach, Not Resume

**Files:**
- Update: `src/index.ts`
- Update: `src/db/repos/sessions.ts`
- Update: `tests/index.test.ts`
- Update: `tests/db/session-repo.test.ts`

- [ ] Subscribe to Discord thread deletion events for managed session threads.
- [ ] When a managed thread is deleted externally:
  - mark the session as detached/deleted in persistence
  - stop treating it as resumable via same-thread `/session-resume`
  - leave the underlying Codex thread untouched
- [ ] Add tests that deleted threads do not remain eligible for same-thread resume.

## Task 6: Finish Surface Behavior, Docs, and Smoke Coverage

**Files:**
- Update: `README.md`
- Update: `tests/index.test.ts`
- Update: `tests/discord/commands.test.ts`
- Update: `tests/db/session-repo.test.ts`

- [ ] Update README with the new lifecycle rules:
  - `close = archive same thread`
  - `resume = sync then unarchive same thread`
  - archived Discord threads do not auto-reopen from remote CLI activity
- [ ] Add focused regression coverage for session listing and archived-session discovery.
- [ ] Run a Discord smoke test against the existing local setup:
  - create session
  - close session
  - confirm archived thread remains mapped
  - resume from control channel
  - confirm same thread id is reused
  - confirm archived-thread owner message follows sync-first resume behavior
  - delete a managed thread and confirm it is no longer resumable as the same thread

## Verification

- [ ] Run: `bun test tests/db/session-repo.test.ts`
- [ ] Run: `bun test tests/discord/commands.test.ts`
- [ ] Run: `bun test tests/discord/thread-handler.test.ts`
- [ ] Run: `bun test tests/index.test.ts`
- [ ] Run: `bun test`
- [ ] Run: `bun run typecheck`
- [ ] Run: `bun run migrate`
