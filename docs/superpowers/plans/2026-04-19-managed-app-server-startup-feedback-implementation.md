# Managed App Server Startup Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make managed Codex App Server startup feedback understandable by classifying delayed versus failed startup, presenting warning-style timeout copy, and showing human-facing start times in explicit local time.

**Architecture:** Keep the current startup sequence accurate and fail-safe, but stop exposing raw timeout text as the headline. First, teach the supervisor to classify timeout diagnostics structurally instead of only emitting a bare string; then let the CLI format that classification into state, impact, and next-step copy while continuing to display runtime timestamps in local time with an explicit timezone. If the code path later becomes reconnect-safe, the same state vocabulary can be threaded into runtime summaries without redesigning the public copy again.

**Tech Stack:** Bun, TypeScript, bun:test, Zod, CLI command formatting, managed Codex supervisor

---

## File Map

- Modify: `src/codex/supervisor.ts`
  Classify startup timeouts as delayed versus failed and attach structured diagnostics.
- Modify: `src/index.ts`
  Publish explicit Codex startup state in the runtime summary on successful startup and leave room for delayed-state projection later.
- Modify: `src/cli/runtime-state.ts`
  Validate any new Codex startup-state field in the persisted runtime summary schema.
- Modify: `src/cli/commands.ts`
  Render warning-style startup timeout copy and keep human-facing `Started:` output in explicit local time.
- Modify: `tests/codex/supervisor.test.ts`
  Lock the supervisor classification and timeout diagnostics.
- Modify: `tests/cli/commands.test.ts`
  Lock warning copy and local-time display behavior.
- Modify: `tests/cli/runtime-state.test.ts`
  Lock runtime summary schema updates when a Codex startup-state field is added.

## Task 1: Add Structured Startup Classification In The Supervisor

**Files:**
- Modify: `src/codex/supervisor.ts`
- Modify: `tests/codex/supervisor.test.ts`

- [ ] **Step 1: Write the failing supervisor tests**

Add coverage for:

- readiness timeout while the child is still alive producing a delayed-startup classification
- child exit or spawn error still producing a failed-startup classification
- diagnostics preserving stderr excerpts and timeout details

Use expectations like:

```ts
await expect(waitForManagedCodexAppServerReady({...})).rejects.toMatchObject({
  code: "CODEX_APP_SERVER_FAILED_TO_START",
  startupDisposition: "delayed",
});
```

and:

```ts
await expect(startManagedCodexAppServer({...})).rejects.toMatchObject({
  startupDisposition: "failed",
});
```

- [ ] **Step 2: Run the focused supervisor tests and verify they fail**

Run:

```bash
bun test tests/codex/supervisor.test.ts
```

Expected: FAIL because the current supervisor error only exposes the generic timeout message.

- [ ] **Step 3: Extend `CodexSupervisorError` and timeout handling**

In `src/codex/supervisor.ts`, add structured fields such as:

```ts
type StartupDisposition = "delayed" | "failed";
```

Then set them from the actual cause:

- readiness timeout while the child remains alive -> `delayed`
- child exit, spawn error, or known fatal setup error -> `failed`

Keep the existing diagnostics helper, but make sure the raw timeout string is no longer the only signal available to callers.

- [ ] **Step 4: Re-run the focused supervisor tests and verify they pass**

Run:

```bash
bun test tests/codex/supervisor.test.ts
```

Expected: PASS. Timeout diagnostics are now structured enough for the CLI to render stateful copy.

- [ ] **Step 5: Commit**

```bash
git add src/codex/supervisor.ts tests/codex/supervisor.test.ts
git commit -m "feat(cli): classify managed Codex startup delays"
```

## Task 2: Render Warning-Style Startup Timeout Copy In The CLI

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Write the failing CLI tests**

Add coverage for:

- delayed startup errors being rendered as warning-style copy with:
  - state conclusion
  - impact
  - next step
- hard failures still rendering failure framing

Use expectations like:

```ts
await expect(runCliCommand({ kind: "start", daemon: false }, services)).rejects.toThrow(
  [
    "Managed Codex App Server startup is taking longer than expected.",
    "Codex requests are not ready yet.",
    "You can keep waiting, inspect logs, or restart CodeHelm if the state does not recover.",
  ].join("\n"),
);
```

- [ ] **Step 2: Run the focused CLI tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because the current path still surfaces the raw timeout sentence.

- [ ] **Step 3: Add startup-copy translation helpers in `src/cli/commands.ts`**

Implement a formatter that maps structured supervisor errors to user-facing copy:

```ts
const formatStartupFailure = (error: unknown) => { ... };
```

Rules:

- `startupDisposition === "delayed"` -> warning framing
- `startupDisposition === "failed"` -> failure framing
- unknown errors -> existing generic fallback

Keep diagnostics available below the headline when useful, but do not lead with the raw timeout sentence.

- [ ] **Step 4: Re-run the focused CLI tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: PASS. Startup timeout copy is warning-shaped and hard failures remain explicit.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands.ts tests/cli/commands.test.ts
git commit -m "fix(cli): improve managed Codex startup timeout messaging"
```

## Task 3: Make Runtime Summaries Explicit About Time And Codex Startup State

**Files:**
- Modify: `src/index.ts`
- Modify: `src/cli/runtime-state.ts`
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/runtime-state.test.ts`
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Write the failing runtime summary tests**

Add coverage for:

- a persisted runtime summary carrying an explicit Codex startup state such as `ready`
- `Started:` rendering in local display format with a timezone label
- never showing the raw UTC ISO string as the primary `Started:` line

Use expectations like:

```ts
expect(result.output).toContain("Started: 2026-04-17 16:22:19");
expect(result.output).toContain("GMT");
expect(result.output).not.toContain("Started: 2026-04-17T08:22:19.208Z");
```

- [ ] **Step 2: Run the focused runtime summary tests and verify they fail**

Run:

```bash
bun test tests/cli/runtime-state.test.ts tests/cli/commands.test.ts
```

Expected: FAIL because the runtime schema does not yet require a Codex startup state field everywhere it should appear, or the display format is still inconsistent in at least one path.

- [ ] **Step 3: Thread explicit startup state through runtime summary writing and reading**

In `src/cli/runtime-state.ts`, add a field such as:

```ts
codex: z.object({
  appServerAddress: wsUrlSchema,
  pid: z.number().int().positive().optional(),
  running: z.boolean().optional(),
  startupState: z.enum(["starting", "ready", "delayed", "failed"]).optional(),
})
```

In `src/index.ts`, publish `startupState: "ready"` once the managed server has actually reached readiness.

In `src/cli/commands.ts`, keep `formatRuntimeStartedAt(...)` the only path that renders `Started:` and make sure the timezone label is preserved in every summary path.

- [ ] **Step 4: Re-run the focused runtime summary tests and verify they pass**

Run:

```bash
bun test tests/cli/runtime-state.test.ts tests/cli/commands.test.ts
```

Expected: PASS. Runtime summaries stay machine-storable while the human-facing display is clearly local-time.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/cli/runtime-state.ts src/cli/commands.ts tests/cli/runtime-state.test.ts tests/cli/commands.test.ts
git commit -m "feat(cli): expose Codex startup state in runtime summaries"
```

## Task 4: Run End-To-End Verification And Capture Follow-Up Risk

**Files:**
- Modify: `tests/codex/supervisor.test.ts`
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Add one final regression assertion for the current startup boundary**

Lock the current architectural reality in tests:

- if managed Codex is not ready, `startCodeHelm` still does not proceed into a fully running runtime
- the user-facing copy is clearer, but startup remains fail-safe

Use an assertion like:

```ts
expect(startedRuntime).toBe(false);
```

- [ ] **Step 2: Run the focused verification commands**

Run:

```bash
bun test tests/codex/supervisor.test.ts tests/cli/runtime-state.test.ts tests/cli/commands.test.ts
bun run typecheck
```

Expected: PASS. The project now distinguishes delayed versus failed startup in user-facing feedback without loosening startup safety accidentally.

- [ ] **Step 3: Commit**

```bash
git add tests/codex/supervisor.test.ts tests/cli/commands.test.ts
git commit -m "test(cli): lock managed Codex startup feedback behavior"
```

