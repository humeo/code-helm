# Discord Minimal Surface Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make managed Discord threads show only remote input, approval UI, and final assistant replies while keeping approval truly blocking.

**Architecture:** Trim transcript projection down to the approved visible surface, keep typing as the only transient running indicator, and route all approval request methods through one blocking approval delivery path. Approval cards stay request-scoped and update in place on resolution; if the approval card cannot be delivered, execution stays blocked and Discord gets one short localized failure notice.

**Tech Stack:** Bun, TypeScript, Discord.js, Bun test, SQLite-backed session/approval repos

---

## File Map

- Modify: `src/discord/transcript.ts`
  Keep snapshot/live transcript collection aligned with the minimal Discord surface.
- Modify: `src/index.ts`
  Stop routine process/status projection, preserve typing behavior, and centralize blocking approval delivery plus failure handling.
- Modify: `tests/discord/transcript.test.ts`
  Lock transcript collection to remote input + final assistant output only.
- Modify: `tests/index.test.ts`
  Lock the minimal visible surface, typing semantics, and approval delivery failure behavior.
- Modify: `tests/codex/jsonrpc-client.test.ts`
  Keep all approval request methods covered.

### Task 1: Lock Minimal Transcript Surface

**Files:**
- Modify: `tests/discord/transcript.test.ts`
- Modify: `tests/index.test.ts`
- Modify: `src/discord/transcript.ts`

- [ ] **Step 1: Write failing transcript tests**

Add tests that prove:
- commentary-only turns emit no Discord transcript entries
- command executions do not create transcript entries
- snapshot mismatch comparable ids ignore commentary and command items

- [ ] **Step 2: Run focused transcript tests to watch them fail**

Run: `bun test tests/discord/transcript.test.ts tests/index.test.ts`
Expected: FAIL where process/commentary entries are still projected

- [ ] **Step 3: Implement minimal transcript projection**

Update `src/discord/transcript.ts` so `collectTranscriptEntries()` and `collectComparableTranscriptItemIds()` only include:
- remote input entries
- final assistant entries

- [ ] **Step 4: Re-run focused transcript tests**

Run: `bun test tests/discord/transcript.test.ts tests/index.test.ts`
Expected: PASS for the minimal transcript surface assertions

### Task 2: Remove Routine Process / Status Projection While Preserving Typing

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Add tests that prove:
- live process/commentary does not render a Discord transcript bubble
- typing still runs only while session state is `running`
- no routine status card output is produced for managed thread execution updates

- [ ] **Step 2: Run focused runtime tests to watch them fail**

Run: `bun test tests/index.test.ts`
Expected: FAIL where running updates still materialize process/status output

- [ ] **Step 3: Implement the runtime change**

Update `src/index.ts` so:
- live commentary/command events no longer project process bubbles
- status updates only control typing and no longer emit routine thread status messages
- final assistant replies and remote input projection still work

- [ ] **Step 4: Re-run focused runtime tests**

Run: `bun test tests/index.test.ts`
Expected: PASS for minimal surface and typing assertions

### Task 3: Make Approval Surface Blocking And Fail-Closed

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`
- Modify: `tests/codex/jsonrpc-client.test.ts`

- [ ] **Step 1: Write failing approval tests**

Add tests that prove:
- all three approval request methods share the same Discord approval surface path
- approval delivery failure raises a short localized thread notice instead of silently continuing
- approval resolution still edits the same card in place

- [ ] **Step 2: Run focused approval tests to watch them fail**

Run: `bun test tests/codex/jsonrpc-client.test.ts tests/index.test.ts`
Expected: FAIL where approval delivery failure has no explicit Discord notice and normal execution surfaces still leak

- [ ] **Step 3: Implement blocking approval delivery**

Update `src/index.ts` so:
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`

all flow through one delivery helper that:
- stops typing
- persists pending approval
- upserts the request-scoped approval card in the thread
- sends one short thread-language failure notice if the approval card cannot be delivered
- never replies to Codex automatically on failure

- [ ] **Step 4: Re-run focused approval tests**

Run: `bun test tests/codex/jsonrpc-client.test.ts tests/index.test.ts`
Expected: PASS for approval routing and fail-closed delivery behavior

### Task 4: Full Verification

**Files:**
- Modify: `src/index.ts`
- Modify: `src/discord/transcript.ts`
- Modify: `tests/discord/transcript.test.ts`
- Modify: `tests/index.test.ts`
- Modify: `tests/codex/jsonrpc-client.test.ts`

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 2: Run static type verification**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

Run:
```bash
git add docs/superpowers/plans/2026-04-14-discord-minimal-surface-approval-implementation.md src/index.ts src/discord/transcript.ts tests/discord/transcript.test.ts tests/index.test.ts tests/codex/jsonrpc-client.test.ts
git commit -m "fix(discord): keep managed threads on minimal surface"
```
