import type {
  StartTurnParams,
  TurnSteerParams,
} from "../codex/protocol-types";
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

export type ArchivedThreadResumeDecision = {
  kind: "implicit-resume";
  request: StartThreadTurnDecision["request"];
};

export type SteerThreadTurnDecision = {
  kind: "steer-turn";
  request: Omit<TurnSteerParams, "input" | "expectedTurnId"> & {
    input: CodexTurnInput;
  };
};

export type NoopThreadTurnDecision = {
  kind: "noop";
  reason: "non-owner";
};

export type RejectThreadTurnDecision = {
  kind: "reject";
  reason: "waiting-approval";
};

export type ReadOnlyThreadTurnDecision = {
  kind: "read-only";
  reason: "session-degraded";
};

export type ThreadTurnDecision =
  | StartThreadTurnDecision
  | SteerThreadTurnDecision
  | NoopThreadTurnDecision
  | RejectThreadTurnDecision
  | ReadOnlyThreadTurnDecision;

export type ArchivedThreadDecision =
  | ArchivedThreadResumeDecision
  | NoopThreadTurnDecision;

export type DecideThreadTurnInput = OwnerThreadMessage & {
  sessionState: SessionRuntimeState;
  codexThreadId: string;
  approvalPolicy?: StartTurnParams["approvalPolicy"];
  sandboxPolicy?: StartTurnParams["sandboxPolicy"];
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

  if (sessionState === "waiting-approval") {
    return {
      kind: "reject",
      reason: "waiting-approval",
    };
  }

  if (sessionState === "running") {
    return {
      kind: "steer-turn",
      request: {
        threadId: codexThreadId,
        input: normalizeOwnerThreadMessage({ authorId, ownerId, content }),
      },
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

export const decideArchivedThreadResume = ({
  authorId,
  ownerId,
  content,
  codexThreadId,
  approvalPolicy,
  sandboxPolicy,
}: DecideThreadTurnInput): ArchivedThreadDecision => {
  if (!canControlSession({ actorId: authorId, ownerId })) {
    return {
      kind: "noop",
      reason: "non-owner",
    };
  }

  const request: ArchivedThreadResumeDecision["request"] = {
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
    kind: "implicit-resume",
    request,
  };
};
