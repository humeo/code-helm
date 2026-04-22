# Update And Check Command Design

Date: 2026-04-22

## Summary

Add a new `code-helm check` command and redesign `code-helm update` so both commands report version state clearly, use the correct package manager for the current installation, and explain what happens when CodeHelm is already running.

The redesigned flow must tell the user:

- the installed version
- the latest published version
- whether an update is available
- which package manager will be used
- whether an update actually happened
- whether a running CodeHelm process is already using the new version

It must also distinguish between:

- the version of the currently running CLI process
- the version currently installed on disk

This distinction matters because `update` may still be executing old code even after the global package files have been replaced.

## Goals

- Introduce `code-helm check` as the decision command for update discovery.
- Make `code-helm update` an execution command that always checks first and then updates immediately.
- Support both npm-installed and Bun-installed global packages.
- Add `check --yes` now so the user can skip the confirmation prompt.
- Handle running CodeHelm instances explicitly:
  - foreground runtime: warn and require manual restart
  - background runtime: stop, update, and restart automatically
- Replace ambiguous update copy such as “installed latest package” with concrete version transition copy.

## Non-Goals

- Do not add downgrade support.
- Do not add release-channel selection such as stable/beta/nightly.
- Do not add package-manager selection prompts during normal command execution.
- Do not auto-restart a foreground runtime started in the current terminal.
- Do not add Homebrew or other package-manager support in this change.

## User Decisions Captured

- Add a dedicated `check` command.
- `check` should prompt the user to continue with the update when a TTY is available.
- Add `check --yes` now.
- `update` should not ask for confirmation; it should check first and then update directly.
- Detect installation source automatically:
  - npm install should update with npm
  - Bun install should update with Bun
- If a background daemon is running, restart it automatically after a successful update.
- If a foreground runtime is running, do not stop it automatically; tell the user it is still on the old version until manually restarted.

## Current State

Today, `code-helm update` only runs a fixed npm command:

```bash
npm install -g code-helm@latest
```

The current success output does not explain:

- what version is installed now
- what version is available remotely
- whether an update actually happened
- whether the running runtime is still on the old version

There is no `check` command yet.

## Command Model

### `code-helm version`

`version` remains a lightweight local-only command.

It should continue to print only the installed CodeHelm version and should not perform registry checks or runtime inspection.

### `code-helm check`

`check` becomes the decision command.

It must:

- read the currently installed version
- read the latest published version from the package registry
- detect the installation source and the command that would be used for update
- render a human-readable status result

The output must include:

- installed version
- latest version
- status:
  - `Up to date`
  - `Update available`
- package manager:
  - `npm`
  - `bun`
  - `unknown`
- update command preview

Behavior by environment:

- TTY and update available:
  - prompt: `Update now?`
- TTY and no update available:
  - render the status only
- non-TTY:
  - render the status only
- `check --yes`:
  - skip the prompt and continue immediately if an update is available

If `check --yes` finds no newer version, it should return a clear no-op result instead of pretending an update occurred.

If `check` prompts and the user declines, it should return a clear no-op result and keep the check output visible.

If `check` continues into an update, either through `--yes` or through an interactive confirmation, it should delegate to the same execution path as `code-helm update` so runtime handling and final output stay consistent.

### `code-helm update`

`update` becomes the execution command.

It must:

1. read the installed version
2. read the latest published version
3. detect the installation source
4. verify the required package-manager executable is available
5. stop the background runtime if one is active
6. perform the package update
7. verify the installed version after update
8. restart the background runtime if one was stopped
9. render the final outcome

`update` does not prompt for confirmation.

If the installed version is already the latest version, the output must explicitly say so and must not run the install command.

If a background runtime was stopped and the install step fails, `update` should make a best-effort attempt to restart the previously installed daemon so the user is not left down unnecessarily.

## Installation Source Detection

Add a lightweight update service that detects how CodeHelm is installed.

Preferred detection order:

1. inspect the resolved `code-helm` executable path
2. inspect the resolved global package directory that executable points at
3. match the path shape against npm or Bun global installation conventions
4. if no confident match exists, return `unknown`

The update service must return:

- `kind: "npm" | "bun" | "unknown"`
- the update command preview

Expected commands:

- npm:

```bash
npm install -g code-helm@latest
```

- Bun:

```bash
bun add -g code-helm@latest
```

If the source is `unknown`, command execution should fail with a targeted error explaining that CodeHelm could not determine whether the current global installation is managed by npm or Bun.

Installed-version reads used by `check` and post-update verification must resolve package metadata from the installed global package on disk, not from the currently running process bundle.

## Runtime-Aware Update Behavior

Before running the update command, inspect runtime state the same way `status` and `stop` already do.

### No runtime active

- update directly
- report version transition

### Foreground runtime active

- do not stop it automatically
- continue with package update
- final output must say:
  - package files were updated
  - the active foreground runtime is still on the old version
  - the user must restart it manually

Example result direction:

- `Updated from 0.2.0 to 0.2.1.`
- `A foreground CodeHelm runtime is still running 0.2.0. Restart it manually to use 0.2.1.`

### Background runtime active

- stop background runtime first
- run the update
- restart the daemon after a successful update

If the install step fails after the daemon was stopped:

- make a best-effort attempt to restart the previous daemon immediately
- report whether recovery succeeded
- include manual recovery instructions if the restart attempt also fails

If restart succeeds:

- report that the background daemon was restarted and now uses the new version

If restart fails:

- keep the package update as a success
- downgrade the overall runtime result to warning / partial success
- tell the user exactly how to recover manually

Example result direction:

- `Updated from 0.2.0 to 0.2.1.`
- `Background daemon restart failed. Run code-helm start --daemon to start 0.2.1.`

## Restart Strategy

After a successful package update, do not reuse a cached path to the old CLI entrypoint when restarting a background daemon.

Instead, restart through the freshly resolved global `code-helm` command on PATH:

```bash
code-helm start --daemon
```

Why:

- the updating process may itself still be running old code
- restarting through a cached old entrypoint risks relaunching the wrong version
- using the global command path after install aligns restart behavior with what the user would run manually

## Version Source Rules

`code-helm update` must not trust `packageMetadata.version` or any other version constant already loaded into the current process when deciding whether the update succeeded.

Instead:

- pre-update installed version should come from the resolved installed package on disk
- post-update installed version should be re-read from disk after the install command finishes
- runtime messaging should distinguish:
  - CLI process version currently executing this command
  - installed package version now present on disk
  - runtime version currently used by a foreground or background process

This avoids false results where the updater says it is still on the old version only because the updater itself was launched before the global package changed.

## Internal Structure

Introduce a new lightweight module:

- `src/cli/update-service.ts`

Recommended responsibilities:

- `readInstalledPackageMetadata()`
- `resolveInstalledPackageManager()`
- `readLatestPublishedVersion()`
- `performPackageUpdate()`

This module should remain CLI-focused and avoid owning broader runtime semantics beyond what update/check need.

### Shared Data Model

Split version/update state into two stages instead of one flat install result.

#### Check Result

Must include:

- installed version
- latest version
- package manager kind
- update command preview
- update available boolean

#### Update Result

Must include:

- command attempted
- before version
- after version
- changed boolean
- runtime action:
  - `none`
  - `foreground-warning`
  - `background-restarted`
  - `background-restart-failed`

This separation prevents command output from guessing whether an update happened based only on the installer exit code.

## Error Handling

Use distinct user-facing failure families instead of collapsing everything into one generic update failure.

### Registry Check Failed

Examples:

- registry unavailable
- invalid registry response
- version parse failure

Behavior:

- `check` fails with “could not determine the latest published version”
- `update` also fails before install begins

### Package Manager Unavailable

Examples:

- npm missing from PATH
- Bun missing from PATH

Behavior:

- explicitly name the missing executable
- explicitly report the detected installation source
- do not stop an already running background daemon before surfacing this failure

### Install Command Failed

Examples:

- permissions failure
- package resolution failure
- network error during install

Behavior:

- report attempted command
- report diagnostics
- suggest a concrete retry path
- if a background daemon was stopped before install, report whether rollback restart of the previous daemon succeeded

### Runtime Restart Failed After Successful Update

Behavior:

- keep the package update result as successful
- render warning / partial-success output
- tell the user how to restart manually

## Output Rules

All success results must answer these four questions:

1. What version was installed before?
2. What version is published now?
3. Did this command actually change the installed version?
4. Is the running CodeHelm runtime already using the new version?

### Copy Rules

- Do not use ambiguous copy such as “installed latest package”.
- Do not blur check results and update results together.
- Do not hide runtime mismatch after update.
- Prefer direct language:
  - `Installed version`
  - `Latest version`
  - `Updated from X to Y`
  - `Already on the latest version`
  - `Foreground runtime still uses X`
  - `Background daemon restarted on Y`

## CLI Surface Changes

### Argument Parsing

Extend `src/cli/args.ts` to support:

- `check`
- `check --yes`

`update` remains non-interactive and should keep rejecting unexpected arguments in this change.

### Help Output

Update `help` so the command overview includes:

- `check`
- a description such as `Check whether a newer version is available`

`update` description should emphasize execution, not discovery. For example:

- `update` — `Install the latest published package`

## Testing Strategy

### `tests/cli/args.test.ts`

Add coverage for:

- `check`
- `check --yes`
- invalid `check` arguments

### `tests/cli/commands.test.ts`

Add or update coverage for:

- `check` with no update available
- `check` with update available
- `check --yes` updating immediately
- `check` in non-TTY mode skipping confirmation
- `update` when already latest
- `update` from X to Y
- update command selection for npm installs
- update command selection for Bun installs
- `unknown` install source failure
- registry check failure
- missing package manager executable
- install command failure
- foreground runtime warning after update
- background runtime stop → update → restart
- background restart failure after successful update

### `tests/cli/output.test.ts`

Lock output structure for:

- version comparison readability
- clear no-op copy when already latest
- clear transition copy when updated
- partial-success warning structure after successful update + failed restart

## Documentation Impact

After implementation, update:

- `README.md`
- help text snapshots / expectations
- any release or operator docs that mention `update`

The README should explain:

- `check`
- `check --yes`
- `update`
- the fact that a foreground runtime may need manual restart after update
- the fact that a background daemon is restarted automatically after update

## Open Constraints To Preserve

- keep `version` local-only and fast
- keep `update` usable in non-interactive shells
- avoid introducing hidden package-manager prompts
- do not make update behavior depend on configuration loading unless runtime inspection is actually needed
