# CodeHelm Pino Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CodeHelm's console-only logger with a Pino-based logging system that writes daily JSONL files, keeps foreground output readable, and preserves safe troubleshooting context.

**Architecture:** `src/logger.ts` remains the application-facing facade and delegates to a configurable Pino runtime. Focused logger modules own daily file sinks, retention, and sanitization; runtime modules add child logger context at key startup, Codex, Discord, session, and approval boundaries.

**Tech Stack:** Bun, TypeScript, `bun:test`, Pino, pino-pretty, Node fs/path/crypto utilities.

---

## File Structure

- Create: `src/logger/retention.ts`
  - Owns CodeHelm log filename matching, local-date retention cutoff, startup cleanup, and 24h retention timer.
- Create: `src/logger/sinks.ts`
  - Owns daily JSONL writable streams and main/error sink routing.
- Create: `src/logger/sanitize.ts`
  - Owns safe serialization, secret redaction, user-content summaries, and error serialization.
- Modify: `src/logger.ts`
  - Exposes the stable facade, Pino runtime creation, env parsing, child loggers, compatibility normalization, `initializeLogger`, and `shutdownLogger`.
- Modify: `src/cli/paths.ts`
  - Adds log directory resolution from `CODE_HELM_LOG_DIR`, defaulting to `stateDir/logs`.
- Modify: `src/index.ts`
  - Initializes the logger early, shuts it down on stop/failure, and adds child loggers around runtime, Codex, Discord, sessions, and approvals.
- Modify: `src/codex/supervisor.ts`
  - Adds structured logger injection or module-level child logging for managed app-server lifecycle and diagnostics.
- Modify: `src/codex/jsonrpc-client.ts`
  - Adds safe transport lifecycle and request failure logging.
- Modify: `src/discord/bot.ts`
  - Uses child logger context for Discord ready, autocomplete/chat failures, and recoverable interaction errors.
- Create: `tests/logger/retention.test.ts`
- Create: `tests/logger/sanitize.test.ts`
- Create: `tests/logger/sinks.test.ts`
- Create: `tests/logger/logger.test.ts`
- Modify existing focused tests only when dependency injection signatures change.

## Task 1: Dependencies And Logger Path Resolution

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `src/cli/paths.ts`
- Test: `tests/cli/config-store.test.ts`

- [ ] **Step 1: Add failing path test**

Add a test that `resolveCodeHelmPaths` exposes `logDir` as `~/.local/state/code-helm/logs` by default and honors `CODE_HELM_LOG_DIR`.

- [ ] **Step 2: Run focused test and verify it fails**

Run: `bun test tests/cli/config-store.test.ts`

Expected: FAIL because `logDir` does not exist.

- [ ] **Step 3: Add Pino dependencies**

Run:

```bash
bun add pino pino-pretty
```

- [ ] **Step 4: Implement path resolution**

Add `logDir` to `CodeHelmPaths` and resolve `CODE_HELM_LOG_DIR ?? join(stateDir, "logs")`.

- [ ] **Step 5: Run focused test**

Run: `bun test tests/cli/config-store.test.ts`

Expected: PASS.

## Task 2: Retention Helper

**Files:**
- Create: `src/logger/retention.ts`
- Test: `tests/logger/retention.test.ts`

- [ ] **Step 1: Write failing retention tests**

Cover:

- file matching only `codehelm-YYYY-MM-DD.jsonl` and `codehelm-error-YYYY-MM-DD.jsonl`
- calendar-date cutoff keeps today plus previous 13 local dates
- deletes older matching files
- ignores unrelated files
- cleanup failure returns/logs a recoverable warning path
- timer can be stopped

- [ ] **Step 2: Run focused test and verify it fails**

Run: `bun test tests/logger/retention.test.ts`

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement retention**

Implement:

- `formatLocalLogDate(date)`
- `getLogFileDate(filename)`
- `cleanupOldLogFiles({ logDir, now, retainDays })`
- `startLogRetention({ logDir, retainDays, intervalMs, logger, now })`

Use a 14-day inclusive local calendar policy: on 2026-04-26, keep 2026-04-13 through 2026-04-26 and delete 2026-04-12 or older.

- [ ] **Step 4: Run focused test**

Run: `bun test tests/logger/retention.test.ts`

Expected: PASS.

## Task 3: Sanitization And Compatibility Normalization

**Files:**
- Create: `src/logger/sanitize.ts`
- Test: `tests/logger/sanitize.test.ts`

- [ ] **Step 1: Write failing sanitizer tests**

Cover:

- token/secret/password/api key redaction
- `content`, `prompt`, `input`, and `text` string summaries with length/hash
- `commandPreview` truncation instead of full redaction
- Error serialization with name/message/stack/code/cause
- console-style argument normalization such as `("message", error)` and `("message", { error })`

- [ ] **Step 2: Run focused test and verify it fails**

Run: `bun test tests/logger/sanitize.test.ts`

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement sanitizer**

Implement stable JSON-safe helpers and export a normalizer that `src/logger.ts` can use before handing records to Pino.

- [ ] **Step 4: Run focused test**

Run: `bun test tests/logger/sanitize.test.ts`

Expected: PASS.

## Task 4: Daily JSONL Sinks

**Files:**
- Create: `src/logger/sinks.ts`
- Test: `tests/logger/sinks.test.ts`

- [ ] **Step 1: Write failing sink tests**

Cover:

- writes main file for current local date
- writes error file only when the record level is `error` or `fatal`
- switches file when date provider crosses midnight
- writes valid JSONL, not pretty text

- [ ] **Step 2: Run focused test and verify it fails**

Run: `bun test tests/logger/sinks.test.ts`

Expected: FAIL because sink module does not exist.

- [ ] **Step 3: Implement daily sinks**

Implement stream-like destinations compatible with Pino multistream. Use synchronous append or a closeable stream abstraction that tests can flush deterministically.

- [ ] **Step 4: Run focused test**

Run: `bun test tests/logger/sinks.test.ts`

Expected: PASS.

## Task 5: Pino Facade

**Files:**
- Modify: `src/logger.ts`
- Test: `tests/logger/logger.test.ts`

- [ ] **Step 1: Write failing facade tests**

Cover:

- default level is `info`
- `CODE_HELM_LOG_LEVEL=debug` enables debug
- invalid log level fails with a clear error
- child logger bindings appear in JSONL
- existing console-style calls produce valid records
- `logger.trace` is exposed because config accepts `trace`
- `initializeLogger` starts retention and `shutdownLogger` stops it

- [ ] **Step 2: Run focused test and verify it fails**

Run: `bun test tests/logger/logger.test.ts`

Expected: FAIL against old console wrapper.

- [ ] **Step 3: Implement facade**

Implement `createCodeHelmLogger`, `initializeLogger`, `shutdownLogger`, default facade delegation, child loggers, Pino pretty console stream, JSONL file sinks, and safe serializers.

- [ ] **Step 4: Run focused test**

Run: `bun test tests/logger/logger.test.ts`

Expected: PASS.

## Task 6: Runtime Integration

**Files:**
- Modify: `src/index.ts`
- Modify: `src/codex/supervisor.ts`
- Modify: `src/codex/jsonrpc-client.ts`
- Modify: `src/discord/bot.ts`
- Test: existing focused tests around touched files plus new assertions only where practical.

- [ ] **Step 1: Add focused integration tests where signatures change**

Prefer existing unit tests for `startCodeHelm`, `JsonRpcClient`, `startManagedCodexAppServer`, and `createDiscordBot`. Add only narrow tests for new logger injection/initialization behavior.

- [ ] **Step 2: Run focused tests and verify failures**

Run:

```bash
bun test tests/index.test.ts tests/codex/supervisor.test.ts tests/codex/jsonrpc-client.test.ts tests/discord/bot.test.ts
```

Expected: FAIL only where new behavior is not implemented yet, or PASS if the integration uses backward-compatible signatures.

- [ ] **Step 3: Implement runtime logging**

Add early logger initialization in `loadAndStartCodeHelmFromProcess`, shutdown cleanup in runtime stop paths, and child logger context for startup, managed app-server, JSON-RPC transport, Discord bot, session lifecycle, and approval lifecycle.

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun test tests/index.test.ts tests/codex/supervisor.test.ts tests/codex/jsonrpc-client.test.ts tests/discord/bot.test.ts
```

Expected: PASS.

## Task 7: Final Verification

**Files:**
- All touched files

- [ ] **Step 1: Run all tests**

Run: `bun test`

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 3: Inspect git diff**

Run: `git diff --stat && git diff --check`

Expected: no whitespace errors; diff limited to logging implementation, tests, dependency files, and this plan.

- [ ] **Step 4: Commit**

Run:

```bash
git add package.json bun.lock src tests docs/superpowers/plans/2026-04-26-codehelm-pino-logging-implementation.md
git commit -m "feat(logging): add pino file logging"
```
