# Discord Thread-Only Approval UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current mixed thread/DM approval flow with a thread-only, decision-driven Discord approval UX that preserves Codex semantics and collapses resolved approvals into one in-place result line.

**Architecture:** Extend the persisted approval record so it stores both the human-facing snapshot and the provider-backed decision catalog, then render pending Discord panels from that durable record instead of from the current fixed `approve/decline/cancel` model. Wire the runtime so each approval owns exactly one thread lifecycle message, remove owner-DM delivery, and collapse every terminal outcome into one precise result line whether it was handled in Discord or in codex-remote.

**Tech Stack:** Bun, TypeScript, bun:test, Discord.js, SQLite, Codex App Server JSON-RPC

---

## File Map

- Modify: `src/codex/protocol-types.ts`
  Add typed helpers for provider decision payloads carried on approval request events.
- Modify: `src/db/migrations/001_init.sql`
  Add durable storage for decision catalog and resolution-origin metadata for fresh databases.
- Modify: `src/db/migrate.ts`
  Upgrade legacy `approvals` tables without losing existing rows or thread bindings.
- Modify: `src/db/repos/approvals.ts`
  Persist and read the new approval decision catalog and terminal-resolution fields.
- Modify: `src/domain/approval-service.ts`
  Replace the generic three-action model with provider-backed decision and resolution helpers.
- Modify: `src/discord/approval-ui.ts`
  Render question-led pending panels, result-line terminal states, and status-aware stale feedback.
- Modify: `src/index.ts`
  Persist approval decisions before rendering, remove owner-DM delivery, wire Discord custom IDs to persisted provider decisions, and keep one lifecycle message per approval.
- Modify: `docs/discord-text-formatting.md`
  Update the Discord surface baseline to document thread-only approvals and collapsed terminal result lines.
- Modify: `tests/db/approval-repo.test.ts`
  Lock persistence, migration, and preservation of decision catalog plus resolution metadata.
- Modify: `tests/domain/approval-service.test.ts`
  Lock provider decision semantics, especially `decline` versus `cancel`.
- Modify: `tests/discord/approval-ui.test.ts`
  Lock pending panel rendering, button sets, terminal result lines, and stale interaction text.
- Modify: `tests/index.test.ts`
  Lock thread-only delivery, in-place lifecycle updates, codex-remote resolution, and resume/replay deduplication.

## Task 1: Persist Provider Decisions And Resolution Metadata

**Files:**
- Modify: `src/db/migrations/001_init.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/db/repos/approvals.ts`
- Modify: `tests/db/approval-repo.test.ts`

- [ ] **Step 1: Write the failing repo tests**

Add coverage in `tests/db/approval-repo.test.ts` for:

- inserting an approval with a persisted provider decision catalog
- updating that approval to a terminal state without losing the original catalog or snapshot
- storing `resolvedProviderDecision`, `resolvedBySurface`, and `resolvedElsewhere`
- migrating a legacy `approvals` table that lacks the new columns

Use expectations like:

```ts
repo.insert({
  approvalKey: "turn-1:call-1",
  requestId: "req-1",
  codexThreadId: "codex-1",
  discordThreadId: "thread-1",
  status: "pending",
  displayTitle: "Command approval",
  commandPreview: "touch i.txt",
  decisionCatalog: JSON.stringify([
    { key: "accept", label: "Yes, proceed" },
    { key: "cancel", label: "No, and tell Codex what to do differently" },
  ]),
});

expect(repo.getByApprovalKey("turn-1:call-1")).toMatchObject({
  decisionCatalog: expect.stringContaining("\"accept\""),
  resolvedProviderDecision: null,
  resolvedBySurface: null,
  resolvedElsewhere: false,
});
```

- [ ] **Step 2: Run the focused repo tests and verify they fail**

Run:

```bash
bun test tests/db/approval-repo.test.ts
```

Expected: FAIL because the schema and repo types do not yet include the new decision and resolution fields.

- [ ] **Step 3: Extend the approval schema and repo**

Update `src/db/migrations/001_init.sql` and `src/db/migrate.ts` to add nullable fields such as:

```sql
decision_catalog TEXT,
resolved_provider_decision TEXT,
resolved_by_surface TEXT,
resolved_elsewhere INTEGER NOT NULL DEFAULT 0
```

Then update `src/db/repos/approvals.ts` so:

- `ApprovalRecord` exposes those fields
- inserts preserve the original decision catalog once captured
- terminal updates can set `resolvedProviderDecision`, `resolvedBySurface`, and `resolvedElsewhere` without erasing the snapshot

Keep the current safeguards that:

- terminal approvals remain terminal
- stale replayed `pending` writes do not revive a resolved approval

- [ ] **Step 4: Re-run the focused repo tests and verify they pass**

Run:

```bash
bun test tests/db/approval-repo.test.ts
```

Expected: PASS. Legacy rows migrate cleanly and the repo keeps catalog plus resolution metadata intact.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/001_init.sql src/db/migrate.ts src/db/repos/approvals.ts tests/db/approval-repo.test.ts
git commit -m "feat(approval): persist decision catalog and resolution metadata"
```

## Task 2: Build A Decision-Driven Approval Model And Renderer

**Files:**
- Modify: `src/codex/protocol-types.ts`
- Modify: `src/domain/approval-service.ts`
- Modify: `src/discord/approval-ui.ts`
- Modify: `tests/domain/approval-service.test.ts`
- Modify: `tests/discord/approval-ui.test.ts`

- [ ] **Step 1: Write the failing model and renderer tests**

Add coverage for:

- command approvals rendering only the provider decisions that were actually offered
- `decline` and `cancel` producing different terminal copy
- pending panels leading with the human question instead of `Approval request`
- result lines including `codex-remote` when the approval was handled elsewhere

Use expectations like:

```ts
expect(rendered.buttons.map((button) => button.label)).toEqual([
  "Yes, proceed",
  "No, and tell Codex what to do differently",
]);

expect(
  renderApprovalResultLine({
    status: "canceled",
    commandPreview: "touch i.txt",
    resolvedElsewhere: false,
  }),
).toBe("Canceled. The current turn was interrupted: touch i.txt");
```

- [ ] **Step 2: Run the focused model/renderer tests and verify they fail**

Run:

```bash
bun test tests/domain/approval-service.test.ts tests/discord/approval-ui.test.ts
```

Expected: FAIL because the current code still assumes the generic `approve/decline/cancel` button trio and terminal card rendering.

- [ ] **Step 3: Introduce provider-backed approval decision helpers**

In `src/codex/protocol-types.ts`, define typed helpers for decision payloads carried on approval request events.

In `src/domain/approval-service.ts`, add a durable representation such as:

```ts
export type PersistedApprovalDecision = {
  key: string;
  providerDecision: string;
  label: string;
  consequence?: string | null;
};
```

In `src/discord/approval-ui.ts`, render:

- question-led pending panels
- persisted decision buttons
- terminal result lines instead of read-only terminal cards
- precise stale interaction feedback

Keep `requestId` and `approvalKey` as secondary metadata only.

- [ ] **Step 4: Re-run the focused model/renderer tests and verify they pass**

Run:

```bash
bun test tests/domain/approval-service.test.ts tests/discord/approval-ui.test.ts
```

Expected: PASS. The UI now reflects provider decisions and terminal outcomes precisely.

- [ ] **Step 5: Commit**

```bash
git add src/codex/protocol-types.ts src/domain/approval-service.ts src/discord/approval-ui.ts tests/domain/approval-service.test.ts tests/discord/approval-ui.test.ts
git commit -m "feat(discord): render provider-driven approval panels"
```

## Task 3: Remove Owner DMs And Wire The Thread-Only Live Path

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Add coverage in `tests/index.test.ts` for:

- live approvals sending only one thread panel and no owner DM
- Discord button clicks resolving through the persisted provider decision instead of a generic local action
- terminal outcomes editing the same thread message into one short result line

Use expectations like:

```ts
expect(dmSendCalls).toEqual([]);
expect(threadMessages).toHaveLength(1);
expect(threadMessages[0]?.content).toContain("Would you like to run the following command?");
```

and:

```ts
expect(finalMessage?.content).toBe("Approved: touch i.txt");
expect(finalMessage?.components).toEqual([]);
```

- [ ] **Step 2: Run the focused integration tests and verify they fail**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because the current runtime still uses the DM path and generic approval custom IDs.

- [ ] **Step 3: Rewire the live approval lifecycle in `src/index.ts`**

Implement the runtime changes in this order:

1. persist decision catalog before any Discord rendering
2. build thread custom IDs from the persisted decision key, not from `approve|decline|cancel`
3. remove `renderApprovalOwnerDmPayload` from the live delivery and resolution paths
4. move accepted button presses into a short-lived submitting state so duplicate clicks get rejected cleanly
5. collapse terminal approvals into the result-line payload in the same message slot

Keep the fail-closed rule:

- if the thread panel cannot be delivered, the approval stays unresolved upstream

- [ ] **Step 4: Re-run the focused integration tests and verify they pass**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS. The live path is thread-only and terminal states collapse in place.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat(approval): make Discord approvals thread-only"
```

## Task 4: Harden Recovery, Replay, And Documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `docs/discord-text-formatting.md`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write the failing recovery and formatting tests**

Add or update tests that prove:

- `resume` reuses the existing approval thread message instead of creating a new pending panel
- a terminal approval handled in codex-remote never revives into `pending`
- stale button clicks return precise text such as `This approval was already approved in codex-remote: touch i.txt`

Document the new baseline in `docs/discord-text-formatting.md`:

- pending approvals are thread-only panels
- terminal approvals are in-place result lines
- owner DMs no longer carry approval controls

- [ ] **Step 2: Run the targeted recovery tests and verify they fail**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because recovery logic still assumes the older lifecycle surface in at least one path.

- [ ] **Step 3: Tighten recovery and docs**

In `src/index.ts`, ensure:

- recovery always prefers the existing `approvalKey`-scoped thread message
- terminal approvals never reopen as pending
- stale replayed `pending` events are ignored once a resolution record exists

Then update `docs/discord-text-formatting.md` so the docs match the new Discord behavior exactly.

- [ ] **Step 4: Run the project verification suite**

Run:

```bash
bun test tests/index.test.ts
bun run typecheck
```

Expected: PASS. The runtime behavior and types align with the new thread-only approval lifecycle.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts docs/discord-text-formatting.md tests/index.test.ts
git commit -m "fix(approval): harden recovery and stale interaction handling"
```

