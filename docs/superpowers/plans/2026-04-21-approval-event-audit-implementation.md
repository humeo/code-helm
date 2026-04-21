# Approval Event Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a protocol-backed audit report for every approval-related event in scope, separating current CodeHelm bugs from support gaps and future integration risks.

**Architecture:** Treat the audit as a document-producing execution project rather than a feature patch. For each event type, gather authoritative protocol evidence from the local `codex` binary, gather current CodeHelm behavior evidence from the repository and local runtime artifacts, then write one report section that classifies findings across parsing, persistence, rendering, response shape, and recovery semantics.

**Tech Stack:** Bun, TypeScript, bun:test, SQLite, Discord.js, Codex App Server JSON-RPC, local `codex` CLI

---

## File Map

- Create: `docs/superpowers/specs/2026-04-21-approval-event-audit-report.md`
  Final audit report with executive summary, per-event findings, and cross-cutting root causes.
- Modify: `docs/superpowers/plans/2026-04-21-approval-event-audit-implementation.md`
  Check off completed steps as the audit proceeds.
- Reference: `docs/superpowers/specs/2026-04-21-approval-event-audit-design.md`
  Source of scope, evidence standards, and severity rules.
- Inspect: `src/index.ts`
  Main approval request extraction, decision catalog generation, Discord rendering handoff, and `serverRequest/resolved` handling.
- Inspect: `src/codex/protocol-types.ts`
  Local approval request typing and helper logic for provider decisions.
- Inspect: `src/codex/jsonrpc-client.ts`
  Outbound reply serialization and request lifecycle tracking.
- Inspect: `src/db/repos/approvals.ts`
  Durable approval snapshot and resolution metadata persistence.
- Inspect: `src/domain/approval-service.ts`
  Local decision-label mapping and approval state semantics.
- Inspect: `src/discord/approval-ui.ts`
  Pending button labels, body copy, and terminal result rendering.
- Inspect: `tests/index.test.ts`
  Integration coverage for approval persistence, rendering, and resolution.
- Inspect: `tests/domain/approval-service.test.ts`
  Coverage for local approval-decision semantics.
- Inspect: `tests/db/approval-repo.test.ts`
  Coverage for durable approval snapshot and resolution metadata behavior.
- Inspect: `tests/codex/jsonrpc-client.test.ts`
  Coverage for request routing and reply serialization.
- Inspect runtime artifact: `~/.local/share/code-helm/codehelm.sqlite`
  Real local approval rows and stored decision catalogs where available.
- Use scratch output: temporary directory from `codex app-server generate-ts --experimental`
  Authoritative generated protocol bindings. Do not commit this directory.

## Task 1: Generate Authoritative Protocol Artifacts And Scaffold The Audit Report

**Files:**
- Create: `docs/superpowers/specs/2026-04-21-approval-event-audit-report.md`
- Modify: `docs/superpowers/plans/2026-04-21-approval-event-audit-implementation.md`
- Reference: `docs/superpowers/specs/2026-04-21-approval-event-audit-design.md`

- [x] **Step 1: Create the report skeleton**

Create `docs/superpowers/specs/2026-04-21-approval-event-audit-report.md` with these sections:

```md
# CodeHelm Approval Event Audit Report

Date: 2026-04-21

## Executive Summary

## Findings By Event

### item/commandExecution/requestApproval

### item/fileChange/requestApproval

### item/permissions/requestApproval

### applyPatchApproval

### execCommandApproval

### serverRequest/resolved and recovery chain

## Cross-Cutting Root Causes
```

- [x] **Step 2: Generate the current protocol bindings**

Run:

```bash
tmpdir=$(mktemp -d)
codex app-server generate-ts --experimental --out "$tmpdir"
echo "$tmpdir"
```

Expected: PASS. A temporary directory is printed and contains generated files such as:

- `v2/CommandExecutionRequestApprovalParams.ts`
- `v2/FileChangeRequestApprovalParams.ts`
- `v2/PermissionsRequestApprovalParams.ts`
- `ApplyPatchApprovalParams.ts`
- `ExecCommandApprovalParams.ts`

- [x] **Step 3: Record the authoritative files for later sections**

Run:

```bash
find "$tmpdir" -maxdepth 2 -type f | sort | rg 'Approval|resolved|Request'
```

Expected: PASS. The output lists the exact generated request and response files that will be cited in the audit report.

Paste the generated-path references into the report introduction so later tasks can cite the same protocol snapshot consistently.

- [x] **Step 4: Verify the repository already exposes the shared approval chain**

Run:

```bash
rg -n "item/commandExecution/requestApproval|item/fileChange/requestApproval|item/permissions/requestApproval|applyPatchApproval|execCommandApproval|serverRequest/resolved" src tests
```

Expected: PASS. The output shows which protocol surfaces are already wired into CodeHelm and which are absent or only represented in generated protocol artifacts.

- [x] **Step 5: Commit the audit scaffold**

```bash
git add docs/superpowers/specs/2026-04-21-approval-event-audit-report.md docs/superpowers/plans/2026-04-21-approval-event-audit-implementation.md
git commit -m "docs: scaffold approval event audit report"
```

## Task 2: Audit `item/commandExecution/requestApproval` As The Baseline Event

**Files:**
- Modify: `docs/superpowers/specs/2026-04-21-approval-event-audit-report.md`
- Inspect: `src/index.ts`
- Inspect: `src/codex/protocol-types.ts`
- Inspect: `src/domain/approval-service.ts`
- Inspect: `src/discord/approval-ui.ts`
- Inspect: `tests/index.test.ts`
- Inspect: `tests/domain/approval-service.test.ts`
- Inspect runtime artifact: `~/.local/share/code-helm/codehelm.sqlite`

- [x] **Step 1: Capture the real command-approval request and response shape**

Run:

```bash
sed -n '1,220p' "$tmpdir"/v2/CommandExecutionRequestApprovalParams.ts
sed -n '1,160p' "$tmpdir"/v2/CommandExecutionRequestApprovalResponse.ts
```

Expected: PASS. The output shows the authoritative request fields, including `availableDecisions`, and the response shape that returns a command approval decision.

- [x] **Step 2: Capture current CodeHelm mapping points**

Run:

```bash
rg -n "availableDecisions|commandPreview|normalizeApprovalCommandPreview|replyToServerRequest|resolvedProviderDecision" src/index.ts src/codex/protocol-types.ts src/domain/approval-service.ts src/discord/approval-ui.ts
```

Expected: PASS. The output identifies the exact lines where CodeHelm reads command approval fields, generates labels, serializes replies, and renders terminal outcomes.

- [x] **Step 3: Inspect real stored command approval rows**

Run:

```bash
python3 - <<'PY'
import json, sqlite3
path = '/Users/koltenluca/.local/share/code-helm/codehelm.sqlite'
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
rows = conn.execute("""
SELECT approval_key, request_id, status, request_kind, display_title, command_preview, justification, decision_catalog, resolved_provider_decision
FROM approvals
WHERE request_kind = 'command_execution'
ORDER BY datetime(updated_at) DESC
LIMIT 5
""").fetchall()
for row in rows:
    print(dict(row))
    if row["decision_catalog"]:
        print(json.loads(row["decision_catalog"]))
PY
```

Expected: PASS. Recent command approvals should show persisted `decision_catalog` data and enough terminal metadata to judge whether command semantics survive persistence.

- [x] **Step 4: Run the focused command approval tests**

Run:

```bash
bun test tests/index.test.ts -t "live command approvals"
bun test tests/domain/approval-service.test.ts -t "provider-backed decisions preserve offered order and labels"
```

Expected: PASS. The tests demonstrate the current intended baseline for command approval request parsing and decision rendering.

- [x] **Step 5: Write the command approval section and commit**

Update the report with:

- authoritative protocol shape
- current CodeHelm behavior
- any copy, mapping, persistence, response-shape, or recovery findings
- severity and follow-up recommendation

Then commit:

```bash
git add docs/superpowers/specs/2026-04-21-approval-event-audit-report.md
git commit -m "docs: audit command approval event"
```

## Task 3: Audit `item/fileChange/requestApproval` End-To-End

**Files:**
- Modify: `docs/superpowers/specs/2026-04-21-approval-event-audit-report.md`
- Inspect: `src/index.ts`
- Inspect: `src/domain/approval-service.ts`
- Inspect: `src/discord/approval-ui.ts`
- Inspect: `tests/index.test.ts`
- Inspect: `tests/domain/approval-service.test.ts`
- Inspect runtime artifact: `~/.local/share/code-helm/codehelm.sqlite`

- [x] **Step 1: Capture the real file-change request and response shape**

Run:

```bash
sed -n '1,200p' "$tmpdir"/v2/FileChangeRequestApprovalParams.ts
sed -n '1,160p' "$tmpdir"/v2/FileChangeRequestApprovalResponse.ts
```

Expected: PASS. The output should show that file-change approvals expose `reason` and optional `grantRoot`, while the response is a file-change decision enum.

- [x] **Step 2: Inspect real local file-change rows**

Run:

```bash
python3 - <<'PY'
import json, sqlite3
path = '/Users/koltenluca/.local/share/code-helm/codehelm.sqlite'
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
rows = conn.execute("""
SELECT approval_key, request_id, status, request_kind, display_title, justification, decision_catalog, resolved_provider_decision, updated_at
FROM approvals
WHERE request_kind = 'file_change'
ORDER BY datetime(updated_at) DESC
LIMIT 10
""").fetchall()
for row in rows:
    print(dict(row))
    if row["decision_catalog"]:
        print(json.loads(row["decision_catalog"]))
PY
```

Expected: PASS. If file-change approvals exist locally, the rows reveal whether retry-oriented `reason` text is being persisted as body copy and whether a decision catalog was synthesized.

- [x] **Step 3: Run the focused file-change tests**

Run:

```bash
bun test tests/index.test.ts -t "live file-change approvals"
bun test tests/domain/approval-service.test.ts -t "file-change decisions use session-scope write copy when grantRoot is present"
```

Expected: PASS. The tests show the current repository behavior for synthesized file-change decisions and current wording assumptions.

- [x] **Step 4: Capture the file-change mapping and rendering path**

Run:

```bash
rg -n "item/fileChange/requestApproval|grantRoot|grant_root|file_change|acceptForSession|continue without applying" src/index.ts src/domain/approval-service.ts src/discord/approval-ui.ts tests/index.test.ts
```

Expected: PASS. The output identifies where CodeHelm synthesizes file-change decisions, labels path/session scope, and persists body copy.

- [x] **Step 5: Write the file-change section and commit**

Document:

- protocol shape
- real stored evidence
- current behavior
- whether the bug is copy-only or model-level
- severity and follow-up

Then commit:

```bash
git add docs/superpowers/specs/2026-04-21-approval-event-audit-report.md
git commit -m "docs: audit file change approval event"
```

## Task 4: Audit `item/permissions/requestApproval` For Response-Shape And Lifecycle Risk

**Files:**
- Modify: `docs/superpowers/specs/2026-04-21-approval-event-audit-report.md`
- Inspect: `src/index.ts`
- Inspect: `src/codex/jsonrpc-client.ts`
- Inspect: `src/domain/approval-service.ts`
- Inspect: `tests/index.test.ts`
- Inspect: `tests/codex/jsonrpc-client.test.ts`
- Inspect runtime artifact: `~/.local/share/code-helm/codehelm.sqlite`

- [x] **Step 1: Capture the real permissions request and response shape**

Run:

```bash
sed -n '1,200p' "$tmpdir"/v2/PermissionsRequestApprovalParams.ts
sed -n '1,200p' "$tmpdir"/v2/PermissionsRequestApprovalResponse.ts
```

Expected: PASS. The output should make clear whether permissions approvals are answered by a structured payload rather than a single scalar `decision`.

- [x] **Step 2: Trace the current generic reply path**

Run:

```bash
rg -n "replyToServerRequest\\(|decisionCatalog|providerDecision|item/permissions/requestApproval" src/index.ts src/codex/jsonrpc-client.ts tests/index.test.ts tests/codex/jsonrpc-client.test.ts
```

Expected: PASS. The output shows whether permissions approvals are routed through the same generic decision path as command and file-change approvals.

- [x] **Step 3: Inspect any real stored permissions rows**

Run:

```bash
python3 - <<'PY'
import json, sqlite3
path = '/Users/koltenluca/.local/share/code-helm/codehelm.sqlite'
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
rows = conn.execute("""
SELECT approval_key, request_id, status, request_kind, display_title, justification, decision_catalog, resolved_provider_decision, updated_at
FROM approvals
WHERE request_kind = 'permissions'
ORDER BY datetime(updated_at) DESC
LIMIT 10
""").fetchall()
for row in rows:
    print(dict(row))
    if row["decision_catalog"]:
        print(json.loads(row["decision_catalog"]))
PY
```

Expected: PASS. If no rows exist, note that the runtime has no live sample and rely on protocol plus repository evidence for the finding.

- [x] **Step 4: Run the focused permissions tests**

Run:

```bash
bun test tests/index.test.ts -t "live permissions approvals"
bun test tests/codex/jsonrpc-client.test.ts -t "routes file and permissions approval requests to subscribers"
```

Expected: PASS. The tests should confirm that request routing exists, even if they do not yet prove response-shape correctness.

- [x] **Step 5: Write the permissions section and commit**

Document:

- whether permissions approvals fit the current generic decision abstraction
- whether current rendering or reply logic risks producing the wrong outbound shape
- severity and recommended follow-up

Then commit:

```bash
git add docs/superpowers/specs/2026-04-21-approval-event-audit-report.md
git commit -m "docs: audit permissions approval event"
```

## Task 5: Audit `applyPatchApproval` And `execCommandApproval` As Unintegrated Approval APIs

**Files:**
- Modify: `docs/superpowers/specs/2026-04-21-approval-event-audit-report.md`
- Inspect: `src/index.ts`
- Inspect: `src/codex/protocol-types.ts`
- Inspect generated protocol files in `"$tmpdir"`

- [x] **Step 1: Capture the real `applyPatchApproval` and `execCommandApproval` shapes**

Run:

```bash
sed -n '1,200p' "$tmpdir"/ApplyPatchApprovalParams.ts
sed -n '1,200p' "$tmpdir"/ExecCommandApprovalParams.ts
```

Expected: PASS. The output shows whether these APIs carry structured file changes, array-based commands, explicit `approvalId`, or other fields that the current generic approval model cannot represent faithfully.

- [x] **Step 2: Verify whether CodeHelm consumes either API today**

Run:

```bash
rg -n "applyPatchApproval|execCommandApproval" src tests
```

Expected: PASS. The output should clearly show whether these APIs are consumed, ignored, or only present in protocol-generation artifacts.

- [x] **Step 3: Compare each shape against the current approval abstraction**

Run:

```bash
rg -n "readApprovalEventString|normalizeApprovalCommandPreview|buildApprovalKey|ApprovalRequestEvent|decisionCatalog" src/index.ts src/codex/protocol-types.ts src/db/repos/approvals.ts
```

Expected: PASS. The output identifies where the current abstraction assumes string-based request fields or the Discord-wired approval event model.

- [x] **Step 4: Write the unintegrated-API sections**

In the report, classify each API as one of:

- currently supported safely
- support gap only
- future integration risk due to abstraction mismatch

Call out specific mismatches such as:

- structured `fileChanges` not fitting the current snapshot model
- array-based commands and `parsedCmd` not fitting current preview extraction
- explicit `approvalId` semantics not matching current request-key assumptions

- [x] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-04-21-approval-event-audit-report.md
git commit -m "docs: audit unintegrated approval APIs"
```

## Task 6: Audit `serverRequest/resolved` And Resume/Recovery Semantics Across Approval Types

**Files:**
- Modify: `docs/superpowers/specs/2026-04-21-approval-event-audit-report.md`
- Inspect: `src/index.ts`
- Inspect: `src/db/repos/approvals.ts`
- Inspect: `src/discord/approval-ui.ts`
- Inspect: `tests/index.test.ts`
- Inspect: `tests/db/approval-repo.test.ts`
- Inspect: `tests/discord/approval-ui.test.ts`

- [x] **Step 1: Trace the shared resolved-event path**

Run:

```bash
rg -n "serverRequest/resolved|resolvedProviderDecision|resolvedBySurface|resolvedElsewhere|reconcileResumedApprovalState" src/index.ts src/db/repos/approvals.ts src/discord/approval-ui.ts tests/index.test.ts tests/db/approval-repo.test.ts tests/discord/approval-ui.test.ts
```

Expected: PASS. The output shows how pending approvals become terminal, how remote resolution is tracked, and how resume/recovery rehydrates approval state.

- [x] **Step 2: Run the focused resolution and recovery tests**

Run:

```bash
bun test tests/index.test.ts -t "resolved events without threadId"
bun test tests/index.test.ts -t "resume re-seeds a locally answered approval"
bun test tests/db/approval-repo.test.ts -t "resolved"
bun test tests/discord/approval-ui.test.ts -t "terminal approvals collapse"
```

Expected: PASS. The tests should show the current shared lifecycle semantics that affect every integrated approval type.

- [x] **Step 3: Inspect recent resolved approval rows**

Run:

```bash
python3 - <<'PY'
import sqlite3
path = '/Users/koltenluca/.local/share/code-helm/codehelm.sqlite'
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
rows = conn.execute("""
SELECT approval_key, request_kind, status, resolved_provider_decision, resolved_by_surface, resolved_elsewhere, updated_at
FROM approvals
ORDER BY datetime(updated_at) DESC
LIMIT 15
""").fetchall()
for row in rows:
    print(dict(row))
PY
```

Expected: PASS. The output reveals whether local persistence retains enough terminal metadata to explain resolutions later.

- [x] **Step 4: Write the shared lifecycle section**

Document:

- strengths of the current resolved and resume path
- gaps that affect more than one approval type
- whether any event type loses meaning specifically during terminal or recovery handling

- [x] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-04-21-approval-event-audit-report.md
git commit -m "docs: audit approval resolution and recovery chain"
```

## Task 7: Finish The Report, Verify The Evidence, And Hand Off Execution

**Files:**
- Modify: `docs/superpowers/specs/2026-04-21-approval-event-audit-report.md`
- Modify: `docs/superpowers/plans/2026-04-21-approval-event-audit-implementation.md`

- [x] **Step 1: Write the executive summary and cross-cutting root causes**

Summarize:

- which approval events are healthy baselines
- which have confirmed user-visible bugs
- which are structurally mismatched or only support gaps
- which root causes repeat across events

- [x] **Step 2: Verify the report cites real evidence for every event**

Run:

```bash
rg -n "Severity:|Evidence:|Protocol:|Current behavior:|Recommendation:" docs/superpowers/specs/2026-04-21-approval-event-audit-report.md
```

Expected: PASS. Every event section should include protocol evidence, current behavior evidence, a classification, and a recommendation.

- [x] **Step 3: Re-run the focused audit commands one final time**

Run:

```bash
bun test tests/index.test.ts tests/domain/approval-service.test.ts tests/db/approval-repo.test.ts tests/codex/jsonrpc-client.test.ts tests/discord/approval-ui.test.ts
```

Expected: PASS. The report's claims remain aligned with the current repository behavior.

- [ ] **Step 4: Commit the finished audit report**

```bash
git add docs/superpowers/specs/2026-04-21-approval-event-audit-report.md docs/superpowers/plans/2026-04-21-approval-event-audit-implementation.md
git commit -m "docs: finish approval event audit report"
```

- [ ] **Step 5: Present the result and stop before code fixes**

Prepare a concise handoff that includes:

- the report path
- highest-severity findings
- current-bug versus support-gap split
- suggested next repair scope (`P0/P1 only` vs broader abstraction cleanup)

Do not start implementing fixes until a separate execution decision is made.
