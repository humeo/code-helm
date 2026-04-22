# README Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `README.md` into a product-first public landing page that highlights Discord control, session continuation, approvals, and progress visibility while keeping install and quick start concise.

**Architecture:** Keep the change scoped to `README.md` and follow the approved spec in `docs/superpowers/specs/2026-04-21-readme-rewrite-design.md`. Reorder the document so value and onboarding come first, move practical operating notes lower, and remove `Advanced Overrides` and `Legacy Workspace Import` from the main structure. Use explicit `[TODO: ...]` placeholders anywhere the approved spec expects missing assets or guides.

**Tech Stack:** Markdown, GitHub-flavored Markdown, existing repository docs structure

---

## File Structure

### Files To Modify

- Modify: `README.md`

### Reference Files

- Reference: `docs/superpowers/specs/2026-04-21-readme-rewrite-design.md`
- Reference: `docs/release.md`

### Notes

- This is a docs-only change.
- No runtime code, tests, or package metadata should change as part of this implementation.
- Validation is structural and content-based rather than test-suite based.

### Task 1: Rewrite The Product-Facing Opening

**Files:**
- Modify: `README.md`
- Reference: `docs/superpowers/specs/2026-04-21-readme-rewrite-design.md`

- [ ] **Step 1: Confirm the current opening does not match the approved product-first direction**

Run:

```bash
rg -n "^# CodeHelm|^## Demo Video$|^## Prerequisites$|^## Why CodeHelm$" README.md
```

Expected:

- `# CodeHelm` is present
- `## Demo Video` is missing
- `## Prerequisites` is missing
- `## Why CodeHelm` is missing

- [ ] **Step 2: Rewrite the title block, one-line summary, intro paragraph, and top-value bullets**

Write the opening so it includes:

- the existing `# CodeHelm` title
- a one-line summary centered on controlling Codex sessions from Discord
- a short paragraph that mentions starting sessions, resuming sessions, approvals, and progress
- exactly four top-value bullets that emphasize:
  - control from Discord
  - resume and continue existing sessions
  - approvals from Discord
  - progress and final output in the same thread

- [ ] **Step 3: Add the `Demo Video` section with approved placeholders**

Add a `## Demo Video` section directly after the opening value section.

Include these placeholders exactly:

```md
[TODO: add demo video link]
[TODO: add demo thumbnail or GIF]
```

Also include a short checklist describing what the demo should show.

- [ ] **Step 4: Verify the new opening structure exists**

Run:

```bash
rg -n "^# CodeHelm$|^## Demo Video$" README.md
```

Expected:

- the title still exists
- `## Demo Video` now exists

- [ ] **Step 5: Commit the opening rewrite**

```bash
git add README.md
git commit -m "docs: rewrite readme opening"
```

### Task 2: Rewrite Prerequisites, Install, And Quick Start

**Files:**
- Modify: `README.md`
- Reference: `docs/superpowers/specs/2026-04-21-readme-rewrite-design.md`

- [ ] **Step 1: Confirm the current README still uses the older install/onboarding structure**

Run:

```bash
rg -n "^## Before You Install$|^## Install$|^## Quick Start$|bun add -g code-helm|\\[TODO: add Discord bot setup guide/link\\]" README.md
```

Expected:

- `## Install` and `## Quick Start` exist
- `## Before You Install` may exist in older form
- `bun add -g code-helm` is missing
- `[TODO: add Discord bot setup guide/link]` is missing

- [ ] **Step 2: Replace the pre-install section with `Prerequisites`**

Rewrite the pre-install guidance into a `## Prerequisites` section.

It must explicitly include:

- Bun installed on the machine
- Codex installed on the machine
- a Discord bot token
- bot invited to the target Discord server
- one text control channel
- `Message Content Intent` enabled
- `[TODO: add Discord bot setup guide/link]`

- [ ] **Step 3: Rewrite `Install` to offer two official install methods**

Rewrite `## Install` so it:

- tells the reader to choose one install method
- includes:

```bash
npm install -g code-helm
```

```bash
bun add -g code-helm
```

- clarifies that Bun is still required at runtime

- [ ] **Step 4: Rewrite `Quick Start` into the approved happy-path flow**

Rewrite `## Quick Start` so it covers:

1. `code-helm onboard`
2. `code-helm start` and `code-helm start --daemon`
3. `codex --remote <ws-url>`
4. Discord control via `/workdir`, `/session-new`, `/session-resume`, approvals, and progress visibility

It must also include these placeholders:

- `[TODO: add sample startup output with ws-url]`
- `[TODO: add Discord thread screenshot or transcript snippet]`
- `[TODO: add approval screenshot or transcript snippet]`

End the section with a sentence that reinforces that the Discord thread stays attached to its Codex session.

- [ ] **Step 5: Verify the new install and quick start content exists**

Run:

```bash
rg -n "^## Prerequisites$|^## Install$|^## Quick Start$|bun add -g code-helm|codex --remote <ws-url>|\\[TODO: add sample startup output with ws-url\\]" README.md
```

Expected:

- all three section headings exist
- `bun add -g code-helm` exists
- `codex --remote <ws-url>` exists
- the startup output placeholder exists

- [ ] **Step 6: Commit the install and quick start rewrite**

```bash
git add README.md
git commit -m "docs: rewrite readme setup flow"
```

### Task 3: Rewrite The Back Half And Remove Deprecated Main Sections

**Files:**
- Modify: `README.md`
- Reference: `docs/superpowers/specs/2026-04-21-readme-rewrite-design.md`
- Reference: `docs/release.md`

- [ ] **Step 1: Confirm deprecated main-README sections still exist before replacement**

Run:

```bash
rg -n "^## Advanced Overrides$|^## Legacy Workspace Import$|^## Development$" README.md
```

Expected:

- `## Development` exists
- `## Advanced Overrides` exists
- `## Legacy Workspace Import` exists

- [ ] **Step 2: Add `Why CodeHelm` and `How It Works` using the approved positioning**

Write:

- a `## Why CodeHelm` section that explicitly says CodeHelm is not just a Discord bot wrapper
- a `## How It Works` section that briefly explains:
  - local daemon
  - managed Codex App Server
  - Discord thread to Codex session binding
  - persisted session and approval state

Keep both sections short and outcome-focused.

- [ ] **Step 3: Rewrite the operational back half into the approved sections**

Make sure the remainder of the document uses these sections:

- `## Operational Notes`
- `## Autostart`
- `## Uninstall`
- `## Development`

Preserve useful content from the old README, but move it into the new shape:

- local state paths
- what CodeHelm touches
- what it does not install
- stop command
- macOS autostart commands
- uninstall behavior
- development commands
- release guide link

- [ ] **Step 4: Remove `Advanced Overrides` and `Legacy Workspace Import` from the main README**

Delete those sections from `README.md` entirely.

Do not create replacement top-level sections for them in this change.

- [ ] **Step 5: Verify the final heading structure and deprecated-section removal**

Run:

```bash
rg -n "^## " README.md
```

Expected:

- the README headings appear in this order:
  - `Demo Video`
  - `Prerequisites`
  - `Install`
  - `Quick Start`
  - `Why CodeHelm`
  - `How It Works`
  - `Operational Notes`
  - `Autostart`
  - `Uninstall`
  - `Development`
- no `Advanced Overrides`
- no `Legacy Workspace Import`

- [ ] **Step 6: Commit the back-half rewrite**

```bash
git add README.md
git commit -m "docs: finalize readme structure"
```

### Task 4: Final Review And Validation

**Files:**
- Modify: `README.md`
- Reference: `docs/superpowers/specs/2026-04-21-readme-rewrite-design.md`

- [ ] **Step 1: Read the full README top to bottom for tone, flow, and placeholder coverage**

Check that:

- the opening reads like a product page
- the middle reads like onboarding
- the bottom reads like operator and contributor notes
- all approved placeholders are present

- [ ] **Step 2: Verify key required phrases and placeholders are still present**

Run:

```bash
rg -n "Control your Codex sessions from Discord\\.|Resume and continue existing Codex sessions|Approve requests without leaving Discord|Watch progress and final output in the same thread|\\[TODO: add demo video link\\]|\\[TODO: add Discord bot setup guide/link\\]" README.md
```

Expected:

- the approved positioning language is present
- the required top-value bullets are present
- the demo video placeholder is present
- the Discord bot setup guide placeholder is present

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff -- README.md
```

Expected:

- only `README.md` changes for the implementation
- the diff reflects the approved section order and messaging

- [ ] **Step 4: Commit the final polish**

```bash
git add README.md
git commit -m "docs: polish readme rewrite"
```

- [ ] **Step 5: Record verification notes**

Document in the task handoff or PR summary:

- this is a docs-only change
- no automated test suite changes were required
- validation was done through structural review and targeted content checks
