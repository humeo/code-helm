import { expect, test } from "bun:test";
import {
  getApprovalRequestDecisionPayloads,
  type ApprovalRequestEvent,
} from "../../src/codex/protocol-types";

const createApprovalEvent = (
  overrides: Partial<ApprovalRequestEvent> = {},
): ApprovalRequestEvent => {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestId: "req-1",
    ...overrides,
  };
};

test("decision payload helper preserves a null sentinel when the provider omits a catalog", () => {
  expect(getApprovalRequestDecisionPayloads(createApprovalEvent())).toBeNull();
});

test("decision payload helper parses camelCase and normalizes mixed decision entries", () => {
  expect(
    getApprovalRequestDecisionPayloads(
      createApprovalEvent({
        availableDecisions: [
          "accept",
          {
            key: "cancel",
            label: "No, and tell Codex what to do differently",
            description: "Interrupt the turn",
          },
        ],
      }),
    ),
  ).toEqual([
    {
      decision: "accept",
    },
    {
      key: "cancel",
      decision: "cancel",
      label: "No, and tell Codex what to do differently",
      consequence: "Interrupt the turn",
      description: "Interrupt the turn",
    },
  ]);
});
