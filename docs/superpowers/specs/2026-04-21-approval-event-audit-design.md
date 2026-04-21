# CodeHelm Approval Event Audit Design

Date: 2026-04-21

## Summary

CodeHelm should run a protocol-backed audit across every approval-related event shape that can affect Discord approval behavior, persistence, or recovery semantics.

This audit is not a generic code review.

It is a bounded investigation with one goal:

- determine which approval event types already have user-visible bugs
- determine which approval event types have protocol-mapping or lifecycle risks
- separate current production bugs from support gaps for not-yet-integrated approval APIs

The audit should use two evidence sources together:

1. real protocol definitions generated from the local `codex` binary
2. local runtime evidence from CodeHelm's current mapping, persistence, rendering, and resolution flows

## Problem

The current approval model treats several different upstream approval shapes as if they were one mostly-uniform event.

That creates three kinds of risk.

### 1. Different approval APIs are being flattened too early

Some approval requests carry:

- ordered provider decisions
- structured command data
- filesystem scope data
- permission grant payloads

Others do not.

If CodeHelm assumes one shared shape too early, Discord copy and response behavior drift away from the real protocol.

### 2. A user-visible copy bug may only be one symptom

The observed Discord file-change bug is not only a wording issue.

It may also indicate:

- the wrong field is being treated as human-facing body copy
- a decision catalog is missing and local fallback logic is filling the gap
- persistence is storing a lossy snapshot
- terminal and resume behavior are preserving the wrong semantics

### 3. Some approval APIs may not yet be integrated cleanly

The local `codex` protocol exposes approval-related interfaces beyond the three Discord-wired request methods.

Those APIs may not currently cause a visible bug in CodeHelm, but they can reveal where the current abstraction would fail if integration expands.

## Approaches Considered

### 1. Static repository audit only

- inspect protocol-types, persistence, rendering, and tests
- do not gather runtime or generated-protocol evidence

Benefits:

- fastest option

Drawbacks:

- too dependent on local assumptions
- does not satisfy the requirement to personally inspect real payload shapes
- weak confidence when the repository uses loose `Record<string, unknown>` event models

### 2. Protocol-backed audit with local runtime evidence

Recommended.

- generate authoritative protocol bindings from the installed `codex` binary
- inspect real local approval rows and current runtime behavior where available
- replay event shapes through CodeHelm's current mapping paths when direct end-to-end capture is unavailable

Benefits:

- grounded in the real protocol, not guesswork
- still focused on audit rather than implementation scaffolding
- strong enough to classify current bugs versus integration gaps

Tradeoff:

- slower than static review
- requires disciplined evidence capture per event type

### 3. Full end-to-end integration exercise for every approval API

- force all approval-related APIs through a Discord-like path
- add temporary harnesses where necessary

Benefits:

- maximum realism

Drawbacks:

- expands from audit into feature work
- spends time building paths that do not exist in production
- obscures the simpler question of whether current assumptions are already wrong

## Goals

- audit all approval-related event types currently relevant to CodeHelm
- inspect real protocol request and response shapes before judging correctness
- verify each event type across request parsing, persistence, rendering, response, and resolved/recovery behavior
- classify findings by severity and by whether they are present bugs or support gaps
- produce a planning-ready report that can drive focused fixes later

## Non-Goals

- implementing all fixes during the audit itself
- forcing not-yet-integrated approval APIs into Discord just for completeness
- redesigning the approval UX in this phase
- changing upstream Codex approval protocol semantics
- broad refactoring unrelated to approval-event correctness

## Audit Scope

The audit covers five approval-related protocol surfaces.

### Discord-wired request methods

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`

### Additional approval-related protocol interfaces

- `applyPatchApproval`
- `execCommandApproval`

The audit also covers the shared resolution path:

- `serverRequest/resolved`

## Evidence Model

Each event type should be judged from both of these sources.

### 1. Protocol Evidence

Use the local `codex` binary to generate current TypeScript bindings with:

- `codex app-server generate-ts --experimental`

From those generated files, capture:

- request shape
- response shape
- decision model
- structured versus scalar fields
- any protocol notes that affect semantics

This source is the authority for what the upstream protocol actually means.

### 2. CodeHelm Behavior Evidence

Use the current repository and local environment to inspect:

- request extraction logic
- approval snapshot persistence
- decision catalog generation
- Discord rendering and button labeling
- reply serialization
- `serverRequest/resolved` handling
- resume and recovery behavior

When local runtime artifacts exist, use them.

When direct end-to-end samples do not exist, replay the real protocol shape through current repository paths without inventing new product behavior.

## Audit Chain

Every event type should be checked across the same five stages.

### 1. Request Input

- What does the real request payload look like?
- Which fields are human-facing?
- Which fields are structural?
- Is there an explicit decision catalog or only an implied decision set?

### 2. Local Mapping

- Which fields does CodeHelm currently read?
- Which fields are ignored?
- Are any fields misinterpreted?
- Does CodeHelm incorrectly coerce structured values into strings?

### 3. Persistence

- Which approval fields are stored durably?
- Which protocol semantics are dropped?
- Does the stored shape support correct terminal and resume behavior later?

### 4. Rendering And Interaction

- Are question copy, body copy, and button labels semantically correct?
- Are decisions rendered from the right source?
- Does the Discord UI reflect the real scope of the approval?

### 5. Resolution And Recovery

- Does the outbound response match the real protocol shape?
- Does `serverRequest/resolved` preserve the right terminal meaning?
- After persistence and resume, can CodeHelm still explain what happened correctly?

## Event-Specific Audit Criteria

### `item/commandExecution/requestApproval`

This is the baseline approval event.

Audit focus:

- `availableDecisions`
- command preview extraction
- `reason`
- `cwd`
- persisted `decisionCatalog`
- button labels for provider-backed decisions
- terminal wording for saved-session or policy-amendment outcomes
- `replyToServerRequest` decision serialization

Expected value of this audit:

- verify the healthy baseline
- detect whether special command decisions are being lost in terminal or recovery paths

### `item/fileChange/requestApproval`

This is the highest-risk currently visible event.

Audit focus:

- `reason`
- `grantRoot`
- locally synthesized decision set
- button wording for path or session-scoped approval
- whether system retry copy is being treated as user-facing body text
- whether persistence stores enough context to explain the approval later

Expected value of this audit:

- determine whether the current bug is isolated to one wording path or reflects a broader model mismatch

### `item/permissions/requestApproval`

This event must be checked especially carefully because its response shape differs from the simple decision-return model.

Audit focus:

- request payload semantics
- response payload semantics
- whether the current generic decision model is structurally compatible
- whether Discord rendering suggests decisions that cannot be serialized back correctly
- whether terminal and recovery paths preserve permission-specific meaning

Expected value of this audit:

- identify whether permissions approvals are safe, lossy, or fundamentally mismatched with the current abstraction

### `applyPatchApproval`

This event is approval-related but not currently wired through the same Discord request path.

Audit focus:

- structured `fileChanges`
- `reason`
- `grantRoot`
- whether the current approval snapshot model could represent this event without losing key semantics
- whether existing file-change assumptions would mis-handle it if future integration reuses current code

Expected value of this audit:

- classify present support gaps and future integration hazards

### `execCommandApproval`

This event resembles command approval but uses a different shape.

Audit focus:

- array-based command shape
- `parsedCmd`
- explicit `approvalId`
- response semantics
- whether current string-based preview extraction would fail
- whether approval identity and resolution correlation would remain correct

Expected value of this audit:

- determine whether the current abstraction is too string-centric and would fail on protocol-native command structures

## Finding Categories

Each finding should be classified into one or more of these buckets.

- `copy defect`
- `protocol mapping defect`
- `persistence gap`
- `response-shape defect`
- `lifecycle or recovery defect`
- `support gap for unintegrated API`

## Severity Model

### `P0`

Current user-visible bug in an already-integrated approval flow.

### `P1`

Current integrated flow is semantically incomplete or likely to misbehave for realistic payload variants.

### `P2`

Not currently surfaced in the product, but the current abstraction would likely fail if the approval API were integrated or exercised more fully.

### `P3`

Testing gap, abstraction roughness, or advisory cleanup that does not currently create a meaningful behavior defect.

## Output Format

The audit result should have three layers.

### 1. Executive Summary

- which event types are healthy
- which event types have confirmed bugs
- which event types have support gaps only

### 2. Per-Event Findings

For each event type:

- protocol evidence
- current CodeHelm behavior evidence
- finding categories
- severity
- root cause
- recommended follow-up

### 3. Cross-Cutting Root Causes

Summarize patterns such as:

- overly generic approval event parsing
- incorrect reliance on provider decision catalogs
- insufficiently expressive persistence
- response handling that assumes every approval can be answered with one scalar decision

## Execution Boundaries

- This work remains an audit until a separate implementation plan is approved.
- The audit may use tests, local database inspection, generated protocol bindings, and local replay.
- The audit should not add product scaffolding solely to make a not-yet-integrated approval API appear in Discord.
- If a small existing implementation defect materially blocks trustworthy observation, it may be documented as part of the findings, but the audit does not automatically expand into fixing it.

## Success Criteria

This design is successful if, after the audit:

- every approval-related protocol surface in scope has a grounded conclusion
- conclusions are based on real protocol shapes, not repository assumptions alone
- the result cleanly separates current bugs from future integration risks
- the next implementation plan can target the highest-value fixes without redoing discovery work
