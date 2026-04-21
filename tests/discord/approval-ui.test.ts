import { expect, test } from "bun:test";
import type {
  ApprovalState,
  PersistedApprovalDecision,
} from "../../src/domain/approval-service";
import * as approvalUi from "../../src/discord/approval-ui";

type ApprovalLifecyclePayload = {
  content: string;
  buttons: approvalUi.ApprovalUiButton[];
  decisions: PersistedApprovalDecision[];
};

const {
  applyApprovalResolutionSignal,
  renderApprovalLifecyclePayload,
  renderApprovalRequestIdText,
  renderApprovalResultLine,
  renderApprovalStaleStatusText,
} = approvalUi as unknown as {
  applyApprovalResolutionSignal: typeof approvalUi.applyApprovalResolutionSignal;
  renderApprovalLifecyclePayload: (input: {
    approvalKey?: string;
    approval: ApprovalState;
  }) => ApprovalLifecyclePayload;
  renderApprovalRequestIdText: (requestId: ApprovalState["requestId"]) => string;
  renderApprovalResultLine: (input: {
    status: ApprovalState["status"];
    commandPreview: string | null;
    displayTitle?: string | null;
    requestKind?: string | null;
    resolvedProviderDecision?: string | null;
    resolvedElsewhere?: boolean;
    resolvedBySurface?: string | null;
  }) => string;
  renderApprovalStaleStatusText: (input: {
    approval: ApprovalState;
  }) => string;
};

const createDecision = (
  providerDecision: string,
  label: string,
  consequence: string | null = null,
) => {
  return {
    key: providerDecision,
    providerDecision,
    label,
    consequence,
  } satisfies PersistedApprovalDecision;
};

const createApproval = (
  overrides: Partial<
    ApprovalState & {
      displayTitle: string | null;
      questionText: string | null;
      commandPreview: string | null;
      justification: string | null;
      cwd: string | null;
      requestKind: string | null;
      decisions: PersistedApprovalDecision[] | null;
      resolvedProviderDecision: string | null;
      resolvedElsewhere: boolean;
      resolvedBySurface: string | null;
    }
  > = {},
) => {
  return {
    requestId: "0",
    status: "pending",
    displayTitle: "Command approval",
    questionText: "Would you like to run the following command?",
    commandPreview: "touch c.txt",
    justification: "要允许我在项目根目录创建 c.txt 吗？",
    cwd: "/tmp/ws1/app",
    requestKind: "command_execution",
    decisions: [
      createDecision("accept", "Yes, proceed"),
      createDecision(
        "decline",
        "No, continue without running it",
      ),
      createDecision(
        "cancel",
        "No, and tell Codex what to do differently",
      ),
    ],
    resolvedProviderDecision: null,
    resolvedElsewhere: false,
    resolvedBySurface: null,
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

test("pending panels lead with the human question and render only offered provider decisions", () => {
  const rendered = renderApprovalLifecyclePayload({
    approvalKey: "turn-1:item-1",
    approval: createApproval({
      decisions: [
        createDecision("accept", "Yes, proceed"),
        createDecision(
          "cancel",
          "No, and tell Codex what to do differently",
        ),
      ],
    }),
  });

  expect(rendered.content.startsWith("**Would you like to run the following command?**")).toBe(
    true,
  );
  expect(rendered.content).not.toContain("**Approval request**");
  expect(rendered.content).toContain("touch c.txt");
  expect(rendered.content).not.toContain("Request ID:");
  expect(rendered.content).not.toContain("Kind:");
  expect(rendered.content).not.toContain("\n\n");
  expect(rendered.decisions.map((button) => button.label)).toEqual([
    "Yes, proceed",
    "No, and tell Codex what to do differently",
  ]);
});

test("pending panels fall back to legacy action buttons when persisted decisions are unavailable", () => {
  const rendered = renderApprovalLifecyclePayload({
    approval: createApproval({
      decisions: null,
    }),
  });

  expect(rendered.buttons).toEqual(["approve", "decline", "cancel"]);
  expect(rendered.decisions.map((decision) => decision.label)).toEqual([
    "Approve",
    "Decline",
    "Cancel",
  ]);
});

test("decline and cancel have different terminal result copy", () => {
  expect(
    renderApprovalResultLine({
      status: "declined",
      commandPreview: "touch i.txt",
      resolvedElsewhere: false,
    }),
  ).toBe("Declined and continuing without it: touch i.txt");

  expect(
    renderApprovalResultLine({
      status: "canceled",
      commandPreview: "touch i.txt",
      resolvedElsewhere: false,
    }),
  ).toBe("Canceled. The current turn was interrupted: touch i.txt");
});

test("file-change declines without a concrete preview use file-change-specific copy", () => {
  expect(
    renderApprovalResultLine({
      status: "declined",
      commandPreview: null,
      displayTitle: "File change approval",
      requestKind: "file_change",
      resolvedElsewhere: false,
    }),
  ).toBe("Declined and continuing without applying these changes.");
});

test("terminal approvals collapse into result lines and include codex-remote origin", () => {
  const rendered = renderApprovalLifecyclePayload({
    approvalKey: "turn-1:item-1",
    approval: createApproval({
      status: "approved",
      commandPreview: "touch i.txt",
      resolvedElsewhere: true,
      resolvedBySurface: "codex_remote",
      resolvedProviderDecision: "accept",
    }),
  });

  expect(rendered.content.startsWith("Handled in codex-remote: approved touch i.txt")).toBe(
    true,
  );
  expect(rendered.content).not.toContain("Request ID:");
  expect(rendered.buttons).toEqual([]);
});

test("remote terminal lines preserve saved-command and network-rule approval semantics", () => {
  expect(
    renderApprovalResultLine({
      status: "approved",
      commandPreview: "bun test",
      resolvedProviderDecision: "acceptWithExecpolicyAmendment",
      resolvedElsewhere: true,
      resolvedBySurface: "codex_remote",
    }),
  ).toBe(
    "Handled in codex-remote: approved and saved for future matching commands bun test",
  );

  expect(
    renderApprovalResultLine({
      status: "approved",
      commandPreview: "curl https://example.test",
      resolvedProviderDecision: "applyNetworkPolicyAmendment",
      resolvedElsewhere: true,
      resolvedBySurface: "codex_remote",
    }),
  ).toBe(
    "Handled in codex-remote: approved and applied the network rule curl https://example.test",
  );
});

test("session-scoped approvals render an explicit terminal result line", () => {
  expect(
    renderApprovalResultLine({
      status: "approved",
      commandPreview: "touch i.txt",
      resolvedProviderDecision: "acceptForSession",
      resolvedElsewhere: false,
    }),
  ).toBe("Approved for this session: touch i.txt");
});

test("bounds rich pending approval content to Discord's message limit", () => {
  const rendered = renderApprovalLifecyclePayload({
    approval: createApproval({
      requestId: `req-${"1234567890".repeat(30)}`,
      questionText: `Would you like to run this command? ${"prompt ".repeat(100)}`,
      commandPreview: `bun run deploy ${"--flag ".repeat(220)}`,
      justification: `Need this approval because ${"context ".repeat(220)}`,
      cwd: `/tmp/${"nested/".repeat(80)}app`,
      requestKind: `command-${"kind-".repeat(40)}`,
    }),
  });

  expect(rendered.content.length).toBeLessThanOrEqual(2000);
  expect(rendered.content).toContain("Would you like to run this command?");
  expect(rendered.content).not.toContain("Request ID:");
  expect(rendered.content).toContain("…");
});

test("request id truncation stays available for legacy fallback matching", () => {
  const requestId = `req-${"1234567890".repeat(30)}`;
  const requestIdText = renderApprovalRequestIdText(requestId);

  expect(requestIdText).toContain("Request ID: `req-");
  expect(requestIdText).toContain("…");
  expect(requestIdText).toContain("7890`");
});

test("renders long request ids with both prefix and suffix to reduce collisions", () => {
  const requestId = `req-${"a".repeat(72)}-suffix`;
  const requestIdText = renderApprovalRequestIdText(requestId);

  expect(requestIdText).toContain("Request ID: `req-");
  expect(requestIdText).toContain("…");
  expect(requestIdText).toContain("-suffix`");
});

test("renders command previews with embedded triple backticks safely", () => {
  const rendered = renderApprovalLifecyclePayload({
    approval: createApproval({
      commandPreview: 'printf "safe"\n```danger```\necho "done"',
    }),
  });

  expect(rendered.content).toContain('printf "safe"');
  expect(rendered.content).toContain("danger");
  expect(rendered.content).toContain("``\u200b`");
  expect(rendered.content.match(/```/g) ?? []).toHaveLength(2);
});

test("stale status text is specific about status and remote origin", () => {
  expect(
    renderApprovalStaleStatusText({
      approval: createApproval({
        status: "approved",
        commandPreview: "touch i.txt",
        resolvedElsewhere: true,
        resolvedBySurface: "codex_remote",
      }),
    }),
  ).toBe("This approval was already approved in codex-remote: touch i.txt");
});
