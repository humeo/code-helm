# CodeHelm CLI Help, Version, Update, and Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `help`, `version`, and `update` to the CodeHelm CLI, publish the package metadata needed for public distribution, and release the project to a public GitHub repo plus npm so `code-helm update` works.

**Architecture:** Extend the existing parser and command runner instead of introducing a parallel CLI path. Keep the new commands configuration-free, render them through the existing panel system, inject the npm update execution behind a `CommandServices` seam for testability, then publish the already-verified package to GitHub and npm.

**Tech Stack:** Bun, TypeScript, bun:test, existing CLI panel renderer, GitHub CLI, npm CLI

---

## File Map

- Create: `src/package-metadata.ts`
  Provide a single package metadata source for CLI version output and Codex initialize client metadata.
- Modify: `src/cli/args.ts`
  Add new command kinds, aliases, and expanded usage text.
- Modify: `src/cli/commands.ts`
  Add help/version/update implementations, package metadata lookup, and an injectable npm update runner.
- Modify: `src/codex/jsonrpc-client.ts`
  Remove the version drift risk by sourcing runtime protocol version metadata from the same package metadata source used by the CLI.
- Modify: `tests/cli/args.test.ts`
  Lock parsing and alias behavior.
- Modify: `tests/cli/output.test.ts`
  Update usage-shaped error expectations to match the expanded top-level usage text.
- Modify: `tests/cli/commands.test.ts`
  Lock help/version rendering and update success/failure behavior.
- Modify: `tests/codex/jsonrpc-client.test.ts`
  Lock the runtime protocol client version against the same source of truth when needed.
- Modify: `README.md`
  Document install, help, version, and update flows.
- Modify: `package.json`
  Add repository metadata and package publishing fields needed for distribution.

## Task 1: Add CLI Parsing For Help, Version, Update, And Aliases

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `tests/cli/args.test.ts`
- Modify: `tests/cli/output.test.ts`

- [ ] **Step 1: Write the failing parser tests**

Extend `tests/cli/args.test.ts` to cover:

- `help`
- `version`
- `update`
- `-h`
- `--help`
- `-v`
- `--version`
- trailing-argument rejection for:
  - `help`
  - `--help`
  - `version`
  - `update`
- bare `code-helm` remaining a usage error
- `code-helm start --help` remaining out of scope under strict parsing

Update `tests/cli/output.test.ts` where the usage-shaped caught-error expectations currently hardcode the old command list.

Use expectations like:

```ts
expect(parseCliArgs(["help"])).toEqual({ kind: "help" });
expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
expect(parseCliArgs(["version"])).toEqual({ kind: "version" });
expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
expect(parseCliArgs(["update"])).toEqual({ kind: "update" });
expect(() => parseCliArgs(["help", "extra"])).toThrow(/Unknown arguments for help/);
expect(() => parseCliArgs(["--help", "extra"])).toThrow(/Unknown arguments for help/);
```

- [ ] **Step 2: Run the focused parser tests and verify they fail**

Run:

```bash
bun test tests/cli/args.test.ts tests/cli/output.test.ts
```

Expected: FAIL because the parser does not yet know about the new commands or aliases, and the old usage text expectations no longer match.

- [ ] **Step 3: Implement the minimal parser changes**

In `src/cli/args.ts`:

- extend `CliCommand` with:
  - `{ kind: "help" }`
  - `{ kind: "version" }`
  - `{ kind: "update" }`
- expand the usage string to include `help|version|update`
- normalize:
  - `-h` and `--help` to `help`
  - `-v` and `--version` to `version`
- reject extra arguments for `help`, `version`, and `update`
- preserve bare invocation as a usage error
- leave subcommand-specific `--help` unsupported for now

- [ ] **Step 4: Re-run the parser tests and verify they pass**

Run:

```bash
bun test tests/cli/args.test.ts tests/cli/output.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/args.ts tests/cli/args.test.ts
git add tests/cli/output.test.ts
git commit -m "feat(cli): add help version and update args"
```

## Task 2: Add Help And Version Command Output

**Files:**
- Create: `src/package-metadata.ts`
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/commands.test.ts`
- Modify: `src/codex/jsonrpc-client.ts`
- Modify: `tests/codex/jsonrpc-client.test.ts`

- [ ] **Step 1: Write the failing help/version command tests**

Extend `tests/cli/commands.test.ts` to cover:

- `help` rendering a panel with:
  - `CodeHelm CLI`
  - `Overview`
  - `Commands`
  - `Examples`
  - the full operator-facing command surface:
    - `code-helm onboard`
    - `code-helm start`
    - `code-helm status`
    - `code-helm stop`
    - `code-helm autostart enable`
    - `code-helm autostart disable`
    - `code-helm help`
    - `code-helm version`
    - `code-helm update`
    - `code-helm uninstall`
- `version` rendering a panel with:
  - `CodeHelm Version`
  - package name
  - package version
- `help` succeeding without touching `loadConfigStore` or `readRuntimeSummary`
- `version` succeeding without touching `loadConfigStore` or `readRuntimeSummary`

Use expectations like:

```ts
const result = await runCliCommand({ kind: "help" }, services);
expect(result.output).toContain("CodeHelm CLI");
expect(result.output).toContain("Commands");
expect(result.output).toContain("code-helm start");
```

and:

```ts
const result = await runCliCommand({ kind: "version" }, services);
expect(result.output).toContain("CodeHelm Version");
expect(result.output).toContain(expectedVersionFromSharedSource);
```

Also extend runtime protocol coverage so version metadata cannot drift. Add or tighten a `tests/codex/jsonrpc-client.test.ts` assertion around the client initialize payload version.

- [ ] **Step 2: Run the focused command tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts tests/codex/jsonrpc-client.test.ts
```

Expected: FAIL because the command runner does not yet implement `help` or `version`.

- [ ] **Step 3: Implement help/version with minimal static command paths**

In `src/cli/commands.ts`:

- refactor `runCliCommand(...)` so `help`, `version`, and later `update` dispatch before eager config-store and runtime-summary loading
- add a shared helper in `src/package-metadata.ts` that reads `package.json` via `import.meta.url`
- add `help` and `version` switch cases
- keep these paths independent from config and runtime state
- render both through the existing panel renderers

In `src/codex/jsonrpc-client.ts`:

- remove the standalone hardcoded package version if present
- source `initialize.clientInfo.version` from the same shared package metadata source used by the CLI

Recommended titles:

- `CodeHelm CLI`
- `CodeHelm Version`

- [ ] **Step 4: Re-run the focused command tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts tests/codex/jsonrpc-client.test.ts
```

Expected: PASS for the new help/version coverage.

- [ ] **Step 5: Commit**

```bash
git add src/package-metadata.ts src/cli/commands.ts src/codex/jsonrpc-client.ts
git add tests/cli/commands.test.ts tests/codex/jsonrpc-client.test.ts
git commit -m "feat(cli): add help and version commands"
```

## Task 3: Add Update Command With Testable npm Execution

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Write the failing update command tests**

Extend `tests/cli/commands.test.ts` to cover:

- the real default update command construction path producing:
  - `npm`
  - `install`
  - `-g`
  - `code-helm@latest`
- successful update rendering a success panel with:
  - `CodeHelm Updated`
  - the npm command
  - a next step such as `code-helm version`
- failed update rejecting with a rendered `Update Failed` panel and diagnostics
- a launch/path failure such as missing `npm` producing explicit interpreted failure copy instead of an unhelpful generic message
- `update` succeeding without touching `loadConfigStore` or `readRuntimeSummary`

Use expectations like:

```ts
const result = await runCliCommand({ kind: "update" }, services);
expect(result.output).toContain("CodeHelm Updated");
expect(result.output).toContain("npm install -g code-helm@latest");
```

and:

```ts
await expect(
  runCliCommand({ kind: "update" }, services),
).rejects.toThrow(/Update Failed/);
```

and:

```ts
await expect(
  runCliCommand({ kind: "update" }, services),
).rejects.toThrow(/npm/i);
```

- [ ] **Step 2: Run the focused command tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because `update` does not exist yet.

- [ ] **Step 3: Add an injectable update runner to `CommandServices`**

In `src/cli/commands.ts`:

- extract a small pure helper for the real default command construction, for example:

```ts
export const buildDefaultPackageUpdateCommand = () => [
  "npm",
  "install",
  "-g",
  "code-helm@latest",
];
```

- extend `CommandServices` with a small update runner, for example:

```ts
runPackageUpdate: () => Promise<{
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}>;
```

- implement the default behavior to run:

```bash
npm install -g code-helm@latest
```

Use a local execution helper so tests can stub success and failure without mutating the machine's global npm state.

The command behavior should explicitly follow the spec:

- `update` is allowed while CodeHelm may already be running
- `update` does not inspect, stop, or restart the runtime
- the updated package affects future invocations and future restarts only
- `update` remains configuration-free and must succeed without config/runtime reads when the injected update runner succeeds

- [ ] **Step 4: Implement the `update` command**

In the `update` switch case:

- call `runPackageUpdate()`
- on success, return a success panel
- on non-zero exit, throw a rendered error panel that includes diagnostics from stderr/stdout/error text
- on launch failure or missing-`npm` errors, throw a rendered `Update Failed` panel with explicit interpreted copy mentioning npm launch/path failure
- keep the failure path non-zero by throwing rather than returning a normal output string

- [ ] **Step 5: Re-run the focused command tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands.ts tests/cli/commands.test.ts
git commit -m "feat(cli): add npm-backed update command"
```

## Task 4: Refresh README And Package Metadata For Public Distribution

**Files:**
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Write the metadata and docs changes**

Update `package.json` with publish-facing fields:

- `description`
- `repository`
- `homepage`
- `bugs`
- `files`

The repository metadata should target:

- `https://github.com/humeo/code-helm`
- `https://github.com/humeo/code-helm#readme`
- `https://github.com/humeo/code-helm/issues`

Ensure published contents still support the installed runtime:

- `bin`
- `src`
- `README.md`
- `package.json`

Update `README.md` to document:

- `code-helm help`
- `code-helm version`
- `code-helm update`
- public npm installation
- npm upgrade flow
- Bun as a runtime prerequisite even after npm publication
- that `code-helm update` updates the npm package only, not Bun or Codex
- replace any machine-local absolute links with repo-safe relative links or GitHub-safe URLs

For `.env.example`, prefer a GitHub/repo-relative documentation link rather than adding it to the npm package allowlist unless runtime behavior truly requires shipping it.

- [ ] **Step 2: Run focused verification for docs-sensitive runtime assumptions**

Run:

```bash
bun test tests/cli/commands.test.ts tests/cli/args.test.ts tests/cli/output.test.ts
```

Expected: PASS. Metadata and docs changes should not break command behavior.

- [ ] **Step 3: Commit**

```bash
git add README.md package.json
git commit -m "docs: document new cli commands and publish metadata"
```

## Task 5: Run Verification, Then Publish To GitHub And npm

**Files:**
- No code files unless verification uncovers a bug

- [ ] **Step 1: Run the focused CLI verification suite**

Run:

```bash
bun test tests/cli/args.test.ts tests/cli/commands.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 3: Run typechecking**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Verify the release worktree is clean**

Run:

```bash
git status --short --branch
```

Expected:

- current branch is the intended release branch
- no uncommitted changes remain

If the worktree is dirty, stop and resolve that before any public push or publish command.

- [ ] **Step 5: Verify external auth prerequisites**

Run:

```bash
gh auth status
npm whoami
```

Expected:

- GitHub auth is active
- npm auth is active for a publisher account

If `npm whoami` fails, stop and surface the auth blocker instead of guessing.

- [ ] **Step 6: Verify the npm artifact before publishing**

Run:

```bash
TARBALL="$(npm pack | tail -n 1)"
echo "$TARBALL"
```

Expected: `TARBALL` is the exact tarball produced for this release run.

Then assert the tarball contains runtime-required files. A concrete pattern is:

```bash
tar -tf "$TARBALL"
```

Expected: the tarball listing includes at least:

- `package/package.json`
- `package/bin/code-helm`
- `package/src/cli.ts`
- `package/src/index.ts`
- `package/src/db/migrate.ts`
- `package/src/db/migrations/001_init.sql`

Also assert the tarball does **not** include local-only or sensitive paths, for example:

- `.env`
- `.git/`
- `.worktrees/`
- coverage artifacts
- other untracked local workspace files

Then install and smoke-test that tarball in an isolated temporary prefix. A concrete pattern is:

```bash
TMP_PREFIX="$(mktemp -d)"
npm install -g --prefix "$TMP_PREFIX" "./$TARBALL"
"$TMP_PREFIX/bin/code-helm" help
"$TMP_PREFIX/bin/code-helm" version
```

Expected:

- installation succeeds
- `help` runs from the packed artifact
- `version` runs from the packed artifact

If the artifact smoke test fails, fix packaging before any public publish step.

- [ ] **Step 7: Create the public GitHub repository**

Run:

```bash
gh repo create code-helm --public --source=. --remote=origin --push
```

Expected: repository `humeo/code-helm` is created and current `main` is pushed.

If the repository name is unavailable, stop and surface the blocker.

- [ ] **Step 8: Publish the npm package**

Run:

```bash
npm publish
```

Expected: package `code-helm` is published successfully.

If npm rejects the unscoped name or publisher permissions, stop and surface the blocker because that changes the package identity and update command target.

- [ ] **Step 9: Spot-check the published version path with a short retry loop**

Run:

```bash
LOCAL_VERSION="$(node -p \"require('./package.json').version\")"
for attempt in 1 2 3 4 5; do
  PUBLISHED_VERSION="$(npm view code-helm version 2>/dev/null || true)"
  [ "$PUBLISHED_VERSION" = "$LOCAL_VERSION" ] && break
  sleep 2
done
printf 'local=%s published=%s\n' "$LOCAL_VERSION" "$PUBLISHED_VERSION"
```

Expected: after a short eventual-consistency window, the registry version matches `LOCAL_VERSION`.

- [ ] **Step 10: Commit a final verification fix only if needed**

If verification uncovered a code or doc issue, fix the smallest thing necessary, rerun the affected commands, then commit:

```bash
git add src/cli/args.ts src/cli/commands.ts tests/cli/args.test.ts tests/cli/commands.test.ts README.md package.json
git commit -m "fix(cli): tighten help version update release polish"
```
