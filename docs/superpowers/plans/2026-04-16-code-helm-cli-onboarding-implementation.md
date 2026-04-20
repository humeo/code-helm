# CodeHelm CLI Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn CodeHelm into a config-first local CLI product with `onboard`, foreground/background `start`, `status`, `stop`, `autostart`, and `uninstall`, while keeping Discord as the primary session surface and Codex App Server as a managed child process.

**Architecture:** Keep the existing daemon logic in `src/index.ts`, but stop treating environment variables as the user-facing configuration surface. Add a thin CLI layer that owns command parsing, onboarding, stored TOML config/secrets, runtime-state tracking, and managed Codex App Server supervision; adapt that layer into the existing daemon bootstrap with a compatibility bridge so the current Discord/session runtime can survive the transition without a full rewrite.

**Tech Stack:** Bun, TypeScript, bun:test, discord.js, SQLite, Node `fs`/`path`/`os`/`child_process`/`net`, `@clack/prompts`, `@iarna/toml`

---

## Assumptions

- Codex is already installed locally; CodeHelm only detects and launches it.
- The v1 install path still expects Bun on the machine because runtime code depends on Bun APIs such as `bun:sqlite`.
- `codex --remote <ws-url>` is the supported local remote-attach command shown to the user.
- Managed Codex App Server startup uses the real local CLI:
  - `codex app-server --listen ws://127.0.0.1:<port>`
- v1 autostart targets macOS LaunchAgents only. Non-macOS hosts should return a clear `unsupported` result instead of silent partial behavior.

## File Map

- Modify: `package.json`
  Purpose: publish an installable CLI surface, add the global bin entry, add CLI/TOML prompt dependencies, and adjust scripts so local development can exercise the new CLI path.
- Create: `bin/code-helm`
  Purpose: provide the global executable wrapper with a Bun shebang that launches the new CLI entrypoint.
- Create: `src/cli.ts`
  Purpose: top-level CLI entrypoint that parses argv, dispatches commands, and exits with stable codes.
- Create: `src/cli/args.ts`
  Purpose: parse `onboard`, `start`, `start --daemon`, `status`, `stop`, `autostart`, and `uninstall` into a typed command contract.
- Create: `tests/cli/args.test.ts`
  Purpose: lock the command grammar and prevent accidental CLI drift.
- Create: `src/cli/paths.ts`
  Purpose: centralize default config, secrets, database, and runtime-state paths.
- Create: `src/cli/config-store.ts`
  Purpose: read and write `config.toml` and `secrets.toml`, apply `CODE_HELM_*` overrides, and expose edit-mode defaults for onboarding.
- Modify: `src/config.ts`
  Purpose: keep the daemon-facing `AppConfig` shape, but build it from stored config/secrets plus derived compatibility values instead of raw user env.
- Modify: `tests/config.test.ts`
  Purpose: replace env-first assumptions with config/secrets/override loading behavior and the daemon-compatibility bridge.
- Create: `src/cli/runtime-state.ts`
  Purpose: enforce single-instance locking, manage `runtime.json`, detect stale state, and support `status`/`stop`.
- Create: `tests/cli/runtime-state.test.ts`
  Purpose: verify lock acquisition, stale cleanup, runtime summary reads/writes, and single-instance semantics.
- Create: `src/codex/supervisor.ts`
  Purpose: detect the local `codex` binary, allocate a loopback websocket port, spawn `codex app-server`, and shut it down with CodeHelm.
- Create: `tests/codex/supervisor.test.ts`
  Purpose: lock Codex detection, spawn argument construction, port/address recording, and shutdown behavior.
- Create: `src/cli/discord-discovery.ts`
  Purpose: validate the bot token and discover selectable guilds/control channels for onboarding without booting the full daemon runtime.
- Create: `src/cli/onboard.ts`
  Purpose: implement the onboarding/edit-mode TUI and persist selected configuration.
- Create: `tests/cli/onboard.test.ts`
  Purpose: cover first-run onboarding, edit mode, invalid token handling, empty guild/channel states, and the “already running” short-circuit.
- Create: `src/cli/autostart.ts`
  Purpose: implement `autostart enable|disable` with macOS LaunchAgent support and unsupported-platform behavior elsewhere.
- Create: `tests/cli/autostart.test.ts`
  Purpose: lock LaunchAgent path/rendering plus unsupported-platform outcomes.
- Create: `src/cli/commands.ts`
  Purpose: orchestrate `start`, `status`, `stop`, `uninstall`, and `autostart` around config, runtime state, the managed supervisor, and the existing daemon bootstrap.
- Create: `tests/cli/commands.test.ts`
  Purpose: verify the top-level command behaviors, startup output, already-running behavior, and uninstall cleanup flow.
- Modify: `src/index.ts`
  Purpose: consume resolved daemon config instead of env-first config only, expose a daemon bootstrap that the CLI can call, and preserve existing Discord/session behavior.
- Modify: `tests/index.test.ts`
  Purpose: keep existing daemon behavior covered after the bootstrap signature changes.
- Modify: `README.md`
  Purpose: document the new CLI-first onboarding/start/status flow and remove `.env` as the primary user path.
- Modify: `.env.example`
  Purpose: demote legacy env-driven startup to a dev/override aid rather than the normal install path.

## Task 1: Scaffold The Installable CLI Surface

**Files:**
- Modify: `package.json`
- Create: `bin/code-helm`
- Create: `src/cli.ts`
- Create: `src/cli/args.ts`
- Test: `tests/cli/args.test.ts`

- [ ] **Step 1: Write the failing CLI grammar tests**

Create `tests/cli/args.test.ts` that locks the supported command surface:

```ts
expect(parseCliArgs(["onboard"])).toEqual({ kind: "onboard" });
expect(parseCliArgs(["start"])).toEqual({ kind: "start", daemon: false });
expect(parseCliArgs(["start", "--daemon"])).toEqual({ kind: "start", daemon: true });
expect(parseCliArgs(["status"])).toEqual({ kind: "status" });
expect(parseCliArgs(["stop"])).toEqual({ kind: "stop" });
expect(parseCliArgs(["autostart", "enable"])).toEqual({ kind: "autostart", action: "enable" });
expect(parseCliArgs(["uninstall"])).toEqual({ kind: "uninstall" });
```

Also assert that unknown commands fail with a short usage error instead of silently falling through.

- [ ] **Step 2: Run the focused parser tests and verify they fail**

Run:

```bash
bun test tests/cli/args.test.ts
```

Expected: FAIL because the CLI parser and entrypoint do not exist yet.

- [ ] **Step 3: Implement the typed parser**

Create `src/cli/args.ts` with a small explicit parser:

```ts
export type CliCommand =
  | { kind: "onboard" }
  | { kind: "start"; daemon: boolean }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "autostart"; action: "enable" | "disable" }
  | { kind: "uninstall" };

export const parseCliArgs = (argv: string[]): CliCommand => { ... };
```

Keep this hand-written; do not add a full command framework for six commands.

- [ ] **Step 4: Add the new CLI entrypoint**

Create `src/cli.ts` that:

- calls `parseCliArgs(process.argv.slice(2))`
- dispatches into a placeholder command runner
- prints parser errors to stderr
- exits non-zero on invalid usage

The first pass can temporarily throw `"not implemented"` for command bodies; the goal here is to establish the CLI shell.

- [ ] **Step 5: Add the global executable wrapper**

Create `bin/code-helm`:

```ts
#!/usr/bin/env bun
import "../src/cli.ts";
```

Keep it tiny so all logic remains testable in TypeScript modules.

- [ ] **Step 6: Update package metadata for global install**

Modify `package.json` to:

- remove `"private": true`
- add a `bin` entry for `code-helm`
- add dependencies:
  - `@clack/prompts`
  - `@iarna/toml`
- keep Bun as the runtime expectation
- adjust local scripts so development can use the new CLI, for example:

```json
{
  "scripts": {
    "dev": "bun run src/cli.ts start",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 7: Re-run the focused parser tests and verify they pass**

Run:

```bash
bun test tests/cli/args.test.ts
```

Expected: PASS. The CLI grammar should now be locked before any runtime behavior is added.

- [ ] **Step 8: Commit**

```bash
git add package.json bin/code-helm src/cli.ts src/cli/args.ts tests/cli/args.test.ts
git commit -m "feat(cli): add command entrypoint scaffold"
```

## Task 2: Add TOML Config, Secrets, And Path Defaults

**Files:**
- Create: `src/cli/paths.ts`
- Create: `src/cli/config-store.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Test: `tests/cli/config-store.test.ts`

- [ ] **Step 1: Write the failing config-store tests**

Create `tests/cli/config-store.test.ts` covering:

- default path expansion for:
  - `~/.config/code-helm/config.toml`
  - `~/.config/code-helm/secrets.toml`
  - `~/.local/share/code-helm/codehelm.sqlite`
  - `~/.local/state/code-helm/`
- saving and loading `config.toml`
- saving and loading `secrets.toml`
- applying `CODE_HELM_CONFIG`, `CODE_HELM_SECRETS`, and `CODE_HELM_DISCORD_BOT_TOKEN`
- edit-mode reads when files already exist

Use assertions like:

```ts
expect(loadStoredConfig(fs, env).discord.guildId).toBe("guild-1");
expect(loadStoredSecrets(fs, env).discord.botToken).toBe("bot-token");
```

- [ ] **Step 2: Rewrite the existing daemon-config tests first**

Update `tests/config.test.ts` so it covers the new daemon-facing adapter instead of raw env parsing.

The new tests should verify:

- a stored config + stored secrets pair can build an `AppConfig`
- `CODE_HELM_*` overrides win over stored files
- the daemon compatibility bridge still provides internal values required by the current runtime

Specifically, assert that:

- `discord.guildId`
- `discord.controlChannelId`
- `discord.botToken`
- `codex.appServerUrl`
- `databasePath`

all materialize correctly from the new config sources.

- [ ] **Step 3: Run the focused config tests and verify they fail**

Run:

```bash
bun test tests/cli/config-store.test.ts tests/config.test.ts
```

Expected: FAIL because no TOML config loader or compatibility bridge exists yet.

- [ ] **Step 4: Implement default path helpers**

Create `src/cli/paths.ts` with helpers such as:

```ts
export type CodeHelmPaths = {
  configPath: string;
  secretsPath: string;
  databasePath: string;
  stateDir: string;
};

export const resolveDefaultCodeHelmPaths = (...) => ({ ... });
```

Centralize path expansion there; do not duplicate `~` handling across commands.

- [ ] **Step 5: Implement TOML config/secrets persistence**

Create `src/cli/config-store.ts` with focused read/write APIs such as:

```ts
export type StoredConfig = {
  discord: { guildId: string; controlChannelId: string };
  codex: { appServerMode: "managed" };
  database: { path: string };
};

export type StoredSecrets = {
  discord: { botToken: string };
};

export const loadStoredConfig = (...) => ({ ... });
export const saveStoredConfig = (...) => { ... };
export const loadStoredSecrets = (...) => ({ ... });
export const saveStoredSecrets = (...) => { ... };
```

Persist TOML using `@iarna/toml`.

- [ ] **Step 6: Adapt daemon config loading**

Modify `src/config.ts` so the daemon-facing `AppConfig` can be built from the stored config/secrets pair plus overrides.

Keep the current daemon shape for now, but hide legacy compatibility inside the adapter:

- derive `DISCORD_APP_ID` internally from the validated token or bot identity metadata captured during onboarding/startup
- synthesize internal workspace compatibility placeholders until the later workspace cleanup runs

Do not re-expose workspace fields to the user-facing config.

- [ ] **Step 7: Re-run the focused config tests and verify they pass**

Run:

```bash
bun test tests/cli/config-store.test.ts tests/config.test.ts
```

Expected: PASS. Config should now be file-first, with env as override only.

- [ ] **Step 8: Commit**

```bash
git add src/cli/paths.ts src/cli/config-store.ts src/config.ts tests/cli/config-store.test.ts tests/config.test.ts
git commit -m "feat(cli): add toml config and secrets storage"
```

## Task 3: Add Single-Instance Runtime State

**Files:**
- Create: `src/cli/runtime-state.ts`
- Test: `tests/cli/runtime-state.test.ts`

- [ ] **Step 1: Write the failing runtime-state tests**

Create `tests/cli/runtime-state.test.ts` covering:

- acquiring a fresh instance lock
- rejecting a second active lock
- cleaning stale state when the pid no longer exists
- writing and reading `runtime.json`
- best-effort cleanup when `runtime.json` is corrupt

Use a runtime summary contract like:

```ts
expect(readRuntimeState(fs, paths)).toMatchObject({
  pid: 1234,
  mode: "foreground",
  discord: { guildId: "guild-1" },
  codex: { appServerAddress: "ws://127.0.0.1:4500" },
});
```

- [ ] **Step 2: Run the focused runtime-state tests and verify they fail**

Run:

```bash
bun test tests/cli/runtime-state.test.ts
```

Expected: FAIL because no runtime-state module exists yet.

- [ ] **Step 3: Implement the lock and runtime summary helpers**

Create `src/cli/runtime-state.ts` with a small surface such as:

```ts
export type RuntimeSummary = { ... };

export const acquireInstanceLock = (...) => { ... };
export const releaseInstanceLock = (...) => { ... };
export const readRuntimeSummary = (...) => { ... };
export const writeRuntimeSummary = (...) => { ... };
export const clearRuntimeState = (...) => { ... };
```

Keep the model intentionally small:

- `instance.lock`
- `runtime.json`

No extra runtime files in v1.

- [ ] **Step 4: Make stale-state detection explicit**

Implement lightweight pid liveness checks so:

- `status` can report `stopped` when state is stale
- `start` can clean stale state before taking the lock
- `stop` can turn a stale background instance into `not running`

Keep the stale cleanup best-effort and predictable; do not silently mask real active conflicts.

- [ ] **Step 5: Re-run the focused runtime-state tests and verify they pass**

Run:

```bash
bun test tests/cli/runtime-state.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/runtime-state.ts tests/cli/runtime-state.test.ts
git commit -m "feat(cli): add runtime state tracking"
```

## Task 4: Add Managed Codex App Server Supervision

**Files:**
- Create: `src/codex/supervisor.ts`
- Test: `tests/codex/supervisor.test.ts`

- [ ] **Step 1: Write the failing supervisor tests**

Create `tests/codex/supervisor.test.ts` that locks:

- detection failure when `codex` is missing
- construction of the managed startup command using the real CLI:
  - `codex app-server --listen ws://127.0.0.1:<port>`
- recording the loopback websocket address that will be shown to users
- graceful shutdown of the child process

Mock `spawn` and port allocation rather than starting real Codex in unit tests.

- [ ] **Step 2: Run the focused supervisor tests and verify they fail**

Run:

```bash
bun test tests/codex/supervisor.test.ts
```

Expected: FAIL because the supervisor module does not exist yet.

- [ ] **Step 3: Implement Codex detection**

In `src/codex/supervisor.ts`, add a detection helper:

```ts
export const detectCodexBinary = async (...) => { ... };
```

Use `which codex` or equivalent platform-aware resolution and produce a short structured error if unavailable.

- [ ] **Step 4: Implement managed app-server startup**

Add a startup helper that:

- finds an available loopback port using `node:net`
- constructs the address `ws://127.0.0.1:<port>`
- spawns:

```bash
codex app-server --listen ws://127.0.0.1:<port>
```

- returns:
  - child pid
  - chosen address
  - a handle for later shutdown

Do not hardcode `4500`; choose a free loopback port per run.

- [ ] **Step 5: Implement graceful shutdown**

Add shutdown helpers that:

- send a normal termination signal first
- await process exit
- return a clear failure if the process does not stop cleanly

Do not add force-kill escalation in v1.

- [ ] **Step 6: Re-run the focused supervisor tests and verify they pass**

Run:

```bash
bun test tests/codex/supervisor.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/codex/supervisor.ts tests/codex/supervisor.test.ts
git commit -m "feat(codex): add managed app server supervisor"
```

## Task 5: Build The Onboarding And Discovery Flow

**Files:**
- Create: `src/cli/discord-discovery.ts`
- Create: `src/cli/onboard.ts`
- Test: `tests/cli/onboard.test.ts`

- [ ] **Step 1: Write the failing onboarding tests**

Create `tests/cli/onboard.test.ts` covering:

- first-run onboarding saves config + secrets
- token validation failure keeps the flow on the token step
- no guilds returns a helpful blocking error
- no valid text channels returns a helpful blocking error
- existing config enters edit mode with existing values preloaded
- already-running short-circuits before the TUI opens

Use a TUI driver abstraction so unit tests can simulate user choices without real terminal IO.

- [ ] **Step 2: Run the focused onboarding tests and verify they fail**

Run:

```bash
bun test tests/cli/onboard.test.ts
```

Expected: FAIL because onboarding and Discord discovery do not exist yet.

- [ ] **Step 3: Implement Discord discovery helpers**

Create `src/cli/discord-discovery.ts` with focused functions such as:

```ts
export const validateBotToken = async (...) => ({ botUser, application });
export const listSelectableGuilds = async (...) => [...];
export const listSelectableControlChannels = async (...) => [...];
```

Use `discord.js` primitives or Discord REST in a way that keeps the full daemon runtime out of onboarding.

- [ ] **Step 4: Implement the onboarding TUI**

Create `src/cli/onboard.ts` that drives the exact flow from the spec:

- welcome
- bot token
- guild select
- control channel select
- review
- finish

Persist only:

- `discord.guild_id`
- `discord.control_channel_id`
- hidden managed Codex mode
- default database path
- `discord.bot_token` in `secrets.toml`

Do not expose app-server mode, config paths, or database paths as editable user inputs.

- [ ] **Step 5: Add edit-mode behavior**

If config exists and no instance is running:

- preload existing guild/channel selections
- do not echo the full token back
- show token as already configured unless the user explicitly replaces it

- [ ] **Step 6: Re-run the focused onboarding tests and verify they pass**

Run:

```bash
bun test tests/cli/onboard.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/discord-discovery.ts src/cli/onboard.ts tests/cli/onboard.test.ts
git commit -m "feat(cli): add onboarding flow"
```

## Task 6: Integrate Start, Status, Stop, And Uninstall Around The Existing Daemon

**Files:**
- Create: `src/cli/commands.ts`
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`
- Test: `tests/cli/commands.test.ts`

- [ ] **Step 1: Write the failing system-command tests**

Create `tests/cli/commands.test.ts` to lock:

- `start` auto-enters onboarding when config is missing
- `start` returns current status instead of launching a second instance
- `start --daemon` records background runtime state
- `status` prints the concise summary including:
  - app-server address
  - `codex --remote <ws-url>`
- `stop` shuts down the background daemon and its managed app server
- `uninstall` clears config, secrets, db, and runtime state without confirmation

- [ ] **Step 2: Run the focused command tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because the command orchestrator does not exist yet.

- [ ] **Step 3: Refactor daemon bootstrap for CLI control**

Modify `src/index.ts` so the daemon bootstrap can be called with resolved config instead of only `process.env`.

Recommended direction:

```ts
export const startCodeHelm = async (config: AppConfig, options?: StartOptions) => { ... };
export const loadAndStartCodeHelmFromProcess = async () => { ... };
```

Keep the existing daemon internals intact as much as possible; this task is about bootstrap boundaries, not a full runtime rewrite.

- [ ] **Step 4: Implement the command orchestrator**

Create `src/cli/commands.ts` that:

- loads config/secrets
- checks runtime state
- runs onboarding when needed
- starts the managed Codex supervisor
- starts the daemon
- renders concise status output
- stops the background daemon
- performs uninstall cleanup

Render startup/status output in a reusable formatter so `start`, `status`, and “already running” all share one concise summary shape.

- [ ] **Step 5: Make daemon mode explicit**

Implement background mode by spawning a detached child process that runs the daemon bootstrap through Bun.

The daemon child should:

- inherit the resolved config/secrets paths through `CODE_HELM_CONFIG` / `CODE_HELM_SECRETS`
- write `runtime.json`
- own the managed app server lifecycle

Foreground mode should call the bootstrap inline and reuse the same startup/status formatter.

- [ ] **Step 6: Preserve existing daemon behavior**

Update `tests/index.test.ts` only where needed so:

- Discord/session runtime behavior stays covered
- the bootstrap signature change does not regress the current managed session logic

- [ ] **Step 7: Re-run the focused command and daemon tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts tests/index.test.ts
```

Expected: PASS. New CLI behavior should exist without breaking the current daemon/session contract.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands.ts src/index.ts tests/cli/commands.test.ts tests/index.test.ts
git commit -m "feat(cli): add system command orchestration"
```

## Task 7: Add Autostart And Finish The User-Facing Documentation

**Files:**
- Create: `src/cli/autostart.ts`
- Test: `tests/cli/autostart.test.ts`
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Write the failing autostart tests**

Create `tests/cli/autostart.test.ts` that locks:

- macOS LaunchAgent plist rendering
- `enable` writes the LaunchAgent file with the correct command
- `disable` removes it
- non-macOS returns a clear unsupported result

- [ ] **Step 2: Run the focused autostart tests and verify they fail**

Run:

```bash
bun test tests/cli/autostart.test.ts
```

Expected: FAIL because autostart support does not exist yet.

- [ ] **Step 3: Implement the autostart helpers**

Create `src/cli/autostart.ts` with functions such as:

```ts
export const enableAutostart = async (...) => { ... };
export const disableAutostart = async (...) => { ... };
```

On macOS, generate a LaunchAgent that starts CodeHelm in daemon mode.
On unsupported platforms, return a structured unsupported error instead of silent noop behavior.

- [ ] **Step 4: Update the README**

Rewrite the README so the primary user path becomes:

1. install CodeHelm
2. run `code-helm onboard`
3. run `code-helm start`
4. connect Codex with `codex --remote <ws-url>`
5. use Discord slash commands

Move `.env` and legacy workspace discussion out of the main path.

- [ ] **Step 5: Update `.env.example`**

Demote it from the primary setup contract to a developer override example.

Keep only `CODE_HELM_*` examples that still make sense as overrides, and clearly mark the file as advanced/dev-only.

- [ ] **Step 6: Re-run the focused autostart tests and the full suite**

Run:

```bash
bun test tests/cli/autostart.test.ts
bun test
bun run typecheck
```

Expected:

- autostart tests pass
- full test suite passes
- typecheck passes

- [ ] **Step 7: Commit**

```bash
git add src/cli/autostart.ts tests/cli/autostart.test.ts README.md .env.example
git commit -m "feat(cli): add autostart and docs refresh"
```

## Final Verification Checklist

- [ ] Global bin entry exists and runs through Bun
- [ ] `code-helm onboard` works on a clean machine profile
- [ ] `code-helm start` auto-onboards when unconfigured
- [ ] `code-helm start --daemon` works and records runtime state
- [ ] `code-helm status` always includes the app-server address and `codex --remote <ws-url>`
- [ ] `code-helm stop` stops the background instance and the managed app server
- [ ] `code-helm uninstall` removes local CodeHelm resources without confirmation
- [ ] `code-helm autostart enable|disable` works on macOS and fails clearly elsewhere
- [ ] Existing Discord managed-session behavior still passes the full test suite
