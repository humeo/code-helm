# Managed App Server Fixed Port Design

## Summary

CodeHelm should stop assigning a different managed Codex App Server port on each startup. The normal managed app-server address should be stable at `ws://127.0.0.1:4200`, with a `code-helm start --port <port>` override for users who need a different port on a specific run.

## Context

The current managed startup path allocates an ephemeral loopback port with `server.listen(0)` in `src/codex/supervisor.ts`, then launches:

```text
codex app-server --listen ws://127.0.0.1:<allocated-port>
```

That makes each CodeHelm startup print a different remote URL. This is awkward for users who want a stable command, shell helper, browser bookmark, or copied Discord instruction.

Existing docs already use `ws://127.0.0.1:4200` as a startup-feedback example, so `4200` is a natural default.

## Goals

- Make the default managed Codex App Server address stable.
- Keep the normal startup command simple: `code-helm start`.
- Let users choose a different startup port when `4200` is unavailable or undesirable.
- Fail clearly when the chosen port cannot be used.
- Preserve the existing single managed app-server process model.

## Non-Goals

- Do not add persistent port configuration to `config.toml`.
- Do not add multi-instance support.
- Do not automatically fall back to a random port after a conflict.
- Do not change Codex itself.
- Do not change the `codex --remote ... -C "$(pwd)"` connect-command shape beyond the address.

## CLI Contract

`code-helm start` uses port `4200`.

```text
code-helm start
```

`code-helm start --daemon` also uses port `4200`.

```text
code-helm start --daemon
```

Users can override the port for this run:

```text
code-helm start --port 4201
code-helm start --daemon --port 4201
code-helm start --port 4201 --daemon
```

The override is runtime-only. It does not modify onboarding output, stored config, secrets, or autostart configuration.

The override applies only to CodeHelm's managed Codex App Server. If a user has explicitly set `CODE_HELM_CODEX_APP_SERVER_URL`, CodeHelm is using an external app-server address and does not start the managed server. In that case, an explicit `--port` should be rejected with a clear message instead of being silently ignored.

The parser should reject invalid values before startup begins:

- missing value: `code-helm start --port`
- non-integer value: `code-helm start --port abc`
- out-of-range value: lower than `1` or greater than `65535`
- unknown extra arguments

## Runtime Design

Add a shared default in the managed app-server module, next to the address-building logic:

```ts
export const DEFAULT_MANAGED_CODEX_APP_SERVER_PORT = 4200;
```

Also provide one small helper so onboarding, help/status tests, and runtime startup do not duplicate string construction:

```ts
export const formatManagedCodexAppServerAddress = (port: number) =>
  `ws://127.0.0.1:${port}`;
```

`startManagedCodexAppServer` should accept an optional `port`:

```ts
export type StartManagedCodexAppServerOptions = {
  cwd?: string;
  port?: number;
  resolveBinary?: ResolveBinary;
  spawnProcess?: SpawnProcess;
  waitForReady?: WaitForReady;
};
```

If `port` is omitted, use `DEFAULT_MANAGED_CODEX_APP_SERVER_PORT`. Build the managed address directly:

```ts
const port = options.port ?? DEFAULT_MANAGED_CODEX_APP_SERVER_PORT;
const address = formatManagedCodexAppServerAddress(port);
```

Remove the default ephemeral-port allocation path from normal managed startup. Tests can continue using dependency injection for process spawning and readiness, but they should no longer need an `allocatePort` seam for the default path.

`startCodeHelm` should accept the chosen managed app-server port from the CLI layer and forward it to `startManagedCodexAppServer`.

Foreground startup can pass that value directly through the in-process service call.

Background startup needs an explicit parent-to-daemon handoff because the parent launches a detached daemon process. The parent should pass the runtime-only port to the daemon through an internal environment variable, for example:

```text
CODE_HELM_MANAGED_APP_SERVER_PORT=4201
```

The detached daemon entrypoint should parse and validate that internal env value before calling `startCodeHelm`. If absent, it should use `DEFAULT_MANAGED_CODEX_APP_SERVER_PORT`. This keeps `code-helm start --daemon --port 4201` equivalent to foreground startup instead of silently reverting to `4200`.

## Background Startup Failure Handoff

Background startup currently has one durable parent-child success signal: `runtime.json`. That is not enough for startup failures, because the parent can only infer that the child did not publish runtime state.

Add a separate startup-failure state file in the same state directory:

```text
startup-error.json
```

The daemon child should write this file when startup fails before runtime readiness, especially during managed app-server startup. The shape should be small and structured:

```json
{
  "stage": "managed-app-server",
  "appServerAddress": "ws://127.0.0.1:4201",
  "message": "Managed Codex App Server failed to start.",
  "diagnostics": "address already in use",
  "occurredAt": "2026-04-27T12:00:00.000Z"
}
```

The state should be represented by typed helpers in the runtime-state module rather than ad hoc JSON reads:

- `writeStartupError(...)`
- `readStartupError(...)`
- `clearStartupError(...)`

The initial supported `stage` value is `managed-app-server`. Additional stages can be added later when another pre-runtime startup phase needs a parent-visible failure.

The parent background launcher should wait for either:

- `runtime.json`, which means startup succeeded
- `startup-error.json`, which means startup failed and should be rendered directly
- timeout with neither file, which remains the generic daemon did not publish state case

This avoids depending on detached-process stderr capture. It also matches CodeHelm's existing file-backed runtime-state model: success writes a runtime summary; startup failure writes a failure summary.

Failure-state cleanup must preserve the current-attempt handoff:

- clear stale `startup-error.json` before launching a new background daemon
- if the current daemon fails before readiness, write `startup-error.json` after local cleanup and leave it in place
- the parent may clear the file after reading and rendering the failure
- the next startup attempt also clears any stale file before launching

Do not extend generic startup-failure cleanup in the daemon child so it deletes the just-written `startup-error.json`. Otherwise the parent can miss the failure and fall back to the same generic timeout.

## Port Conflict Behavior

If the chosen port is already occupied, CodeHelm should not fall back to a random port. The startup must fail because the user asked for a stable address.

The error surface should include:

- the attempted address, such as `ws://127.0.0.1:4200`
- the fact that the managed Codex App Server failed to start
- diagnostics from the managed app-server stderr when available
- a troubleshooting hint:

```text
lsof -nP -iTCP:<port> -sTCP:LISTEN
```

Implementation can rely on the child process failing readiness after `codex app-server` cannot bind the port. If stderr includes an address-in-use message, existing diagnostics should show it. If diagnostics are sparse, the CLI failure formatter should still mention the attempted port and the `lsof` command.

Daemon-mode conflict handling needs its own acceptance criteria. If the detached daemon exits before publishing runtime state because the chosen port is unavailable, the parent `code-helm start --daemon --port <port>` command should report a managed app-server startup failure for that attempted port, not only `Background CodeHelm daemon did not publish runtime state.` A focused test should cover this failure path.

The intended implementation path is the `startup-error.json` handoff described above. The child writes the selected address and diagnostics; the parent reads that failure state and renders the same managed app-server startup failure family used by foreground startup.

## Onboarding And Status Output

Onboarding should no longer show `ws://127.0.0.1:<auto>`.

Recommended onboarding rows:

```text
Codex App Server  managed (loopback, default port 4200)
Codex address     ws://127.0.0.1:4200
Codex connect     codex --remote ws://127.0.0.1:4200 -C "$(pwd)"
```

Runtime status should continue using the actual running address from runtime state. If the user starts with `--port 4201`, `code-helm status` should show `ws://127.0.0.1:4201`.

## Autostart Behavior

Existing macOS autostart should continue launching:

```text
code-helm start --daemon
```

That means autostart uses the default `4200`. This spec intentionally does not add a stored autostart port option.

## Logging

Keep structured production logs at the existing startup points. Include the selected address and port in managed app-server startup, readiness failure, and ready logs.

Debug logging is not required for the happy path. Detailed diagnostics should come from structured error fields and stderr tail capture, not ad hoc console output.

## Tests

Add or update focused tests for:

- CLI parsing:
  - `start` defaults to no explicit port
  - `start --daemon`
  - `start --port 4201`
  - `start --daemon --port 4201`
  - `start --port 4201 --daemon`
  - invalid/missing/out-of-range port values
- supervisor:
  - default managed startup uses `ws://127.0.0.1:4200`
  - custom port startup uses the selected address
  - spawn args include `["app-server", "--listen", address]`
- runtime:
  - foreground start forwards the requested port to the supervisor
  - background start forwards the requested port to the supervisor
  - background start passes the selected port into the detached daemon process
  - runtime summary/status uses the actual address returned by the supervisor
  - `--port` is rejected clearly when an explicit external `CODE_HELM_CODEX_APP_SERVER_URL` is active
- startup failure state:
  - child writes `startup-error.json` when startup fails before runtime readiness
  - parent returns the startup failure from `startup-error.json` instead of waiting for a generic timeout
  - stale startup failure state is cleared before a new startup attempt
  - child cleanup does not delete the current-attempt startup failure before the parent can read it
- daemon failure reporting:
  - `code-helm start --daemon --port <busy-port>` reports the attempted address and troubleshooting hint instead of only reporting missing runtime state
- onboarding:
  - review summary shows `4200`, not `<auto>`
- docs/help:
  - help output lists `start --port <port>` or equivalent usage

Before implementation is complete, run:

```text
bun test
bun run typecheck
```

## Rollout

This is a small breaking behavior change for users relying on ephemeral ports, but that path is not a useful stable product contract. Users who need another port can run `code-helm start --port <port>`.

No database migration is required.
