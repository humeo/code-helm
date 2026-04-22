# Discord Managed Session Command Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Discord-native `/status`, `/model`, and `/interrupt` controls for managed session threads, make running owner messages steer the active turn, and persist model plus reasoning-effort overrides per session.

**Architecture:** Extend the existing Discord managed-session flow instead of introducing a second runtime surface. The implementation should add the missing app-server protocol methods, store session-scoped model overrides in SQLite, route managed-thread slash commands through focused Discord handlers, and evolve runtime pending-input tracking so running owner messages can safely become steer input while approval-state messages stay blocked.

**Tech Stack:** Bun, TypeScript, bun:test, SQLite, Discord.js, Codex App Server JSON-RPC

---

## File Map

- Create: `docs/superpowers/plans/2026-04-22-discord-managed-session-command-surface-implementation.md`
  This implementation plan.
- Reference: `docs/superpowers/specs/2026-04-22-discord-managed-session-command-surface-design.md`
  Approved product and architecture spec for this feature.
- Modify: `src/codex/protocol-types.ts`
  Add request and response types for `turn/steer`, `turn/interrupt`, and `model/list`.
- Modify: `src/codex/jsonrpc-client.ts`
  Expose the new JSON-RPC methods through the shared client.
- Modify: `src/codex/session-controller.ts`
  Add any thin helper methods needed by runtime orchestration.
- Create: `src/db/migrations/002_session_model_overrides.sql`
  Add durable session-level `model_override` and `reasoning_effort_override` columns.
- Modify: `src/db/migrate.ts`
  Ensure the new migration is included in the migration runner if required by current migration loading.
- Modify: `src/db/repos/sessions.ts`
  Persist and retrieve session model and reasoning-effort overrides.
- Modify: `src/discord/commands.ts`
  Define managed-thread slash commands and their interaction contracts.
- Modify: `src/discord/bot.ts`
  Route managed-thread slash commands alongside the existing control-channel commands.
- Modify: `src/discord/thread-handler.ts`
  Change running owner messages from `session-busy` noop into `turn/steer` decisions and keep approval-state rejection explicit.
- Create: `src/discord/managed-session-commands.ts`
  Focused runtime helpers for `/status`, `/model`, and `/interrupt` interaction handling.
- Create: `src/discord/managed-session-status.ts`
  Render compact monospace `/status` output for Discord threads.
- Create: `src/discord/managed-session-model-ui.ts`
  Encapsulate model catalog mapping, compact custom-id helpers, and Discord selection-flow helpers.
- Modify: `src/index.ts`
  Integrate protocol helpers, expanded pending-input tracking, steer submission, interrupt handling, model override application, and interaction wiring.
- Modify: `tests/codex/jsonrpc-client.test.ts`
  Add protocol client coverage for `turn/steer`, `turn/interrupt`, and `model/list`.
- Modify: `tests/db/session-repo.test.ts`
  Add migration and repo coverage for session override persistence.
- Modify: `tests/discord/commands.test.ts`
  Add command registration and managed-thread command interaction coverage.
- Modify: `tests/discord/bot.test.ts`
  Add routing coverage for managed-thread command interactions and selection components if command dispatch is extended there.
- Modify: `tests/discord/thread-handler.test.ts`
  Cover `running -> steer` and `waiting-approval -> reject`.
- Modify: `tests/index.test.ts`
  Add integration coverage for steer lifecycle, interrupt queue clearing, session override application, and `/status` rendering.

## Task 1: Add Protocol Coverage For Steer, Interrupt, And Model List

**Files:**
- Modify: `src/codex/protocol-types.ts`
- Modify: `src/codex/jsonrpc-client.ts`
- Modify: `src/codex/session-controller.ts`
- Test: `tests/codex/jsonrpc-client.test.ts`

- [ ] **Step 1: Write the failing protocol client tests**

Add tests in `tests/codex/jsonrpc-client.test.ts` covering:

```ts
test("json rpc client sends turn/steer with expectedTurnId", async () => {
  const transport = createMockTransport();
  const client = new JsonRpcClient("ws://localhost", { transport });

  await client.turnSteer({
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "Please continue." }],
  });

  expect(transport.sent.at(-1)?.method).toBe("turn/steer");
});

test("json rpc client sends turn/interrupt for the active turn", async () => {
  const transport = createMockTransport();
  const client = new JsonRpcClient("ws://localhost", { transport });

  await client.turnInterrupt({
    threadId: "thread-1",
    turnId: "turn-1",
  });

  expect(transport.sent.at(-1)?.method).toBe("turn/interrupt");
});

test("json rpc client requests model/list", async () => {
  const transport = createMockTransport();
  const client = new JsonRpcClient("ws://localhost", { transport });

  await client.listModels();

  expect(transport.sent.at(-1)?.method).toBe("model/list");
});
```

- [ ] **Step 2: Run the focused protocol test file to verify failure**

Run:

```bash
bun test tests/codex/jsonrpc-client.test.ts
```

Expected: FAIL with missing methods or missing protocol types for steer, interrupt, or model list.

- [ ] **Step 3: Add the protocol types and client methods**

Update `src/codex/protocol-types.ts` with exact request types:

```ts
export type TurnSteerParams = {
  threadId: string;
  expectedTurnId: string;
  input: unknown;
};

export type TurnInterruptParams = {
  threadId: string;
  turnId: string;
};

export type ModelListParams = {
  includeHidden?: boolean;
};
```

Then expose matching client methods in `src/codex/jsonrpc-client.ts`:

```ts
async turnSteer(params: TurnSteerParams) {
  await this.initialize();
  return this.sendRequest("turn/steer", params);
}

async turnInterrupt(params: TurnInterruptParams) {
  await this.initialize();
  return this.sendRequest("turn/interrupt", params);
}

async listModels(params: ModelListParams = {}) {
  await this.initialize();
  return this.sendRequest("model/list", params);
}
```

Only add controller wrappers in `src/codex/session-controller.ts` if runtime call sites would otherwise reach into `JsonRpcClient` directly in a way that breaks current conventions.

- [ ] **Step 4: Re-run the focused protocol tests**

Run:

```bash
bun test tests/codex/jsonrpc-client.test.ts
```

Expected: PASS for the new steer, interrupt, and model-list cases.

- [ ] **Step 5: Commit the protocol bridge**

```bash
git add src/codex/protocol-types.ts src/codex/jsonrpc-client.ts src/codex/session-controller.ts tests/codex/jsonrpc-client.test.ts
git commit -m "feat(codex): add steer interrupt and model list client methods"
```

## Task 2: Persist Session-Scoped Model And Reasoning-Effort Overrides

**Files:**
- Create: `src/db/migrations/002_session_model_overrides.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/db/repos/sessions.ts`
- Test: `tests/db/session-repo.test.ts`

- [ ] **Step 1: Write the failing session repo tests**

Add repo tests for override persistence:

```ts
test("session repo reads null model overrides from legacy rows", () => {
  const repo = createSessionRepo(db);
  repo.insert({
    discordThreadId: "discord-1",
    codexThreadId: "codex-1",
    ownerDiscordUserId: "owner-1",
    cwd: "/tmp/project",
    state: "idle",
  });

  expect(repo.getByDiscordThreadId("discord-1")).toMatchObject({
    modelOverride: null,
    reasoningEffortOverride: null,
  });
});

test("session repo updates model and reasoning effort overrides", () => {
  const repo = createSessionRepo(db);
  // insert session...
  repo.updateModelOverride("discord-1", {
    modelOverride: "gpt-5.4",
    reasoningEffortOverride: "xhigh",
  });

  expect(repo.getByDiscordThreadId("discord-1")).toMatchObject({
    modelOverride: "gpt-5.4",
    reasoningEffortOverride: "xhigh",
  });
});
```

- [ ] **Step 2: Run the focused session repo test file to verify failure**

Run:

```bash
bun test tests/db/session-repo.test.ts
```

Expected: FAIL because the session repo and schema do not yet include override columns or update helpers.

- [ ] **Step 3: Add the migration and repo support**

Create `src/db/migrations/002_session_model_overrides.sql`:

```sql
ALTER TABLE sessions ADD COLUMN model_override TEXT;
ALTER TABLE sessions ADD COLUMN reasoning_effort_override TEXT;
```

Then extend `src/db/repos/sessions.ts`:

```ts
export type SessionRecord = {
  // existing fields...
  modelOverride: string | null;
  reasoningEffortOverride: string | null;
};
```

Add a focused mutation:

```ts
updateModelOverride(
  discordThreadId: string,
  input: {
    modelOverride: string | null;
    reasoningEffortOverride: string | null;
  },
) {
  // update model_override, reasoning_effort_override, updated_at
}
```

Keep the repo API narrow. Do not add generalized settings blobs.

- [ ] **Step 4: Re-run the focused repo tests**

Run:

```bash
bun test tests/db/session-repo.test.ts
```

Expected: PASS for legacy-null and override-update coverage.

- [ ] **Step 5: Commit the session override persistence**

```bash
git add src/db/migrations/002_session_model_overrides.sql src/db/migrate.ts src/db/repos/sessions.ts tests/db/session-repo.test.ts
git commit -m "feat(session): persist model overrides per managed session"
```

## Task 3: Evolve Thread Message Decisions From Busy-Noop To Start Or Steer

**Files:**
- Modify: `src/discord/thread-handler.ts`
- Test: `tests/discord/thread-handler.test.ts`

- [ ] **Step 1: Write the failing thread-handler tests**

Add tests that lock in the new running-session behavior:

```ts
test("running owner thread message becomes steer-turn", () => {
  const result = decideThreadTurn({
    authorId: "u1",
    ownerId: "u1",
    content: "Please continue.",
    sessionState: "running",
    codexThreadId: "codex-thread-1",
  });

  expect(result).toEqual({
    kind: "steer-turn",
    request: {
      threadId: "codex-thread-1",
      expectedTurnId: undefined,
      input: [{ type: "text", text: "Please continue." }],
    },
  });
});

test("waiting approval owner message is rejected instead of queued", () => {
  const result = decideThreadTurn({
    authorId: "u1",
    ownerId: "u1",
    content: "After approval, continue.",
    sessionState: "waiting-approval",
    codexThreadId: "codex-thread-1",
  });

  expect(result).toEqual({
    kind: "noop",
    reason: "waiting-approval",
  });
});
```

- [ ] **Step 2: Run the focused thread-handler test file to verify failure**

Run:

```bash
bun test tests/discord/thread-handler.test.ts
```

Expected: FAIL because `running` still resolves to `session-busy` noop and `waiting-approval` does not have a dedicated rejection reason.

- [ ] **Step 3: Update the decision model in `src/discord/thread-handler.ts`**

Introduce a steer branch without overloading start-turn:

```ts
export type SteerThreadTurnDecision = {
  kind: "steer-turn";
  request: {
    threadId: string;
    input: CodexTurnInput;
    expectedTurnId?: string;
  };
};
```

Then update `decideThreadTurn`:

```ts
if (sessionState === "waiting-approval") {
  return { kind: "noop", reason: "waiting-approval" };
}

if (sessionState === "running") {
  return {
    kind: "steer-turn",
    request: {
      threadId: codexThreadId,
      input: normalizeOwnerThreadMessage({ authorId, ownerId, content }),
    },
  };
}
```

Keep `degraded` and non-owner behavior unchanged.

- [ ] **Step 4: Re-run the focused thread-handler tests**

Run:

```bash
bun test tests/discord/thread-handler.test.ts
```

Expected: PASS for the new running-steer and waiting-approval rejection cases.

- [ ] **Step 5: Commit the decision-model change**

```bash
git add src/discord/thread-handler.ts tests/discord/thread-handler.test.ts
git commit -m "feat(discord): route running owner messages to steer"
```

## Task 4: Add Managed-Thread Slash Command Definitions And Routing

**Files:**
- Create: `src/discord/managed-session-commands.ts`
- Modify: `src/discord/commands.ts`
- Modify: `src/discord/bot.ts`
- Test: `tests/discord/commands.test.ts`
- Test: `tests/discord/bot.test.ts`

- [ ] **Step 1: Write the failing command registration tests**

Add command tests for the new command family:

```ts
test("managed session commands include status model and interrupt", () => {
  const commands = buildManagedSessionCommands();
  const names = commands.map((command) => command.name);

  expect(names).toContain("status");
  expect(names).toContain("model");
  expect(names).toContain("interrupt");
});

test("/model and /interrupt are ephemeral failures outside managed session threads", async () => {
  // create mock interaction outside a managed thread and assert ephemeral reply
});
```

Add bot-routing tests if needed:

```ts
test("bot routes managed session commands through managed command handler", async () => {
  // emit InteractionCreate with commandName "status" inside a managed thread
});
```

- [ ] **Step 2: Run the focused command and bot tests to verify failure**

Run:

```bash
bun test tests/discord/commands.test.ts
bun test tests/discord/bot.test.ts
```

Expected: FAIL because the new command family and routing entry points do not yet exist.

- [ ] **Step 3: Implement the command definitions and bot routing**

Create `src/discord/managed-session-commands.ts` with a focused interface:

```ts
export type ManagedSessionCommandServices = {
  renderStatus(input: ManagedSessionCommandContext): Promise<DiscordCommandResult>;
  interrupt(input: ManagedSessionCommandContext): Promise<DiscordCommandResult>;
  beginModelSelection(input: ManagedSessionCommandContext): Promise<DiscordCommandResult>;
};
```

Define guild-only commands:

```ts
guildOnlyCommand("status", "Show the current managed session status");
guildOnlyCommand("model", "Select model and reasoning effort for this session");
guildOnlyCommand("interrupt", "Interrupt the current managed session turn");
```

Update `src/discord/bot.ts` so `InteractionCreate` can route:

- existing control-channel commands
- managed-thread commands
- future component interactions for `/model`

Do not merge all command logic into one unstructured switch.

- [ ] **Step 4: Re-run the focused command and bot tests**

Run:

```bash
bun test tests/discord/commands.test.ts
bun test tests/discord/bot.test.ts
```

Expected: PASS for command registration and managed-thread command dispatch.

- [ ] **Step 5: Commit the command-surface scaffolding**

```bash
git add src/discord/managed-session-commands.ts src/discord/commands.ts src/discord/bot.ts tests/discord/commands.test.ts tests/discord/bot.test.ts
git commit -m "feat(discord): add managed session slash commands"
```

## Task 5: Implement Runtime Steer And Interrupt Handling In The Managed Session Flow

**Files:**
- Modify: `src/index.ts`
- Modify: `src/discord/thread-handler.ts`
- Test: `tests/index.test.ts`

- [ ] **Step 1: Write the failing integration tests for steer lifecycle and interrupt clearing**

Add integration tests in `tests/index.test.ts`:

```ts
test("running owner message submits turn/steer and tracks queued steer until transcript consumption", async () => {
  // seed running session, send MessageCreate, expect turn/steer request and pending queue
});

test("waiting approval owner message is rejected and does not queue steer", async () => {
  // seed waiting-approval session, send MessageCreate, expect reply and no queue mutation
});

test("interrupt clears queued steer only after interrupt request succeeds", async () => {
  // seed running session with queued steer, invoke interrupt service, assert queue cleared after success
});

test("interrupt failure preserves queued steer", async () => {
  // seed queue, force turn/interrupt failure, assert queue remains
});
```

- [ ] **Step 2: Run the focused integration tests to verify failure**

Run:

```bash
bun test tests/index.test.ts -t "steer"
bun test tests/index.test.ts -t "interrupt"
```

Expected: FAIL because runtime pending-input tracking only supports start-turn replay suppression and there is no interrupt control path yet.

- [ ] **Step 3: Implement the minimal runtime changes in `src/index.ts`**

Refactor the local pending-input structure from a plain string list into a typed list:

```ts
type PendingLocalInput = {
  kind: "start" | "steer";
  text: string;
  replyToMessageId?: string;
  turnId?: string;
};
```

Add focused helpers:

```ts
const queuePendingSteerInput = (...) => { /* push steer record */ };
const clearQueuedSteerInputs = (...) => { /* remove only steer records */ };
const consumeConfirmedPendingInputs = (...) => { /* transcript reconciliation */ };
```

Then update the managed-thread message flow so:

- `start-turn` still uses `turn/start`
- `steer-turn` uses `turn/steer`
- `waiting-approval` replies with a specific short rejection

Add a narrow interrupt service path that:

- resolves ownership and active turn id
- submits `turn/interrupt`
- clears queued steer only after request success

- [ ] **Step 4: Re-run the focused integration tests**

Run:

```bash
bun test tests/index.test.ts -t "steer"
bun test tests/index.test.ts -t "interrupt"
```

Expected: PASS for steer acceptance, steer rollback, approval-state rejection, and interrupt queue-clearing behavior.

- [ ] **Step 5: Commit the runtime steer and interrupt work**

```bash
git add src/index.ts src/discord/thread-handler.ts tests/index.test.ts
git commit -m "feat(runtime): support steer and interrupt in managed sessions"
```

## Task 6: Implement `/status` Rendering For Managed Session Threads

**Files:**
- Create: `src/discord/managed-session-status.ts`
- Modify: `src/discord/managed-session-commands.ts`
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

- [ ] **Step 1: Write the failing `/status` rendering tests**

Add status-render tests:

```ts
test("managed session status renderer returns compact monospace text", () => {
  const text = renderManagedSessionStatus({
    session: {
      codexThreadId: "codex-1",
      discordThreadId: "discord-1",
      cwd: "/tmp/project",
      state: "running",
      modelOverride: "gpt-5.4",
      reasoningEffortOverride: "xhigh",
    },
    queuedSteers: ["Please continue."],
    pendingApprovalCount: 1,
  });

  expect(text).toContain("Model:");
  expect(text).toContain("Queued steer:");
});
```

Add an integration test that `/status` prefers a fresh thread snapshot when available.

- [ ] **Step 2: Run the focused `/status` tests to verify failure**

Run:

```bash
bun test tests/index.test.ts -t "status"
```

Expected: FAIL because no managed-session status renderer or command handler exists yet.

- [ ] **Step 3: Implement the renderer and command handler**

Create `src/discord/managed-session-status.ts` with a single focused API:

```ts
export const renderManagedSessionStatus = (input: {
  session: SessionRecord;
  effectiveState: string;
  queuedSteers: string[];
  pendingApprovalCount: number;
}) => {
  return [
    ">_ OpenAI Codex",
    "",
    `Model:              ${input.session.modelOverride ?? "not available"}`,
    `Reasoning effort:   ${input.session.reasoningEffortOverride ?? "not available"}`,
    `Directory:          ${input.session.cwd}`,
    `State:              ${input.effectiveState}`,
    `Queued steer:       ${input.queuedSteers.length}`,
    `Pending approvals:  ${input.pendingApprovalCount}`,
  ].join("\n");
};
```

Keep the renderer text-only and monospace-friendly.

Wire `/status` in the managed command service so it:

- validates the thread mapping
- fetches a fresh thread snapshot when feasible
- falls back to stored session state
- replies with a code block or raw monospace content

- [ ] **Step 4: Re-run the focused `/status` tests**

Run:

```bash
bun test tests/index.test.ts -t "status"
```

Expected: PASS for compact output shape and live-state preference behavior.

- [ ] **Step 5: Commit the `/status` feature**

```bash
git add src/discord/managed-session-status.ts src/discord/managed-session-commands.ts src/index.ts tests/index.test.ts
git commit -m "feat(discord): add managed session status command"
```

## Task 7: Implement `/model` Picker And Apply Overrides To Future Turns

**Files:**
- Create: `src/discord/managed-session-model-ui.ts`
- Modify: `src/discord/managed-session-commands.ts`
- Modify: `src/index.ts`
- Modify: `src/db/repos/sessions.ts`
- Test: `tests/index.test.ts`
- Test: `tests/discord/bot.test.ts`

- [ ] **Step 1: Write the failing `/model` tests**

Add tests for:

```ts
test("model command is rejected while session is running", async () => {
  // invoke /model for a running session and expect an ephemeral failure
});

test("model command persists the selected model and effort for the current session", async () => {
  // choose gpt-5.4 + xhigh and assert repo update
});

test("future start turns include the session model and effort overrides", async () => {
  // seed override, start a new owner message, assert turn/start includes model and reasoningEffort
});
```

If component-selection routing is moved through `src/discord/bot.ts`, add a bot test for model component interaction dispatch.

- [ ] **Step 2: Run the focused `/model` tests to verify failure**

Run:

```bash
bun test tests/index.test.ts -t "model"
bun test tests/discord/bot.test.ts
```

Expected: FAIL because there is no model picker flow, no component handling, and no start-turn override application.

- [ ] **Step 3: Implement the model picker and override application**

Create `src/discord/managed-session-model-ui.ts` with helpers that:

- map `model/list` output into Discord select options
- generate short `custom_id` tokens
- parse selected model and effort values back into validated payloads

Example helper shape:

```ts
export const managedModelCustomId = (kind: "model" | "effort", token: string) =>
  `msm|${kind}|${token}`;
```

In `src/index.ts` or a focused managed-command service:

- `/model` only works for owner plus `idle`
- fetch `model/list`
- show model picker
- if needed, show effort picker
- persist to `sessions` repo
- emit one short visible thread confirmation

Then ensure future `turn/start` requests include:

```ts
{
  model: session.modelOverride ?? undefined,
  reasoningEffort: session.reasoningEffortOverride ?? undefined,
}
```

Do not inject overrides into `turn/steer`.

- [ ] **Step 4: Re-run the focused `/model` tests**

Run:

```bash
bun test tests/index.test.ts -t "model"
bun test tests/discord/bot.test.ts
```

Expected: PASS for idle-only gating, override persistence, and future-turn parameter application.

- [ ] **Step 5: Commit the `/model` flow**

```bash
git add src/discord/managed-session-model-ui.ts src/discord/managed-session-commands.ts src/index.ts src/db/repos/sessions.ts tests/index.test.ts tests/discord/bot.test.ts
git commit -m "feat(discord): add managed session model picker"
```

## Task 8: Run Full Verification And Clean Up Plan Checkboxes

**Files:**
- Modify: `docs/superpowers/plans/2026-04-22-discord-managed-session-command-surface-implementation.md`

- [ ] **Step 1: Run the full test suite**

Run:

```bash
bun test
```

Expected: PASS. All existing and new Bun tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS. No TypeScript errors from protocol types, Discord command routing, or session repo changes.

- [ ] **Step 3: Sanity-check the implementation against the approved spec**

Run:

```bash
rg -n "followup|interrupt and send immediately|persistent runtime control panel" docs/superpowers/specs/2026-04-22-discord-managed-session-command-surface-design.md
```

Expected: PASS. The implementation should still match the approved non-goals and must not accidentally add the deferred features.

Then manually verify:

- running owner messages become steer input
- waiting approval still blocks ordinary follow-up messages
- `/interrupt` discards queued steer
- `/model` is session-scoped and idle-only
- `/status` stays text-first and does not invent unavailable data

- [ ] **Step 4: Update this plan document to reflect execution status**

Mark each completed checkbox in this file as execution proceeds.

- [ ] **Step 5: Commit the final verification pass**

```bash
git add docs/superpowers/plans/2026-04-22-discord-managed-session-command-surface-implementation.md
git commit -m "docs: record managed session command surface execution progress"
```
