import type { StartTurnParams } from "../codex/protocol-types";
import { canControlSession } from "./permissions";
import type { SessionRuntimeState } from "../domain/types";

export type CodexTextInput = {
  type: "text";
  text: string;
};

export type CodexTurnInput = CodexTextInput[];

export type OwnerThreadMessage = {
  authorId: string;
  ownerId: string;
  content: string;
};

export type StartThreadTurnDecision = {
  kind: "start-turn";
  request: Omit<StartTurnParams, "input"> & {
    input: CodexTurnInput;
  };
};

export type NoopThreadTurnDecision = {
  kind: "noop";
  reason: "non-owner" | "session-busy";
};

export type ReadOnlyThreadTurnDecision = {
  kind: "read-only";
  reason: "session-degraded";
};

export type ThreadTurnDecision =
  | StartThreadTurnDecision
  | NoopThreadTurnDecision
  | ReadOnlyThreadTurnDecision;

export type DecideThreadTurnInput = OwnerThreadMessage & {
  sessionState: SessionRuntimeState;
  codexThreadId: string;
  approvalPolicy?: StartTurnParams["approvalPolicy"];
  sandboxPolicy?: StartTurnParams["sandboxPolicy"];
};

const isSessionBusy = (sessionState: SessionRuntimeState) => {
  return sessionState === "running" || sessionState === "waiting-approval";
};

export const normalizeOwnerThreadMessage = ({
  content,
}: OwnerThreadMessage): CodexTurnInput => {
  return [{ type: "text", text: content }];
};

export const decideThreadTurn = ({
  authorId,
  ownerId,
  content,
  sessionState,
  codexThreadId,
  approvalPolicy,
  sandboxPolicy,
}: DecideThreadTurnInput): ThreadTurnDecision => {
  if (!canControlSession({ actorId: authorId, ownerId })) {
    return {
      kind: "noop",
      reason: "non-owner",
    };
  }

  if (sessionState === "degraded") {
    return {
      kind: "read-only",
      reason: "session-degraded",
    };
  }

  if (isSessionBusy(sessionState)) {
    return {
      kind: "noop",
      reason: "session-busy",
    };
  }

  const request: StartThreadTurnDecision["request"] = {
    threadId: codexThreadId,
    input: normalizeOwnerThreadMessage({ authorId, ownerId, content }),
  };

  if (approvalPolicy !== undefined) {
    request.approvalPolicy = approvalPolicy;
  }

  if (sandboxPolicy !== undefined) {
    request.sandboxPolicy = sandboxPolicy;
  }

  return {
    kind: "start-turn",
    request,
  };
};
