# Session Resume Workdir Hint Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-of-picker current-workdir hint to `/session-resume`, reject that synthetic row safely on submit, and preserve every existing real-session attach behavior.

**Architecture:** Keep the change narrowly scoped to the existing Discord command services in `src/index.ts`. Reuse the current workdir lookup, session sorting, and attach pipeline; add one synthetic autocomplete choice plus one submit-time sentinel interception path, and lock the whole flow with behavior-level tests in `tests/index.test.ts`.

**Tech Stack:** Bun, TypeScript, bun:test, discord.js, Node `path`/`os`, existing CodeHelm Discord command services

---

## File Map

- Modify: `src/index.ts`
  Purpose: add the synthetic `/session-resume` workdir-hint choice, format its display label, thread `homeDir` through the autocomplete builder, and intercept the sentinel value before any real thread read or attach logic runs.
- Modify: `tests/index.test.ts`
  Purpose: lock the top-of-picker hint row, 25-choice cap, long-path truncation, sentinel submit rejection, and the guarantee that hint-row submission does not trigger any thread read or attach behavior.
- Modify: `docs/baselines/e2e-baseline.md`
  Purpose: keep the user-visible control-channel contract aligned with the new picker hint row and sentinel rejection behavior.

## Task 1: Lock The Picker Hint Row In Tests

**Files:**
- Modify: `tests/index.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing autocomplete tests**

Add behavior coverage near the existing resume-picker tests for:

- a synthetic top row that reads `Current workdir: ~/... · Use /workdir to switch directories`
- a reserved sentinel `value`
- one hint row plus at most 24 real sessions
- long-path truncation that still fits Discord's 100-character choice limit

Use focused assertions like:

```ts
const homeRoot = createTestHomeRoot();
const cwd = join(homeRoot, "code-github/code-agent-helm-example");
mkdirSync(cwd, { recursive: true });

const choices = await buildResumeSessionAutocompleteChoices({
  codexClient: {
    async listThreads(params: ThreadListParams) {
      return {
        data: params.archived ? archivedThreads : activeThreads,
        nextCursor: null,
      };
    },
  } as never,
  query: "plan",
  cwd,
  homeDir: homeRoot,
  now: baseTimestamp + 7_200_000,
});

expect(choices[0]).toEqual({
  name:
    "Current workdir: ~/code-github/code-agent-helm-example · Use /workdir to switch directories",
  value: RESUME_SESSION_WORKDIR_HINT_VALUE,
});
expect(choices).toHaveLength(25);
expect(choices[1]?.value).toBe("codex-thread-12345678901");
```

- [ ] **Step 2: Run the focused test file and verify it fails**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because there is no hint-row constant/helper yet, `buildResumeSessionAutocompleteChoices(...)` does not accept `homeDir`, and the first returned choice is still a real session.

- [ ] **Step 3: Implement the minimal autocomplete changes**

In `src/index.ts`:

- export a reserved sentinel value such as:

```ts
export const RESUME_SESSION_WORKDIR_HINT_VALUE =
  "__codehelm:resume-session-workdir-hint__";
```

- add a focused formatter such as:

```ts
export const formatResumeSessionWorkdirHintChoice = ({
  cwd,
  homeDir,
}: {
  cwd: string;
  homeDir: string;
}) => ({
  name: truncateWithEllipsis(
    `Current workdir: ${formatSessionPathForDisplay(cwd, homeDir)} · Use /workdir to switch directories`,
    100,
  ),
  value: RESUME_SESSION_WORKDIR_HINT_VALUE,
});
```

- extend `buildResumeSessionAutocompleteChoices(...)` to accept `homeDir`
- prepend the synthetic hint row
- keep `listThreads` calls unchanged
- cap real session results at 24 so total returned choices never exceed 25
- pass `homeDir` from `autocompleteResumeSessions(...)`

- [ ] **Step 4: Re-run the focused test file and verify the new picker behavior passes**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS. The picker now starts with the workdir hint row, preserves the 25-choice cap, and keeps real session ordering behind the hint.

- [ ] **Step 5: Commit the picker-row change**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat(discord): show workdir hint in resume picker"
```

## Task 2: Reject Hint-Row Submission Before Attach Logic

**Files:**
- Modify: `tests/index.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing sentinel-submit test**

Add a behavior-level service test that:

1. stores a current workdir with `services.setCurrentWorkdir(...)`
2. submits `/session-resume` using `RESUME_SESSION_WORKDIR_HINT_VALUE`
3. expects an ephemeral corrective message with the current workdir
4. proves no thread read or attach path was touched

Use assertions like:

```ts
await services.setCurrentWorkdir({
  actorId: "owner-1",
  guildId: "guild-1",
  channelId: "control-1",
  path: defaultSessionPath,
});

const result = await services.resumeSession({
  actorId: "owner-1",
  guildId: "guild-1",
  channelId: "control-1",
  codexThreadId: RESUME_SESSION_WORKDIR_HINT_VALUE,
});

expect(result).toEqual({
  reply: {
    content:
      "Current workdir: `/tmp/workspace/api`. This row is only a hint and does not select a session. Run /workdir to switch directories, then choose a session below.",
    ephemeral: true,
  },
});
expect(calls.readThreadIds).toEqual([]);
expect(calls.resumedThreads).toEqual([]);
expect(calls.createVisibleSessionThread).toEqual([]);
```

- [ ] **Step 2: Run the focused test file and verify it fails**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because `resumeSession(...)` still treats the sentinel like a real thread id and tries to read it from Codex.

- [ ] **Step 3: Implement the submit-time interception**

In `src/index.ts`:

- add a tiny guard such as `isResumeSessionWorkdirHintValue(...)`
- in `resumeSession(...)`, after current-workdir resolution and display-path formatting, intercept the sentinel before `readThreadForSnapshotReconciliation(...)`
- return exactly:

```ts
{
  reply: {
    content:
      `Current workdir: \`${displayPath}\`. This row is only a hint and does not select a session. Run /workdir to switch directories, then choose a session below.`,
    ephemeral: true,
  },
}
```

- do not change the existing real-session code path

- [ ] **Step 4: Re-run the focused test file and verify the interception passes**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS. Choosing the hint row returns the corrective message and does not trigger any thread read, attach, sync, or rebind behavior.

- [ ] **Step 5: Commit the sentinel interception**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "fix(discord): intercept resume picker hint row"
```

## Task 3: Update The Baseline And Run Full Verification

**Files:**
- Modify: `docs/baselines/e2e-baseline.md`

- [ ] **Step 1: Update the baseline contract**

Patch `docs/baselines/e2e-baseline.md` so `BL-CMD-004` and `P0-07` mention:

- the synthetic top hint row when current workdir is available
- the `/workdir` switch guidance in that row
- the fact that choosing the hint row does not attach a session and instead returns a corrective message

- [ ] **Step 2: Run full regression verification**

Run:

```bash
bun test
bun run typecheck
```

Expected: PASS. Existing create/resume/attach semantics still hold, and the new workdir hint flow is covered without introducing type regressions.

- [ ] **Step 3: Commit the baseline update**

```bash
git add docs/baselines/e2e-baseline.md
git commit -m "docs: capture resume picker workdir hint behavior"
```
