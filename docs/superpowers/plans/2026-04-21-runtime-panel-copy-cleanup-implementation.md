# CodeHelm Runtime Panel Copy Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the shared CodeHelm runtime panel used by `status`, foreground `start`, background `start --daemon`, and already-active `start` so it removes `Time Zone`, replaces `Runtime State` with the real runtime state file path, renames `Next steps` to `Quick actions`, and hides self-referential `code-helm status` only on the `status` screen.

**Architecture:** Keep `src/cli/commands.ts` as the runtime-panel composition boundary and avoid changing command semantics. Export a tiny runtime-state path helper from `src/cli/runtime-state.ts` so the CLI can show the same `runtime.json` path used by read/write logic, then pass minimal caller context into the shared runtime panel renderer so `status` and `start` differ only where the spec requires.

**Tech Stack:** Bun, TypeScript, bun:test, Node CLI entrypoints, existing CodeHelm CLI command layer

---

## File Map

- Modify: `src/cli/runtime-state.ts`
  Export a small helper that resolves the runtime summary file path from `stateDir`, then reuse it inside the existing read/write/clear helpers so the path displayed by the CLI stays aligned with storage behavior.
- Modify: `src/cli/commands.ts`
  Update shared runtime-panel assembly to remove `Time Zone`, render `State Source`, rename the action section to `Quick actions`, and filter `code-helm status` only for `status` callers.
- Modify: `tests/cli/commands.test.ts`
  Update runtime-panel assertions for foreground `start`, background `start --daemon`, `start` when already active, and `status` so they lock the new metadata copy, state-path rendering, and per-command quick-action differences.

## Decisions Locked By This Plan

- Keep the change inside the existing shared runtime panel path; do not touch startup failure copy in this plan.
- Keep `code-helm status` in successful foreground `start`, successful background `start --daemon`, and in `start` when a runtime is already active.
- Remove `code-helm status` only from the `status` screen.
- Do not modify `src/cli/output.ts` unless implementation reveals a concrete regression tied to the new `Quick actions` title.

### Task 1: Clean Up Shared Runtime Panel Metadata

**Files:**
- Modify: `tests/cli/commands.test.ts`
- Modify: `src/cli/runtime-state.ts`
- Modify: `src/cli/commands.ts`

- [ ] **Step 1: Write the failing tests for shared runtime-panel copy**

Update the runtime-panel assertions in `tests/cli/commands.test.ts` for:

- `start returns current status instead of launching a second instance`
- `start with invalid TZ falls back to system-default timezone display in runtime panel`
- `start foreground success renders runtime panel output`
- `start --daemon records background runtime state`
- `status renders the runtime panel including app-server address and codex remote command`
- `status renders a not-running runtime panel when no instance is active`

Use expectations like:

```ts
const expectedStatePath = join(services.loadConfigStore().paths.stateDir, "runtime.json");

expect(result.output).toContain("Quick actions");
expect(result.output).toContain("State Source");
expect(result.output).toContain(expectedStatePath);
expect(result.output).not.toContain("Time Zone");
expect(result.output).not.toContain("Runtime State");
```

For the not-running `status` case, keep the assertions narrower:

```ts
expect(result.output).toContain("Quick actions");
expect(result.output).not.toContain("Time Zone");
```

- [ ] **Step 2: Run the focused CLI command tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because `src/cli/commands.ts` still renders `Time Zone`, still uses `Runtime State`, and still titles the action section `Next steps`.

- [ ] **Step 3: Export the runtime-state path helper in `src/cli/runtime-state.ts`**

Add a shared helper and reuse it internally:

```ts
export const resolveRuntimeStatePath = ({ stateDir }: RuntimeStateOptions) => {
  return join(stateDir, "runtime.json");
};
```

Then replace direct `join(stateDir, "runtime.json")` usage inside `clearRuntimeState(...)`, `writeRuntimeSummary(...)`, and `readRuntimeSummary(...)` with `resolveRuntimeStatePath(...)`.

- [ ] **Step 4: Update the shared runtime panel in `src/cli/commands.ts`**

Import the new helper and extend `renderRuntimeStatusOutput(...)` to accept `stateDir`:

```ts
const renderRuntimeStatusOutput = (
  runtime: RuntimeSummary | undefined,
  options: {
    env: Record<string, string | undefined>;
    stateDir: string;
    timeZone?: string;
    headline?: string;
    isCurrentForegroundInvocation?: boolean;
  },
) => { ... };
```

Then make these concrete changes:

- remove `Time Zone` from the not-running `Process` rows
- remove `Time Zone` from the running `Configuration` rows
- replace `Runtime State` with `State Source`
- set `State Source` to `resolveRuntimeStatePath({ stateDir: options.stateDir })`
- rename the action section title from `Next steps` to `Quick actions`
- keep the current action list contents unchanged for now

Update all runtime-panel callers to pass a real `stateDir`:

- `start` when a runtime is already active
- successful foreground `start`
- successful background `start --daemon`
- `status`

- [ ] **Step 5: Re-run the focused CLI command tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: PASS. Foreground `start`, background `start --daemon`, and `status` now use `Quick actions`, show `State Source`, and no longer render `Time Zone`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/runtime-state.ts src/cli/commands.ts tests/cli/commands.test.ts
git commit -m "fix(cli): clean up shared runtime panel metadata"
```

### Task 2: Tailor Quick Actions By Command Context

**Files:**
- Modify: `tests/cli/commands.test.ts`
- Modify: `src/cli/commands.ts`

- [ ] **Step 1: Write the failing tests for command-specific quick actions**

Tighten the same runtime-panel tests so they also verify:

- `status renders the runtime panel including app-server address and codex remote command` does **not** include `code-helm status`
- `start returns current status instead of launching a second instance` still includes `code-helm status`
- `start foreground success renders runtime panel output` still includes `code-helm status`
- `start --daemon records background runtime state` still includes `code-helm status`

Use assertions like:

```ts
expect(statusResult.output).not.toContain("code-helm status");
expect(startResult.output).toContain("code-helm status");
```

- [ ] **Step 2: Run the focused CLI command tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because the shared runtime panel still always includes `code-helm status` whenever a runtime is present.

- [ ] **Step 3: Add minimal caller context to `renderRuntimeStatusOutput(...)`**

Extend the renderer options with a small command-context flag:

```ts
type RuntimePanelContext = "start" | "status";

const renderRuntimeStatusOutput = (
  runtime: RuntimeSummary | undefined,
  options: {
    context: RuntimePanelContext;
    env: Record<string, string | undefined>;
    stateDir: string;
    timeZone?: string;
    headline?: string;
    isCurrentForegroundInvocation?: boolean;
  },
) => { ... };
```

Build the runtime action list like:

```ts
const quickActions = [`codex --remote ${runtime.codex.appServerAddress}`];

if (options.context !== "status") {
  quickActions.push("code-helm status");
}
```

Then preserve the existing stop guidance behavior:

- background -> `code-helm stop`
- current foreground start -> `Stop this foreground process with Ctrl+C.`
- non-current foreground status/start -> `Use the terminal running this foreground process to stop it.`

Update callers so:

- `status` passes `context: "status"`
- successful `start` passes `context: "start"`
- successful `start --daemon` passes `context: "start"`
- `start` when a runtime is already active passes `context: "start"`

- [ ] **Step 4: Re-run the focused CLI command tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: PASS. `status` drops the self-referential command, while both `start` paths keep it.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands.ts tests/cli/commands.test.ts
git commit -m "fix(cli): tailor runtime quick actions by command"
```

### Task 3: Run Full Verification

**Files:**
- Modify if needed: `src/cli/runtime-state.ts`
- Modify if needed: `src/cli/commands.ts`
- Modify if needed: `tests/cli/commands.test.ts`

- [ ] **Step 1: Run the full test suite**

Run:

```bash
bun test
```

Expected: PASS. No other CLI or runtime tests should regress from the copy cleanup.

- [ ] **Step 2: Run type checking**

Run:

```bash
bun run typecheck
```

Expected: PASS. The new helper export and renderer option shape should type-check cleanly.

- [ ] **Step 3: If verification fails, make the smallest fix in already-touched files**

Only adjust the files already listed in this plan. Do not broaden scope into unrelated CLI panels. Re-run:

```bash
bun test
bun run typecheck
```

until both commands pass.

- [ ] **Step 4: Commit only if Step 3 changed tracked files**

```bash
git add src/cli/runtime-state.ts src/cli/commands.ts tests/cli/commands.test.ts
git commit -m "chore(cli): finalize runtime panel copy cleanup"
```

If Step 3 made no changes, skip this commit.
