import { expect, test } from "bun:test";
import {
  reduceApprovalEvent,
  shouldShowApprovalControls,
  type ApprovalState,
} from "../../src/domain/approval-service";
import {
  renderApprovalUi,
  shouldCloseApprovalUi,
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
    requestId: "req-1",
  });

  expect(pending).toEqual({
    requestId: "req-1",
    status: "pending",
  } satisfies ApprovalState);

  expect(
    reduceApprovalEvent(pending, {
      type: "resolved",
      requestId: "req-1",
    }),
  ).toEqual({
    requestId: "req-1",
    status: "resolved",
  } satisfies ApprovalState);

  expect(
    reduceApprovalEvent(pending, {
      type: "approved",
      requestId: "req-1",
    }),
  ).toEqual({
    requestId: "req-1",
    status: "approved",
  } satisfies ApprovalState);

  expect(
    reduceApprovalEvent(pending, {
      type: "declined",
      requestId: "req-1",
    }),
  ).toEqual({
    requestId: "req-1",
    status: "declined",
  } satisfies ApprovalState);

  expect(
    reduceApprovalEvent(pending, {
      type: "canceled",
      requestId: "req-1",
    }),
  ).toEqual({
    requestId: "req-1",
    status: "canceled",
  } satisfies ApprovalState);
});

test("owner approval UI shows buttons while other viewers get status only", () => {
  const approval = {
    requestId: "req-1",
    status: "pending",
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
    buttons: ["approve", "decline", "cancel"],
    closeOnResolved: false,
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
    closeOnResolved: false,
  });
});

test("resolved approval UI closes immediately", () => {
  expect(
    shouldCloseApprovalUi({
      requestId: "req-1",
      status: "resolved",
    }),
  ).toBe(true);
});
