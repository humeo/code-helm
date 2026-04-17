import { expect, test } from "bun:test";
import type { ApprovalState } from "../../src/domain/approval-service";
import * as approvalUi from "../../src/discord/approval-ui";

type ApprovalLifecyclePayload = {
  content: string;
  buttons: string[];
};

const {
  applyApprovalResolutionSignal,
  renderApprovalLifecyclePayload,
  renderApprovalStaleStatusText,
} = approvalUi as unknown as {
  applyApprovalResolutionSignal: typeof approvalUi.applyApprovalResolutionSignal;
  renderApprovalLifecyclePayload: (input: {
    approvalKey?: string;
    approval: ApprovalState;
  }) => ApprovalLifecyclePayload;
  renderApprovalStaleStatusText: (input: {
    approval: ApprovalState;
  }) => string;
};

const createApproval = (
  overrides: Partial<
    ApprovalState & {
      displayTitle: string | null;
      commandPreview: string | null;
      justification: string | null;
      cwd: string | null;
      requestKind: string | null;
    }
  > = {},
) => {
  return {
    requestId: "0",
    status: "pending",
    displayTitle: "Command approval",
    commandPreview: "touch c.txt",
    justification: "要允许我在项目根目录创建 c.txt 吗？",
    cwd: "/tmp/ws1/app",
    requestKind: "command",
    ...overrides,
  } as ApprovalState;
};

test("terminal approval signals remain unchanged when resolved arrives later", () => {
  for (const status of ["approved", "declined", "canceled"] as const) {
    expect(
      applyApprovalResolutionSignal(
        {
          requestId: "9",
          status,
        },
        {
          type: "serverRequest/resolved",
          requestId: 9,
        },
      ).approval.status,
    ).toBe(status);
  }
});

test("renders a rich pending approval card when snapshot fields exist", () => {
  const rendered = renderApprovalLifecyclePayload({
    approvalKey: "turn-1:item-1",
    approval: createApproval(),
  });

  expect(rendered.content).toContain("Command approval");
  expect(rendered.content).toContain("touch c.txt");
  expect(rendered.content).toContain("要允许我在项目根目录创建 c.txt 吗？");
  expect(rendered.content).toContain("/tmp/ws1/app");
  expect(rendered.content).toContain("Request ID: `0`");
  expect(rendered.buttons).toEqual(["approve", "decline", "cancel"]);
});

test("legacy approvals without snapshot fields use a generic fallback title", () => {
  const rendered = renderApprovalLifecyclePayload({
    approval: createApproval({
      displayTitle: null,
      commandPreview: null,
      justification: null,
      cwd: null,
      requestKind: null,
    }),
  });

  expect(rendered.content).toContain("Approval request");
  expect(rendered.content).not.toContain("Approval 0");
});

test("terminal approval cards keep the snapshot body but hide action buttons", () => {
  const rendered = renderApprovalLifecyclePayload({
    approvalKey: "turn-1:item-1",
    approval: createApproval({
      status: "approved",
    }),
  });

  expect(rendered.content).toContain("Command approval");
  expect(rendered.content).toContain("touch c.txt");
  expect(rendered.content).toContain("Request ID: `0`");
  expect(rendered.buttons).toEqual([]);
});

test("renders stale status text from the shared approval title", () => {
  expect(
    renderApprovalStaleStatusText({
      approval: createApproval({
        status: "declined",
      }),
    }),
  ).toBe("Command approval is already declined.");
});
