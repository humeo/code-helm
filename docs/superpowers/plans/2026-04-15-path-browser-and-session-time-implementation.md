# Path Browser And Session Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix incorrect `/session-resume` relative times and add a directory-browser-style `path` autocomplete flow for both `/session-new` and `/session-resume`.

**Architecture:** Extract two focused helper layers out of the current `src/index.ts` logic: one for provider timestamp normalization and one for path-browser autocomplete. Then wire Discord command handling so `path` autocomplete works for both commands, and keep runtime validation at submit time so hand-typed paths and stale filesystem state still fail safely.

**Tech Stack:** Bun, TypeScript, discord.js, Node `fs`/`path`/`os`, Codex App Server JSON-RPC

---

## File Map

- Create: `src/domain/session-time.ts`
  Purpose: normalize provider timestamps into epoch milliseconds and format relative-time labels safely.
- Create: `tests/domain/session-time.test.ts`
  Purpose: lock timestamp unit normalization, plausibility guards, and relative-time rendering.
- Create: `src/domain/session-path-browser.ts`
  Purpose: resolve path-browser state from a `path` input, list directories, and build Discord autocomplete choices for `Select ...`, `../`, and child directories.
- Create: `tests/domain/session-path-browser.test.ts`
  Purpose: lock home-root browsing, child-directory navigation, parent navigation, directory-only filtering, and 25-choice truncation.
- Modify: `src/domain/session-paths.ts`
  Purpose: expose any shared helpers needed by the new path browser while preserving submit-time path normalization rules.
- Modify: `src/discord/commands.ts`
  Purpose: mark `path` options as autocomplete-driven and route both `/session-new` and `/session-resume` path browsing through a shared service surface.
- Modify: `src/index.ts`
  Purpose: replace inline picker-time math with `session-time` helpers, add the shared `autocompleteSessionPaths(...)` service, and gate `/session-resume` session lookup on a valid browsed directory.
- Modify: `README.md`
  Purpose: document the new `~/`-rooted directory browser behavior and the corrected session picker contract.
- Modify: `docs/baselines/e2e-baseline.md`
  Purpose: update the regression contract to cover directory-browser autocomplete and correct relative-time behavior.
- Modify: `tests/discord/commands.test.ts`
  Purpose: lock command registration and autocomplete dispatch for path browsing on both commands.
- Modify: `tests/index.test.ts`
  Purpose: lock normalized-time sorting/formatting behavior, runtime path-browser integration, and the “session picker only after valid directory” rule.

## Task 1: Normalize Provider Thread Times

**Files:**
- Create: `src/domain/session-time.ts`
- Create: `tests/domain/session-time.test.ts`
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write the failing domain tests for timestamp normalization**

Add coverage in `tests/domain/session-time.test.ts` for:

- second-based timestamps
- millisecond-based timestamps
- microsecond-like oversized timestamps
- `undefined` timestamps
- implausible timestamps that should become `null`

Use expectations like:

```ts
expect(normalizeThreadTimestamp(1_744_750_000)).toBe(1_744_750_000_000);
expect(normalizeThreadTimestamp(1_744_750_000_123)).toBe(1_744_750_000_123);
expect(normalizeThreadTimestamp(1_744_750_000_123_000)).toBe(1_744_750_000_123);
expect(normalizeThreadTimestamp(undefined)).toBeNull();
```

- [ ] **Step 2: Write the failing relative-time formatting tests**

Still in `tests/domain/session-time.test.ts`, lock:

- `just now`
- `1 minute ago`
- `2 hours ago`
- `1 day ago`
- `unknown time`

Use expectations like:

```ts
expect(formatRelativeThreadTime(3_600_000, 7_200_000)).toBe("1 hour ago");
expect(formatRelativeThreadTime(null, 7_200_000)).toBe("unknown time");
```

- [ ] **Step 3: Write the failing runtime picker tests**

Update `tests/index.test.ts` so the picker contract proves the helper is really wired:

- sorting uses normalized values, not raw provider numbers
- labels no longer produce impossible large-day counts when provider values are not already milliseconds

Use one case where `updatedAt` is second-based:

```ts
expect(
  formatResumeSessionAutocompleteChoice(
    createResumePickerThread({ updatedAt: 1_700_000_000 }),
    1_700_003_600_000,
  ).name.startsWith("1 hour ago · "),
).toBe(true);
```

- [ ] **Step 4: Run the focused tests and verify they fail**

Run:

```bash
bun test tests/domain/session-time.test.ts tests/index.test.ts
```

Expected: FAIL because the helper module does not exist yet and `src/index.ts` still treats provider values as raw milliseconds.

- [ ] **Step 5: Implement the time helper**

Create `src/domain/session-time.ts` with small focused functions such as:

```ts
export const normalizeThreadTimestamp = (value?: number) => { ... };
export const getNormalizedThreadActivityTime = (thread: CodexThread) => { ... };
export const formatRelativeThreadTime = (timestampMs: number | null, now: number) => { ... };
```

Keep the plausibility thresholds as named constants so future provider adjustments are easy to reason about.

- [ ] **Step 6: Wire the helper into picker sorting and display**

In `src/index.ts`, update:

- `sortResumePickerThreads(...)`
- `formatResumeSessionAutocompleteChoice(...)`

so they both consume the new normalized-time helper instead of raw `updatedAt`/`createdAt`.

- [ ] **Step 7: Re-run the focused tests and verify they pass**

Run:

```bash
bun test tests/domain/session-time.test.ts tests/index.test.ts
```

Expected: PASS. Picker sorting and labels now agree on one normalized interpretation.

- [ ] **Step 8: Commit**

```bash
git add src/domain/session-time.ts tests/domain/session-time.test.ts src/index.ts tests/index.test.ts
git commit -m "fix(session): normalize resume picker times"
```

## Task 2: Lock The Slash Command Contract For Path Browsing

**Files:**
- Modify: `src/discord/commands.ts`
- Modify: `tests/discord/commands.test.ts`

- [ ] **Step 1: Write the failing command-registration tests**

Update `tests/discord/commands.test.ts` so it asserts:

- `/session-new` `path` has `autocomplete: true`
- `/session-resume` `path` has `autocomplete: true`
- `/session-resume` `session` still has `autocomplete: true`

Use expectations like:

```ts
expect(commandsByName.get("session-new")?.options).toEqual([
  {
    type: 3,
    name: "path",
    description: "Path to the workspace directory",
    required: true,
    autocomplete: true,
  },
]);
```

- [ ] **Step 2: Write the failing autocomplete-dispatch tests**

Still in `tests/discord/commands.test.ts`, add coverage for:

- `/session-new` focused `path` delegates to a shared path-autocomplete service
- `/session-resume` focused `path` delegates to that same service
- `/session-resume` focused `session` still delegates to the session service

Use interaction stubs like:

```ts
const interaction = createAutocompleteInteraction({
  commandName: "session-new",
  focused: { name: "path", value: "~/cod" },
});
```

- [ ] **Step 3: Run the focused command tests and verify they fail**

Run:

```bash
bun test tests/discord/commands.test.ts
```

Expected: FAIL because the command builder does not yet expose path autocomplete and command dispatch has no shared path-autocomplete service.

- [ ] **Step 4: Update the command-layer types and registration**

In `src/discord/commands.ts`:

- add a shared `autocompleteSessionPaths(...)` service contract
- mark `path` options as autocomplete-enabled on both commands
- extend `handleControlChannelAutocomplete(...)` to route:
  - `/session-new` focused `path`
  - `/session-resume` focused `path`
  - `/session-resume` focused `session`

- [ ] **Step 5: Re-run the focused command tests and verify they pass**

Run:

```bash
bun test tests/discord/commands.test.ts
```

Expected: PASS. The public slash-command contract now matches the intended path-browser UX.

- [ ] **Step 6: Commit**

```bash
git add src/discord/commands.ts tests/discord/commands.test.ts
git commit -m "feat(discord): add path autocomplete contract"
```

## Task 3: Build The Shared Path Browser Helper

**Files:**
- Create: `src/domain/session-path-browser.ts`
- Create: `tests/domain/session-path-browser.test.ts`
- Modify: `src/domain/session-paths.ts`

- [ ] **Step 1: Write the failing path-browser tests**

Add focused coverage for:

- empty input starts at `~/`
- choosing a child directory yields the child path
- `../` yields the parent path
- `Select <current-directory>` uses the current path value
- only directories are listed
- results are sorted and truncated to 25

Use a temporary directory fixture so the tests hit a real filesystem layout:

```ts
expect(buildPathBrowserChoices({
  inputPath: undefined,
  homeDir,
  nowPathExists: realFs,
})).toEqual([
  { name: "Select ~", value: "~" },
  { name: "code-github/", value: "~/code-github/" },
]);
```

- [ ] **Step 2: Write the failing fallback tests**

Lock graceful-degradation behavior:

- nonexistent path falls back to nearest valid parent
- unreadable path returns a safe fallback or empty list
- files never appear

- [ ] **Step 3: Run the focused path-browser tests and verify they fail**

Run:

```bash
bun test tests/domain/session-path-browser.test.ts
```

Expected: FAIL because the helper does not exist yet.

- [ ] **Step 4: Implement the shared helper**

Create `src/domain/session-path-browser.ts` with narrow functions such as:

```ts
export const resolvePathBrowserState = ({ inputPath, homeDir }) => { ... };
export const listPathBrowserDirectoryChoices = ({ currentPath, homeDir }) => { ... };
export const buildPathBrowserChoices = ({ inputPath, homeDir }) => { ... };
```

Use `src/domain/session-paths.ts` for path normalization and display formatting rather than duplicating tilde logic.

- [ ] **Step 5: Re-run the focused path-browser tests and verify they pass**

Run:

```bash
bun test tests/domain/session-path-browser.test.ts
```

Expected: PASS. The helper expresses the directory-browser state machine without touching command handlers yet.

- [ ] **Step 6: Commit**

```bash
git add src/domain/session-path-browser.ts tests/domain/session-path-browser.test.ts src/domain/session-paths.ts
git commit -m "feat(path): add directory browser helper"
```

## Task 4: Wire Path Browsing Into Runtime Services

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write the failing runtime-service tests**

Add service-level tests for:

- `/session-new` path autocomplete starts from `~/`
- `/session-resume` path autocomplete uses the same choices
- `/session-resume` session autocomplete returns no choices until the chosen path resolves to a valid directory
- hand-typed valid paths still execute without going through the browser flow

Use expectations like:

```ts
expect(await services.autocompleteSessionPaths({
  actorId: "owner-1",
  guildId: "guild-1",
  channelId: "control-1",
  commandName: "session-new",
  query: "",
})).toEqual([
  { name: "Select ~", value: "~" },
  { name: "code-github/", value: "~/code-github/" },
]);
```

and:

```ts
expect(await services.autocompleteResumeSessions({
  actorId: "owner-1",
  guildId: "guild-1",
  channelId: "control-1",
  path: "~/code-github/",
  query: "",
})).toEqual([]);
```

- [ ] **Step 2: Run the focused runtime tests and verify they fail**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because runtime services do not expose shared path browsing and `session` autocomplete still assumes the `path` is already a final valid directory.

- [ ] **Step 3: Add the shared runtime autocomplete service**

In `src/index.ts`, add a shared `autocompleteSessionPaths(...)` service implementation that:

- requires the configured control-channel context
- calls the new path-browser helper
- returns only real path values

- [ ] **Step 4: Gate session discovery on a valid final directory**

Still in `src/index.ts`, keep `buildResumeSessionAutocompleteChoices(...)` as-is for session lookup, but only call it after:

- the current `path` input resolves to a valid directory via submit-time path normalization rules

This preserves the distinction between “browsing around” and “ready to list sessions.”

- [ ] **Step 5: Re-run the focused runtime tests and verify they pass**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS. The runtime now exposes a real directory browser for `path` while keeping path validation and session discovery safe.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat(path): wire directory browser into session commands"
```

## Task 5: Update Docs And Run Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/baselines/e2e-baseline.md`
- Modify: `tests/discord/commands.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Update the docs**

Make `README.md` and `docs/baselines/e2e-baseline.md` say exactly this:

- `path` autocomplete starts from `~/`
- `path` behaves like a lightweight directory browser
- users can choose the current directory at any level
- `/session-resume` session choices appear only after the chosen path resolves to a valid directory
- session picker times are relative times derived from normalized provider timestamps

- [ ] **Step 2: Run the full test suite**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 3: Run the full typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Commit the final docs-and-verification sweep**

```bash
git add README.md docs/baselines/e2e-baseline.md tests/discord/commands.test.ts tests/index.test.ts
git commit -m "docs: document path browser session flow"
```
