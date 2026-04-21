# CodeHelm Approval Event Audit Report

Date: 2026-04-21

Protocol snapshot:

- Generated with `codex app-server generate-ts --experimental --out /var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO`
- Audit-reference files:
  - `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/CommandExecutionRequestApprovalParams.ts`
  - `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/CommandExecutionRequestApprovalResponse.ts`
  - `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/FileChangeRequestApprovalParams.ts`
  - `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/FileChangeRequestApprovalResponse.ts`
  - `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/PermissionsRequestApprovalParams.ts`
  - `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/PermissionsRequestApprovalResponse.ts`
  - `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/ApplyPatchApprovalParams.ts`
  - `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/ApplyPatchApprovalResponse.ts`
  - `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/ExecCommandApprovalParams.ts`
  - `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/ExecCommandApprovalResponse.ts`
  - `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/ServerRequestResolvedNotification.ts`

Repository coverage snapshot:

- Wired request methods found in `src/` and `tests/`: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, and `serverRequest/resolved`
- `applyPatchApproval` and `execCommandApproval` are not yet consumed by the current repository search surface and will be audited as protocol-exposed integration risks

## Executive Summary

- Confirmed current bug: real `item/fileChange/requestApproval` events lose their decision catalog and `grantRoot` semantics before persistence, so Discord falls back to generic approval buttons and cannot render accurate file-change/session-scope copy.
- Confirmed wired-surface structural mismatch: `item/permissions/requestApproval` is routed into the generic string-decision approval flow even though the upstream response must be `{ permissions, scope }`. This surface is discoverable today but not safely resolvable.
- Partial baseline only: `item/commandExecution/requestApproval` works well for the string-decision subset exercised in current tests and local runtime data, but the richer object-valued amendment decisions in the protocol are not fully represented by the current parsing or reply model.
- Support gap plus future-risk: `applyPatchApproval` and `execCommandApproval` are not wired into the repository today, but their structured payloads and `ReviewDecision` shapes would not fit the current approval abstraction if integrated naively.
- Shared lifecycle result: the `serverRequest/resolved` and resume path is strong on replay suppression, ambiguity handling, and terminal-origin tracking, but it loses approval-specific terminal meaning when remote resolution metadata is generic or incomplete.

## Findings By Event

### item/commandExecution/requestApproval

Protocol:

- `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/CommandExecutionRequestApprovalParams.ts` shows a rich request shape: `approvalId`, `reason`, `networkApprovalContext`, `command`, `cwd`, `commandActions`, `additionalPermissions`, proposed policy amendments, and ordered `availableDecisions`.
- `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/CommandExecutionRequestApprovalResponse.ts` returns `{ decision }`, but `decision` is not string-only: `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/CommandExecutionApprovalDecision.ts` includes both string decisions and object-valued amendment decisions.

Current behavior:

- CodeHelm uses `approvalId` when building the durable approval key, so command approvals with multiple callbacks under one `itemId` are disambiguated in [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L2022), [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L2316), and [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L6215).
- CodeHelm extracts only a small subset of the rich request payload: `command | cmd` into `commandPreview`, `reason` into stored `justification`, `cwd`, and a decision catalog from `availableDecisions` in [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L2135) and [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L2158).
- The current mapping does not persist `networkApprovalContext`, `commandActions`, `additionalPermissions`, `proposedExecpolicyAmendment`, or `proposedNetworkPolicyAmendments`, so those richer semantics are not available to Discord rendering or later recovery.
- Ordered string-like provider decisions are preserved and labeled via [`src/codex/protocol-types.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/codex/protocol-types.ts#L144) and [`src/domain/approval-service.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/domain/approval-service.ts#L195).
- The current decision parser only understands strings or objects with `decision`, `providerDecision`, or `key` fields in [`src/codex/protocol-types.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/codex/protocol-types.ts#L98), so object-valued `CommandExecutionApprovalDecision` variants such as `acceptWithExecpolicyAmendment` and `applyNetworkPolicyAmendment` are not faithfully represented from the generated protocol union.
- Discord pending rendering uses the stored command preview, justification, and cwd, and the focused tests confirm wrapper stripping plus decision-order preservation in [`tests/index.test.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/tests/index.test.ts#L5035) and [`tests/domain/approval-service.test.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/tests/domain/approval-service.test.ts#L143).
- The current outbound reply path only matches the string subset of the command-approval response shape: Discord interactions resolve to a string `providerDecision`, then call `replyToServerRequest({ requestId, decision: nextDecision.providerDecision })` in [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L4767), and the transport serializes `result: { decision }` in [`src/codex/jsonrpc-client.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/codex/jsonrpc-client.ts#L269).
- Real local rows in `~/.local/share/code-helm/codehelm.sqlite` show persisted `decision_catalog` data for recent `command_execution` requests, with `command_preview`, `justification`, and terminal `resolved_provider_decision` intact.

Evidence:

- Runtime rows inspected on 2026-04-21 showed recent `command_execution` approvals persisting `decision_catalog` JSON and `resolved_provider_decision = 'accept'`.
- Focused verification passed:
  - `bun test tests/index.test.ts -t "live command approvals"`
  - `bun test tests/domain/approval-service.test.ts -t "provider-backed decisions preserve offered order and labels"`
- The focused tests and live rows only exercised string decisions, not the object-valued amendment variants allowed by the generated protocol.

Severity:

- Medium current partial support: the request, persistence, and pending-render path are healthy for the currently observed string decisions.
- High protocol-compliance risk for richer command decisions because object-valued amendment variants are not fully representable in the current parsing or reply path.
- Medium shared lifecycle risk for command-specific terminal wording when richer provider decisions are resolved through the generic `serverRequest/resolved` chain rather than the local Discord reply path.

Recommendation:

- Keep using command approvals as the baseline healthy event.
- Treat command approvals as the strongest current baseline only for the string-decision subset that is actually exercised today.
- Preserve the richer protocol fields that are currently dropped before persistence, and add explicit support for object-valued `CommandExecutionApprovalDecision` variants before claiming full command-approval coverage.
- When auditing the shared resolved chain, verify that `acceptWithExecpolicyAmendment` and `applyNetworkPolicyAmendment` survive remote-resolution rendering with the same fidelity as the local Discord path.

### item/fileChange/requestApproval

Protocol:

- `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/FileChangeRequestApprovalParams.ts` exposes only `threadId`, `turnId`, `itemId`, optional `reason`, and optional `grantRoot`.
- `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/FileChangeRequestApprovalResponse.ts` returns `{ decision }`, and the upstream decision enum is `accept | acceptForSession | decline | cancel`.

Current behavior:

- CodeHelm routes file-change requests through the same generic approval snapshot path as command approvals in [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L2310), storing `displayTitle`, `requestKind`, and a `justification` string derived from `justification` or `reason`.
- The generic snapshot model does not persist `grantRoot`, so CodeHelm cannot explain or label session-scoped write access from the real file-change payload.
- File-change button labels do exist in [`src/domain/approval-service.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/domain/approval-service.ts#L167), but they are only used when a stored `decisionCatalog` exists. Real protocol-backed file-change requests do not expose `availableDecisions`, so `extractApprovalDecisionCatalogFromRequest()` returns `null`.
- When `decisionCatalog` is missing, Discord rendering falls back to generic `Approve / Decline / Cancel` decisions in [`src/discord/approval-ui.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/discord/approval-ui.ts#L67) and [`src/discord/approval-ui.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/discord/approval-ui.ts#L190), which is exactly where the observed Discord copy drift comes from.
- The focused repository test for file-change persistence currently fabricates `availableDecisions` and `cwd` fields that are not present in the authoritative protocol shape, so it validates a friendlier synthetic event, not the real protocol event in [`tests/index.test.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/tests/index.test.ts#L5156).

Evidence:

- Real runtime evidence from `~/.local/share/code-helm/codehelm.sqlite` on 2026-04-21 showed a live `file_change` row with:
  - `justification = 'command failed; retry without sandbox?'`
  - `decision_catalog = NULL`
  - `resolved_provider_decision = 'decline'`
- `bun test tests/index.test.ts -t "live file-change approvals"` passed, but the planned targeted test name for `grantRoot` matched zero tests, confirming a coverage gap around the real session-scope variant.
- Independent subagent audit confirmed the same two model-level gaps: missing persisted decision catalog and ignored `grantRoot`.

Severity:

- High current bug for Discord rendering fidelity on real file-change approvals.
- High lifecycle risk for session-scoped write approvals because `grantRoot` is lost before persistence and rendering.

Recommendation:

- Synthesize and persist the real file-change decision catalog from the upstream enum when `availableDecisions` is absent.
- Persist `grantRoot` and use it to drive file-change-specific copy instead of falling back to generic approval buttons.
- Replace the current synthetic file-change tests with protocol-accurate fixtures and add explicit coverage for `grantRoot` and retry-style `reason` payloads.

### item/permissions/requestApproval

Protocol:

- `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/PermissionsRequestApprovalParams.ts` requires `threadId`, `turnId`, `itemId`, `reason`, and a structured `permissions` object.
- `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/PermissionsRequestApprovalResponse.ts` requires a structured response: `{ permissions, scope }`.

Current behavior:

- CodeHelm currently treats permissions approvals as a generic string-decision approval event in the same `ApprovalRequestEvent` abstraction used for command and file-change requests in [`src/codex/protocol-types.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/codex/protocol-types.ts#L82) and [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L2310).
- The snapshot path stores only generic text fields and ignores the authoritative `permissions` payload entirely. Because the real protocol does not provide `availableDecisions`, the stored `decisionCatalog` is also `null`.
- The Discord UI therefore falls back to legacy generic decisions in [`src/discord/approval-ui.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/discord/approval-ui.ts#L67), even though the upstream reply model is not a string decision at all.
- Approval interactions resolve only string provider decisions from the hard-coded supported set in [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L1315) and [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L2386).
- `replyToServerRequest()` always serializes `{ decision }` in [`src/codex/jsonrpc-client.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/codex/jsonrpc-client.ts#L269), so the current reply path cannot produce the required `{ permissions, scope }` shape for a real permissions approval.
- The focused persistence test uses `justification` and `cwd` fields that do not exist in the authoritative protocol payload and does not assert anything about the required `permissions` object or structured reply in [`tests/index.test.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/tests/index.test.ts#L5196).

Evidence:

- No live `permissions` rows were present in `~/.local/share/code-helm/codehelm.sqlite` on 2026-04-21, so this finding is based on protocol evidence plus current repository behavior.
- Focused verification passed:
  - `bun test tests/index.test.ts -t "live permissions approvals"`
  - `bun test tests/codex/jsonrpc-client.test.ts -t "routes file and permissions approval requests to subscribers"`
- The transport reply test still asserts a scalar `{ decision: "approved" }` payload in [`tests/codex/jsonrpc-client.test.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/tests/codex/jsonrpc-client.test.ts#L203), which confirms the current generic reply assumption.

Severity:

- High structural mismatch on an already wired request surface.
- If a real permissions approval reaches Discord today, CodeHelm can display a placeholder prompt but cannot send a protocol-correct approval response.

Recommendation:

- Split permissions approvals out of the generic string-decision model before treating them as supported.
- Persist and render the structured `permissions` payload, and add a dedicated reply serializer for `{ permissions, scope }`.
- Until that exists, treat permissions approvals as a support gap rather than a safely integrated approval type.

### applyPatchApproval

Protocol:

- `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/ApplyPatchApprovalParams.ts` carries `conversationId`, `callId`, structured `fileChanges`, `reason`, and `grantRoot`.
- `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/ApplyPatchApprovalResponse.ts` returns `{ decision: ReviewDecision }`, where `ReviewDecision` can be plain strings or structured object variants.

Current behavior:

- Repository search found no `applyPatchApproval` consumer in `src/` or `tests/`, so this API is not currently integrated into CodeHelm.
- The current approval abstraction assumes `threadId`, `turnId`, `itemId`, string-readable snapshot fields, optional `availableDecisions`, and a string-oriented `decisionCatalog` in [`src/codex/protocol-types.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/codex/protocol-types.ts#L82), [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L2022), and [`src/db/repos/approvals.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/db/repos/approvals.ts#L7).
- Structured `fileChanges` and `grantRoot` would be dropped by the current snapshot model, and object-valued `ReviewDecision` variants would not fit the current string-only reply and button-mapping path.

Evidence:

- `rg -n "applyPatchApproval|execCommandApproval" src tests` returned no matches for `applyPatchApproval`.
- `ReviewDecision` includes structured variants such as `approved_execpolicy_amendment` and `network_policy_amendment`, which do not fit the current supported provider-decision string set.

Severity:

- Medium current support gap because the API is not wired today.
- High future integration risk if it is routed through the existing generic approval abstraction without redesign.

Recommendation:

- Treat `applyPatchApproval` as a separate integration track.
- Add a dedicated snapshot and UI model for `fileChanges` and `grantRoot` instead of trying to coerce it into the current command/file/permissions abstraction.

### execCommandApproval

Protocol:

- `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/ExecCommandApprovalParams.ts` carries `conversationId`, `callId`, optional `approvalId`, `command` as a string array, `cwd`, `reason`, and structured `parsedCmd`.
- `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/ExecCommandApprovalResponse.ts` also returns `{ decision: ReviewDecision }`, including object-valued review outcomes.

Current behavior:

- Repository search found no `execCommandApproval` consumer in `src/` or `tests/`, so this API is also unintegrated today.
- The current command approval path expects a shell-like string command plus `threadId` / `turnId` / `itemId` keys, then derives `commandPreview` by reading string fields and stripping wrapper shells in [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L2099) and [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L2144).
- `command: Array<string>`, `parsedCmd`, and object-valued `ReviewDecision` outcomes do not fit that abstraction, and the current approval-key builder only partly overlaps via optional `approvalId`.

Evidence:

- `rg -n "applyPatchApproval|execCommandApproval" src tests` returned no matches for `execCommandApproval`.
- The current `replyToServerRequest()` path emits only `{ decision }` with a scalar value, while `ReviewDecision` can carry structured amendments.

Severity:

- Medium current support gap.
- High future integration risk because command parsing, preview extraction, and response serialization all assume the Discord-wired v2 approval model.

Recommendation:

- Do not treat `execCommandApproval` as “almost supported” just because it sounds similar to `item/commandExecution/requestApproval`.
- Add a dedicated integration path that preserves array commands, `parsedCmd`, and structured `ReviewDecision` outcomes.

### serverRequest/resolved and recovery chain

Protocol:

- The shared terminal signal in scope is `serverRequest/resolved`, represented in the generated protocol snapshot by `/var/folders/py/j9ws8lpn57g_syngj3b58b6h0000gn/T/tmp.unWPIZW1AO/v2/ServerRequestResolvedNotification.ts`.
- This event is not the original approval payload. It is a lifecycle acknowledgment that must preserve enough local metadata to explain what happened after persistence and resume.

Current behavior:

- CodeHelm resolves stored approvals by request id, fails safe on ambiguous no-threadId matches, and falls back to the unique persisted request id when runtime associations are empty in [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L2279).
- Resume logic re-seeds pending or locally answered approvals into the thread surface and intentionally preserves terminal metadata through `reconcileResumedApprovalState()` in [`src/index.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/index.ts#L2774).
- The repo layer keeps resolution-origin metadata on resolved acknowledgments and prevents stale pending replays from reviving terminal approvals in [`src/db/repos/approvals.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/db/repos/approvals.ts#L298).
- Discord terminal rendering is mostly strong, but remote-result wording loses fidelity: `toRemoteDecisionText()` special-cases only `acceptForSession` and otherwise collapses richer outcomes to `approved` in [`src/discord/approval-ui.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/discord/approval-ui.ts#L196), even though the local path preserves richer text for exec-policy and network-amendment approvals in [`src/discord/approval-ui.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/src/discord/approval-ui.ts#L341).
- Real local rows also show remote-resolved approvals with `resolved_by_surface = 'codex_remote'` and `resolved_provider_decision = NULL`, which means the shared chain sometimes has only origin metadata, not the original semantic outcome.

Evidence:

- Focused verification passed:
  - `bun test tests/index.test.ts -t "resolved events without threadId"`
  - `bun test tests/index.test.ts -t "resume re-seeds a locally answered approval"`
  - `bun test tests/db/approval-repo.test.ts -t "resolved"`
  - `bun test tests/discord/approval-ui.test.ts -t "terminal approvals collapse"`
- Real sqlite rows on 2026-04-21 included remote command approvals with:
  - `status = 'resolved'`
  - `resolved_by_surface = 'codex_remote'`
  - `resolved_provider_decision = NULL`
- The UI test for remote terminal copy currently expects only `Handled in codex-remote: approved ...`, confirming the current generic remote-summary behavior in [`tests/discord/approval-ui.test.ts`](/Users/koltenluca/code-github/code-helm/.worktrees/approval-event-audit/tests/discord/approval-ui.test.ts#L172).

Severity:

- Medium shared lifecycle limitation.
- The resolved/recovery chain is robust for ownership, replay suppression, and origin tracking, but it is not semantically rich enough to preserve all approval-specific terminal meanings.

Recommendation:

- Preserve a richer normalized resolution outcome in persistence so remote acknowledgments can render event-specific terminal text instead of the generic remote summary.
- Keep the current ambiguity safeguards and replay suppression behavior; those are strengths, not problems.

## Cross-Cutting Root Causes

- CodeHelm flattens multiple upstream approval APIs into one generic `ApprovalRequestEvent` too early, before deciding which fields are human-facing text versus structured approval semantics.
- The current persistence model stores a small text snapshot plus an optional string-based decision catalog. That fits command approvals reasonably well, but it drops `grantRoot`, `permissions`, `fileChanges`, array commands, and structured review outcomes.
- UI rendering depends heavily on a persisted `decisionCatalog`. When the real upstream event does not carry `availableDecisions`, the product silently falls back to generic legacy buttons, which is the direct cause of the current file-change copy bug.
- Test fixtures overfit the current abstraction by inventing fields such as `availableDecisions`, `cwd`, or `justification` on protocol shapes that do not actually carry them. That hides mismatch bugs instead of detecting them.
