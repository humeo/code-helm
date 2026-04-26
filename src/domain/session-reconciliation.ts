import type { ThreadReadResult } from "../codex/protocol-types";
import type { SessionLifecycleState } from "../db/repos/sessions";

export const recentReconcileTurnLimit = 10;
export const syncReplayMessageLimit = 3;

type StartupWarmupSession = {
  lifecycleState: SessionLifecycleState;
  state: string;
};

export const limitThreadReadResultToRecentTurns = (
  snapshot: ThreadReadResult,
  limit = recentReconcileTurnLimit,
): ThreadReadResult => ({
  ...snapshot,
  thread: {
    ...snapshot.thread,
    turns: (snapshot.thread.turns ?? []).slice(-Math.max(0, limit)),
  },
});

export const shouldWarmManagedSessionControlAtStartup = (
  session: StartupWarmupSession,
) => {
  return session.lifecycleState === "active"
    && (session.state === "running" || session.state === "waiting-approval");
};
