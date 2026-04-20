# CodeHelm CLI Help, Version, Update, and Publish Design

Date: 2026-04-20

## Summary

CodeHelm should expose a complete baseline CLI surface for discovery, version inspection, and self-updating.

This design adds:

- `code-helm help`
- `code-helm version`
- `code-helm update`
- `-h` / `--help`
- `-v` / `--version`
- public GitHub publishing for the repository
- npm publishing for the package

This design keeps the existing panel-oriented CLI language and does not change the behavior of existing operational commands such as `onboard`, `start`, `status`, `stop`, `autostart`, and `uninstall`.

## Problem

### 1. The CLI still lacks basic discovery commands

CodeHelm already has operational commands, but it does not yet provide first-class help and version commands.

That creates friction for:

- first-run users who want a command overview
- support workflows that need to confirm the installed version
- automation or debugging flows that expect `--help` or `--version`

### 2. Update behavior is missing from the product surface

Users currently have no built-in `code-helm update` path.

That means the CLI can describe how to start and manage the runtime, but it cannot upgrade itself from the same surface. This is especially awkward once the tool is published and used as a normal global package.

### 3. GitHub publication alone is not enough for the requested update path

The desired `update` behavior is a real npm global upgrade, not just a printed suggestion and not a GitHub-only install path.

That means the release design must include:

- a public GitHub repository
- an npm-published package

Otherwise `code-helm update` would be designed around a package that does not exist.

## Approaches Considered

### 1. Add explicit commands only

Add `help`, `version`, and `update` as normal commands, but do not support aliases such as `--help` and `--version`.

Benefits:

- smallest parser change
- lowest implementation cost

Drawback:

- weaker CLI ergonomics than users expect

### 2. Add explicit commands plus standard aliases

Recommended.

Add `help`, `version`, and `update`, and also support:

- `-h`
- `--help`
- `-v`
- `--version`

Benefits:

- matches normal CLI expectations
- preserves explicit command names for readability
- easy to document and test

Tradeoff:

- slightly broader parser coverage than the minimum

### 3. Detect installer provenance and support many update backends

Examples:

- npm
- pnpm
- bun
- brew
- git checkout

Benefit:

- strongest theoretical flexibility

Drawbacks:

- no reliable installer provenance exists in the current product
- high risk of guessing wrong
- overbuilt for the requested scope

## Goals

- add discoverable `help`, `version`, and `update` commands
- support common `help` and `version` aliases
- keep user-visible output aligned with the existing CLI panel language
- make `update` execute a real npm global upgrade
- ensure the package metadata supports public GitHub and npm publication
- publish the repository publicly on GitHub
- publish the package to npm so `update` is valid

## Non-Goals

- redesigning existing runtime command semantics
- adding installer-source detection for multiple package managers
- changing `onboard`
- adding machine-readable output modes
- introducing release automation or CI publishing in this design

## Design

### Command Surface

The CLI should support these new entry points:

- `code-helm help`
- `code-helm version`
- `code-helm update`
- `code-helm -h`
- `code-helm --help`
- `code-helm -v`
- `code-helm --version`

The canonical command names remain:

- `help`
- `version`
- `update`

Aliases should be normalized during CLI argument parsing rather than handled later in the command runner.

Parser behavior should stay strict unless explicitly expanded here.

Resolved parser rules:

- bare `code-helm` remains a usage error
- `code-helm help extra` is an error
- `code-helm --help extra` is an error
- `code-helm version extra` is an error
- `code-helm update extra` is an error
- subcommand-specific help such as `code-helm start --help` remains out of scope and continues to be parsed under the current strict argument rules

### Usage Text

The top-level usage string in `src/cli/args.ts` should be expanded to include:

- `help`
- `version`
- `update`

This ensures:

- raw parser failures stay accurate
- top-level error panels inherit the correct usage text automatically

### Static Command Dispatch

`help`, `version`, and `update` are intended to be usable even when the local CodeHelm config is missing or broken.

The current command runner eagerly loads the config store and runtime summary before command dispatch. This design explicitly requires that to change.

`runCliCommand(...)` should dispatch these new static commands before any config-store or runtime-summary work happens.

That prevents hidden machine-state dependencies from leaking into:

- `help`
- `version`
- `update`

### `help`

`help` should render through the shared CLI panel renderer.

It should not depend on local config or runtime state.

Recommended sections:

1. `Overview`
2. `Commands`
3. `Examples`

The command list should describe the stable operator-facing surface:

- onboard
- start
- status
- stop
- autostart enable
- autostart disable
- help
- version
- update
- uninstall

The examples should stay short and practical.

### `version`

`version` should render through the shared CLI panel renderer.

It should not depend on local config or runtime state.

It should read the version from `package.json`, because that is the canonical package version for npm publication.

The implementation must also address the existing duplicate version string in the Codex runtime client metadata so CLI output and the Codex initialize payload cannot drift apart.

This design requires one version source of truth for:

- `code-helm version`
- `initialize.clientInfo.version`

Recommended sections:

1. `Version`
2. `Package`

The output should include at least:

- package name
- package version

### `update`

`update` should be a real mutation command, not just a recommendation printer.

It should execute:

```bash
npm install -g code-helm@latest
```

The command should be interpreted at the command layer and rendered using panels.

`update` should remain a configuration-free command. It should not need a valid local CodeHelm config to run.

#### Runtime semantics

`update` should be allowed even if CodeHelm is currently running.

It should not try to stop, restart, or inspect the current runtime as part of the update path.

The intended semantics are:

- the running process, if any, keeps using the already-started code
- the updated package affects future invocations and future restarts

That keeps `update` simple and avoids coupling package mutation to runtime lifecycle control.

#### Success behavior

On success, `update` should render a success panel titled:

- `CodeHelm Updated`

It should include:

- the update command that ran
- a concise success statement
- a next-step hint such as `code-helm version`

#### Failure behavior

On failure, `update` should fail with a rendered error panel titled:

- `Update Failed`

It should include:

- the npm command that was attempted
- a short interpreted explanation
- diagnostics populated from npm stdout and stderr

The failure should preserve a non-zero CLI exit path by throwing the rendered panel text, the same way existing command-level failures already do.

If `npm` is missing from `PATH` or process launch fails before npm returns an exit code, the command should still render `Update Failed` with a more specific interpreted explanation, for example:

- npm was not found
- CodeHelm could not launch npm

The low-level spawn or path error should still be preserved in diagnostics.

### Testability

The command runner should not execute real global npm updates in unit tests.

`src/cli/commands.ts` should introduce a small injectable update runner on `CommandServices`, similar to the existing service seams already used for process and autostart behavior.

That seam should allow tests to simulate:

- update success
- update failure
- low-level execution failure text

### Package Metadata

`package.json` should be updated for public distribution.

It should include:

- `repository`
- `homepage`
- `bugs`

Those fields should target the public GitHub repository:

- slug: `humeo/code-helm`
- repository URL: `https://github.com/humeo/code-helm`
- homepage: `https://github.com/humeo/code-helm#readme`
- bugs URL: `https://github.com/humeo/code-helm/issues`

It should also ensure published contents are sufficient for runtime execution from npm, especially:

- `bin/`
- `src/`
- `README.md`
- `package.json`

Because the published package executes directly from TypeScript sources and runtime file paths such as `bin/code-helm` and `src/index.ts`, artifact correctness must be validated from the packed npm tarball, not inferred only from source tests.

### Runtime Prerequisites

Publishing to npm does not remove current runtime prerequisites.

The published CLI still depends on:

- Bun at runtime
- Codex for the managed local app server path

Updated help and README copy must preserve that explicitly.

`code-helm update` updates the npm package only. It does not install or upgrade:

- Bun
- Codex

The package name should remain unscoped:

- `code-helm`

That keeps install and update commands simple, provided npm publication succeeds with that name.

### Publication Sequence

The release order should be:

1. complete local implementation
2. verify tests and typechecking
3. create a public GitHub repository named `code-helm`
4. push `main`
5. publish the npm package `code-helm`

### External Risk Boundary

Two external blockers may require surfacing to the user:

1. GitHub repository name unavailability or permission failure
2. npm package name unavailability or publication permission failure

If either occurs, implementation should stop at the external boundary and report the exact blocker, because both would change the release shape or package identity.

## File Impact

### Runtime files

- `src/cli/args.ts`
  Add new command kinds, aliases, and usage text.

- `src/cli/commands.ts`
  Add `help`, `version`, and `update` execution paths plus a test seam for npm update execution.

### Tests

- `tests/cli/args.test.ts`
  Cover new command parsing and alias normalization.

- `tests/cli/commands.test.ts`
  Cover help, version, update success, and update failure.

### Documentation and package metadata

- `README.md`
  Document the new commands and public install/update flow.

- `package.json`
  Add publish-facing metadata and any packaging fields required for npm distribution.

## Testing Strategy

The implementation should verify:

- parser coverage for new commands and aliases
- panel output for help and version
- successful update rendering
- failed update rendering with diagnostics
- full suite compatibility
- clean typechecking

Required commands:

```bash
bun test tests/cli/args.test.ts tests/cli/commands.test.ts
bun test
bun run typecheck
```

Release verification should also include artifact checks before `npm publish`:

```bash
npm pack
```

The artifact verification should do two things:

1. assert that the tarball contains runtime-required files, including at minimum:

- `package/package.json`
- `package/bin/code-helm`
- `package/src/cli.ts`
- `package/src/index.ts`
- `package/src/db/migrate.ts`
- `package/src/db/migrations/001_init.sql`

2. run a local smoke test from the packed tarball, using an isolated temporary prefix, to confirm the published artifact can execute:

- `code-helm help`
- `code-helm version`

The point of this release check is to validate packaged file contents, not just source behavior.

## Open Questions Resolved

- GitHub repository visibility: `public`
- GitHub repository name: `code-helm`
- npm publication scope: unscoped `code-helm`
- `update` behavior: execute a real npm global update
