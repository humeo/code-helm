# Discord Approval Rich Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and render rich, request-scoped Discord approval cards from durable snapshot data so approvals stay readable through pending, resolved, and resumed session flows.

**Architecture:** Extend the existing `approvals` row so it stores a compact display snapshot alongside lifecycle state, then render both the thread approval card and the owner DM from that stored record instead of from `requestId` alone. Keep lifecycle precedence explicit so `serverRequest/resolved` never clobbers a more specific terminal decision, and make stale button clicks reply with status-aware text that references the original approval context.

**Tech Stack:** Bun, TypeScript, bun:test, Discord.js, SQLite, Codex App Server JSON-RPC

---

## File Map

- Modify: `src/db/migrations/001_init.sql`
  Add nullable approval snapshot columns for fresh databases.
- Modify: `src/db/migrate.ts`
  Upgrade existing `approvals` tables by adding or rebuilding the new snapshot columns without breaking legacy rows or thread rebind behavior.
- Modify: `src/db/repos/approvals.ts`
  Persist and read approval snapshot fields while preserving them across status-only updates.
- Modify: `src/domain/approval-service.ts`
  Keep lifecycle precedence and terminal-state helpers authoritative for approval transitions.
- Modify: `src/discord/approval-ui.ts`
  Render rich approval cards, fallback cards, and status-aware interaction feedback from one shared helper surface.
- Modify: `src/index.ts`
  Extract snapshot data from live approval events, persist it before rendering, reuse the stored record for thread/DM updates, and improve stale-click handling.
- Modify: `tests/db/approval-repo.test.ts`
  Lock snapshot persistence, status-only updates, migration compatibility, and rebind safety.
- Create: `tests/discord/approval-ui.test.ts`
  Lock rich approval rendering, fallback rendering, and status-aware copy at the unit level.
- Modify: `tests/domain/approval-service.test.ts`
  Lock lifecycle precedence so `resolved` never overwrites a more specific terminal state.
- Modify: `tests/index.test.ts`
  Lock end-to-end approval snapshot persistence, rich thread/DM rendering, resume reconciliation, and stale interaction feedback.

## Task 1: Extend Approval Persistence For Snapshot Data

**Files:**
- Modify: `src/db/migrations/001_init.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/db/repos/approvals.ts`
- Modify: `tests/db/approval-repo.test.ts`

- [ ] **Step 1: Write the failing approval repo tests**

Add coverage in `tests/db/approval-repo.test.ts` for:

- inserting a pending approval with snapshot fields
- updating that approval to `approved` without losing `displayTitle`, `commandPreview`, `justification`, `cwd`, or `requestKind`
- migrating a legacy `approvals` table that lacks the new columns and verifying the resulting row reads back with nullable snapshot fields

Use expectations like:

```ts
repo.insert({
  approvalKey: "turn-1:item-1",
  requestId: 9,
  discordThreadId: "123",
  status: "pending",
  displayTitle: "Command approval",
  commandPreview: "touch c.txt",
  justification: "要允许我在项目根目录创建 c.txt 吗？",
  cwd: "/tmp/ws1/app",
  requestKind: "command",
});

expect(repo.getByApprovalKey("turn-1:item-1")).toMatchObject({
  displayTitle: "Command approval",
  commandPreview: "touch c.txt",
  justification: "要允许我在项目根目录创建 c.txt 吗？",
  cwd: "/tmp/ws1/app",
  requestKind: "command",
});
```

- [ ] **Step 2: Run the focused repo tests and verify they fail**

Run:

```bash
bun test tests/db/approval-repo.test.ts
```

Expected: FAIL because the schema and repo types do not yet recognize the snapshot fields.

- [ ] **Step 3: Add snapshot columns to the bootstrap schema and migration path**

Update `src/db/migrations/001_init.sql` so fresh databases create:

```sql
CREATE TABLE IF NOT EXISTS approvals (
  approval_key TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  codex_thread_id TEXT NOT NULL,
  discord_thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  display_title TEXT,
  command_preview TEXT,
  justification TEXT,
  cwd TEXT,
  request_kind TEXT,
  resolved_by_discord_user_id TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (discord_thread_id)
    REFERENCES sessions(discord_thread_id)
    ON UPDATE CASCADE
);
```

Update `src/db/migrate.ts` so legacy databases gain the same columns with `NULL` defaults. Prefer additive migration logic where possible; if a rebuild is needed, preserve:

- `approval_key`
- `request_id`
- `codex_thread_id`
- `discord_thread_id`
- `status`
- resolution metadata
- existing rebind / foreign-key guarantees

- [ ] **Step 4: Extend the approval repo to carry snapshot fields**

Update `src/db/repos/approvals.ts` so `ApprovalRecord`, `ApprovalRow`, and `InsertApprovalInput` include:

```ts
displayTitle?: string | null;
commandPreview?: string | null;
justification?: string | null;
cwd?: string | null;
requestKind?: string | null;
```

Preserve existing snapshot values on status-only updates by defaulting omitted fields to the existing row:

```ts
const displayTitle =
  input.displayTitle !== undefined
    ? input.displayTitle
    : existing?.displayTitle ?? null;
```

Do the same for the other snapshot fields so `approved`, `declined`, `canceled`, and `resolved` transitions do not erase the original approval context.

- [ ] **Step 5: Re-run the focused repo tests and verify they pass**

Run:

```bash
bun test tests/db/approval-repo.test.ts
```

Expected: PASS. Approval rows preserve snapshot data across lifecycle updates and legacy tables migrate cleanly.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/001_init.sql src/db/migrate.ts src/db/repos/approvals.ts tests/db/approval-repo.test.ts
git commit -m "feat(approval): persist approval display snapshots"
```

## Task 2: Build Shared Rich Approval Rendering And Status Precedence

**Files:**
- Modify: `src/domain/approval-service.ts`
- Modify: `src/discord/approval-ui.ts`
- Create: `tests/discord/approval-ui.test.ts`
- Modify: `tests/domain/approval-service.test.ts`

- [ ] **Step 1: Write the failing rendering and lifecycle tests**

Add coverage for:

- `approved`, `declined`, and `canceled` remaining unchanged when `serverRequest/resolved` arrives later
- a rich pending approval card that shows a human title, command preview, justification, cwd, and request id as secondary metadata
- a legacy approval row without snapshot fields rendering a generic fallback title instead of `Approval 0`
- buttons disappearing for terminal approvals while the snapshot body remains visible

Use expectations like:

```ts
expect(
  applyApprovalResolutionSignal(
    { requestId: "9", status: "approved" },
    { type: "serverRequest/resolved", requestId: 9 },
  ).approval.status,
).toBe("approved");
```

and:

```ts
expect(rendered.content).toContain("Command approval");
expect(rendered.content).toContain("touch c.txt");
expect(rendered.content).toContain("要允许我在项目根目录创建 c.txt 吗？");
expect(rendered.content).toContain("Request ID: `0`");
```

- [ ] **Step 2: Run the focused rendering tests and verify they fail**

Run:

```bash
bun test tests/domain/approval-service.test.ts tests/discord/approval-ui.test.ts
```

Expected: FAIL because approval rendering still only knows about `requestId` and `status`.

- [ ] **Step 3: Extend the domain and Discord approval helpers**

In `src/domain/approval-service.ts`, keep lifecycle precedence explicit. Add or refine a helper so the rule is encoded once:

```ts
approved / declined / canceled > resolved > pending
```

In `src/discord/approval-ui.ts`, add a display model and shared render helpers that can be reused by:

- thread approval cards
- owner DMs
- stale interaction feedback

Recommended shape:

```ts
export type ApprovalDisplaySnapshot = {
  displayTitle: string | null;
  commandPreview: string | null;
  justification: string | null;
  cwd: string | null;
  requestKind: string | null;
};

export const renderApprovalLifecyclePayload = (...) => { ... };
export const renderApprovalStaleStatusText = (...) => { ... };
```

Keep fallback behavior explicit for rows where every snapshot field is `null`.

- [ ] **Step 4: Re-run the focused rendering tests and verify they pass**

Run:

```bash
bun test tests/domain/approval-service.test.ts tests/discord/approval-ui.test.ts
```

Expected: PASS. Approval copy is rich when snapshot data exists and coherent when it does not.

- [ ] **Step 5: Commit**

```bash
git add src/domain/approval-service.ts src/discord/approval-ui.ts tests/domain/approval-service.test.ts tests/discord/approval-ui.test.ts
git commit -m "feat(discord): render rich approval cards"
```

## Task 3: Persist Snapshot Data Before Rendering And Reuse It On Recovery

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Add coverage in `tests/index.test.ts` for:

- a live `item/commandExecution/requestApproval` event with `cmd`, `justification`, and `cwd` persisting snapshot data before the thread card is rendered
- the owner DM using the same snapshot-driven copy as the thread card rather than a `Request: <id>`-only message
- `serverRequest/resolved` updating the existing approval message in place while preserving the original approval body
- waiting-approval resume reconciliation rebuilding the rich approval card from the stored row instead of falling back to `Approval <requestId>: pending.`

Use a request payload shaped like:

```ts
{
  threadId: "codex-1",
  turnId: "turn-1",
  itemId: "call-1",
  cmd: "touch c.txt",
  justification: "要允许我在项目根目录创建 c.txt 吗？",
  cwd: "/tmp/ws1/app",
}
```

- [ ] **Step 2: Run the focused integration tests and verify they fail**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL where the approval surface still renders `Approval \`req-7\`: pending.` and the DM still uses the bare request id message.

- [ ] **Step 3: Implement snapshot extraction and shared rendering in the runtime**

Update `src/index.ts` so the approval event path knows which request method fired. Use method-specific subscriptions instead of discarding that context:

```ts
for (const method of approvalRequestMethods) {
  codexClient.on(method, (event) => {
    handleApprovalRequestEvent(method, event);
  });
}
```

Inside the handler:

- derive `approvalKey`
- map the method to a stable `requestKind`
- extract snapshot fields from the live event
- persist the snapshot on the pending approval row before rendering
- load the stored approval row when building:
  - the thread lifecycle message
  - the owner DM
  - resume reconciliation surfaces
  - resolution updates

Keep `approvalKey` as the message identity so pending and terminal states continue editing the same Discord message.

- [ ] **Step 4: Re-run the focused integration tests and verify they pass**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS. Live approvals, DM controls, resolution updates, and resume reconciliation all render from the persisted snapshot.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "fix(approval): render Discord approvals from stored snapshots"
```

## Task 4: Make Stale Approval Clicks Status-Aware

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write the failing stale-interaction tests**

Add coverage for button clicks against approvals that are already:

- `approved`
- `declined`
- `canceled`
- `resolved`

The reply text should reference the real status and, when available, the original approval context:

```ts
expect(reply.content).toBe(
  "That approval was already approved: touch c.txt",
);
```

Use a softer fallback when no preview exists, for example:

```ts
"That approval was already canceled."
```

- [ ] **Step 2: Run the focused stale-interaction tests and verify they fail**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because the handler still replies with the generic `That approval is no longer pending.`

- [ ] **Step 3: Implement status-aware stale feedback**

Update `handleApprovalInteraction(...)` in `src/index.ts` so the non-pending branch uses the new shared renderer helper instead of a hard-coded generic string.

Behavior target:

- terminal approval statuses mention the exact status
- `resolved` explains that the approval already finished or was resolved elsewhere
- preview/title is included when available
- controls still remain disabled because the approval is no longer actionable

- [ ] **Step 4: Re-run the focused stale-interaction tests and verify they pass**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS. Cached Discord buttons now produce precise, human-readable feedback.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "fix(approval): clarify stale Discord approval actions"
```

## Task 5: Full Verification

**Files:**
- Modify: `src/db/migrations/001_init.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/db/repos/approvals.ts`
- Modify: `src/domain/approval-service.ts`
- Modify: `src/discord/approval-ui.ts`
- Modify: `src/index.ts`
- Modify: `tests/db/approval-repo.test.ts`
- Create: `tests/discord/approval-ui.test.ts`
- Modify: `tests/domain/approval-service.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Run the full test suite**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 2: Run static type verification**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Create the feature commit**

```bash
git add src/db/migrations/001_init.sql src/db/migrate.ts src/db/repos/approvals.ts src/domain/approval-service.ts src/discord/approval-ui.ts src/index.ts tests/db/approval-repo.test.ts tests/discord/approval-ui.test.ts tests/domain/approval-service.test.ts tests/index.test.ts
git commit -m "fix(approval): preserve rich Discord approval context"
```
