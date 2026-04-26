# Startup Lazy Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make old-session recovery event-driven: startup no longer snapshots or polls idle sessions, Discord actions reconcile only the latest 10 Codex turns, and Codex remote live events project to Discord only when the mapped thread is still active and writable.

**Architecture:** Add a small recent-window reconciliation boundary, then route every snapshot-based recovery path through it. Remove startup transcript seeding and idle snapshot polling. Treat Discord input, `/session-resume`, `/status`, and `/session-sync` as the only snapshot-reconciliation triggers; treat Codex App Server live events as projection-only events gated by active lifecycle plus Discord thread sendability.

**Tech Stack:** Bun, TypeScript, `bun:test`, Discord.js, SQLite repos, Codex App Server JSON-RPC client.

---

## Pre-Flight Notes

The current worktree may contain unrelated implementation edits in files such as:

- `src/codex/jsonrpc-client.ts`
- `src/discord/bot.ts`
- `src/index.ts`
- `tests/codex/jsonrpc-client.test.ts`
- `tests/discord/bot.test.ts`
- `tests/index.test.ts`

Before executing this plan, inspect `git status --short` and keep unrelated edits intact. Do not reset or overwrite user changes. If another change already implements part of this plan, adapt the implementation to it instead of reverting it.

## File Structure

Modify:

- `src/index.ts`
  - Owns the runtime orchestration today. Keep changes scoped to existing boundaries unless a helper is created below.
  - Remove startup transcript seed and idle snapshot poll.
  - Add lazy reconcile wiring before Discord-origin input and resume forwarding.
  - Add projection gate around Codex live-event Discord sends.

- `src/domain/session-reconciliation.ts`
  - New focused helper module for recent-window constants and pure helpers.
  - Keeps turn-window slicing and startup-control-warmup predicates out of the already-large runtime file.

- `tests/domain/session-reconciliation.test.ts`
  - New pure tests for latest-10 slicing and startup control warmup selection.

- `tests/index.test.ts`
  - Behavior coverage for startup no-snapshot, no idle polling, Discord input lazy reconcile, resume lazy reconcile, sync caps, and live-event projection gating.

- `tests/discord/transcript.test.ts`
  - Add or extend transcript relay tests only if the implementation exposes entry/message limiting at the transcript-rendering boundary.

Avoid schema changes in this plan. Persistent checkpoints are explicitly future hardening.

## Task 0: Guard the Worktree

**Files:**
- No code changes

- [ ] **Step 1: Inspect current worktree**

Run:

```bash
git status --short
```

Expected: identify any unrelated dirty files before editing.

- [ ] **Step 2: Inspect the approved spec**

Run:

```bash
sed -n '1,520p' docs/superpowers/specs/2026-04-26-startup-lazy-reconcile-design.md
```

Expected: spec includes Discord-triggered reconciliation, Codex remote projection gating, latest-10 default, no idle background sweep, and resume coverage.

## Task 1: Add Recent-Window Reconciliation Helpers

**Files:**
- Create: `src/domain/session-reconciliation.ts`
- Test: `tests/domain/session-reconciliation.test.ts`

- [ ] **Step 1: Write failing helper tests**

Create tests for:

- `limitThreadReadResultToRecentTurns(...)` keeps the latest 10 turns and preserves thread metadata.
- custom limits work for small tests.
- empty or missing `turns` becomes `[]`.
- `shouldWarmManagedSessionControlAtStartup(...)` returns true only for active `running` and active `waiting-approval`.

Example test shape:

```ts
import { expect, test } from "bun:test";
import {
  limitThreadReadResultToRecentTurns,
  shouldWarmManagedSessionControlAtStartup,
} from "../../src/domain/session-reconciliation";
import type { ThreadReadResult } from "../../src/codex/protocol-types";

const makeSnapshot = (turnCount: number): ThreadReadResult => ({
  thread: {
    id: "thread-1",
    cwd: "/tmp/project",
    status: { type: "idle" },
    turns: Array.from({ length: turnCount }, (_, index) => ({
      id: `turn-${index + 1}`,
      items: [],
    })),
  },
});

test("limits thread snapshots to the latest ten turns", () => {
  const limited = limitThreadReadResultToRecentTurns(makeSnapshot(12));

  expect(limited.thread.turns?.map((turn) => turn.id)).toEqual([
    "turn-3",
    "turn-4",
    "turn-5",
    "turn-6",
    "turn-7",
    "turn-8",
    "turn-9",
    "turn-10",
    "turn-11",
    "turn-12",
  ]);
});

test("startup control warmup only targets active live sessions", () => {
  expect(shouldWarmManagedSessionControlAtStartup({
    lifecycleState: "active",
    state: "running",
  })).toBe(true);
  expect(shouldWarmManagedSessionControlAtStartup({
    lifecycleState: "active",
    state: "waiting-approval",
  })).toBe(true);
  expect(shouldWarmManagedSessionControlAtStartup({
    lifecycleState: "active",
    state: "idle",
  })).toBe(false);
  expect(shouldWarmManagedSessionControlAtStartup({
    lifecycleState: "archived",
    state: "running",
  })).toBe(false);
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
bun test tests/domain/session-reconciliation.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the helper module**

Create `src/domain/session-reconciliation.ts`:

```ts
import type { ThreadReadResult } from "../codex/protocol-types";
import type { SessionLifecycleState } from "../db/repos/sessions";

export const recentReconcileTurnLimit = 10;
export const syncReplayMessageLimit = 3;

type StartupWarmupSession = {
  lifecycleState: SessionLifecycleState;
  state: string;
};

export const limitThreadReadResultToRecentTurns = (
  snapshot: ThreadReadResult,
  limit = recentReconcileTurnLimit,
): ThreadReadResult => ({
  ...snapshot,
  thread: {
    ...snapshot.thread,
    turns: (snapshot.thread.turns ?? []).slice(-Math.max(0, limit)),
  },
});

export const shouldWarmManagedSessionControlAtStartup = (
  session: StartupWarmupSession,
) => {
  return session.lifecycleState === "active"
    && (session.state === "running" || session.state === "waiting-approval");
};
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
bun test tests/domain/session-reconciliation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/session-reconciliation.ts tests/domain/session-reconciliation.test.ts
git commit -m "feat(session): add recent reconciliation helpers"
```

## Task 2: Remove Startup Transcript Seeding and Idle Snapshot Polling

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

- [ ] **Step 1: Write failing startup tests**

Add behavior tests in `tests/index.test.ts` for:

- startup warmup resumes only `running` and `waiting-approval` active sessions.
- startup warmup never calls the transcript snapshot reader or `thread/read(includeTurns=true)`.
- control warmup starts only after `runtime.json` readiness has been published.
- a slow control warmup does not block the parent readiness signal.
- no idle snapshot polling is installed after startup.

Use existing fakes around `restoreManagedSessionSubscriptions` and `startCodeHelm` where possible. A focused pure test for the restore predicate can stay in `tests/domain/session-reconciliation.test.ts`; the integration test should assert no snapshot reads happen in startup wiring.

Example integration expectation:

```ts
test("startup warmup does not seed transcript snapshots for idle sessions", async () => {
  const readCalls: string[] = [];
  const resumeCalls: string[] = [];

  // Arrange a runtime with active idle, active running, archived running.
  // Wire readThreadForSnapshotReconciliation/readThread fake to push into readCalls.
  // Wire resumeThread fake to push into resumeCalls.

  // Start the runtime enough to run post-ready warmup.

  expect(readCalls).toEqual([]);
  expect(resumeCalls).toEqual(["running-thread-id"]);
});
```

Add a second ordering test with a controlled `resumeThread` promise:

```ts
test("startup control warmup runs after runtime readiness is published", async () => {
  const events: string[] = [];
  let releaseWarmup!: () => void;

  // Arrange writeRuntimeSummary to push "runtime-ready".
  // Arrange resumeThread to push "warmup-started" and wait on releaseWarmup.
  // Start CodeHelm and wait until writeRuntimeSummary has been called.

  expect(events).toEqual(["runtime-ready", "warmup-started"]);
  releaseWarmup();
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
bun test tests/domain/session-reconciliation.test.ts tests/index.test.ts
```

Expected: FAIL because startup still seeds transcript snapshots and the interval still exists.

- [ ] **Step 3: Filter subscription restore to live sessions**

In `src/index.ts`:

- Import `shouldWarmManagedSessionControlAtStartup`.
- Extend `restoreManagedSessionSubscriptions(...)` session input to include `state`.
- Replace the lifecycle-only filter with `shouldWarmManagedSessionControlAtStartup(session)`.
- Pass `sessionRepo.listAll()` as before; the helper decides which rows matter.

Implementation sketch:

```ts
import {
  limitThreadReadResultToRecentTurns,
  shouldWarmManagedSessionControlAtStartup,
  syncReplayMessageLimit,
} from "./domain/session-reconciliation";

// inside restoreManagedSessionSubscriptions:
if (!shouldWarmManagedSessionControlAtStartup(session)) {
  continue;
}
```

- [ ] **Step 4: Remove startup transcript seed loop**

In `startCodeHelmRuntime(...)`:

- Remove `seedTranscriptRuntimeFromSnapshot(...)` if no longer used.
- Remove the `for (const session of sessionRepo.listAll())` loop inside startup warmup that calls `seedTranscriptRuntimeFromSnapshot`.
- Rename the local function from `warmManagedSessionsAtStartup` to `warmManagedSessionSubscriptionsAtStartup` if that keeps the intent clearer.

- [ ] **Step 5: Make control warmup post-readiness and fire-and-forget**

In `startCodeHelmRuntime(...)`:

- call `await options.onCoreReady?.()` before starting control warmup.
- start `warmManagedSessionSubscriptionsAtStartup()` after `onCoreReady`.
- do not `await` the warmup on the runtime readiness path.
- keep the existing background catch/log pattern so failures are visible but session-local:

```ts
void warmManagedSessionSubscriptionsAtStartup().catch((error) => {
  logger.error("Managed session startup control warmup failed", error);
});
```

Expected behavior:

- `runtime.json` can be published before any per-session `resumeThread` completes.
- a hung `resumeThread` cannot block the parent `start --daemon` readiness wait.
- warmup warnings/errors are logged after readiness instead of reported as startup failure.

- [ ] **Step 6: Remove idle snapshot polling**

In `startCodeHelmRuntime(...)`:

- Remove the `setInterval(... sessionSnapshotPollIntervalMs)` block.
- Remove `clearInterval(snapshotPoll)` from `stop`.
- Keep direct snapshot uses for Discord actions and explicit commands.
- Leave `pollSessionRecovery` exported only if tests or other code still use it; do not delete unrelated helper tests in this task unless TypeScript proves the helper is now unused and unexported.

- [ ] **Step 7: Run focused tests**

Run:

```bash
bun test tests/domain/session-reconciliation.test.ts tests/index.test.ts
```

Expected: PASS for updated startup/no-poll coverage.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts tests/index.test.ts src/domain/session-reconciliation.ts tests/domain/session-reconciliation.test.ts
git commit -m "fix(startup): stop snapshotting idle sessions"
```

## Task 3: Bound Snapshot Reads to Latest 10 Turns in Runtime Paths

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

- [ ] **Step 1: Write failing tests for recent-window reads**

Add tests that prove these paths receive only the latest 10 turns:

- `syncManagedSession(...)`
- `resumeManagedSession(...)`
- runtime wrappers used by `/status`, `/session-sync`, and `/session-resume`

For the lower-level exported functions, pass a `ThreadReadResult` with 12 turns and assert the transcript sync callback receives only turns 3 through 12 after the runtime wrapper is introduced.

Example assertion:

```ts
expect(receivedTurns.map((turn) => turn.id)).toEqual([
  "turn-3",
  "turn-4",
  "turn-5",
  "turn-6",
  "turn-7",
  "turn-8",
  "turn-9",
  "turn-10",
  "turn-11",
  "turn-12",
]);
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because existing wrappers pass full snapshots through.

- [ ] **Step 3: Add a recent snapshot wrapper**

In `startCodeHelmRuntime(...)`, near `readThreadForSnapshotReconciliation`, add a timeout-bounded local helper:

```ts
const readRecentThreadForSnapshotReconciliation = async (threadId: string) =>
  limitThreadReadResultToRecentTurns(
    await withSessionOperationTimeout(
      readThreadForSnapshotReconciliation({
        codexClient,
        threadId,
      }),
      sessionReconcileTimeoutMs,
      `Session reconciliation timed out for managed session ${threadId}.`,
    ),
  );
```

Rename `withStartupSessionTimeout(...)` to `withSessionOperationTimeout(...)` or introduce a second wrapper with the same implementation. Use the shared wrapper for startup control warmup and all lazy/resume/sync/status snapshot reads.

Use this helper for user-triggered reconciliation paths:

- `/status`
- `/session-sync`
- `/session-resume`
- `resumeManagedSessionIntoDiscordThread`
- `syncManagedSessionIntoDiscordThread`
- lazy Discord input reconcile from Task 5

Do not use it for startup warmup, because startup warmup must not read turns.

- [ ] **Step 4: Add timeout tests**

Add fake promise tests for the recent snapshot wrapper through whichever exported helper or runtime seam is practical:

- lazy reconcile timeout returns a session-local failure and does not crash runtime.
- `/status` snapshot timeout falls back to stored state.
- `/session-sync` snapshot timeout returns a sync failure reply.

Expected: the tests fail before the timeout wrapper is wired.

- [ ] **Step 5: Keep status state accurate**

`/status` needs status and active turn id, not historical replay. It may use the latest-10 snapshot for `readActiveTurnIdFromThreadReadResult(...)`. Do not render transcript entries from `/status`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS for recent-window and timeout assertions.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "fix(sync): bound snapshot reconciliation to recent turns"
```

## Task 4: Cap Snapshot Replay and Suppress Historical User Messages

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`
- Optional Test: `tests/discord/transcript.test.ts`

- [ ] **Step 1: Write failing replay-cap tests**

Add behavior coverage for:

- manual sync renders at most 3 assistant/tool-result messages.
- manual sync does not render historical user messages as bot-authored messages.
- resume sync inherits the same cap.

Use a snapshot with recent turns containing:

- several external user messages
- more than 3 assistant/tool-result entries

Expected:

- no sent payload contains the historical user message text
- only 3 assistant/tool-result payloads are sent
- seen bookkeeping still marks the recent window so later snapshot replay does not duplicate.

In this codebase, transcript entries with kind `process` are the current renderer-level representation for command/tool progress or result surfaces. They may count toward the "tool-result" cap only when they are produced from command/tool items. Do not use this cap to render generic historical user input.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
bun test tests/index.test.ts tests/discord/transcript.test.ts
```

Expected: FAIL because `relayTranscriptEntries(...)` currently has no replay cap or user suppression option.

- [ ] **Step 3: Add relay options**

In `src/index.ts`, extend `relayTranscriptEntries(...)`:

```ts
const relayTranscriptEntries = async ({
  client,
  channelId,
  runtime,
  turns,
  source,
  activeTurnId,
  activeTurnFooter,
  suppressUserEntries = false,
  maxRenderedEntries,
}: {
  client: Client;
  channelId: string;
  runtime: TranscriptRuntime;
  turns: CodexTurn[] | undefined;
  source: "live" | "snapshot";
  activeTurnId?: string;
  activeTurnFooter?: ProcessFooterText;
  suppressUserEntries?: boolean;
  maxRenderedEntries?: number;
}) => {
  // collect entries as today
  // remove user entries when suppressUserEntries is true
  // apply maxRenderedEntries to assistant/tool-result entries before rendering
  // still call markTranscriptItemsSeen({ runtime, turns, source }) for the full recent window
};
```

Keep live relay behavior unchanged by leaving defaults unset.

- [ ] **Step 4: Use cap for sync/resume/lazy reconcile**

When calling `syncTranscriptSnapshotFromReadResult(...)` from manual sync, resume, or lazy reconcile, pass:

```ts
{
  suppressUserEntries: true,
  maxRenderedEntries: syncReplayMessageLimit,
}
```

For turn completion live events, keep existing live behavior.

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test tests/index.test.ts tests/discord/transcript.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/index.test.ts tests/discord/transcript.test.ts
git commit -m "fix(transcript): cap recent snapshot replay"
```

## Task 5: Gate Discord-Origin Input with Lazy Reconciliation

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

- [ ] **Step 1: Write failing Discord input tests**

Add tests for the `Events.MessageCreate` managed-thread path or an extracted exported helper:

- first owner message after daemon restart and no runtime calls recent-window reconcile before `startTurn`.
- safe recent-window reconcile allows the message to continue.
- unknown recent remote user input marks the session read-only/out-of-sync and does not call `startTurn`.
- trusted runtime skips the snapshot read and continues as before.
- read-only, out-of-sync, or prior failed reconcile state never skips the snapshot read just because a runtime object exists.

Prefer a focused exported helper if direct Discord event tests become too bulky:

```ts
export const reconcileManagedSessionBeforeDiscordInput = async (...)
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because Discord input currently starts/steers without a preflight recent-window check when the runtime is missing.

- [ ] **Step 3: Track whether transcript runtime already exists**

In `startCodeHelmRuntime(...)`, add a non-creating lookup next to `ensureTranscriptRuntime(...)`:

```ts
const getTranscriptRuntime = (codexThreadId: string) => {
  return transcriptRuntimes.get(codexThreadId);
};
```

Use this to decide whether a session has trusted in-memory state.

- [ ] **Step 4: Add Discord input reconcile helper**

Add a local helper that:

- checks `getTranscriptRuntime(session.codexThreadId)` and an explicit trusted-state predicate
- returns immediately only when the runtime exists, the session runtime state is writable/busy (`idle`, `running`, or `waiting-approval`), and the thread is not marked as needing reconcile after a prior failure
- otherwise reads the recent snapshot
- calls `syncTranscriptSnapshotFromReadResult(...)` with `degradeOnUnexpectedItems: true`, `suppressUserEntries: true`, and cap 3
- returns whether the caller may continue

Sketch:

```ts
const reconcileFailedThreadIds = new Set<string>();

const hasTrustedRuntimeForDiscordInput = (session: SessionRecord) => {
  if (!getTranscriptRuntime(session.codexThreadId)) {
    return false;
  }

  if (reconcileFailedThreadIds.has(session.codexThreadId)) {
    return false;
  }

  return session.state === "idle"
    || session.state === "running"
    || session.state === "waiting-approval";
};

const reconcileBeforeDiscordInput = async (session: SessionRecord) => {
  if (hasTrustedRuntimeForDiscordInput(session)) {
    return { ok: true as const };
  }

  try {
    const snapshot = await readRecentThreadForSnapshotReconciliation(session.codexThreadId);
    await syncTranscriptSnapshotFromReadResult({
      discord: bot.client,
      session,
      snapshot,
      degradeOnUnexpectedItems: true,
      suppressUserEntries: true,
      maxRenderedEntries: syncReplayMessageLimit,
    });
    reconcileFailedThreadIds.delete(session.codexThreadId);
  } catch (error) {
    reconcileFailedThreadIds.add(session.codexThreadId);
    throw error;
  }

  const refreshed = sessionRepo.getByCodexThreadId(session.codexThreadId);
  return refreshed?.state === "degraded"
    ? { ok: false as const }
    : { ok: true as const };
};
```

- [ ] **Step 5: Wire helper into active managed thread input**

In the active `MessageCreate` path:

- run the helper before `decideThreadTurn(...)` for owner messages that could start a turn.
- after helper returns, reload the session row from `sessionRepo`.
- if the helper returns not ok, send or rely on the degradation/read-only surface and do not call `startTurnFromDiscordInput` or `steerTurnFromDiscordInput`.
- if the helper throws due to timeout or snapshot failure, surface a narrow session-level failure and do not call `startTurnFromDiscordInput` or `steerTurnFromDiscordInput`.

Do not run this helper for bot/system messages or unmanaged channels.

- [ ] **Step 6: Run focused tests**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "fix(discord): lazy reconcile before thread input"
```

## Task 6: Apply Recent-Window Reconcile to Resume and Manual Sync

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

- [ ] **Step 1: Write failing resume/sync tests**

Cover:

- `/session-resume` uses latest-10 reconciliation before reopen/rebind/create attach.
- `/session-resume` does not restore writable control when the recent window contains unknown remote user input.
- archived-thread implicit resume forwards the owner message only after safe continuation.
- archived-thread implicit resume does not forward when recent reconcile returns read-only/untrusted/out-of-sync.
- `/session-sync` accepts recent remote state and can clear read-only when no local input is pending.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because resume currently uses full snapshot behavior and can unarchive before the new recent-window trust gate is enforced.

- [ ] **Step 3: Reuse the initial recent snapshot in resume attach**

In `createControlChannelServices(...).resumeSession(...)`:

- replace the direct `readThreadForSnapshotReconciliation(...)` call with the recent-window wrapper.
- pass the resulting snapshot into `resumeManagedSessionIntoDiscordThread(...)` or `syncManagedSessionIntoDiscordThread(...)` to avoid a second read.
- do not introduce any raw `codexClient.readThread({ includeTurns: true })` call here; all resume and sync reads must go through the timeout-bounded recent wrapper from Task 3.

Update these local runtime helpers to accept an optional `initialSnapshot`:

```ts
const resumeManagedSessionIntoDiscordThread = async (
  session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>,
  initialSnapshot?: ThreadReadResult,
) => { ... };

const syncManagedSessionIntoDiscordThread = async (
  session: NonNullable<ReturnType<typeof sessionRepo.getByCodexThreadId>>,
  initialSnapshot?: ThreadReadResult,
) => { ... };
```

Inside each helper:

```ts
readThread: async () =>
  initialSnapshot ?? readRecentThreadForSnapshotReconciliation(session.codexThreadId)
```

- [ ] **Step 4: Detect snapshot mismatch before unarchive/rebind becomes writable**

Extend `resumeManagedSession(...)` to support a read-only detector, or perform the detector in `resumeManagedSessionIntoDiscordThread(...)` before calling the generic resume helper.

Required behavior:

- unknown recent user input means do not silently restore writable control.
- for an archived existing thread, keep it archived.
- for a new replacement thread created during attach, roll it back if the view is untrusted.

Use the existing mismatch helper:

```ts
shouldDegradeForSnapshotMismatch({
  runtime,
  turns: snapshot.thread.turns,
})
```

with the latest-10 snapshot only.

- [ ] **Step 5: Keep manual sync explicit accept-remote**

For `/session-sync`, keep the user action semantics:

- use latest-10 snapshot
- use the timeout-bounded recent wrapper from Task 3
- check pending local input before accepting external remote input
- suppress user replay
- cap rendered assistant/tool messages at 3
- if external-origin user input exists, mark it trusted for the recent window instead of blocking, provided no local input is pending

Tests should lock the difference between automated lazy reconcile and manual sync.

Implementation detail for the pending-local-input gate:

- use `ensureTranscriptRuntime(session.codexThreadId)` or a non-creating runtime lookup to inspect `runtime.pendingLocalInputs`.
- add a helper so the condition is readable:

```ts
const hasPendingLocalInput = (runtime: Pick<TranscriptRuntime, "pendingLocalInputs">) => {
  return runtime.pendingLocalInputs.length > 0;
};
```

- when `/session-sync` sees external-origin recent user input and `hasPendingLocalInput(runtime)` is true, do not clear read-only/out-of-sync state.
- return an explicit sync failure/blocked result telling the user to send a new message after sync or start a new session.
- add a test where pending local input exists, remote external input exists, and `/session-sync` refuses to restore writable control.

- [ ] **Step 6: Run focused tests**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "fix(resume): reconcile before restoring session control"
```

## Task 7: Gate Codex Remote Live-Event Projection

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

- [ ] **Step 1: Write failing projection tests**

Add tests for live Codex event handling:

- active persisted session with sendable Discord thread projects assistant/status events.
- archived persisted session does not send projected transcript events.
- deleted persisted session does not send projected transcript events.
- active persisted session with archived/unavailable Discord thread does not send and does not call `setArchived(false)`.
- remote event handling does not call `readThreadForSnapshotReconciliation`.

If direct event tests are too large, extract and export a small helper:

```ts
export const shouldProjectCodexRemoteEventToDiscord = async (...)
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because live-event handlers currently mostly check only persisted lifecycle.

- [ ] **Step 3: Add Discord thread projectability check**

Add a helper near `isManagedDiscordThreadUsable(...)`:

```ts
const isManagedDiscordThreadProjectable = async ({
  client,
  threadId,
}: {
  client: Client;
  threadId: string;
}) => {
  try {
    const channel = await client.channels.fetch(threadId);

    if (!isSendableChannel(channel)) {
      return false;
    }

    if ("archived" in channel && channel.archived === true) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
};
```

Do not call `setArchived(false)` in this helper.

- [ ] **Step 4: Gate live-event send paths**

For handlers that can send to Discord:

- `turn/started`
- `thread/status/changed`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- command execution deltas/completions
- approval request/resolution surfaces

Before sending, require:

- `shouldProjectManagedSessionDiscordSurface(session)` is true
- `await isManagedDiscordThreadProjectable({ client: bot.client, threadId: session.discordThreadId })` is true

When the projectability check fails:

- update internal runtime bookkeeping if needed to avoid leaks
- skip Discord send
- log a session-level warning at most at the operation boundary

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "fix(discord): gate remote event projection"
```

## Task 8: Full Verification and Local Smoke

**Files:**
- Modify only if verification finds issues

- [ ] **Step 1: Run focused tests**

Run:

```bash
bun test tests/domain/session-reconciliation.test.ts tests/index.test.ts tests/discord/transcript.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Check whitespace**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Smoke daemon startup with local source**

Run:

```bash
bun run src/cli.ts status
time bun run src/cli.ts start --daemon
bun run src/cli.ts status
time bun run src/cli.ts stop
```

Expected:

- startup returns promptly without waiting for old-session snapshot work
- status reports the daemon while running
- stop exits cleanly
- no new orphan CodeHelm-managed Codex App Server remains after stop

- [ ] **Step 6: Final commit if verification required fixes**

If verification-only fixes were needed:

```bash
git add <changed files>
git commit -m "fix: stabilize lazy reconciliation"
```

Otherwise no commit is needed for this task.
