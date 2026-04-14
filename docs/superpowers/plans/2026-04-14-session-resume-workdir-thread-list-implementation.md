# Session Resume By Workdir And Codex Thread List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old import/list command surface with a single `workdir + session` `/session-resume` flow backed by live Codex `thread/list`, while keeping `session-new`, `session-close`, and `session-sync` as the only other user-facing session commands.

**Architecture:** Update Discord command registration so `session-new` remains a workdir-scoped create path and `/session-resume` becomes the only attach path, using autocomplete over configured workdirs plus live Codex sessions. Reuse the existing resume/sync runtime behavior for archived managed threads, add attach logic for unmanaged and deleted-thread sessions, and keep local persistence limited to Discord attachment state rather than session discovery.

**Tech Stack:** Bun, TypeScript, discord.js, bun:sqlite, Codex App Server JSON-RPC

---

## File Map

- Modify: `src/discord/commands.ts`
  Purpose: remove `workdir-list`, `session-list`, and `session-import`; keep `session-new`; redefine `/session-resume` as `workdir + session`; add autocomplete contracts.
- Modify: `src/discord/bot.ts`
  Purpose: route autocomplete interactions in addition to chat-input commands.
- Modify: `src/index.ts`
  Purpose: implement workdir/session autocomplete services, remove import/list services, unify attach semantics under `resumeSession`, and reuse the existing resume/sync path where possible.
- Modify: `src/db/repos/sessions.ts`
  Purpose: add focused helpers for Discord-thread rebind when a selected Codex session needs a replacement thread.
- Modify: `src/db/migrations/001_init.sql`
  Purpose: ensure approval rows survive Discord-thread id rebinding through `ON UPDATE CASCADE`.
- Modify: `src/db/migrate.ts`
  Purpose: rebuild older approval schemas when cascade update support is missing.
- Modify: `README.md`
  Purpose: document the new command surface and remove `workdir-list`, `session-list`, and `session-import`.
- Modify: `docs/baselines/e2e-baseline.md`
  Purpose: replace the old command baseline with `session-new`, `session-resume`, `session-close`, and `session-sync`.
- Test: `tests/discord/commands.test.ts`
  Purpose: lock the new command schema, removed commands, and autocomplete behavior.
- Test: `tests/discord/bot.test.ts`
  Purpose: lock bot-level autocomplete routing.
- Test: `tests/index.test.ts`
  Purpose: lock runtime attach semantics for active, archived, deleted, and unmanaged Codex sessions.
- Test: `tests/db/session-repo.test.ts`
  Purpose: lock Discord-thread rebind behavior.
- Test: `tests/db/approval-repo.test.ts`
  Purpose: lock approval row survival across Discord-thread rebinding.

## Task 1: Lock The New Command Surface

**Files:**
- Modify: `tests/discord/commands.test.ts`
- Modify: `tests/discord/bot.test.ts`

- [ ] **Step 1: Write the failing command-shape tests**

Add assertions that:

- `workdir-list` is gone
- `session-list` is gone
- `session-import` is gone
- `session-new` still takes a required `workdir`
- `/session-resume` now takes required `workdir` and `session` options, both with autocomplete

Use expectations like:

```ts
expect(commandsByName.has("workdir-list")).toBe(false);
expect(commandsByName.has("session-list")).toBe(false);
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

Update command delegation coverage so:

- `/session-new` still forwards `workdirId`
- `/session-resume` forwards `workdirId` and `codexThreadId`
- no test continues to expect `listWorkdirs`, `listSessions`, or `importSession`

Use an expectation like:

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

Add tests that cover:

- workdir autocomplete for `/session-resume`
- session autocomplete for `/session-resume` when `workdir` is already selected
- `createDiscordBot(...)` routing `interaction.isAutocomplete()` into the autocomplete handler

- [ ] **Step 4: Run the focused Discord command tests and verify they fail**

Run:

```bash
bun test tests/discord/commands.test.ts tests/discord/bot.test.ts
```

Expected: FAIL because the removed commands still exist, `/session-resume` still uses the old option schema, and autocomplete handling is not wired yet.

- [ ] **Step 5: Commit the red test scaffolding**

```bash
git add tests/discord/commands.test.ts tests/discord/bot.test.ts
git commit -m "test(discord): lock session resume command surface"
```

## Task 2: Implement Slash Command And Autocomplete Plumbing

**Files:**
- Modify: `src/discord/commands.ts`
- Modify: `src/discord/bot.ts`
- Test: `tests/discord/commands.test.ts`
- Test: `tests/discord/bot.test.ts`

- [ ] **Step 1: Add the new command and autocomplete types**

Define the new resume/autocomplete input types in `src/discord/commands.ts`:

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

Remove now-unused `ListWorkdirsInput`, `ImportSessionInput`, and `ListSessionsInput` service contracts.

- [ ] **Step 2: Update slash-command registration**

Change the exported command set so it contains only:

- `session-new`
- `session-resume`
- `session-close`
- `session-sync`

Keep `session-new` as a configured-workdir command. Change `/session-resume` to:

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

Implement `handleControlChannelAutocomplete(...)` in `src/discord/commands.ts` so it:

- extracts guild/channel/user context
- checks the focused option name
- calls `services.autocompleteResumeWorkdirs(...)` or `services.autocompleteResumeSessions(...)`
- returns `choices.slice(0, 25)` through `interaction.respond(...)`

- [ ] **Step 4: Route autocomplete interactions in the bot**

Update `createDiscordBot(...)` in `src/discord/bot.ts` so it handles autocomplete before chat-input commands:

```ts
if (interaction.isAutocomplete()) {
  await handleControlChannelAutocomplete(interaction, services);
  return;
}
```

- [ ] **Step 5: Re-run the focused Discord command tests and verify they pass**

Run:

```bash
bun test tests/discord/commands.test.ts tests/discord/bot.test.ts
```

Expected: PASS. The removed commands are gone, `/session-resume` exposes `workdir + session`, and autocomplete requests are routed correctly.

- [ ] **Step 6: Commit**

```bash
git add src/discord/commands.ts src/discord/bot.ts tests/discord/commands.test.ts tests/discord/bot.test.ts
git commit -m "feat(discord): add workdir-scoped session resume autocomplete"
```

## Task 3: Add Rebind-Safe Persistence For Replacement Threads

**Files:**
- Modify: `src/db/migrations/001_init.sql`
- Modify: `src/db/migrate.ts`
- Modify: `src/db/repos/sessions.ts`
- Test: `tests/db/session-repo.test.ts`
- Test: `tests/db/approval-repo.test.ts`

- [ ] **Step 1: Write the failing persistence tests**

Add tests that assert:

- a managed session row can be rebound from one `discord_thread_id` to another while preserving `codex_thread_id`
- approval rows remain attached to the rebound session thread

Use a focused expectation like:

```ts
sessionRepo.rebindDiscordThread({
  currentDiscordThreadId: "deleted-thread",
  nextDiscordThreadId: "replacement-thread",
});

expect(sessionRepo.getByDiscordThreadId("replacement-thread")?.codexThreadId).toBe("codex-thread-1");
expect(approvalRepo.listPendingByDiscordThreadId("replacement-thread")).toHaveLength(1);
```

- [ ] **Step 2: Run the focused DB tests and verify they fail**

Run:

```bash
bun test tests/db/session-repo.test.ts tests/db/approval-repo.test.ts
```

Expected: FAIL because there is no thread-rebind helper yet and older approval schemas do not follow `discord_thread_id` updates.

- [ ] **Step 3: Add the schema upgrade path**

Update `src/db/migrations/001_init.sql` so `approvals.discord_thread_id` references `sessions.discord_thread_id` with:

```sql
FOREIGN KEY (discord_thread_id)
  REFERENCES sessions(discord_thread_id)
  ON UPDATE CASCADE
```

Then mirror the existing schema-upgrade style in `src/db/migrate.ts` by rebuilding the `approvals` table when cascade support is missing.

- [ ] **Step 4: Add the focused repo helper**

Implement a narrow helper in `src/db/repos/sessions.ts`:

```ts
rebindDiscordThread(input: {
  currentDiscordThreadId: string;
  nextDiscordThreadId: string;
}) { ... }
```

Preserve the Codex session binding and let approval rows follow through the upgraded foreign key.

- [ ] **Step 5: Re-run the focused DB tests and verify they pass**

Run:

```bash
bun test tests/db/session-repo.test.ts tests/db/approval-repo.test.ts
```

Expected: PASS. Deleted or unusable attachments can be replaced without losing Codex session identity or approval history.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/001_init.sql src/db/migrate.ts src/db/repos/sessions.ts tests/db/session-repo.test.ts tests/db/approval-repo.test.ts
git commit -m "feat(db): support session thread rebinding"
```

## Task 4: Lock Picker Data And Attach Resolution Helpers

**Files:**
- Modify: `tests/index.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing helper tests**

Add focused tests for:

- workdir autocomplete choices sourced from configured workdirs
- session sorting by `updatedAt desc`, then `createdAt desc`, then `id`
- session label formatting from status, preview/name, and short thread id
- attach resolution deciding between active reuse, archived reopen, and replacement-thread creation

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
  resolveResumeAttachmentKind({
    existingSession,
    discordThreadUsable: false,
  }),
).toBe("rebind");
```

- [ ] **Step 2: Run the focused runtime-helper tests and verify they fail**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because the picker helpers and attach-resolution helpers do not exist yet.

- [ ] **Step 3: Add the pure helpers in `src/index.ts`**

Implement small exported helpers near the existing session/runtime helpers:

```ts
export const sortResumePickerThreads = (threads: CodexThread[]) => { ... };
export const formatResumeSessionAutocompleteChoice = (thread: CodexThread) => ({ ... });
export const resolveResumeAttachmentKind = (...) => { ... };
```

Keep them pure so the service layer can reuse them without growing more inline branching.

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

## Task 5: Implement The Unified Attach Runtime

**Files:**
- Modify: `src/index.ts`
- Test: `tests/index.test.ts`

- [ ] **Step 1: Write the failing attach-flow tests**

Add service-level tests for:

- unmanaged session with matching workdir creates a new Discord thread and session row
- archived managed session syncs and reopens the same Discord thread
- active managed session reuses the existing Discord thread instead of creating a duplicate
- deleted or unusable managed thread creates a replacement Discord thread through `rebindDiscordThread(...)`
- attached busy sessions stay non-writable
- attached degraded or error sessions stay read-only

Model the new resume call shape directly:

```ts
const result = await services.resumeSession({
  actorId: "u1",
  guildId: "guild-1",
  channelId: "control-1",
  workdirId: "example",
  codexThreadId: "codex-thread-1",
});
```

- [ ] **Step 2: Run the focused runtime tests and verify they fail**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because `resumeSession` still only handles archived managed sessions and the old import/list paths are still present.

- [ ] **Step 3: Add Codex-backed autocomplete services**

In `src/index.ts`, implement:

- `autocompleteResumeWorkdirs(...)`
- `autocompleteResumeSessions(...)`

Use `config.workdirs`, `findConfiguredWorkdir(...)`, and `codexClient.listThreads(...)`. Filter by the selected workdir `cwd`, pass the user query through as `searchTerm`, sort with `sortResumePickerThreads(...)`, and only then truncate to 25 results.

- [ ] **Step 4: Rewrite `resumeSession(...)` as the attach entry point**

Refactor the service logic so it:

1. validates control-channel context and selected workdir
2. confirms the selected Codex thread still belongs to that workdir
3. looks up any existing managed row by `codexThreadId`
4. branches into:
   - active row -> reuse/return the existing Discord thread
   - archived row -> sync and reopen the same Discord thread
   - deleted or unusable row -> create replacement thread and rebind
   - no row -> create a new Discord thread and insert a session row
5. synchronizes transcript and status into the resulting Discord thread

Prefer a helper split like:

```ts
const attachment = await resolveResumeAttachment(...);
return finalizeResumedAttachment(attachment);
```

Reuse the existing resume/sync helpers instead of duplicating archived-session recovery logic.

- [ ] **Step 5: Remove the old import/list runtime path**

Delete or inline runtime logic that only exists for:

- `workdir-list`
- `session-list`
- `session-import`

Also remove import-era helpers that no longer fit the new model, such as `canImportThreadIntoWorkdir(...)` and `isImportableThreadStatus(...)`, unless they are renamed and reused for attach validation.

- [ ] **Step 6: Re-run the focused runtime tests and verify they pass**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS. `/session-resume` can now attach unmanaged Codex sessions, reopen archived ones, reuse active attachments, and replace deleted thread containers.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat(runtime): unify session resume attachment flow"
```

## Task 6: Update Docs And Final Regression Coverage

**Files:**
- Modify: `README.md`
- Modify: `docs/baselines/e2e-baseline.md`
- Modify: `tests/discord/commands.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write the failing doc-adjacent assertions**

Update tests so they fail loudly if they still expect:

- `/workdir-list`
- `/session-list`
- `/session-import`
- archived-only `/session-resume` semantics

- [ ] **Step 2: Run the affected tests and verify they fail**

Run:

```bash
bun test tests/discord/commands.test.ts tests/index.test.ts
```

Expected: FAIL where the old command surface or old resume semantics still linger.

- [ ] **Step 3: Update README and baseline prose**

Make the docs say exactly this product model:

- `session-new` creates a new Codex session in a selected workdir
- `session-resume` attaches Discord to an existing Codex session discovered through live Codex `thread/list`
- `session-close` archives the Discord surface without deleting the Codex session
- `session-sync` remains the recovery path for degraded session threads
- `workdir-list`, `session-list`, and `session-import` no longer exist in the user-facing command surface

- [ ] **Step 4: Run full verification**

Run:

```bash
bun test
bun run typecheck
```

Expected: PASS. All Discord, runtime, DB, and documentation-adjacent tests should pass, and TypeScript should be clean.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/baselines/e2e-baseline.md tests/discord/commands.test.ts tests/index.test.ts
git commit -m "docs: align session command surface"
```
