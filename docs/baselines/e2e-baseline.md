# CodeHelm End-to-End Baseline

> Regression contract for the current Discord -> CodeHelm -> Codex App Server product surface. Update this file in the same change whenever intentionally changing externally visible behavior or the required regression suite.

## Scope

- This baseline covers the current CodeHelm v1 behavior exposed through Discord, the local daemon, and the supported `codex resume --remote <ws-url> <thread-id>` path.
- Only implemented behavior belongs here. This document is not a roadmap.
- Use this file in two ways:
  - as the stable product baseline for review during iteration
  - as the executable E2E checklist for regression runs

## Execution Contract

- Run Discord browser automation in headed `agent-browser`.
- Always reuse an existing `agent-browser` session when one already exists.
- In the Discord composer, do not rely on raw `/command` text. Open the slash candidate UI, click the candidate, confirm the composer shows a real command token, then send it.
- Do not insert arbitrary fixed delays between typing, candidate selection, and send. Wait only for real async boundaries such as the slash listbox appearing, the command token appearing, the thread opening, or the response content rendering.
- Treat `The application did not respond` as a runtime-health failure after tokenization is confirmed, not as a slash-picker failure.

## Product Baseline

### Control Channel

- `BL-CMD-001` The control surface is a guild-only slash-command console. DMs are not part of the control path.
  Evidence: `README.md`, `src/discord/commands.ts`, `tests/discord/commands.test.ts`
- `BL-CMD-002` `/session-new` requires a configured workdir choice, creates a Codex session for that workdir, and opens a managed Discord thread bound to it.
  Evidence: `README.md`, `src/discord/commands.ts`, `src/index.ts`
- `BL-CMD-003` `/session-resume` requires `workdir` and `session` autocomplete inputs. Workdir choices come from daemon config; session choices come from live Codex `thread/list` scoped to the selected workdir.
  Evidence: `README.md`, `src/discord/commands.ts`, `src/index.ts`, `tests/discord/commands.test.ts`, `tests/index.test.ts`
- `BL-CMD-004` `/session-resume` only attaches when the selected Codex thread cwd matches the selected workdir. It can reuse an active attachment, reopen an archived one, create a new Discord thread for an unmanaged session, or create a replacement thread when the old Discord container is deleted or unusable.
  Evidence: `README.md`, `src/index.ts`, `tests/index.test.ts`
- `BL-CMD-005` `/session-close` only works inside a managed session thread and only for the thread owner. It archives the same Discord thread instead of destroying the Codex session.
  Evidence: `README.md`, `src/index.ts`, `tests/discord/commands.test.ts`, `tests/index.test.ts`
- `BL-CMD-006` `/session-sync` is the manual recovery path for degraded managed sessions. It only clears read-only mode when the daemon can form a trustworthy session view.
  Evidence: `README.md`, `src/index.ts`, `tests/discord/commands.test.ts`, `tests/index.test.ts`, `tests/domain/session-service.test.ts`
- `BL-CMD-007` Waiting-approval attaches use resume semantics instead of plain sync so approval lifecycle UI and owner DM controls can be rehydrated on the attached Discord surface.
  Evidence: `README.md`, `src/index.ts`, `tests/index.test.ts`

### Managed Session Control

- `BL-CTRL-001` Inside an active managed thread, an owner message becomes Codex user input and starts a turn only when the session is ready for new input.
  Evidence: `src/discord/thread-handler.ts`, `tests/discord/thread-handler.test.ts`
- `BL-CTRL-002` Non-owner thread messages do not advance the session.
  Evidence: `README.md`, `src/domain/session-service.ts`, `tests/discord/thread-handler.test.ts`, `tests/discord/permissions.test.ts`
- `BL-CTRL-003` Running and waiting-approval sessions stay single-turn. A second owner message is not forwarded as a second turn.
  Evidence: `src/discord/thread-handler.ts`, `tests/discord/thread-handler.test.ts`
- `BL-CTRL-004` Degraded sessions stay read-only in Discord.
  Evidence: `README.md`, `src/domain/session-service.ts`, `tests/discord/thread-handler.test.ts`, `tests/domain/session-service.test.ts`
- `BL-CTRL-005` An owner message posted into an archived managed thread is treated as an implicit resume attempt. The message is only forwarded after resume sync says the session is writable again.
  Evidence: `README.md`, `src/index.ts`, `tests/discord/thread-handler.test.ts`, `tests/index.test.ts`

### Transcript And Status Surface

- `BL-TX-001` Discord-originated user input is recorded once. The transcript does not echo a second durable `User:` line for the same Discord message.
  Evidence: `README.md`, `src/discord/transcript.ts`, `tests/discord/transcript.test.ts`
- `BL-TX-002` Live non-Discord input observed through the supported remote path is rendered as a distinct weak "Remote input" card rather than as ordinary Discord user content.
  Evidence: `README.md`, `src/discord/transcript.ts`, `tests/discord/transcript.test.ts`
- `BL-TX-003` Completed turns render one process/progress surface plus one final answer when a final reply exists.
  Evidence: `README.md`, `src/discord/transcript.ts`, `tests/discord/transcript.test.ts`
- `BL-TX-004` Commentary-only turns keep process history without fabricating a final answer.
  Evidence: `src/discord/transcript.ts`, `tests/discord/transcript.test.ts`
- `BL-TX-005` Successful command execution stays inside the process/progress surface instead of creating a separate transcript bubble.
  Evidence: `README.md`, `src/discord/transcript.ts`, `tests/discord/transcript.test.ts`
- `BL-TX-006` The status surface stays fixed to operational states such as `Idle`, `Running`, and `Waiting for approval`; commentary and command detail stay on the process/progress surface instead of the status card or durable transcript noise.
  Evidence: `README.md`, `src/index.ts`, `tests/index.test.ts`

### Approval And Ownership

- `BL-APR-001` Each managed session has one Discord owner. Only the owner gets actionable approval controls and writable session control.
  Evidence: `README.md`, `src/domain/approval-service.ts`, `tests/domain/approval-service.test.ts`, `tests/discord/permissions.test.ts`
- `BL-APR-002` Other guild members can observe approval state, transcript, and status, but they cannot advance the session or resolve approvals.
  Evidence: `README.md`, `tests/domain/approval-service.test.ts`, `tests/discord/thread-handler.test.ts`
- `BL-APR-003` Approval lifecycle is request-scoped. Resolution updates the existing Discord approval surface instead of creating new stateful duplicates.
  Evidence: `src/index.ts`, `tests/index.test.ts`, `tests/db/approval-repo.test.ts`
- `BL-APR-004` If an approval resolves while the managed thread is archived, CodeHelm still updates the DM and any existing lifecycle message without reopening the thread.
  Evidence: `README.md`, `src/index.ts`, `tests/index.test.ts`

### Degradation, Recovery, And Container Semantics

- `BL-REC-001` Unsupported external modification is treated as a read-only degradation in Discord.
  Evidence: `README.md`, `src/domain/external-modification.ts`, `tests/domain/session-service.test.ts`, `tests/index.test.ts`
- `BL-REC-002` Snapshot mismatch is a best-effort detector for unsupported/offline modification. Once degraded, Discord stays read-only until a trustworthy sync clears it or the session is recreated.
  Evidence: `README.md`, `src/index.ts`, `tests/domain/session-service.test.ts`, `tests/index.test.ts`
- `BL-REC-003` Deleting the Discord thread detaches the Discord container without deleting the underlying Codex session.
  Evidence: `README.md`, `src/index.ts`, `tests/index.test.ts`, `tests/db/session-repo.test.ts`
- `BL-REC-004` Plain local `codex resume <thread-id>` is not part of the supported product path and is not baseline behavior.
  Evidence: `README.md`

## Excluded From Baseline

- Interrupt controls are not baseline yet in this repository snapshot.
- Any behavior that depends on unsupported plain local `codex resume <thread-id>` is out of scope.
- Provider abstraction, workdir switching inside an existing session, and multi-owner control are out of scope for this baseline.

## Regression Suite

### P0: Every Iteration Touching Discord Or Runtime Integration

#### `P0-01` Slash command picker and `/session-new`

Preconditions:
- CodeHelm daemon is running and connected to Discord.
- The control channel is open in Discord.

Steps:
1. Type `/` in the control channel composer.
2. Click the `/session-new` slash candidate.
3. Confirm the composer contains a real slash-command token.
4. Choose the `example` workdir from the slash options.
5. Press `Enter`.

Expected:
- Discord sends a real slash interaction rather than leaving raw `/session-new` text in the composer.
- `code-helm` replies in-channel.
- A managed Discord thread is created for the selected workdir.
- Discord does not show `The application did not respond`.

Coverage:
- `BL-CMD-001`, `BL-CMD-002`

#### `P0-02` Owner message starts a turn and returns one readable conversation

Preconditions:
- A newly created managed thread exists and is writable.

Steps:
1. In the managed thread, send a simple owner prompt such as `reply with the current workdir label only`.
2. Wait for the turn to complete.

Expected:
- The owner message advances the session.
- The thread shows progress/status and then a final answer.
- The transcript does not duplicate the same Discord user message as a second durable user bubble.

Coverage:
- `BL-CTRL-001`, `BL-TX-001`, `BL-TX-003`, `BL-TX-006`

#### `P0-03` Busy sessions stay single-turn

Preconditions:
- A managed thread exists.

Steps:
1. Send a prompt that keeps the agent busy for long enough to race a second message.
2. While the session is still running or waiting for approval, send a second owner message.

Expected:
- CodeHelm does not start a second turn from the second message.
- The original turn continues as the only active turn.

Coverage:
- `BL-CTRL-003`

#### `P0-04` Non-owner cannot control the session

Preconditions:
- A second Discord user can see the same managed thread.

Steps:
1. Have the non-owner send a message in the managed thread.
2. Have the non-owner try a control action such as `/session-close` inside that thread.

Expected:
- The non-owner message does not advance the session.
- The non-owner control attempt is rejected with an owner-only result.

Coverage:
- `BL-CTRL-002`, `BL-APR-001`, `BL-APR-002`

#### `P0-05` `/session-close` archives the same thread

Preconditions:
- The owner is in an active managed thread.

Steps:
1. Run `/session-close` inside that managed thread.

Expected:
- The thread is archived.
- The underlying session is not destroyed.
- Session lifecycle changes without losing the thread/session identity.

Coverage:
- `BL-CMD-005`

#### `P0-06` Archived owner message implicitly resumes the same thread

Preconditions:
- `P0-05` passed and the archived thread is still available.

Steps:
1. Post a new owner message in the archived thread.
2. Wait for CodeHelm to resume the session and handle the message.

Expected:
- CodeHelm reopens the same Discord thread instead of creating a new one.
- The message is only forwarded if the synced session becomes writable.
- If resume says the session is busy or degraded, the thread reopens in that state without forwarding the message.

Coverage:
- `BL-CTRL-005`, `BL-CMD-004`

#### `P0-07` `/session-resume` autocomplete surfaces live sessions for the selected workdir

Preconditions:
- The control channel is open in Discord.
- `P0-01` passed or another Codex thread already exists for the selected workdir.
- The selected workdir has at least one Codex thread visible through the daemon.

Steps:
1. Run `/session-resume` from the control channel.
2. Choose the `example` workdir from the slash options.
3. Open the `session` autocomplete list.

Expected:
- Discord shows `session` suggestions only after the `workdir` is selected.
- The suggestions correspond to live Codex threads for the selected workdir.
- The command uses real slash-command options rather than raw text.

Coverage:
- `BL-CMD-003`

### P1: Run When Touching The Named Subsystem Or Before Release

#### `P1-01` Explicit `/session-resume` attaches the selected Codex session based on attachment state

Preconditions:
- A selected Codex thread exists for the chosen workdir.
- Prepare at least one of these cases if possible:
  - a managed archived session
  - a managed active session
  - an unmanaged Codex session
  - a managed session whose Discord thread was deleted or became unusable

Steps:
1. Run `/session-resume` with the target workdir and session.
2. Repeat for any other attachment-state variants you prepared.

Expected:
- An archived managed session syncs and reopens the same Discord thread.
- An active managed session reuses the existing Discord thread instead of creating a duplicate.
- An unmanaged or detached session creates a new or replacement Discord thread attachment.
- Busy, degraded, or error states attach without pretending the session is writable.
- Wrong-workdir selections are rejected.

Coverage:
- `BL-CMD-004`, `BL-CTRL-004`

#### `P1-02` Waiting-approval `/session-resume` restores the approval surface

Preconditions:
- A Codex session in `waiting-approval` state exists for the selected workdir.
- The owner can observe both the Discord thread and DM approval surface.

Steps:
1. Run `/session-resume` with the matching workdir and waiting-approval session id.

Expected:
- Discord attaches to the selected session without fabricating writable idle state.
- The thread shows waiting-approval state.
- Approval lifecycle UI and owner DM controls are restored on the attached Discord surface.

Coverage:
- `BL-CMD-007`, `BL-APR-001`

#### `P1-03` Approval UI is owner-only and request-scoped

Preconditions:
- A managed thread can trigger a Codex approval request.
- A second Discord user can observe the thread.

Steps:
1. Trigger an approval request from the owner.
2. Observe the approval surface as both owner and non-owner.
3. Resolve the approval as the owner.

Expected:
- The owner sees actionable controls.
- The non-owner sees status only.
- Resolution updates the existing approval surface instead of spawning a second independent approval card.

Coverage:
- `BL-APR-001`, `BL-APR-002`, `BL-APR-003`

#### `P1-04` Approval resolution still reconciles while the thread is archived

Preconditions:
- A managed thread can enter waiting-approval state and then be archived before resolution completes.

Steps:
1. Trigger an approval.
2. Archive the thread path involved in the session lifecycle.
3. Resolve the approval.

Expected:
- CodeHelm updates the DM and the existing lifecycle surface even though the thread stays archived.
- The thread is not reopened just to reflect approval resolution.

Coverage:
- `BL-APR-004`

#### `P1-05` Supported remote CLI input is rendered as remote input

Preconditions:
- A managed session exists.
- The local host can run `codex resume --remote <ws-url> <thread-id>`.

Steps:
1. Attach with the supported remote CLI path.
2. Send a user message from the remote CLI.

Expected:
- The Discord thread renders the input as a distinct remote-input card.
- The same text is not double-counted as a Discord-originated user bubble.

Coverage:
- `BL-TX-001`, `BL-TX-002`, `BL-REC-004`

#### `P1-06` Unsupported/offline modification degrades Discord to read-only

Preconditions:
- A managed session exists and can be modified outside the supported flow or can be driven into snapshot mismatch.

Steps:
1. Produce an unsupported/offline modification condition.
2. Wait for snapshot reconciliation or force the degraded state through the relevant recovery path.

Expected:
- Discord marks the session read-only.
- The degradation reason is surfaced.
- The thread no longer accepts writable input.

Coverage:
- `BL-REC-001`, `BL-REC-002`

#### `P1-07` `/session-sync` clears only trustworthy snapshot-mismatch degradation

Preconditions:
- A managed session is degraded because of snapshot mismatch.

Steps:
1. Run `/session-sync` inside the degraded managed thread.

Expected:
- If the daemon can form a trustworthy view, read-only mode clears and the thread becomes writable again.
- If the view is still untrusted or Codex is in an error branch, the thread stays read-only.

Coverage:
- `BL-CMD-008`, `BL-REC-002`

#### `P1-08` Discord thread deletion detaches the container but preserves the session record

Preconditions:
- A managed session thread exists.

Steps:
1. Delete the Discord thread container.
2. Inspect the persisted session state or attempt the supported recovery path.

Expected:
- CodeHelm treats the Discord thread as detached/deleted.
- The underlying Codex session is not treated as destroyed just because the Discord thread disappeared.

Coverage:
- `BL-REC-003`

## Maintenance Rule

- When a PR changes a baseline behavior, update the matching `BL-*` entry and the affected `P0`/`P1` scenarios in the same PR.
- When adding a new externally visible capability, do not only add code and unit tests. Add a baseline entry and place the scenario into `P0` or `P1`.
