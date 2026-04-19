import { expect, test } from "bun:test";
import {
  createPersistedApprovalDecisions,
  reduceApprovalEvent,
  shouldShowApprovalControls,
  type PersistedApprovalDecision,
  type ApprovalState,
} from "../../src/domain/approval-service";
import {
  applyApprovalResolutionSignal,
  renderApprovalUi,
} from "../../src/discord/approval-ui";

test("only owner sees approval controls in Discord", () => {
  expect(shouldShowApprovalControls({ viewerId: "u1", ownerId: "u1" })).toBe(
    true,
  );
  expect(shouldShowApprovalControls({ viewerId: "u2", ownerId: "u1" })).toBe(
    false,
  );
});

test("approval events are reduced by request id through the full lifecycle", () => {
  const pending = reduceApprovalEvent(undefined, {
    type: "requestApproval",
    requestId: 9,
  });

  expect(pending).toEqual({
    requestId: "9",
    status: "pending",
  } satisfies ApprovalState);

  expect(
    reduceApprovalEvent(pending, {
      type: "approved",
      requestId: "9",
    }),
  ).toEqual({
    requestId: "9",
    status: "approved",
  } satisfies ApprovalState);

  expect(
    applyApprovalResolutionSignal(
      {
        requestId: "9",
        status: "approved",
      },
      {
        type: "serverRequest/resolved",
        requestId: 9,
      },
    ),
  ).toEqual({
    approval: {
      requestId: "9",
      status: "approved",
    },
    closeActiveUi: true,
  });

  expect(
    reduceApprovalEvent(
      {
        requestId: "9",
        status: "approved",
      },
      {
        type: "serverRequest/resolved",
        requestId: 9,
      },
    ),
  ).toEqual({
    requestId: "9",
    status: "approved",
  } satisfies ApprovalState);
});

test("terminal approval statuses outrank a later resolved event", () => {
  for (const status of ["approved", "declined", "canceled"] as const) {
    expect(
      reduceApprovalEvent(
        {
          requestId: "9",
          status,
        },
        {
          type: "serverRequest/resolved",
          requestId: 9,
        },
      ).status,
    ).toBe(status);
  }
});

test("owner approval UI shows buttons while other viewers get status only", () => {
  const decisions = [
    {
      key: "accept",
      providerDecision: "accept",
      label: "Yes, proceed",
    },
    {
      key: "cancel",
      providerDecision: "cancel",
      label: "No, and tell Codex what to do differently",
    },
  ] satisfies PersistedApprovalDecision[];

  const approval = {
    requestId: "req-1",
    status: "pending",
    decisions,
  } satisfies ApprovalState;

  expect(
    renderApprovalUi({
      approval,
      viewerId: "u1",
      ownerId: "u1",
    }),
  ).toEqual({
    kind: "controls",
    requestId: "req-1",
    status: "pending",
    buttons: decisions,
  });

  expect(
    renderApprovalUi({
      approval,
      viewerId: "u2",
      ownerId: "u1",
    }),
  ).toEqual({
    kind: "status-only",
    requestId: "req-1",
    status: "pending",
  });
});

test("provider-backed decisions preserve offered order and labels", () => {
  expect(
    createPersistedApprovalDecisions({
      availableDecisions: ["accept", "cancel"],
      requestMethod: "item/commandExecution/requestApproval",
    }),
  ).toEqual([
    {
      key: "accept",
      providerDecision: "accept",
      label: "Yes, proceed",
      consequence: null,
    },
    {
      key: "cancel",
      providerDecision: "cancel",
      label: "No, and tell Codex what to do differently",
      consequence: null,
    },
  ] satisfies PersistedApprovalDecision[]);
});

test("serverRequest/resolved signal closes the active approval UI immediately", () => {
  const approval = {
    requestId: "9",
    status: "pending",
  } satisfies ApprovalState;

  expect(
    applyApprovalResolutionSignal(approval, {
      type: "serverRequest/resolved",
      requestId: 9,
    }),
  ).toEqual({
    approval: {
      requestId: "9",
      status: "resolved",
    },
    closeActiveUi: true,
  });
});
