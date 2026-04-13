# Session Resume Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `session-import` with a single searchable `/session-resume` flow that attaches Discord to existing Codex sessions by workdir while preserving one active Discord thread per Codex session.

**Architecture:** Add Discord autocomplete plumbing for `workdir` and `session`, then route both archived reopens and first-time attaches through one runtime attachment path in `src/index.ts`. Preserve the existing single-controller model, but expose it as `controller` in user-facing text and add session-row rebind support so deleted Discord threads can be replaced without losing the Codex session binding.

**Tech Stack:** Bun, TypeScript, discord.js, bun:sqlite, Codex App Server JSON-RPC

---

## File Map

- Modify: `src/discord/commands.ts`
  Purpose: remove `/session-import`, define `/session-resume` autocomplete options, add autocomplete handlers and input/result types.
- Modify: `src/discord/bot.ts`
  Purpose: route Discord autocomplete interactions in addition to slash-command executions.
- Modify: `src/index.ts`
  Purpose: implement workdir/session autocomplete services, unify attach logic under `resumeSession`, reject active-attachment conflicts, and switch user-facing wording from `owner` to `controller` where the user sees it.
- Modify: `src/db/repos/sessions.ts`
  Purpose: add repo helpers for controller reassignment and Discord-thread rebind.
- Modify: `src/db/migrations/001_init.sql`
  Purpose: declare approval-to-session foreign key with `ON UPDATE CASCADE` so a session row can be rebound to a replacement Discord thread.
- Modify: `src/db/migrate.ts`
  Purpose: upgrade older databases by rebuilding the `approvals` table when its foreign key does not support Discord-thread rebind.
- Modify: `README.md`
  Purpose: document `session-new` + `session-resume` as the only session-entry commands and update user-facing `controller` language.
- Modify: `docs/baselines/e2e-baseline.md`
  Purpose: replace import-era baseline items and add the new `/session-resume` picker/attach contract.
- Modify: `tests/discord/commands.test.ts`
  Purpose: lock the new command schema, service delegation, and autocomplete behavior.
- Modify: `tests/discord/bot.test.ts`
  Purpose: lock bot-level routing for autocomplete interactions.
- Modify: `tests/index.test.ts`
  Purpose: lock runtime helpers and unified attach semantics for active, archived, deleted, and unmanaged sessions.
- Modify: `tests/db/session-repo.test.ts`
  Purpose: lock controller reassignment and Discord-thread rebind behavior.
- Modify: `tests/db/approval-repo.test.ts`
  Purpose: lock approval-row survival across Discord-thread rebind after schema upgrade.

## Task 1: Lock The New Discord Command Contract

**Files:**
- Modify: `tests/discord/commands.test.ts`
- Modify: `tests/discord/bot.test.ts`

- [ ] **Step 1: Write the failing command-shape tests**

Add coverage that removes `session-import`, adds `workdir` plus `session` to `/session-resume`, and marks both options as autocomplete-driven:

```ts
expect(commandsByName.has("session-import")).toBe(false);
expect(commandsByName.get("session-resume")?.options).toEqual([
  {
    type: 3,
    name: "workdir",
    description: "Configured workdir identifier",
    required: true,
    autocomplete: true,
  },
  {
    type: 3,
    name: "session",
    description: "Codex session identifier to attach",
    required: true,
    autocomplete: true,
  },
]);
```

- [ ] **Step 2: Write the failing command-dispatch tests**

Replace the old import delegation assertion with the new resume payload:

```ts
expect(calls.resumeSession).toEqual([
  {
    actorId: "u1",
    guildId: "g1",
    channelId: "c1",
    workdirId: "example",
    codexThreadId: "codex-thread-7",
  },
]);
```

- [ ] **Step 3: Write the failing autocomplete-routing tests**

Add tests for:

- `handleControlChannelAutocomplete` returns workdir choices when the focused option is `workdir`
- `handleControlChannelAutocomplete` returns session choices when the focused option is `session` and `workdir` is already selected
- `createDiscordBot` routes `interaction.isAutocomplete()` into the autocomplete handler instead of the chat-command handler

Use minimal interaction stubs like:

```ts
const interaction = {
  commandName: "session-resume",
  guildId: "g1",
  channelId: "c1",
  user: { id: "u1" },
  isAutocomplete: () => true,
  options: {
    getFocused: () => ({ name: "workdir", value: "ex" }),
    getString: (name: string) => (name === "workdir" ? "example" : null),
  },
  respond: async (choices: unknown[]) => {
    seenChoices.push(choices);
  },
};
```

- [ ] **Step 4: Run the focused Discord command tests and verify they fail**

Run:

```bash
bun test tests/discord/commands.test.ts tests/discord/bot.test.ts
```

Expected: FAIL because `/session-import` still exists, `/session-resume` still has the old option schema, and there is no autocomplete handler yet.

- [ ] **Step 5: Commit the red test scaffolding**

```bash
git add tests/discord/commands.test.ts tests/discord/bot.test.ts
git commit -m "test(discord): lock session resume command contract"
```

## Task 2: Implement Slash Autocomplete And Remove `session-import`

**Files:**
- Modify: `src/discord/commands.ts`
- Modify: `src/discord/bot.ts`
- Test: `tests/discord/commands.test.ts`
- Test: `tests/discord/bot.test.ts`

- [ ] **Step 1: Add the new Discord command/autocomplete types**

Replace import-era service types with the new resume input and autocomplete types:

```ts
export type ResumeSessionInput = {
  actorId: string;
  guildId: string;
  channelId: string;
  workdirId: string;
  codexThreadId: string;
};

export type DiscordAutocompleteChoice = {
  name: string;
  value: string;
};

export type ResumeSessionAutocompleteInput = {
  actorId: string;
  guildId: string;
  channelId: string;
  workdirId?: string;
  query: string;
};
```

- [ ] **Step 2: Update slash-command registration**

Change `/session-resume` to two required autocomplete options and delete `/session-import` from both the builder and command-name registry:

```ts
guildOnlyCommand("session-resume", "Attach Discord to an existing Codex session")
  .addStringOption((option) =>
    option
      .setName("workdir")
      .setDescription(workdirOptionDescription)
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName("session")
      .setDescription("Codex session identifier to attach")
      .setRequired(true)
      .setAutocomplete(true),
  );
```

- [ ] **Step 3: Add a dedicated autocomplete handler**

Implement `handleControlChannelAutocomplete(...)` in `src/discord/commands.ts`, including:

- context extraction from the interaction
- focused-option switching
- `services.autocompleteResumeWorkdirs(...)`
- `services.autocompleteResumeSessions(...)`
- `interaction.respond(choices.slice(0, 25))`

Treat autocomplete as convenience only. Do not let it become the only validation path; submit-time runtime validation still has to reject stale or hand-typed values.

- [ ] **Step 4: Route autocomplete interactions in the bot**

Update `createDiscordBot(...)` so it distinguishes:

```ts
if (interaction.isAutocomplete()) {
  await handleControlChannelAutocomplete(interaction, services);
  return;
}

if (!interaction.isChatInputCommand()) {
  return;
}
```

- [ ] **Step 5: Run the focused Discord command tests and verify they pass**

Run:

```bash
bun test tests/discord/commands.test.ts tests/discord/bot.test.ts
```

Expected: PASS. `/session-import` is gone, `/session-resume` exposes the new options, and autocomplete interactions route correctly.

- [ ] **Step 6: Commit**

```bash
git add src/discord/commands.ts src/discord/bot.ts tests/discord/commands.test.ts tests/discord/bot.test.ts
git commit -m "feat(discord): add session resume autocomplete"
```

## Task 3: Add Rebind-Safe Persistence For Replacing Deleted Discord Threads

**Files:**
- Modify: `src/db/migrations/001_init.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/db/repos/sessions.ts`
- Modify: `tests/db/session-repo.test.ts`
- Modify: `tests/db/approval-repo.test.ts`

- [ ] **Step 1: Write the failing persistence tests**

Add tests that assert:

- session controller can be reassigned on an existing row
- a deleted session row can be rebound from one `discord_thread_id` to another while keeping the same `codex_thread_id`
- pending approvals follow the new thread id after the rebind

Use expectations like:

```ts
repo.reassignController("thread-1", "u2");
expect(repo.getByDiscordThreadId("thread-1")?.ownerDiscordUserId).toBe("u2");
```

and:

```ts
sessionRepo.rebindDiscordThread({
  currentDiscordThreadId: "archived-thread",
  nextDiscordThreadId: "replacement-thread",
  nextOwnerDiscordUserId: "u2",
});

expect(sessionRepo.getByDiscordThreadId("replacement-thread")?.codexThreadId).toBe("codex-archived");
expect(approvalRepo.listPendingByDiscordThreadId("replacement-thread")).toHaveLength(1);
```

- [ ] **Step 2: Run the focused DB tests and verify they fail**

Run:

```bash
bun test tests/db/session-repo.test.ts tests/db/approval-repo.test.ts
```

Expected: FAIL because there is no controller-reassignment helper, no rebind helper, and old schemas do not support approval-row survival across Discord-thread id updates.

- [ ] **Step 3: Add the schema upgrade path**

Update the base schema and migration logic so `approvals.discord_thread_id` uses `ON UPDATE CASCADE`:

```sql
FOREIGN KEY (discord_thread_id)
  REFERENCES sessions(discord_thread_id)
  ON UPDATE CASCADE
```

Mirror the existing lifecycle upgrade pattern in `src/db/migrate.ts` by detecting an old `approvals` table definition and rebuilding it when cascade support is missing.

- [ ] **Step 4: Add the session repo helpers**

Implement focused helpers rather than overloading `insert`:

```ts
reassignController(discordThreadId: string, ownerDiscordUserId: string) { ... }

rebindDiscordThread(input: {
  currentDiscordThreadId: string;
  nextDiscordThreadId: string;
  nextOwnerDiscordUserId: string;
}) { ... }
```

`rebindDiscordThread(...)` should preserve `codex_thread_id`, set the replacement row authoritative, and let approval rows follow via the upgraded foreign key.

- [ ] **Step 5: Run the focused DB tests and verify they pass**

Run:

```bash
bun test tests/db/session-repo.test.ts tests/db/approval-repo.test.ts
```

Expected: PASS. Session rows can switch controller, deleted attachments can be rebound to a new thread id, and approval rows survive the rebind.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/001_init.sql src/db/migrate.ts src/db/repos/sessions.ts tests/db/session-repo.test.ts tests/db/approval-repo.test.ts
git commit -m "feat(db): support session thread rebind"
```

## Task 4: Lock Picker Data Helpers And Conflict Messaging

**Files:**
- Modify: `tests/index.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing helper tests**

Add focused unit tests for pure helper behavior instead of going straight to full runtime integration:

- sorting Codex sessions by `updatedAt desc`, then `createdAt desc`, then `id`
- formatting autocomplete labels from timestamp, status, preview/name, and short id
- rejecting an already-active attachment with thread and controller details

Use expectations like:

```ts
expect(sortResumePickerThreads([older, newer]).map((thread) => thread.id)).toEqual([
  "newer",
  "older",
]);
```

and:

```ts
expect(
  formatActiveSessionAttachConflict({
    discordThreadId: "123",
    controllerDiscordUserId: "u1",
  }).reply.content,
).toContain("<#123>");
```

- [ ] **Step 2: Run the focused runtime-helper tests and verify they fail**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because the picker helpers and active-attachment conflict helper do not exist yet.

- [ ] **Step 3: Add the pure helpers in `src/index.ts`**

Implement small exported helpers near the existing session-status helpers:

```ts
export const sortResumePickerThreads = (threads: CodexThread[]) => { ... };
export const formatResumeSessionAutocompleteChoice = (thread: CodexThread) => ({ ... });
export const resolveActiveSessionAttachConflict = (...) => ({ ... });
```

Keep these helpers pure so the integration path in the next task can reuse them without growing more inline branching.

- [ ] **Step 4: Re-run the focused helper tests and verify they pass**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS for the new helper coverage.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "test(runtime): lock session resume picker helpers"
```

## Task 5: Replace Import/Resume Split With One Attach Flow

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write the failing attach-flow tests**

Add service-level tests for:

- unmanaged session with matching workdir creates a new thread and session row
- archived managed session reuses the same thread and reassigns controller
- deleted managed session creates a replacement thread and rebinds the session row
- already-active managed session is rejected with current thread/controller details
- attached busy session stays non-writable
- attached degraded or error session stays read-only
- after archived resume or deleted-thread reattach, the new controller can drive the session and resolve approvals while the prior controller cannot
- user-facing runtime replies and control errors say `controller` where this change intentionally surfaces the concept

Model the new resume call shape directly:

```ts
const result = await services.resumeSession({
  actorId: "u2",
  guildId: "guild-1",
  channelId: "control-1",
  workdirId: "api",
  codexThreadId: "codex-thread-1",
});
```

- [ ] **Step 2: Run the focused runtime tests and verify they fail**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because `resumeSession` still only accepts archived managed rows, `importSession` still exists, and there is no active-attachment conflict path.

- [ ] **Step 3: Add autocomplete-backed services in `src/index.ts`**

Implement:

- `autocompleteResumeWorkdirs(...)`
- `autocompleteResumeSessions(...)`

Use `config.workdirs`, `findConfiguredWorkdir(...)`, and paged `codexClient.listThreads(...)` calls for the selected `cwd` and `searchTerm`. Collect the full matching result set for that query scope, then sort through `sortResumePickerThreads(...)`, and only then truncate to 25 formatted choices so the picker preserves the spec’s recent-first ordering contract.

- [ ] **Step 4: Rewrite `resumeSession(...)` as the unified attach path**

Refactor the service logic so it:

1. validates control-channel context and configured workdir
2. rejects stale or hand-typed `workdir` values that no longer match current daemon config
3. reads the selected Codex session to confirm the `cwd` still belongs to the chosen workdir
4. checks for an existing managed row by `codexThreadId`
5. branches into:
   - active conflict -> reject
   - archived row -> sync/reopen same thread + `reassignController(...)`
   - deleted row -> create replacement thread + `rebindDiscordThread(...)`
   - no row -> create new thread + `sessionRepo.insert(...)`
6. synchronizes transcript/status into the resulting Discord thread
7. updates user-facing control and approval surfaces so the reassigned controller becomes authoritative immediately

Prefer a helper split like:

```ts
const attachment = await resolveResumeAttachment(...);
return finalizeResumedAttachment(attachment);
```

Do not duplicate the archived resume reconciliation path; reuse the existing sync/resume helpers wherever they already encode the correct read-only vs busy behavior.

As part of this step, update runtime messages in `src/index.ts` that intentionally expose control semantics so they use `controller` rather than `owner`.

- [ ] **Step 5: Remove import-only runtime helpers that no longer fit**

Delete or inline code that only exists for `session-import`, such as:

- `canImportThreadIntoWorkdir(...)`
- `isImportableThreadStatus(...)`
- import-specific reply paths and command text

If a helper still makes sense for the new attach path, rename it to attach-oriented language rather than leaving an import-era name behind.

- [ ] **Step 6: Run the focused runtime tests and verify they pass**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS. `/session-resume` can now attach unmanaged sessions, reopen archived ones, replace deleted thread containers, and reject active-attachment conflicts.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat(runtime): unify session resume attachment flow"
```

## Task 6: Update User-Facing Docs And Final Regression Coverage

**Files:**
- Modify: `README.md`
- Modify: `docs/baselines/e2e-baseline.md`
- Modify: `tests/discord/commands.test.ts`
- Modify: `tests/index.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing doc-adjacent assertions**

Before editing prose, add or update tests that still mention import-only behavior so they fail loudly:

- no test should expect `/session-import`
- no test should expect `/session-resume` to reject unmanaged sessions as "Unknown managed session"
- no test should keep user-facing `owner` wording where this change intentionally exposes `controller`
- approval/control behavior after controller reassignment should remain controller-only

- [ ] **Step 2: Run the affected tests and verify they fail**

Run:

```bash
bun test tests/discord/commands.test.ts tests/index.test.ts
```

Expected: FAIL where old import-era strings and command lists still linger.

- [ ] **Step 3: Update README and baseline prose**

Make the docs say exactly this product model:

- `session-new` creates a new Codex session
- `session-resume` attaches Discord to an existing Codex session
- `session-import` no longer exists
- active attachments are rejected instead of silently stealing control
- `controller` is the user-facing term for the one Discord user who can drive the attached thread

Also finish any remaining runtime message cleanup in `src/index.ts` so user-visible reply text matches the doc language.

- [ ] **Step 4: Run full verification**

Run:

```bash
bun test
bun run typecheck
```

Expected: PASS. All Discord, runtime, DB, and doc-adjacent tests should pass, and TypeScript should be clean.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/baselines/e2e-baseline.md src/index.ts tests/discord/commands.test.ts tests/index.test.ts
git commit -m "docs: update session resume baseline"
```
