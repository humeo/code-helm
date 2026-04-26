# CodeHelm Pino Logging Design

Date: 2026-04-26

## Summary

CodeHelm should replace the current `console.*` logger wrapper with a Pino-based logging system that is useful for local error diagnosis without adding a log-reading CLI surface.

The logging system will write structured JSONL files for durable investigation and keep foreground development output readable through Pino pretty output. Runtime code should use a small CodeHelm logger facade and child loggers instead of spreading direct Pino setup across Discord, Codex, database, and CLI modules.

## Decisions Confirmed

- Use Pino for TypeScript/Node-style structured logging.
- Do not use Rust `tracing`-style text logs.
- Write file logs as JSONL.
- Use pretty console output for development and foreground runs.
- Write daily log files.
- Keep logs for 14 days.
- Run retention at startup and once per day while the daemon is alive.
- Control level with `CODE_HELM_LOG_LEVEL`, defaulting to `info`.
- Record metadata and safe summaries by default.
- Do not log bot tokens, secrets, or full user prompts.
- Do not add a `code-helm logs` subcommand in this phase.

## Problem

CodeHelm currently exposes `src/logger.ts` as a thin wrapper over `console.log`, `console.warn`, `console.error`, and `console.debug`.

That is not enough for diagnosing real production-style local failures because:

- log output is not consistently structured
- foreground output and durable file output are not separated
- there is no daily log file or retention policy
- errors are often logged without stable session, Discord, Codex, or approval context
- sensitive data boundaries are not encoded in the logger layer
- long-running background daemons can run for weeks without rotating or cleaning logs

The existing runtime has strong natural correlation keys:

- Discord guild, channel, thread, message, and user IDs
- Codex thread, turn, item, and request IDs
- approval keys and provider request IDs
- session lifecycle and runtime states
- managed app-server process IDs and addresses

The logging system should make those keys searchable in JSONL without forcing the user to remember a new CodeHelm log CLI.

## Approaches Considered

### 1. Pino Singleton Logger Upgrade

Replace `src/logger.ts` with a Pino-backed singleton while keeping existing call sites mostly unchanged.

Benefits:

- smallest implementation
- low risk
- quick improvement over console output

Drawbacks:

- context remains inconsistent unless every call manually passes fields
- weaker for tracing one session or approval through the system

### 2. Pino Logger With Child Context

Recommended.

Upgrade `src/logger.ts` into a Pino facade and use child loggers at runtime boundaries such as runtime startup, Discord, Codex, sessions, and approvals.

Benefits:

- matches common TypeScript/Pino style
- makes errors searchable by stable IDs
- keeps business modules insulated from direct Pino setup
- avoids turning logging into a separate event-audit subsystem

Tradeoff:

- requires more careful field naming and targeted call-site changes than a singleton-only wrapper

### 3. Pino Plus Strict Event Audit Model

Define a formal event taxonomy for every operation, such as `session.turn.started`, `approval.request.received`, and `discord.message.failed`.

Benefits:

- best long-term observability model
- easier to connect to external analytics later

Drawbacks:

- too broad for this phase
- risks expanding logging into a separate audit/event system
- more likely to require unrelated refactors

## Goals

- provide durable local JSONL logs for troubleshooting
- keep foreground development output readable
- preserve current logger call-site compatibility where practical
- support child loggers with session, Discord, Codex, and approval context
- separate debug logging from production-oriented info/warn/error logs
- rotate daily and retain 14 days of logs for long-running daemons
- protect secrets and user content from accidental log persistence
- keep implementation focused enough for a single implementation plan

## Non-Goals

- adding `code-helm logs` or any other log-reading subcommand
- storing logs in SQLite
- adding Sentry, OpenTelemetry, Datadog, or another external collector
- creating a full audit-event system
- adding size-based rotation in the first version
- logging full Discord messages, full prompts, bot tokens, or secrets
- rewriting every existing logger call in one pass

## Architecture

### Logger Facade

`src/logger.ts` becomes the stable application-facing API.

It should expose:

- `logger.info(...)`
- `logger.warn(...)`
- `logger.error(...)`
- `logger.debug(...)`
- `logger.fatal(...)`
- `logger.child(bindings)`

Runtime code should not need to know how Pino transports, serializers, daily files, or retention timers work.

The facade must support both new structured calls and existing console-style calls. Existing call sites often use forms like:

```ts
logger.error("Failed to handle Discord thread message", error);
logger.warn("Failed to steer managed session turn from Discord message", {
  discordThreadId,
  codexThreadId,
  error,
});
```

The implementation should normalize these into Pino-friendly structured records so the migration does not become a large unrelated rewrite.

### Setup Boundary

Logger setup should be explicit and testable.

The design should support:

- default initialization for runtime entrypoints
- dependency injection or isolated setup for tests
- clean shutdown of file streams and retention timers

The top-level runtime should initialize logging before major startup work so startup failures are captured.

### Child Loggers

Use child loggers at subsystem and operation boundaries:

```ts
const runtimeLogger = logger.child({ component: "runtime", mode });
const discordLogger = logger.child({ component: "discord" });
const codexLogger = logger.child({ component: "codex" });
const sessionLogger = logger.child({
  component: "session",
  codexThreadId,
  discordThreadId,
});
const approvalLogger = logger.child({
  component: "approval",
  approvalKey,
  codexThreadId,
  discordThreadId,
});
```

This is the primary replacement for Rust-style spans. The log file remains normal Pino JSONL.

## Configuration

### Environment Variables

`CODE_HELM_LOG_LEVEL`

- controls minimum level
- default: `info`
- accepted values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`
- invalid values should fail with a clear message or fall back with a warning; the implementation plan should choose one and test it

`CODE_HELM_LOG_DIR`

- optional override for the log directory
- useful for tests and local investigations
- default: `resolveCodeHelmPaths({ env }).stateDir + "/logs"`

### Paths

Default log directory:

```text
~/.local/state/code-helm/logs/
```

Daily files:

```text
codehelm-YYYY-MM-DD.jsonl
codehelm-error-YYYY-MM-DD.jsonl
```

The main file receives all entries at or above the configured level.

The error file receives only `error` and `fatal` entries.

## Output Format

### File Output

File logs are JSONL. Each line is one Pino record.

Example:

```json
{"level":30,"time":"2026-04-26T12:00:00.000Z","service":"code-helm","component":"codex","msg":"Managed Codex App Server ready","pid":12345,"appServerAddress":"ws://127.0.0.1:4500"}
```

The `time` field should be ISO-8601 for readability, not only a numeric epoch.

### Console Output

Foreground and development console output should be human-readable through Pino pretty output.

Console output is not the durable investigation artifact. The JSONL files are.

The implementation should avoid making `pino-pretty` optional if the published CLI can exercise pretty console output. If a dynamic or optional transport is chosen, missing pretty support must degrade cleanly rather than breaking daemon startup.

## Rotation And Retention

### Daily Rotation

The file sink should write to the file for the current local date.

When the date changes, new log entries should go to the new daily file. The daemon must not require restart to change files.

### Retention

Retention policy:

- keep 14 days
- delete only files matching CodeHelm log filename patterns
- run once during startup
- run once every 24 hours while the process is alive
- clear the retention timer during runtime shutdown

Cleanup failures should be logged as `warn` and must not block startup or normal operation.

This handles long-running background daemons as well as short foreground runs.

## Context Fields

Use stable, predictable field names.

Common fields:

- `service`
- `component`
- `operation`
- `mode`
- `pid`
- `discordGuildId`
- `discordChannelId`
- `discordThreadId`
- `discordMessageId`
- `discordUserId`
- `codexThreadId`
- `codexTurnId`
- `codexItemId`
- `approvalKey`
- `requestId`
- `providerRequestId`
- `cwd`
- `sessionState`
- `lifecycleState`
- `appServerAddress`
- `appServerPid`

Avoid ad hoc aliases for the same concept. For example, use `codexThreadId` everywhere rather than mixing `threadId`, `sessionId`, and `codexThread`.

## Event Coverage

First-version coverage should focus on boundaries where failures are hardest to reconstruct.

### Startup And Shutdown

Log:

- config load outcome without secrets
- instance lock acquired or stale lock recovered
- managed Codex App Server spawn attempt
- readiness success, delayed startup, and failure
- runtime summary write success or failure
- signal-triggered shutdown
- clean stop and stop failures

### Codex App Server And JSON-RPC

Log:

- transport connect/init success and failure
- transport close/error
- request failures
- managed app-server stderr diagnostics summary on startup failure
- approval request and resolution event receipt at safe metadata level

High-volume JSON-RPC payloads should not be dumped into logs.

### Discord Surface

Log:

- bot ready
- command and interaction failures
- thread message forwarding failures
- message send/edit/delete failures
- stale or expired Discord interaction handling as `warn` when recoverable

Do not log complete Discord message content.

### Session Lifecycle

Log:

- session create/resume/sync/close
- transition into `idle`, `running`, `waiting-approval`, `degraded`, or read-only mode when it matters for support
- snapshot reconciliation warning/error
- degradation reason

### Approval Lifecycle

Log:

- approval request received
- approval snapshot persisted
- approval projected into Discord
- approval decision submitted
- approval resolved elsewhere
- approval delivery failure

Approval command previews may be logged only after truncation and sanitization.

### Database And Migration

Log:

- database open path
- migration start/success/failure
- database close failure

Do not log row dumps.

## Log Levels

Use levels consistently:

- `debug`: detailed branch decisions, ignored stale events, retry details, low-level diagnostics
- `info`: normal lifecycle events, startup ready, session created, approval received
- `warn`: recoverable problems, cleanup failure, Discord fallback paths, snapshot reconciliation warning
- `error`: user-visible operation failure or failure requiring investigation
- `fatal`: process cannot continue, mainly top-level startup crash

Production default should be `info`. Debug logs should require `CODE_HELM_LOG_LEVEL=debug`.

## Security And Sanitization

The logger layer should include serializers or normalization helpers that prevent common accidental leaks.

Never log:

- Discord bot token
- values from secrets files
- environment variables containing token, secret, password, key, or credential material
- complete user prompts
- complete Discord message content

Safe to log:

- stable IDs
- status values
- operation names
- cwd and workspace paths
- truncated command previews for approval diagnostics
- message length
- short content hash if needed for dedupe diagnostics
- error type, message, stack, code, and cause after sanitization

Debug mode must not bypass these security rules.

## Testing Strategy

Add focused tests around the logger rather than relying only on end-to-end runtime behavior.

Test cases should cover:

- default level is `info`
- `CODE_HELM_LOG_LEVEL=debug` enables debug
- invalid log level behavior is explicit and tested
- main JSONL file receives expected records
- error JSONL file receives only `error` and `fatal`
- console pretty setup does not write pretty text into JSONL files
- daily rotation changes file when the date changes
- startup retention deletes files older than 14 days
- daily retention timer deletes files older than 14 days during a long-running process
- retention ignores non-CodeHelm files
- retention failure logs `warn` and does not throw through startup
- sanitizer redacts token/secret/password-like fields
- existing console-style calls still produce valid Pino records
- child logger bindings appear in JSONL records

Existing repository verification remains:

```bash
bun test
bun run typecheck
```

## Implementation Notes For Planning

The implementation plan should keep file ownership narrow:

- `src/logger.ts`: facade, level parsing, child logger API, compatibility normalization
- `src/logger/` or equivalent: file sinks, daily routing, retention helpers, serializers
- `src/cli/paths.ts`: log directory path resolution
- `src/config.ts`: env parsing only if needed by runtime configuration
- `src/index.ts`: startup/shutdown/session/approval child logger integration
- `src/codex/jsonrpc-client.ts`: transport and request failure logging
- `src/codex/supervisor.ts`: managed app-server startup and diagnostics logging
- `src/discord/bot.ts`: Discord interaction logger integration
- tests under `tests/logger/` or close to the touched modules

Dependency changes should use Bun:

```bash
bun add pino
bun add pino-pretty
```

If the final implementation only uses `pino-pretty` in local development and can prove it is not needed by the published CLI, the implementation plan may choose `bun add -d pino-pretty`. Otherwise it should remain a runtime dependency so foreground pretty output cannot break for installed users.

## Acceptance Criteria

- Runtime logs are written to daily JSONL files by default.
- Error and fatal logs are also written to a daily error JSONL file.
- Foreground development output is human-readable.
- `CODE_HELM_LOG_LEVEL=debug` enables debug logs.
- `CODE_HELM_LOG_DIR` can redirect logs for tests and investigations.
- Logs older than 14 days are cleaned at startup and during long-running daemon execution.
- Logs include useful session, Discord, Codex, and approval context on key failure paths.
- Logs do not persist secrets or complete user prompts.
- No `code-helm logs` command is added.
- `bun test` and `bun run typecheck` pass.
