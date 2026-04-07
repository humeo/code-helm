import { expect, test } from "bun:test";
import { shouldShowApprovalControls } from "../../src/domain/approval-service";

test("only owner sees approval controls in Discord", () => {
  expect(shouldShowApprovalControls({ viewerId: "u1", ownerId: "u1" })).toBe(
    true,
  );
  expect(shouldShowApprovalControls({ viewerId: "u2", ownerId: "u1" })).toBe(
    false,
  );
});
