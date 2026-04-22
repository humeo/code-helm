# Update And Check Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `code-helm check` and redesign `code-helm update` so CodeHelm can compare installed vs published versions, choose the correct global package manager, and handle running foreground/background runtimes correctly during updates.

**Architecture:** Keep CLI parsing and top-level orchestration in `src/cli/args.ts` and `src/cli/commands.ts`, but move registry lookup, installed-package inspection, package-manager detection, and installer execution into a dedicated `src/cli/update-service.ts`. Reuse the existing panel renderer for all human-readable output, add a small interactive confirmation/output seam for `check`, and verify update success from package metadata on disk rather than from the currently running process.

**Tech Stack:** Bun, TypeScript, bun:test, existing CLI panel renderer, `@clack/prompts`, Node child process/fs/path APIs, npm registry HTTP lookups

---

## File Map

- Create: `src/cli/update-service.ts`
  Own package-manager detection, registry version lookup, installed-package metadata reads from disk, and installer execution helpers.
- Create: `tests/cli/update-service.test.ts`
  Lock the pure update-service data model, path detection, registry parsing, and install-command behavior.
- Modify: `src/cli/args.ts`
  Add `check` and `check --yes`, plus updated top-level usage text.
- Modify: `src/cli/commands.ts`
  Add `check` orchestration, redesign `update`, add runtime-aware update helpers, inject prompt/output services, and refresh help text.
- Modify: `src/cli.ts`
  Pass an output sink for interim `check` status rendering before interactive confirmation.
- Modify: `src/package-metadata.ts`
  Add a non-cached path-based metadata reader if that keeps installed-package parsing DRY.
- Modify: `tests/cli/args.test.ts`
  Lock parsing, `--yes`, and usage errors.
- Modify: `tests/cli/commands.test.ts`
  Lock `check`, `update`, prompt behavior, runtime handling, and recovery behavior.
- Modify: `tests/cli/output.test.ts`
  Lock shared output structure that the new check/update screens rely on.
- Modify: `README.md`
  Document `check`, `check --yes`, `update`, package-manager detection, and runtime restart semantics.

## Task 1: Add The `check` CLI Surface

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `tests/cli/args.test.ts`
- Modify: `tests/cli/output.test.ts`
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Write the failing parser and help-surface tests**

Extend `tests/cli/args.test.ts` to cover:

- `check`
- `check --yes`
- rejection for `check extra`
- rejection for `check --yes extra`
- rejection for `check --bogus`
- updated top-level usage text including `check`

Extend `tests/cli/commands.test.ts` help assertions so the help screen includes:

- `check`
- `Check whether a newer version is available`
- `update`
- `Install the latest published package`

Update the usage-shaped expectations in `tests/cli/output.test.ts` to match the new top-level command list.

Use expectations like:

```ts
expect(parseCliArgs(["check"])).toEqual({ kind: "check", yes: false });
expect(parseCliArgs(["check", "--yes"])).toEqual({ kind: "check", yes: true });
expect(() => parseCliArgs(["check", "--bogus"])).toThrow(/Unknown arguments for check/);
```

- [ ] **Step 2: Run the focused parsing tests and verify they fail**

Run:

```bash
bun test tests/cli/args.test.ts tests/cli/output.test.ts tests/cli/commands.test.ts
```

Expected: FAIL because the parser and help output do not know about `check` yet.

- [ ] **Step 3: Implement the minimal CLI-surface changes**

In `src/cli/args.ts`:

- extend `CliCommand` with:

```ts
| { kind: "check"; yes: boolean }
```

- expand the usage string to include `check`
- parse:
  - `check` as `{ kind: "check", yes: false }`
  - `check --yes` as `{ kind: "check", yes: true }`
- reject every other trailing argument combination for `check`

In `src/cli/commands.ts`:

- update the help screen so `check` appears in the Maintenance section before `update`
- keep `update` as a separate execution command

- [ ] **Step 4: Re-run the focused parsing tests and verify they pass**

Run:

```bash
bun test tests/cli/args.test.ts tests/cli/output.test.ts tests/cli/commands.test.ts
```

Expected: PASS for parsing and help-surface expectations.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts src/cli/commands.ts
git add tests/cli/args.test.ts tests/cli/output.test.ts tests/cli/commands.test.ts
git commit -m "feat(cli): add check command surface"
```

## Task 2: Create A Dedicated Update Service

**Files:**
- Create: `src/cli/update-service.ts`
- Create: `tests/cli/update-service.test.ts`
- Modify: `src/package-metadata.ts`

- [ ] **Step 1: Write the failing update-service unit tests**

Create `tests/cli/update-service.test.ts` covering:

- installed-version reads from an arbitrary package directory on disk, not from `readPackageMetadata()` cache
- npm install-source detection from canonical global package paths such as:
  - `/Users/example/.nvm/versions/node/v22.17.0/lib/node_modules/code-helm`
  - `/opt/homebrew/lib/node_modules/code-helm`
- Bun install-source detection from canonical Bun global paths such as:
  - `/Users/example/.bun/install/global/node_modules/code-helm`
  - `/Users/example/.bun/bin/code-helm` resolving back to the global package directory
- `unknown` detection when the resolved path shape does not match npm or Bun conventions
- latest-version lookup from the npm registry JSON response
- targeted failure when the registry response is invalid
- install command preview generation for:
  - npm: `npm install -g code-helm@latest`
  - Bun: `bun add -g code-helm@latest`

Use a pure type shape like:

```ts
expect(result).toEqual({
  installedVersion: "0.2.0",
  latestVersion: "0.2.1",
  packageManager: {
    kind: "npm",
    command: ["npm", "install", "-g", "code-helm@latest"],
  },
  updateAvailable: true,
});
```

- [ ] **Step 2: Run the focused update-service tests and verify they fail**

Run:

```bash
bun test tests/cli/update-service.test.ts
```

Expected: FAIL because `src/cli/update-service.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal update-service module**

Create `src/cli/update-service.ts` with focused helpers such as:

```ts
export type InstallSourceKind = "npm" | "bun" | "unknown";

export type PackageManagerResolution = {
  kind: InstallSourceKind;
  command: string[] | undefined;
  executableName?: "npm" | "bun";
  packageRoot?: string;
  executablePath?: string;
};

export type UpdateCheckResult = {
  installedVersion: string;
  latestVersion: string;
  packageManager: PackageManagerResolution;
  updateAvailable: boolean;
};
```

Implement helpers with injected dependencies where useful:

- `readInstalledPackageMetadataFromPath(packageRoot)`
- `resolveInstalledPackageManager()`
- `readLatestPublishedVersion()`
- `performPackageUpdate(commandParts, env)`

Implementation rules:

- use direct npm-registry HTTP fetch for latest-version lookup so `check` does not depend on `npm` or `bun` being available
- inspect the installed package directory on disk after update instead of trusting in-process cached metadata
- return `unknown` when source detection is not confident
- keep runtime stop/start logic out of this module

If `src/package-metadata.ts` can cleanly host a helper like `readPackageMetadataFromFile(path)`, add it there and keep the cached current-process reader unchanged.

- [ ] **Step 4: Re-run the focused update-service tests and verify they pass**

Run:

```bash
bun test tests/cli/update-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/update-service.ts src/package-metadata.ts
git add tests/cli/update-service.test.ts
git commit -m "feat(update): add package update service"
```

## Task 3: Implement Non-Interactive `check` And `update`

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Write the failing non-interactive command tests**

Extend `tests/cli/commands.test.ts` to cover:

- `check` when already up to date
- `check` when an update is available in non-TTY mode
- `check --yes` immediately delegating into update execution
- `update` when already on the latest version
- `update` from `0.2.0` to `0.2.1`
- `update` failing before install when install source is `unknown`
- registry check failure
- package-manager executable missing
- install command failure

Use expectations like:

```ts
const result = await runCliCommand({ kind: "check", yes: false }, services);
expect(result.output).toContain("Installed version");
expect(result.output).toContain("Latest version");
expect(result.output).toContain("Up to date");
```

and:

```ts
const result = await runCliCommand({ kind: "update" }, services);
expect(result.output).toContain("Updated from 0.2.0 to 0.2.1");
expect(result.output).toContain("Package manager");
```

- [ ] **Step 2: Run the focused non-interactive command tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because `commands.ts` still only supports the old fixed npm update path.

- [ ] **Step 3: Redesign command orchestration around check/update results**

In `src/cli/commands.ts`:

- replace the old `buildDefaultPackageUpdateCommand()` / `runPackageUpdate()`-only flow with injected update-service seams
- add internal helpers for:
  - rendering check status output
  - rendering no-op update output
  - rendering update success output
  - rendering targeted failure output
- keep `version` local-only and fast
- keep plain `check` free of config/runtime reads until it actually transitions into update execution
- make `check --yes` delegate to the exact same update execution path as `update`

Prefer a split like:

```ts
type CommandServices = {
  readUpdateCheck: () => Promise<UpdateCheckResult>;
  ensurePackageManagerExecutable: (input: PackageManagerResolution) => Promise<void>;
  runPackageUpdate: (command: string[]) => Promise<PackageUpdateResult>;
  // existing runtime/config services...
};
```

If adding `emitOutput` / `confirmUpdate` placeholders now keeps the refactor smaller, leave them as inert stubs in this task and wire the real interactive behavior in Task 4.

Output rules to implement now:

- `check` shows:
  - installed version
  - latest version
  - status
  - package manager
  - update command preview
- `update` explicitly says either:
  - `Already on the latest version`
  - `Updated from X to Y`
- failures name the missing executable or the failed attempted command

- [ ] **Step 4: Re-run the focused non-interactive command tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: PASS for the new non-interactive coverage.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands.ts tests/cli/commands.test.ts
git commit -m "feat(cli): add non-interactive check and update flows"
```

## Task 4: Add Interactive `check` Confirmation Without Losing The Status Output

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `src/cli.ts`
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Write the failing interactive `check` tests**

Extend `tests/cli/commands.test.ts` to cover:

- TTY `check` with update available prompts once
- TTY `check` acceptance emits the check status first, then returns the update result
- TTY `check` decline keeps the original check output visible and returns a clear no-op result
- non-TTY `check` never prompts
- `check --yes` never prompts even in TTY mode

Capture emitted output through a stub so tests can assert that the status screen is printed before confirmation and before the final result.

Use expectations like:

```ts
expect(emittedOutputs[0]).toContain("Installed version");
expect(confirmCalls).toBe(1);
expect(result.output).toContain("Update canceled");
```

- [ ] **Step 2: Run the focused interactive command tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because `runCliCommand()` currently returns a single final output string and has no prompt/output seam.

- [ ] **Step 3: Implement an output sink plus confirmation service**

In `src/cli/commands.ts`:

- add `emitOutput(output: string)` to `CommandServices`
- add `confirmUpdate(input)` to `CommandServices`
- default `emitOutput` should be a no-op for tests and non-CLI callers
- default `confirmUpdate` should return `false` or throw only when the code path reaches it unexpectedly outside TTY
- when `check` is interactive and an update is available:
  - render the check screen
  - send it through `emitOutput(...)`
  - prompt `Update now?`
  - if accepted, delegate to the same update path as `update`
  - if declined, return a no-op output such as `Update canceled. Installed version remains X.`

In `src/cli.ts`:

- pass `emitOutput: (output) => console.log(output)` into `runCliCommand(...)`
- keep the final `result.output` print behavior unchanged for the returned screen

For the default confirmation prompt, use `@clack/prompts.confirm` with copy similar to:

```ts
const confirmed = await confirm({
  message: "Update now?",
  active: "yes",
  inactive: "no",
  initialValue: true,
});
```

- [ ] **Step 4: Re-run the focused interactive command tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: PASS for prompt behavior and emitted-output ordering.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli/commands.ts tests/cli/commands.test.ts
git commit -m "feat(cli): add interactive check confirmation"
```

## Task 5: Make `update` Runtime-Aware For Foreground And Background Processes

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/commands.test.ts`
- Modify: `tests/cli/output.test.ts`

- [ ] **Step 1: Write the failing runtime-aware update tests**

Extend `tests/cli/commands.test.ts` to cover:

- foreground runtime active:
  - package update continues
  - final output warns that the running foreground process is still on the old version
- background runtime active:
  - background runtime is stopped before install
  - successful install restarts via `code-helm start --daemon`
  - final output says the daemon restarted on the new version
- background runtime + install failure:
  - best-effort restart of the previous daemon is attempted
  - output reports whether rollback restart succeeded
- background runtime + restart failure after successful install:
  - package update remains successful
  - final output is warning / partial success with manual recovery steps
- package-manager missing:
  - update fails before any daemon stop happens

Also add or adjust `tests/cli/output.test.ts` assertions for the shared screen shape used by:

- installed/latest version key-value sections
- warning panels with `Try next` steps
- partial-success wording staying readable without box-drawing characters

- [ ] **Step 2: Run the focused runtime-aware tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts tests/cli/output.test.ts
```

Expected: FAIL because `update` still ignores runtime state entirely.

- [ ] **Step 3: Implement runtime-aware update execution**

In `src/cli/commands.ts`:

- only once update execution is actually happening:
  - load the config store
  - read runtime state
- before stopping any background runtime:
  - verify the chosen package-manager executable exists
- if runtime mode is `foreground`:
  - do not stop it
  - include the runtime version mismatch warning in the final output
- if runtime mode is `background`:
  - reuse `stopBackgroundRuntime(...)`
  - perform the install
  - restart with the fresh global CLI command:

```bash
code-helm start --daemon
```

- do not reuse the current process entrypoint or `bun run src/index.ts` for post-update restart
- if install fails after stopping the daemon:
  - attempt a best-effort rollback restart of the previous daemon immediately
  - report whether that recovery succeeded

Prefer extracting focused helpers such as:

```ts
const runUpdateExecution = async (...) => { ... };
const restartBackgroundRuntimeFromPath = async (...) => { ... };
const renderRuntimeAwareUpdateResult = (...) => { ... };
```

When restarting the updated daemon:

- pass `CODE_HELM_CONFIG` and `CODE_HELM_SECRETS`
- run through `spawnBackgroundProcess`
- wait for runtime state to reappear with `waitForBackgroundRuntime`
- surface manual recovery steps if the daemon does not come back

- [ ] **Step 4: Re-run the focused runtime-aware tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts tests/cli/output.test.ts
```

Expected: PASS for foreground warning, background restart, rollback-restart attempt, and package-manager-before-stop ordering.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands.ts tests/cli/commands.test.ts tests/cli/output.test.ts
git commit -m "feat(update): handle running runtimes during update"
```

## Task 6: Refresh Docs And Run Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README for the new command model**

Document:

- `code-helm check`
- `code-helm check --yes`
- `code-helm update`
- that CodeHelm auto-detects npm vs Bun global installs
- that `update` may require a manual restart for a foreground runtime
- that `update` automatically restarts a background daemon when possible
- that `check` can show an available update without making changes

Include concrete examples such as:

```bash
code-helm check
code-helm check --yes
code-helm update
```

- [ ] **Step 2: Run the focused CLI verification suite**

Run:

```bash
bun test tests/cli/update-service.test.ts tests/cli/args.test.ts tests/cli/commands.test.ts tests/cli/output.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 4: Run typechecking**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Check the worktree before handing off**

Run:

```bash
git status --short --branch
```

Expected:

- only the intended implementation changes are present
- unrelated pre-existing files remain untouched unless explicitly included in the task

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(cli): document check and update behavior"
```
