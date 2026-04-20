# CodeHelm CLI Panel Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the user-facing CodeHelm CLI output so `start`, `status`, `stop`, `autostart`, `uninstall`, and top-level CLI errors render through one terminal panel system with retry-aware startup failures and Unicode-to-ASCII fallback.

**Architecture:** Add a small internal renderer in `src/cli/output.ts` and migrate command output onto it incrementally instead of rewriting command semantics. Keep `onboard` unchanged by introducing a new panel-oriented runtime renderer for `start` and `status`, while leaving the existing onboard-specific summary path intact. Route top-level thrown errors through the same renderer so usage failures, startup failures, and regular command failures all share one visual language.

**Tech Stack:** Bun, TypeScript, bun:test, Node CLI entrypoints, existing CodeHelm CLI command layer

---

## File Map

- Create: `src/cli/output.ts`
  Centralize terminal panel framing, section rendering, command hints, diagnostics blocks, charset fallback, and top-level CLI error rendering.
- Modify: `src/cli/commands.ts`
  Replace ad hoc string assembly for `start`, `status`, `stop`, `autostart`, and `uninstall` with the shared renderer; keep `onboard` on its current copy path.
- Modify: `src/cli.ts`
  Stop printing raw `error.message` directly and render caught CLI failures through the new output helper.
- Create: `tests/cli/output.test.ts`
  Lock panel framing, Unicode/ASCII fallback, diagnostics formatting, command hints, and CLI error rendering.
- Modify: `tests/cli/commands.test.ts`
  Lock panel-shaped command results, retry-aware startup failures, certificate-specific startup guidance, not-running states, autostart unsupported messaging, and uninstall partial-failure rendering.

## Task 1: Build The Shared CLI Output Renderer

**Files:**
- Create: `src/cli/output.ts`
- Create: `tests/cli/output.test.ts`

- [ ] **Step 1: Write the failing renderer tests**

Add unit coverage in `tests/cli/output.test.ts` for:

- Unicode panel framing by default
- ASCII framing when `TERM=dumb`
- ASCII framing when `CODE_HELM_CLI_ASCII=1`
- aligned key-value rows inside a titled panel
- diagnostics rendering after the headline instead of before it
- command hints rendering as their own section

Use expectations like:

```ts
expect(renderSuccessPanel({
  title: "CodeHelm Stopped",
  sections: [{ title: "Result", lines: ["The runtime is no longer active."] }],
  env: {},
})).toContain("CodeHelm Stopped");
```

and:

```ts
expect(renderSuccessPanel({
  title: "CodeHelm Stopped",
  sections: [{ title: "Result", lines: ["Done"] }],
  env: { TERM: "dumb" },
})).toContain("+");
```

- [ ] **Step 2: Run the focused renderer tests and verify they fail**

Run:

```bash
bun test tests/cli/output.test.ts
```

Expected: FAIL because `src/cli/output.ts` does not exist yet and there is no shared panel renderer.

- [ ] **Step 3: Implement the renderer foundation in `src/cli/output.ts`**

Add focused helpers such as:

```ts
export const detectCliCharset = (env: Record<string, string | undefined>) => { ... };
export const renderPanelFrame = (options: RenderPanelOptions) => { ... };
export const renderKeyValueRows = (rows: Array<{ key: string; value: string }>) => { ... };
export const renderDiagnosticsSection = (details?: string) => { ... };
export const renderCommandHint = (command: string) => { ... };
```

Then expose semantic renderers:

```ts
export const renderRuntimePanel = (...) => { ... };
export const renderSuccessPanel = (...) => { ... };
export const renderWarningPanel = (...) => { ... };
export const renderErrorPanel = (...) => { ... };
```

Fallback rules:

- default to Unicode
- downgrade when `TERM === "dumb"`
- downgrade when `CODE_HELM_CLI_ASCII === "1"`
- downgrade when `LANG`, `LC_ALL`, or `LC_CTYPE` clearly do not indicate UTF-8

Keep the renderer dependency-free and ASCII-safe.

- [ ] **Step 4: Re-run the focused renderer tests and verify they pass**

Run:

```bash
bun test tests/cli/output.test.ts
```

Expected: PASS. The renderer can draw compact panels and reliably fall back to ASCII.

- [ ] **Step 5: Commit**

```bash
git add src/cli/output.ts tests/cli/output.test.ts
git commit -m "feat(cli): add shared panel output renderer"
```

## Task 2: Migrate Runtime Panels And Startup Failures

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/commands.test.ts`
- Modify: `src/cli/output.ts`

- [ ] **Step 1: Write the failing command tests for runtime panels**

Extend `tests/cli/commands.test.ts` to cover:

- `start` rendering a `CodeHelm Runtime` panel instead of loose lines
- `status` rendering the same runtime panel
- `status` with no runtime rendering a not-running panel instead of plain `CodeHelm stopped`
- `start` while an instance is already running reusing the runtime panel with a short note
- local-time `Started:` display still appearing with an explicit timezone label

Use expectations like:

```ts
expect(result.output).toContain("CodeHelm Runtime");
expect(result.output).toContain("Status");
expect(result.output).toContain("Quick Actions");
expect(result.output).toContain("codex --remote ws://127.0.0.1:4200");
```

and:

```ts
expect(result.output).not.toContain("CodeHelm running\nMode:");
```

- [ ] **Step 2: Write the failing startup failure tests**

Add or tighten coverage for:

- delayed startup rendering warning-style panel copy with retry guidance
- hard startup failure rendering error-style panel copy with retry guidance
- certificate verification failure rendering more specific certificate guidance while preserving diagnostics

Use expectations like:

```ts
await expect(
  runCliCommand({ kind: "start", daemon: false }, services),
).rejects.toThrow(/try running the command again/i);
```

and:

```ts
await expect(
  runCliCommand({ kind: "start", daemon: false }, services),
).rejects.toThrow(/certificate trust setup/i);
```

- [ ] **Step 3: Run the focused command tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because runtime output is still loose text and startup failures are not yet panel-rendered.

- [ ] **Step 4: Implement runtime-panel rendering in `src/cli/commands.ts`**

Replace direct summary assembly with renderer calls for:

- `start`
- `start --daemon`
- `status`

Recommended shape:

```ts
const renderRuntimeStatusOutput = (
  runtime: RuntimeSummary | undefined,
  options: { timeZone?: string; alreadyRunningNote?: string },
) => { ... };
```

Important constraint:

- do **not** route `onboard` through the new runtime panel
- keep the current onboard already-running message on its own formatting path

Use `renderRuntimePanel(...)` only from the command paths that were approved in the spec.

- [ ] **Step 5: Add startup-failure classification and panel rendering**

Keep `formatStartupFailure(...)` as the interpretation boundary, but have it return renderer output.

Implement a helper like:

```ts
const classifyStartupFailure = (message: string) => {
  if (/certificate|verification|tls|ssl/i.test(message)) {
    return "certificate";
  }

  return "generic";
};
```

Rules:

- delayed startup -> warning panel with retry-later guidance
- generic failed startup -> error panel with fix-and-retry guidance
- certificate startup failure -> error panel with network / proxy / certificate trust guidance plus diagnostics

- [ ] **Step 6: Re-run the focused command tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: PASS. Runtime output is panel-shaped, startup copy is retry-aware, and certificate failures get targeted guidance.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands.ts src/cli/output.ts tests/cli/commands.test.ts
git commit -m "fix(cli): render runtime panels and startup failure guidance"
```

## Task 3: Migrate Success, Inactive, And Cleanup Command Output

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `src/cli/output.ts`
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Write the failing tests for stop, autostart, and uninstall**

Extend `tests/cli/commands.test.ts` to cover:

- `stop` success rendering a `CodeHelm Stopped` panel
- `stop` when no runtime exists rendering a not-running panel
- `autostart enable` rendering a panel with launch label and launch agent path
- `autostart disable` rendering a panel with removal status
- unsupported autostart rendering a warning-style panel instead of a bare sentence
- successful uninstall rendering `Removed` and `Next Step` sections
- uninstall partial failures rendering an error panel that lists removed and failed items

Use expectations like:

```ts
expect(result.output).toContain("Autostart Enabled");
expect(result.output).toContain("/tmp/code-helm.plist");
```

and:

```ts
await expect(
  runCliCommand({ kind: "uninstall" }, services),
).rejects.toThrow(/Uninstall/i);
```

Then tighten the final assertion to the actual chosen error title after implementation.

- [ ] **Step 2: Run the focused command tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because these commands still return plain sentences or joined newline blocks.

- [ ] **Step 3: Implement success and cleanup panels**

In `src/cli/commands.ts`, replace:

- `CodeHelm not running`
- `CodeHelm stopped`
- `Autostart enabled\n...`
- `Autostart disabled\n...`
- `Uninstall complete\n...`

with renderer calls such as:

```ts
renderSuccessPanel({
  title: "Autostart Enabled",
  sections: [
    {
      title: "Configuration",
      rows: [
        { key: "Label", value: result.label },
        { key: "Launch Agent", value: result.launchAgentPath },
      ],
    },
  ],
});
```

For uninstall partial failures, stop building one raw joined error string. Instead build:

```ts
renderErrorPanel({
  title: "Uninstall Incomplete",
  sections: [
    { title: "Removed", lines: removedPaths },
    { title: "Failed", lines: uninstallErrors },
  ],
});
```

Preserve existing cleanup behavior:

- attempt every cleanup path
- keep removing local resources even when stopping the daemon fails

- [ ] **Step 4: Re-run the focused command tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: PASS. Success, inactive, unsupported, and uninstall-failure paths all render through the same panel language.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands.ts src/cli/output.ts tests/cli/commands.test.ts
git commit -m "fix(cli): panelize lifecycle and cleanup commands"
```

## Task 4: Centralize Top-Level CLI Error Rendering

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/cli/output.ts`
- Modify: `tests/cli/output.test.ts`

- [ ] **Step 1: Write the failing error-rendering tests**

Add coverage in `tests/cli/output.test.ts` for:

- a plain `Error("boom")` becoming an error panel with `Problem` and `Details`
- a usage-shaped message such as `Unknown command: wat\nUsage: code-helm <...>` becoming an error panel with `Problem` and `Usage`
- diagnostics staying in a secondary section instead of the title line

Use expectations like:

```ts
expect(renderCliCaughtError(new Error("Unknown command: wat\nUsage: code-helm <...>"), {}))
  .toContain("Usage");
```

and:

```ts
expect(renderCliCaughtError(new Error("boom"), {}))
  .toContain("Problem");
```

- [ ] **Step 2: Run the focused output tests and verify they fail**

Run:

```bash
bun test tests/cli/output.test.ts
```

Expected: FAIL because the renderer does not yet expose a helper for caught CLI errors.

- [ ] **Step 3: Implement top-level caught-error rendering**

In `src/cli/output.ts`, add:

```ts
export const renderCliCaughtError = (
  error: unknown,
  env: Record<string, string | undefined>,
) => { ... };
```

Rules:

- if the final message contains `\nUsage:`, split it into `Problem` and `Usage`
- otherwise render `Problem` and `Details`
- keep the title short, for example `Invalid Arguments` or `Command Failed`

In `src/cli.ts`, replace:

```ts
console.error(message);
```

with:

```ts
console.error(renderCliCaughtError(error, process.env as Record<string, string | undefined>));
```

- [ ] **Step 4: Re-run the focused output tests and verify they pass**

Run:

```bash
bun test tests/cli/output.test.ts
```

Expected: PASS. Top-level caught errors now use the same panel system as command output.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli/output.ts tests/cli/output.test.ts
git commit -m "fix(cli): format top-level errors as panels"
```

## Task 5: Run Full Verification And Capture Any Last Gaps

**Files:**
- Modify if needed: `tests/cli/output.test.ts`
- Modify if needed: `tests/cli/commands.test.ts`

- [ ] **Step 1: Run the focused CLI test suite**

Run:

```bash
bun test tests/cli/output.test.ts tests/cli/commands.test.ts tests/cli/args.test.ts
```

Expected: PASS. The new renderer, command outputs, and parser expectations all remain coherent.

- [ ] **Step 2: Run the full test suite**

Run:

```bash
bun test
```

Expected: PASS. No non-CLI area regresses from the output refactor.

- [ ] **Step 3: Run typechecking**

Run:

```bash
bun run typecheck
```

Expected: PASS. New renderer types, env handling, and command integrations typecheck cleanly.

- [ ] **Step 4: If verification uncovers formatting edge cases, fix the smallest issue and re-run the affected tests**

Likely edge cases:

- overly wide key alignment with long command hints
- diagnostics blocks introducing accidental blank lines
- ASCII fallback drifting from Unicode layout
- `onboard` accidentally picking up the new runtime panel path

- [ ] **Step 5: Commit the final verification fix if one was needed**

```bash
git add tests/cli/output.test.ts tests/cli/commands.test.ts src/cli/output.ts src/cli/commands.ts
git commit -m "test(cli): lock panel output regressions"
```
