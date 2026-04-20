# CodeHelm CLI Bare Command Palette Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current framed CLI panel system with a frame-free bare command palette across the full CodeHelm CLI, including help, runtime output, mutation confirmations, failures, and onboarding-adjacent command messaging.

**Architecture:** Keep `src/cli/commands.ts` responsible for command semantics and move the visual redesign into `src/cli/output.ts`. Implement the renderer as a compatibility bridge: preserve the current high-level entry points (`renderSuccessPanel`, `renderRuntimePanel`, `renderWarningPanel`, `renderErrorPanel`) while teaching them to render a frame-free screen model with typed section helpers, then migrate each command family onto those helpers incrementally. Keep the implementation TDD-first so every family change is locked by focused Bun tests before broader rollout.

**Tech Stack:** Bun, TypeScript, bun:test, Node CLI entrypoints, `@clack/prompts`

---

## File Map

- Modify: `src/cli/output.ts`
  Replace border-frame rendering with a frame-free screen renderer, preserve charset detection, add typed section helpers for command lists, key/value rows, steps, paths, and diagnostics, and update top-level caught-error normalization.
- Modify: `src/cli/commands.ts`
  Migrate `help`, `version`, `update`, `start`, `status`, `stop`, `autostart`, `uninstall`, and onboarding-blocked command output to the new bare command palette language.
- Modify: `src/cli/onboard.ts`
  Update onboarding intro, review summary, completion copy, and blocked messaging so the interactive flow matches the new product language where `@clack/prompts` allows it.
- Modify: `tests/cli/output.test.ts`
  Lock the frame-free renderer behavior, command-list alignment, key/value alignment, diagnostics ordering, caught-error normalization, and ASCII fallback.
- Modify: `tests/cli/commands.test.ts`
  Lock discoverability, runtime, mutation, warning, and failure outputs under the new CLI language.
- Modify: `tests/cli/onboard.test.ts`
  Lock the updated onboarding copy and aligned review summary format.

## Decisions Locked By This Plan

- Use a compatibility bridge in `src/cli/output.ts` instead of rewriting every command call site at once.
- Render `version` as a compact identity screen with the version in the title line and the package name as a short metadata line.
- Do not invent any restart command as part of `update`.
- Keep `src/cli.ts` unchanged unless the renderer API unexpectedly forces a call-site update.
- Keep `src/cli/args.ts` semantics unchanged; argument handling still throws usage-shaped errors that `renderCliCaughtError(...)` interprets.

## Task 1: Build The Frame-Free Screen Renderer Foundation

**Files:**
- Modify: `src/cli/output.ts`
- Modify: `tests/cli/output.test.ts`

- [ ] **Step 1: Write the failing renderer tests for the new screen model**

Add focused tests in `tests/cli/output.test.ts` for:

- no outer box characters in default success output
- command-list alignment with command and description columns
- step-list rendering for `Next steps`
- diagnostics rendered after the result and action guidance
- ASCII fallback keeping section order without reintroducing frames

Use test shapes like:

```ts
const output = renderSuccessPanel({
  title: "CodeHelm",
  headline: "Control Codex from Discord",
  sections: [
    {
      kind: "command-list",
      title: "Runtime",
      items: [
        { command: "start", description: "Start CodeHelm in foreground" },
        { command: "status", description: "Show runtime state" },
      ],
    },
  ],
  env: {},
});

expect(output).toContain("CodeHelm");
expect(output).toContain("Runtime");
expect(output).toContain("start");
expect(output).not.toContain("┌");
expect(output).not.toContain("+---");
```

- [ ] **Step 2: Run the focused renderer tests and verify they fail**

Run:

```bash
bun test tests/cli/output.test.ts
```

Expected: FAIL because `src/cli/output.ts` still renders framed panels and does not support typed frame-free sections.

- [ ] **Step 3: Implement the frame-free renderer in `src/cli/output.ts`**

Add a compatibility-first screen model such as:

```ts
type ScreenSection =
  | { kind: "lines"; title: string; lines: string[] }
  | { kind: "key-value"; title: string; rows: Array<{ key: string; value: string }> }
  | { kind: "command-list"; title: string; items: Array<{ command: string; description: string }> }
  | { kind: "steps"; title: string; items: string[] }
  | { kind: "paths"; title: string; items: string[] };
```

Implement helpers such as:

```ts
export const renderKeyValueRows = (rows: Array<{ key: string; value: string }>) => {
  const keyWidth = rows.reduce((max, row) => Math.max(max, getDisplayWidth(row.key)), 0);
  return rows.map((row) => `${padLine(row.key, keyWidth)}  ${row.value}`);
};

export const renderCommandList = (items: Array<{ command: string; description: string }>) => {
  const commandWidth = items.reduce((max, item) => Math.max(max, getDisplayWidth(item.command)), 0);
  return items.map((item) => `${padLine(item.command, commandWidth)}  ${item.description}`);
};
```

Then update the semantic entry points so they call a frame-free renderer like:

```ts
const renderCliScreen = (options: RenderSemanticPanelOptions) => {
  const lines = [options.title];

  if (options.headline) {
    lines.push(options.headline);
  }

  for (const section of options.sections ?? []) {
    lines.push("", section.title, ...renderSection(section));
  }

  return lines.join("\n");
};

export const renderSuccessPanel = (options: RenderSemanticPanelOptions) => {
  return renderCliScreen(options);
};
```

Rules:

- keep `detectCliCharset(...)`
- preserve display-width safety for mixed ASCII and CJK text
- use blank lines and section titles for hierarchy
- keep `renderDiagnosticsSection(...)` and `renderCliCaughtError(...)` compatible with the new layout

- [ ] **Step 4: Re-run the focused renderer tests and verify they pass**

Run:

```bash
bun test tests/cli/output.test.ts
```

Expected: PASS. The renderer now produces frame-free screens with stable alignment and ASCII-safe fallback.

- [ ] **Step 5: Commit**

```bash
git add src/cli/output.ts tests/cli/output.test.ts
git commit -m "feat(cli): add bare command palette renderer"
```

## Task 2: Migrate Help, Version, Update, And Top-Level Failure Output

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `src/cli/output.ts`
- Modify: `tests/cli/commands.test.ts`
- Modify: `tests/cli/output.test.ts`

- [ ] **Step 1: Write the failing command and error tests for discoverability output**

Update `tests/cli/commands.test.ts` and `tests/cli/output.test.ts` to cover:

- `help` rendering grouped sections `Get started`, `Runtime`, `Automation`, `Maintenance`, and `Common flows`
- `help` showing short command descriptions instead of `Overview` and raw command-only lines
- `version` rendering compactly as `CodeHelm <version>` plus the package name
- `update` success rendering `Command run` and `Next steps`
- `renderCliCaughtError(...)` rendering `Invalid arguments` and `Usage` without panel framing

Use assertions like:

```ts
expect(result.output).toContain("CodeHelm");
expect(result.output).toContain("Get started");
expect(result.output).toContain("onboard");
expect(result.output).toContain("Connect Discord and initialize local state");
expect(result.output).not.toContain("Overview");
```

and:

```ts
expect(output).toContain("Invalid arguments");
expect(output).toContain("Usage");
expect(output).not.toContain("Command Failed");
```

- [ ] **Step 2: Run the focused discoverability tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts tests/cli/output.test.ts
```

Expected: FAIL because `help`, `version`, `update`, and caught-error formatting still use the old panel-era copy and section model.

- [ ] **Step 3: Implement the discoverability and failure-family outputs**

Update `src/cli/commands.ts` so:

- `renderHelpOutput(...)` builds grouped command-list sections with descriptions
- `renderVersionOutput(...)` renders a compact identity screen
- `renderUpdateSuccessOutput(...)` uses `Command run` and `Next steps`
- `renderUpdateFailureOutput(...)` uses `Try next` plus diagnostics ordering

Use concrete structures like:

```ts
const renderHelpOutput = (env: Record<string, string | undefined>) => {
  return renderSuccessPanel({
    title: "CodeHelm",
    headline: "Control Codex from Discord",
    sections: [
      {
        kind: "command-list",
        title: "Get started",
        items: [
          { command: "onboard", description: "Connect Discord and initialize local state" },
          { command: "help", description: "Show the command overview" },
        ],
      },
    ],
    env,
  });
};
```

Also update `renderCliCaughtError(...)` in `src/cli/output.ts` so it produces:

- `Invalid arguments`
- relevant `Usage`
- `Try next` or `Details` only when needed

- [ ] **Step 4: Re-run the focused discoverability tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts tests/cli/output.test.ts
```

Expected: PASS. Help and version read like a command palette, update reads like a mutation confirmation, and argument failures normalize into the new failure family.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands.ts src/cli/output.ts tests/cli/commands.test.ts tests/cli/output.test.ts
git commit -m "feat(cli): migrate help version update to bare command palette"
```

## Task 3: Migrate Runtime Lifecycle Output And Startup Failures

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Write the failing runtime and startup tests**

Update `tests/cli/commands.test.ts` to cover:

- `start` and `status` sharing the same `Runtime` family layout
- the not-running `status` view being shorter and no longer padded with `n/a` rows
- `start` already-running output using the same runtime layout with an active-runtime subtitle
- `stop` success rendering `Runtime stopped`
- startup delayed and startup failed flows using `Try next` followed by `Diagnostics`

Use assertions like:

```ts
expect(result.output).toContain("Runtime");
expect(result.output).toContain("Process");
expect(result.output).toContain("Connections");
expect(result.output).toContain("Next steps");
expect(result.output).not.toContain("CodeHelm Runtime");
```

and:

```ts
const tryNextIndex = output.indexOf("Try next");
const diagnosticsIndex = output.indexOf("Diagnostics");
expect(tryNextIndex).toBeGreaterThan(-1);
expect(diagnosticsIndex).toBeGreaterThan(tryNextIndex);
```

- [ ] **Step 2: Run the focused runtime tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because runtime output still uses `CodeHelm Runtime` panel copy, the not-running view still shows placeholder rows, and startup failure sections still use panel-era titles like `How To Fix`.

- [ ] **Step 3: Implement the runtime family in `src/cli/commands.ts`**

Refactor `renderRuntimeStatusOutput(...)`, `stopBackgroundRuntime(...)`, and `formatStartupFailure(...)` so they emit:

- title `Runtime`, `Runtime stopped`, or `Startup failed`
- short result lines instead of panel headlines
- sections `Process`, `Connections`, `Configuration`, `Next steps`, `Try next`

Concrete shape:

```ts
const renderRuntimeStatusOutput = (
  runtime: RuntimeSummary | undefined,
  options: { env: Record<string, string | undefined>; timeZone?: string; alreadyRunningNote?: string },
) => {
  if (!runtime) {
    return renderWarningPanel({
      title: "Runtime",
      headline: "CodeHelm is not running",
      sections: [
        { kind: "steps", title: "Next steps", items: ["code-helm start", "code-helm onboard"] },
      ],
      env: options.env,
    });
  }

  return renderRuntimePanel({
    title: "Runtime",
    headline: options.alreadyRunningNote ?? `CodeHelm is running in ${runtime.mode} mode`,
    sections: [
      {
        kind: "key-value",
        title: "Process",
        rows: [
          { key: "Mode", value: runtime.mode },
          { key: "PID", value: String(runtime.pid) },
        ],
      },
    ],
    env: options.env,
  });
};
```

Failure rules:

- delayed startup -> `Startup delayed` + `Try next`
- certificate startup failure -> certificate-specific `Try next`
- generic startup failure -> concise summary + `Try next`

- [ ] **Step 4: Re-run the focused runtime tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: PASS. Runtime output now reads like one consistent operator surface and startup failures follow the new conclusion/action/diagnostics order.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands.ts tests/cli/commands.test.ts
git commit -m "fix(cli): migrate runtime output to bare command palette"
```

## Task 4: Migrate Autostart And Uninstall Into The Mutation Confirmation Family

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/commands.test.ts`
- Modify: `src/cli/output.ts`

- [ ] **Step 1: Write the failing mutation-family tests**

Update `tests/cli/commands.test.ts` to cover:

- `autostart enable` rendering `Autostart enabled` + `Changed` + `Next steps`
- `autostart disable` rendering `Autostart disabled` with `Not found` as a compact no-op confirmation
- unsupported and mismatch autostart cases using warning-family subtitles instead of status-card framing
- `uninstall` success rendering `Removed` paths and one explicit next step
- `uninstall` partial failure rendering `Removed`, `Failed`, and `Try next`

Use assertions like:

```ts
expect(result.output).toContain("Autostart enabled");
expect(result.output).toContain("Changed");
expect(result.output).toContain("Launch agent");
```

and:

```ts
await expect(runCliCommand({ kind: "uninstall" }, services)).rejects.toThrow(/Uninstall incomplete/);
```

- [ ] **Step 2: Run the focused mutation tests and verify they fail**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because autostart and uninstall still render panel-era titles and do not consistently use the new mutation confirmation language.

- [ ] **Step 3: Implement the mutation-family outputs**

Update `formatAutostartResult(...)` and the uninstall branch in `runCliCommand(...)` so they use:

- title-case result lines such as `Autostart enabled`
- `Changed`, `Removed`, `Failed`, and `Next steps`
- warning subtitles for unsupported or mismatch cases

Use concrete shapes like:

```ts
return renderSuccessPanel({
  title: "Autostart enabled",
  headline: "CodeHelm will launch automatically for this user session",
  sections: [
    {
      kind: "key-value",
      title: "Changed",
      rows: [
        { key: "Label", value: result.label },
        { key: "Launch agent", value: result.launchAgentPath },
      ],
    },
    { kind: "steps", title: "Next steps", items: ["code-helm status"] },
  ],
  env,
});
```

For uninstall partial failures, keep the thrown pre-rendered error pattern, but make the rendered error use the new failure-family section ordering.

- [ ] **Step 4: Re-run the focused mutation tests and verify they pass**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: PASS. Autostart and uninstall now match the same mutation confirmation language as `update`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands.ts src/cli/output.ts tests/cli/commands.test.ts
git commit -m "fix(cli): migrate autostart and uninstall output"
```

## Task 5: Align Onboarding Copy And Command-Level Blocked Messaging

**Files:**
- Modify: `src/cli/onboard.ts`
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/onboard.test.ts`
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Write the failing onboarding tests**

Update `tests/cli/onboard.test.ts` and `tests/cli/commands.test.ts` to cover:

- intro copy staying concise and product-facing
- review summary rows appearing in a stable aligned order
- completion copy ending with one explicit next command
- already-running onboarding using the new warning family instead of the legacy loose runtime summary
- cancelled onboarding keeping a concise product-aligned sentence

Use expectations like:

```ts
expect(formatReviewSummary(input)).toContain("Bot");
expect(formatReviewSummary(input)).toContain("Discord bot token");
expect(formatReviewSummary(input)).toContain("Control channel");
```

and:

```ts
expect(result.output).toContain("Onboarding blocked");
expect(result.output).toContain("Try next");
expect(result.output).not.toContain("CodeHelm running");
```

- [ ] **Step 2: Run the focused onboarding tests and verify they fail**

Run:

```bash
bun test tests/cli/onboard.test.ts tests/cli/commands.test.ts
```

Expected: FAIL because onboarding still uses the old wizard copy, review-summary shape, and legacy already-running output path.

- [ ] **Step 3: Implement onboarding copy and blocked output alignment**

Update `src/cli/onboard.ts` so:

- `showWelcome()` uses a short product sentence
- `formatReviewSummary(...)` uses aligned concise labels
- `showCompleted()` ends with one explicit next command

Example target:

```ts
return [
  "Bot                CodeHelm Bot",
  "Discord bot token  abcd****",
  "Guild              Guild One",
  "Control channel    #control-room",
  "Codex App Server   managed (loopback, port assigned on start)",
  "Codex connect      codex --remote ws://127.0.0.1:<auto>",
].join("\n");
```

Update the `onboard` branch in `src/cli/commands.ts` so `already-running` returns a warning-family rendered screen like:

```ts
return {
  output: renderWarningPanel({
    title: "Onboarding blocked",
    headline: "Stop the active CodeHelm runtime before changing onboarding settings",
    sections: [
      { kind: "steps", title: "Try next", items: ["code-helm stop", "code-helm onboard"] },
    ],
    env: services.env,
  }),
  runtime: currentRuntime,
};
```

- [ ] **Step 4: Re-run the focused onboarding tests and verify they pass**

Run:

```bash
bun test tests/cli/onboard.test.ts tests/cli/commands.test.ts
```

Expected: PASS. Onboarding copy and blocked output now feel like part of the same CLI product.

- [ ] **Step 5: Commit**

```bash
git add src/cli/onboard.ts src/cli/commands.ts tests/cli/onboard.test.ts tests/cli/commands.test.ts
git commit -m "fix(onboard): align onboarding copy with bare command palette"
```

## Task 6: Run Full Verification And Clean Up Cross-Test Drift

**Files:**
- Modify: `tests/cli/output.test.ts`
- Modify: `tests/cli/commands.test.ts`
- Modify: `tests/cli/onboard.test.ts`
- Modify: `src/cli/output.ts`
- Modify: `src/cli/commands.ts`
- Modify: `src/cli/onboard.ts`

- [ ] **Step 1: Run the full CLI-focused test set**

Run:

```bash
bun test tests/cli/output.test.ts tests/cli/commands.test.ts tests/cli/onboard.test.ts tests/cli/args.test.ts
```

Expected: PASS. If there is any copy drift or helper mismatch left, fix it before broader verification.

- [ ] **Step 2: Run the full Bun test suite**

Run:

```bash
bun test
```

Expected: PASS. The CLI redesign should not regress unrelated runtime behavior.

- [ ] **Step 3: Run type checking**

Run:

```bash
bun run typecheck
```

Expected: PASS. The new renderer section types and migrated command call sites should be fully typed.

- [ ] **Step 4: Make any final minimal fixes required by the full run**

If a final compatibility issue appears, fix only the smallest necessary code in the already-touched files. Do not expand scope beyond the bare command palette rollout.

- [ ] **Step 5: Commit**

```bash
git add src/cli/output.ts src/cli/commands.ts src/cli/onboard.ts tests/cli/output.test.ts tests/cli/commands.test.ts tests/cli/onboard.test.ts
git commit -m "test(cli): verify bare command palette rollout"
```
