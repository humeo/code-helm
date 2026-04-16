# User-Scoped Workdir Session Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brittle `/session-resume path + session` interaction with a user-scoped current-workdir flow built around `/workdir`, `/session-new`, and `/session-resume session`, while preserving existing attach, approval, transcript, and thread-binding semantics.

**Architecture:** Introduce a tiny persistence layer for the current workdir keyed by `guild + channel + user`, then keep path validation centralized in the existing `src/index.ts` helpers. Rework the Discord command contract so `/workdir` owns path autocomplete, while `/session-new` and `/session-resume` read the persisted workdir snapshot at command start; keep `buildResumeSessionAutocompleteChoices(...)` and the existing resume attachment pipeline so active reuse, archived reopen, replacement-thread rebinds, and waiting-approval approval restoration stay intact.

**Tech Stack:** Bun, TypeScript, bun:test, discord.js, SQLite, Node `fs`/`path`/`os`, Codex App Server JSON-RPC

---

## File Map

- Modify: `docs/superpowers/specs/2026-04-16-user-workdir-session-entry-design.md`
  Purpose: fold in the review findings so the implementation source of truth explicitly preserves existing attach semantics, picker formatting, invalid submit handling, and docs/baseline sync requirements.
- Create: `src/db/repos/current-workdirs.ts`
  Purpose: persist current workdir rows keyed by `guild_id + channel_id + discord_user_id`.
- Create: `tests/db/current-workdirs-repo.test.ts`
  Purpose: lock repo semantics for insert/upsert, lookup, and user/channel isolation.
- Modify: `src/db/migrations/001_init.sql`
  Purpose: create the new `current_workdirs` table on fresh databases.
- Modify: `src/discord/commands.ts`
  Purpose: add `/workdir`, remove `path` from `/session-new` and `/session-resume`, simplify autocomplete routing, and remove slash-option path memory from resume flow.
- Modify: `tests/discord/commands.test.ts`
  Purpose: lock the new slash-command schema and command/autocomplete delegation behavior.
- Modify: `src/index.ts`
  Purpose: instantiate the current-workdir repo, validate stored workdirs, implement `/workdir`, switch create/resume flows to current-workdir lookup, and preserve existing attach/recovery behavior.
- Modify: `src/discord/renderers.ts`
  Purpose: rename user-facing starter copy from `Path:` to `Workdir:` where session-start payloads are shown.
- Modify: `tests/index.test.ts`
  Purpose: lock workdir-backed create/resume behavior, empty autocomplete behavior without workdir, unavailable-workdir handling, and waiting-approval attach preservation.
- Modify: `README.md`
  Purpose: document the new `/workdir`-first flow and remove stale `path + session` instructions.
- Modify: `docs/baselines/e2e-baseline.md`
  Purpose: update the regression contract and end-to-end checklist to the new command surface.

## Task 1: Tighten The Source-Of-Truth Spec

**Files:**
- Modify: `docs/superpowers/specs/2026-04-16-user-workdir-session-entry-design.md`

- [ ] **Step 1: Patch the reviewed spec gaps before touching runtime code**

Add explicit sections or bullets that preserve:

- `/session-resume` attach semantics for:
  - active attachment reuse
  - archived-thread reopen
  - deleted/unusable-thread replacement + rebind
  - waiting-approval resume semantics that restore thread approval lifecycle UI and owner DM controls
- session picker label contract:
  - `updated-time · conversation · session-id`
  - no status in the label
  - no repeated path/workdir in each choice
  - keep normalized-time formatting
- invalid submit handling for:
  - hand-typed or stale `session` ids
  - sessions no longer discoverable in the current workdir
- documentation follow-through:
  - README and baseline must be updated in the same implementation

- [ ] **Step 2: Re-read the patched spec and make sure it can drive implementation without historical context**

Check that an engineer can answer these questions using only the spec:

- what commands exist?
- where is current workdir stored?
- what happens when current workdir is missing or unavailable?
- what happens when resume hits `waiting-approval`?
- what format should session autocomplete labels use?

- [ ] **Step 3: Commit the spec patch**

```bash
git add docs/superpowers/specs/2026-04-16-user-workdir-session-entry-design.md
git commit -m "docs(spec): tighten workdir session entry contract"
```

## Task 2: Add Current Workdir Persistence

**Files:**
- Create: `src/db/repos/current-workdirs.ts`
- Create: `tests/db/current-workdirs-repo.test.ts`
- Modify: `src/db/migrations/001_init.sql`

- [ ] **Step 1: Write the failing repo tests**

Add `tests/db/current-workdirs-repo.test.ts` coverage for:

- creating and reading a stored workdir row
- upserting the same `guild + channel + user` row updates `cwd`
- different users in the same channel do not share workdirs
- the same user in different channels does not share workdirs

Use expectations like:

```ts
repo.upsert({
  guildId: "g1",
  channelId: "c1",
  discordUserId: "u1",
  cwd: "/tmp/ws1/app",
});

expect(repo.get({
  guildId: "g1",
  channelId: "c1",
  discordUserId: "u1",
})?.cwd).toBe("/tmp/ws1/app");
```

- [ ] **Step 2: Run the focused repo tests and verify they fail**

Run:

```bash
bun test tests/db/current-workdirs-repo.test.ts
```

Expected: FAIL because the repo module and schema do not exist yet.

- [ ] **Step 3: Add the table to the bootstrap schema**

Update `src/db/migrations/001_init.sql` with a new table:

```sql
CREATE TABLE IF NOT EXISTS current_workdirs (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id, discord_user_id)
);
```

Keep it independent from `sessions` so current workdir stays an operator context, not a session lifecycle field.

- [ ] **Step 4: Implement the repo**

Create `src/db/repos/current-workdirs.ts` with a focused surface such as:

```ts
export type CurrentWorkdirRecord = {
  guildId: string;
  channelId: string;
  discordUserId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
};

export const createCurrentWorkdirRepo = (db: Database) => ({
  get(input: { guildId: string; channelId: string; discordUserId: string }) { ... },
  upsert(input: { guildId: string; channelId: string; discordUserId: string; cwd: string }) { ... },
});
```

Prefer `INSERT ... ON CONFLICT (...) DO UPDATE` so `/workdir` behaves like `cd`, not like append-only history.

- [ ] **Step 5: Re-run the focused repo tests and verify they pass**

Run:

```bash
bun test tests/db/current-workdirs-repo.test.ts
```

Expected: PASS. The repo exposes stable lookup and overwrite behavior per user/channel context.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/001_init.sql src/db/repos/current-workdirs.ts tests/db/current-workdirs-repo.test.ts
git commit -m "feat(db): persist current workdirs"
```

## Task 3: Rework The Slash Command Contract

**Files:**
- Modify: `src/discord/commands.ts`
- Modify: `tests/discord/commands.test.ts`

- [ ] **Step 1: Write the failing command-registration tests**

Update `tests/discord/commands.test.ts` so it asserts:

- `/workdir` exists with one required `path` autocomplete option
- `/session-new` has no options
- `/session-resume` only has the required `session` autocomplete option
- deprecated surfaces such as `/workdir-list`, `/session-list`, and `path` on `/session-resume` are gone from the active contract

Use expectations like:

```ts
expect(commandsByName.get("workdir")?.options).toEqual([
  {
    type: 3,
    name: "path",
    description: "Path to the workspace directory",
    required: true,
    autocomplete: true,
  },
]);

expect(commandsByName.get("session-new")?.options ?? []).toEqual([]);
expect(commandsByName.get("session-resume")?.options).toEqual([
  {
    type: 3,
    name: "session",
    description: "Codex session identifier to attach",
    required: true,
    autocomplete: true,
  },
]);
```

- [ ] **Step 2: Write the failing delegation tests**

Still in `tests/discord/commands.test.ts`, add coverage that:

- `/workdir` forwards `path` to a new `setCurrentWorkdir(...)` service
- `/session-new` forwards only actor/guild/channel context
- `/session-resume` forwards only actor/guild/channel context plus `codexThreadId`
- autocomplete routing becomes:
  - `/workdir` focused `path` -> `autocompleteSessionPaths(...)`
  - `/session-resume` focused `session` -> `autocompleteResumeSessions(...)`
- path-memory fallback is removed from the resume tests

- [ ] **Step 3: Run the focused command tests and verify they fail**

Run:

```bash
bun test tests/discord/commands.test.ts
```

Expected: FAIL because the command schema and input types still assume `/session-new path` and `/session-resume path + session`.

- [ ] **Step 4: Update the command module**

In `src/discord/commands.ts`:

- add a `SetCurrentWorkdirInput`
- add a `setCurrentWorkdir(...)` service contract
- remove `path` from `CreateSessionInput`
- remove `path` from `ResumeSessionInput`
- add `/workdir`
- remove resume-path autocomplete routing and the associated path-memory state
- update command descriptions to mention "current workdir" where appropriate

The command layer should no longer need to remember slash-option path state between autocomplete requests.

- [ ] **Step 5: Re-run the focused command tests and verify they pass**

Run:

```bash
bun test tests/discord/commands.test.ts
```

Expected: PASS. The public Discord command contract now matches the new product model.

- [ ] **Step 6: Commit**

```bash
git add src/discord/commands.ts tests/discord/commands.test.ts
git commit -m "feat(discord): switch session commands to current workdir"
```

## Task 4: Implement `/workdir` And Workdir-Backed Session Creation

**Files:**
- Modify: `src/index.ts`
- Modify: `src/discord/renderers.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write the failing runtime tests for `/workdir`**

Add `tests/index.test.ts` coverage that proves:

- `/workdir` validates and normalizes the selected path using the same path policy as session paths
- `/workdir` stores the normalized absolute cwd in the repo
- `/workdir` returns `Current workdir: ~/...`
- hidden or invalid paths are rejected with the existing path-validation surface

Use a fixture expectation like:

```ts
expect(await services.setCurrentWorkdir({
  actorId: "u1",
  guildId: "guild-1",
  channelId: "control-1",
  path: "~/code-github/code-helm",
})).toEqual({
  reply: { content: "Current workdir: `~/code-github/code-helm`" },
});
```

- [ ] **Step 2: Write the failing runtime tests for `/session-new`**

Still in `tests/index.test.ts`, add coverage that:

- `/session-new` fails with `No current workdir. Run /workdir first.` when no row exists
- `/session-new` uses the stored current workdir as `cwd` for `thread/start`
- `/session-new` returns user-visible workdir text and keeps starter payloads aligned with `Workdir: ...`
- `/session-new` fails with `Current workdir is no longer available. Run /workdir again.` when the stored path no longer points to a readable directory

- [ ] **Step 3: Run the focused runtime tests and verify they fail**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because the service layer still expects `path` on `/session-new` and has no current-workdir repo.

- [ ] **Step 4: Wire the repo into the runtime service factory**

In `src/index.ts`:

- instantiate `createCurrentWorkdirRepo(db)` alongside the existing repos
- extend `createControlChannelServices(...)` dependencies to accept the current-workdir repo
- add helper functions that:
  - load current workdir by `guild + channel + actor`
  - validate the stored cwd for command submit
  - return consistent command-error payloads for missing or unavailable workdir

Prefer focused helpers such as:

```ts
const resolveStoredCurrentWorkdirForCommand = (...) => { ... };
const resolveStoredCurrentWorkdirForAutocomplete = (...) => { ... };
```

- [ ] **Step 5: Implement `/workdir` and update `/session-new`**

Still in `src/index.ts`:

- implement `setCurrentWorkdir(...)`
- make `/session-new` read one workdir snapshot at command start
- keep the existing Codex `thread/start` + visible-thread bind flow intact
- continue storing the authoritative `started.cwd` on the managed session row

In `src/discord/renderers.ts`, rename starter copy from `Path:` to `Workdir:` so the visible UI matches the new model.

- [ ] **Step 6: Re-run the focused runtime tests and verify they pass**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS for the new `/workdir` and workdir-backed create behavior.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/discord/renderers.ts tests/index.test.ts
git commit -m "feat(session): add current workdir create flow"
```

## Task 5: Rewire Resume Autocomplete And Submit To Current Workdir

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write the failing autocomplete tests**

Add or update `tests/index.test.ts` coverage so that:

- `/session-resume` autocomplete returns `[]` when no current workdir exists
- `/session-resume` autocomplete returns `[]` when the stored workdir is no longer available
- `/session-resume` autocomplete scopes `codexClient.listThreads(...)` by the stored current workdir, not by any slash-command `path`
- picker labels continue to use the existing `updated-time · conversation · session-id` contract and normalized relative times

- [ ] **Step 2: Write the failing submit-path tests**

Still in `tests/index.test.ts`, lock that:

- `/session-resume` fails with `No current workdir. Run /workdir first.` when unset
- hand-typed or stale `session` ids produce a deterministic user-facing error instead of leaking a raw provider exception
- a selected session whose authoritative `cwd` differs from current workdir is rejected
- active attachment reuse still works
- archived attachment reopen still works
- deleted/unusable thread replacement still works
- waiting-approval attach still goes through resume semantics and restores approval lifecycle state before reopening the thread

Reuse and adapt the existing waiting-approval tests around:

- `resume session applies the waiting-approval lifecycle message before reopening the thread`
- `waiting-approval create attach resumes the Discord thread instead of doing a plain sync`

- [ ] **Step 3: Run the focused runtime tests and verify they fail**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because resume autocomplete and submit still depend on explicit `path` command input.

- [ ] **Step 4: Implement current-workdir-backed resume autocomplete**

In `src/index.ts`:

- change `autocompleteResumeSessions(...)` to load the stored current workdir
- return `[]` when no workdir is set or the stored directory is unavailable
- keep using `buildResumeSessionAutocompleteChoices(...)` for thread-list fetching, sorting, label formatting, and top-25 truncation

- [ ] **Step 5: Implement current-workdir-backed resume submit**

Still in `src/index.ts`:

- change `resumeSession(...)` to resolve current workdir at command start
- read the authoritative thread snapshot by `codexThreadId`
- reject mismatched `cwd`
- preserve the existing attach pipeline:
  - owner checks
  - active reuse
  - archived reopen
  - replacement-thread creation + rebind
  - `resumeManagedSessionIntoDiscordThread(...)` path for busy and waiting-approval states

Use a stable not-found surface for stale input, for example:

```ts
content: `Session \`${codexThreadId}\` was not found in current workdir \`${displayPath}\`.`
```

Do not fall back to sessions outside the current workdir.

- [ ] **Step 6: Re-run the focused runtime tests and verify they pass**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS. Resume is now workdir-scoped without regressing existing attach and approval behavior.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat(session): scope resume to current workdir"
```

## Task 6: Sync User Docs, Baselines, And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/baselines/e2e-baseline.md`

- [ ] **Step 1: Update README to the new command surface**

Replace stale user-facing instructions so README now says:

- `/workdir --path <...>` sets the current workdir
- `/session-new` creates a session in the current workdir
- `/session-resume --session <thread-id>` attaches inside the current workdir
- session picker labels and waiting-approval attach semantics stay the same

- [ ] **Step 2: Update the regression baseline**

Revise `docs/baselines/e2e-baseline.md` so the control-channel contract and e2e steps cover:

- `/workdir` as the required first step
- `/session-new` with no `path`
- `/session-resume` with only `session`
- empty resume autocomplete without current workdir
- waiting-approval resume still restoring approval surfaces

- [ ] **Step 3: Run the targeted verification commands**

Run:

```bash
bun test tests/db/current-workdirs-repo.test.ts tests/discord/commands.test.ts tests/index.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the full verification suite**

Run:

```bash
bun test
bun run typecheck
```

Expected: PASS. No command contract, runtime, approval, or docs-related regressions remain.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/baselines/e2e-baseline.md
git commit -m "docs: document current workdir session flow"
```

## Notes For Execution

- Keep `sessions.cwd` as the authoritative session binding. The new current-workdir table is only the user's command context.
- Do not remove legacy `workspaces` / `workdirs` tables in this plan; they can remain as compatibility data until a later cleanup pass.
- Preserve the existing `buildResumeSessionAutocompleteChoices(...)` helper and its normalized-time label behavior unless a test proves the current contract is insufficient.
- Prefer low-noise debug logging only around current-workdir lookup/validation failures if runtime debugging becomes necessary; do not add noisy user-facing explanation text about Discord autocomplete internals.
